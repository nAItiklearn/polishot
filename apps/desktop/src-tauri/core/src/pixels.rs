//! Fast pixel-buffer helpers shared by the clipboard, the BMP builders and the image checks.
//!
//! Screenshots are tens of megabytes, so per-pixel `extend_from_slice` loops (a bounds check and a
//! capacity check per pixel) are far too slow: they cost more than the actual memory traffic.
//! These helpers work a whole `u32` at a time over pre-sized buffers, which the compiler turns into
//! vector code, and can split a buffer into row bands across a few threads.

/// Buffers smaller than this are processed on the calling thread: starting threads would cost more
/// than the work.
const PAR_MIN_BYTES: usize = 4 * 1024 * 1024;

/// Threads worth using for pixel work on this machine (at most 4: the work is memory-bound).
pub fn default_threads() -> usize {
    std::thread::available_parallelism().map_or(1, |n| n.get().min(4))
}

/// Copy `src` into `dst` swapping the red and blue byte of every 4-byte pixel (RGBA to BGRA and
/// back). `force_opaque` also sets the fourth byte to 255. Both slices must have the same length.
pub fn swap_rb(dst: &mut [u8], src: &[u8], force_opaque: bool) {
    debug_assert_eq!(dst.len(), src.len());
    let alpha = if force_opaque { 0xFF00_0000 } else { 0 };
    for (d, s) in dst.chunks_exact_mut(4).zip(src.chunks_exact(4)) {
        let px = u32::from_le_bytes([s[0], s[1], s[2], s[3]]);
        let out = (px & 0xFF00_FF00) | ((px & 0xFF) << 16) | ((px >> 16) & 0xFF) | alpha;
        d.copy_from_slice(&out.to_le_bytes());
    }
}

/// Call `f(row_index, row)` for every `row_len`-byte row of `buf`, in bands on up to `threads`
/// threads when the buffer is large. Rows are independent, so the result is the same whatever the
/// thread count. A trailing partial row is left untouched.
pub fn par_rows<F>(buf: &mut [u8], row_len: usize, threads: usize, f: F)
where
    F: Fn(usize, &mut [u8]) + Sync,
{
    if row_len == 0 {
        return;
    }
    let rows = buf.len() / row_len;
    let threads = threads.clamp(1, 16).min(rows.max(1));
    if threads == 1 || buf.len() < PAR_MIN_BYTES {
        for (i, row) in buf.chunks_exact_mut(row_len).enumerate() {
            f(i, row);
        }
        return;
    }
    let band_rows = rows.div_ceil(threads);
    std::thread::scope(|scope| {
        for (band, chunk) in buf.chunks_mut(band_rows * row_len).enumerate() {
            let f = &f;
            scope.spawn(move || {
                for (j, row) in chunk.chunks_exact_mut(row_len).enumerate() {
                    f(band * band_rows + j, row);
                }
            });
        }
    });
}

/// True when any pixel's alpha is not 255. (A plain early-exit scan measured as fast as a
/// branch-free vectorised fold: this loop is limited by memory bandwidth, about 6 ms for a 4K
/// screenshot.)
pub fn has_transparency(rgba: &[u8]) -> bool {
    rgba.chunks_exact(4).any(|p| p[3] != 255)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-random bytes.
    fn noise(len: usize, seed: u32) -> Vec<u8> {
        let mut x = seed.wrapping_mul(0x9E37_79B1) | 1;
        (0..len)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                (x >> 8) as u8
            })
            .collect()
    }

    #[test]
    fn swap_rb_matches_the_per_pixel_definition() {
        for px_count in [0usize, 1, 3, 4, 7, 16, 1000] {
            let src = noise(px_count * 4, px_count as u32 + 1);
            let mut keep_alpha = vec![0u8; src.len()];
            let mut opaque = vec![0u8; src.len()];
            swap_rb(&mut keep_alpha, &src, false);
            swap_rb(&mut opaque, &src, true);
            for (i, p) in src.chunks_exact(4).enumerate() {
                assert_eq!(&keep_alpha[i * 4..i * 4 + 4], &[p[2], p[1], p[0], p[3]]);
                assert_eq!(&opaque[i * 4..i * 4 + 4], &[p[2], p[1], p[0], 255]);
            }
        }
    }

    #[test]
    fn swapping_twice_is_the_identity() {
        let src = noise(4 * 999, 5);
        let mut once = vec![0u8; src.len()];
        let mut twice = vec![0u8; src.len()];
        swap_rb(&mut once, &src, false);
        swap_rb(&mut twice, &once, false);
        assert_eq!(twice, src);
    }

    #[test]
    fn par_rows_visits_every_row_once_whatever_the_thread_count() {
        // Large enough to take the threaded path (> PAR_MIN_BYTES).
        let row_len = 4096;
        let rows = 1100;
        for threads in [1usize, 2, 3, 4, 7, 64] {
            let mut buf = vec![0u8; row_len * rows];
            par_rows(&mut buf, row_len, threads, |i, row| {
                row.fill((i % 251) as u8 + 1);
            });
            for (i, row) in buf.chunks_exact(row_len).enumerate() {
                assert!(
                    row.iter().all(|&b| b == (i % 251) as u8 + 1),
                    "row {i} with {threads} threads"
                );
            }
        }
    }

    #[test]
    fn par_rows_handles_small_empty_and_ragged_buffers() {
        let mut empty: Vec<u8> = Vec::new();
        par_rows(&mut empty, 16, 4, |_, _| panic!("no rows"));
        let mut zero_len = vec![1u8; 8];
        par_rows(&mut zero_len, 0, 4, |_, _| panic!("no rows"));
        // A trailing partial row is not visited.
        let mut ragged = vec![0u8; 10];
        let mut seen = Vec::new();
        let counter = std::sync::Mutex::new(&mut seen);
        par_rows(&mut ragged, 4, 1, |i, _| counter.lock().unwrap().push(i));
        assert_eq!(seen, [0, 1]);
    }

    #[test]
    fn transparency_is_found_anywhere() {
        let mut px = vec![255u8; 4 * 10_000];
        assert!(!has_transparency(&px));
        assert!(!has_transparency(&[]));
        for at in [0usize, 1, 1023, 1024, 5000, 9999] {
            px[at * 4 + 3] = 254;
            assert!(has_transparency(&px), "pixel {at}");
            px[at * 4 + 3] = 255;
        }
        // Colour bytes never count, only alpha.
        px[2] = 0;
        px[4 * 5000] = 7;
        assert!(!has_transparency(&px));
    }
}
