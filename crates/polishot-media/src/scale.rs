//! Hand-written area-average ("box") downscaler. No `image` crate.
//!
//! Each output pixel is the area-weighted mean of the source rectangle it covers, so any ratio
//! (not just integers) is handled without aliasing. Only shrinking is supported; the GIF encoder
//! never upscales. The arithmetic is 8-bit fixed point (weights sum to 4096 per axis), which keeps
//! the inner loops integer-only and auto-vectorisable while staying exact for flat colours and
//! integer ratios.

/// Fixed-point weight of a whole pixel (12 bits).
const WEIGHT_ONE: u32 = 4096;
/// Shift and rounding term for the two-axis product (2 x 12 bits).
const SHIFT: u32 = 24;
const ROUND: u32 = 1 << (SHIFT - 1);

/// Output size for scaling a `w`x`h` image down to at most `max_width` pixels wide, preserving the
/// aspect ratio. `max_width == 0` or a source that is already narrow enough keeps the size.
pub(crate) fn target_size(w: u32, h: u32, max_width: u32) -> (u32, u32) {
    if max_width == 0 || w <= max_width {
        return (w, h);
    }
    let new_h = (u64::from(h) * u64::from(max_width) + u64::from(w) / 2) / u64::from(w);
    (max_width, u32::try_from(new_h).unwrap_or(u32::MAX).max(1))
}

/// Downscales an RGBA8 image to `out_w` x `out_h` (both `<=` the source size) and returns opaque
/// RGBA8 (alpha forced to 255). When the size is unchanged the pixels are copied with alpha forced
/// opaque. Inputs must already be validated: `src.len() == w * h * 4`.
#[cfg(test)]
pub(crate) fn downscale_box(src: &[u8], w: usize, h: usize, out_w: usize, out_h: usize) -> Vec<u8> {
    downscale_box_threads(src, w, h, out_w, out_h, 1)
}

/// Frames at least this large (in output pixels) are scaled by several threads at once.
const PAR_MIN_OUT_PIXELS: usize = 1 << 16;

/// [`downscale_box`] with the output rows split into bands on up to `threads` threads. Every
/// output row depends only on the source, so the result is identical for any thread count.
pub(crate) fn downscale_box_threads(
    src: &[u8],
    w: usize,
    h: usize,
    out_w: usize,
    out_h: usize,
    threads: usize,
) -> Vec<u8> {
    let mut out = vec![255u8; out_w * out_h * 4];
    if out_w == w && out_h == h {
        for (d, s) in out.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
            d[..3].copy_from_slice(&s[..3]);
        }
        return out;
    }

    let y_scale = h as f64 / out_h as f64;
    // Up to 16:1 vertically the weights fit in 8 bits, which lets the (dominant) vertical pass run
    // in 16-bit lanes; beyond that 12-bit weights keep the rounding error small.
    let narrow = y_scale <= 16.0;
    let plan = Plan {
        src,
        w,
        h,
        out_w,
        y_scale,
        narrow,
        y_one: if narrow { 256 } else { WEIGHT_ONE },
        cols: (0..out_w)
            .map(|ox| axis_weights(ox, w as f64 / out_w as f64, w, WEIGHT_ONE))
            .collect(),
    };

    let threads = threads.clamp(1, 16).min(out_h);
    if threads == 1 || out_w * out_h < PAR_MIN_OUT_PIXELS {
        scale_band(&plan, 0, &mut out);
        return out;
    }
    let band_rows = out_h.div_ceil(threads);
    std::thread::scope(|scope| {
        for (band, rows) in out.chunks_mut(band_rows * out_w * 4).enumerate() {
            let plan = &plan;
            scope.spawn(move || scale_band(plan, band * band_rows, rows));
        }
    });
    out
}

/// Everything the row bands share.
struct Plan<'a> {
    src: &'a [u8],
    w: usize,
    h: usize,
    out_w: usize,
    y_scale: f64,
    narrow: bool,
    y_one: u32,
    cols: Vec<(usize, Vec<u32>)>,
}

/// Fill the output rows `first_row..` held in `band`.
fn scale_band(plan: &Plan<'_>, first_row: usize, band: &mut [u8]) {
    let Plan {
        src,
        w,
        h,
        out_w,
        y_scale,
        narrow,
        y_one,
        cols,
    } = plan;
    let (w, h, out_w, narrow) = (*w, *h, *out_w, *narrow);
    // Vertical accumulation row (4 lanes per source column), reused for every output row.
    let mut acc = vec![0u32; w * 4];
    let mut acc16 = vec![0u16; if narrow { w * 4 } else { 0 }];
    for (j, out_row) in band.chunks_exact_mut(out_w * 4).enumerate() {
        let oy = first_row + j;
        let (y0, y_weights) = axis_weights(oy, *y_scale, h, *y_one);
        if narrow {
            acc16.fill(0);
            for (k, &weight) in y_weights.iter().enumerate() {
                let row = &src[(y0 + k) * w * 4..(y0 + k + 1) * w * 4];
                let weight = weight as u16;
                for (a, &p) in acc16.iter_mut().zip(row) {
                    // At most 256 * 255 = 65 280 in total, so this never overflows.
                    *a += weight * u16::from(p);
                }
            }
            // Bring the 8-bit-weight sums (x256) to the 12-bit scale (x4096) used below.
            for (a, &s) in acc.iter_mut().zip(&acc16) {
                *a = u32::from(s) << 4;
            }
        } else {
            acc.fill(0);
            for (k, &weight) in y_weights.iter().enumerate() {
                let row = &src[(y0 + k) * w * 4..(y0 + k + 1) * w * 4];
                for (a, &p) in acc.iter_mut().zip(row) {
                    *a += weight * u32::from(p);
                }
            }
        }
        for (dst, (x0, x_weights)) in out_row.chunks_exact_mut(4).zip(cols) {
            let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
            let taps = &acc[x0 * 4..(x0 + x_weights.len()) * 4];
            for (px, &wx) in taps.chunks_exact(4).zip(x_weights) {
                r += wx * px[0];
                g += wx * px[1];
                b += wx * px[2];
            }
            // Both axes carry weight 4096, so the sums are scaled by 2^24 (and still fit in u32:
            // 4096 * 4096 * 255 + 2^23 < 2^32).
            dst[0] = ((r + ROUND) >> SHIFT) as u8;
            dst[1] = ((g + ROUND) >> SHIFT) as u8;
            dst[2] = ((b + ROUND) >> SHIFT) as u8;
        }
    }
}

/// For output index `o` on an axis scaled by `scale = in_len / out_len`, returns the first source
/// index touched and the weight of each source index from there on, in `1/one` units summing to
/// `one`.
fn axis_weights(o: usize, scale: f64, in_len: usize, one: u32) -> (usize, Vec<u32>) {
    let lo = o as f64 * scale;
    let hi = ((o + 1) as f64 * scale).min(in_len as f64);
    let first = (lo.floor() as usize).min(in_len - 1);
    let last = ((hi.ceil() as usize).max(first + 1)).min(in_len);
    let overlaps: Vec<f64> = (first..last)
        .map(|i| (hi.min((i + 1) as f64) - lo.max(i as f64)).max(0.0))
        .collect();
    let total: f64 = overlaps.iter().sum();
    if total <= 0.0 {
        // Degenerate (cannot happen for valid scales): nearest source sample.
        return (first, vec![one]);
    }
    let mut weights: Vec<u32> = overlaps
        .iter()
        .map(|&v| (v / total * f64::from(one)).round() as u32)
        .collect();
    // Rounding can leave the sum off by a few units: give the difference to the largest tap.
    let sum: i64 = weights.iter().map(|&w| i64::from(w)).sum();
    if let Some(i) = (0..weights.len()).max_by_key(|&i| weights[i]) {
        weights[i] = (i64::from(weights[i]) + i64::from(one) - sum).max(0) as u32;
    }
    (first, weights)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn target_size_keeps_aspect_and_never_upscales() {
        assert_eq!(target_size(1600, 900, 800), (800, 450));
        assert_eq!(target_size(800, 450, 800), (800, 450));
        assert_eq!(target_size(640, 360, 0), (640, 360));
        assert_eq!(target_size(100, 1, 10), (10, 1));
        assert_eq!(target_size(1000, 3, 10), (10, 1));
    }

    #[test]
    fn weights_always_sum_to_one_and_stay_in_range() {
        for (in_len, out_len) in [
            (1920usize, 800usize),
            (1080, 450),
            (7, 3),
            (101, 100),
            (1000, 3),
        ] {
            let scale = in_len as f64 / out_len as f64;
            for o in 0..out_len {
                // 8-bit weights are only used up to 16:1; 12-bit weights at any ratio.
                let ones: &[u32] = if scale <= 16.0 {
                    &[256, WEIGHT_ONE]
                } else {
                    &[WEIGHT_ONE]
                };
                for &one in ones {
                    let (first, w) = axis_weights(o, scale, in_len, one);
                    assert_eq!(w.iter().sum::<u32>(), one, "{in_len}->{out_len} at {o}");
                    assert!(first + w.len() <= in_len);
                }
            }
        }
    }

    #[test]
    fn constant_image_stays_constant() {
        let (w, h) = (37usize, 29usize);
        let mut src = vec![0u8; w * h * 4];
        for px in src.chunks_exact_mut(4) {
            px.copy_from_slice(&[200, 100, 50, 7]);
        }
        let out = downscale_box(&src, w, h, 11, 9);
        assert_eq!(out.len(), 11 * 9 * 4);
        assert!(out.chunks_exact(4).all(|px| px == [200, 100, 50, 255]));
    }

    #[test]
    fn any_thread_count_gives_the_same_pixels() {
        // Non-integer ratios in both directions, large enough to take the threaded path.
        let (w, h) = (1280usize, 720usize);
        let mut x = 0x1234_5678u32;
        let src: Vec<u8> = (0..w * h * 4)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x >> 8) as u8
            })
            .collect();
        let (out_w, out_h) = (421usize, 237usize);
        assert!(out_w * out_h >= PAR_MIN_OUT_PIXELS);
        let one = downscale_box_threads(&src, w, h, out_w, out_h, 1);
        for threads in [2usize, 3, 4, 7, 64] {
            assert_eq!(
                downscale_box_threads(&src, w, h, out_w, out_h, threads),
                one,
                "{threads} threads"
            );
        }
        // The wide-ratio (12-bit weight) path too.
        let one = downscale_box_threads(&src, w, h, 60, 45, 1);
        assert_eq!(downscale_box_threads(&src, w, h, 60, 45, 4), one);
    }

    #[test]
    fn integer_ratio_is_a_plain_average() {
        // 4x2 -> 2x1: every output pixel is the mean of a 2x2 block.
        let mut src = vec![0u8; 4 * 2 * 4];
        let vals = [[0u8, 40, 100, 200], [20, 60, 140, 240]];
        for (y, row) in vals.iter().enumerate() {
            for (x, &v) in row.iter().enumerate() {
                let i = (y * 4 + x) * 4;
                src[i..i + 4].copy_from_slice(&[v, v, v, 255]);
            }
        }
        let out = downscale_box(&src, 4, 2, 2, 1);
        assert_eq!(out[0], 30); // (0 + 40 + 20 + 60) / 4
        assert_eq!(out[4], 170); // (100 + 200 + 140 + 240) / 4
    }
}
