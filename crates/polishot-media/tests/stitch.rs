mod common;

use common::*;
use polishot_media::{Frame, FrameError, StitchError, StitchOptions, Stitcher};

struct Scene {
    doc: Frame,
    header: Option<Frame>,
    footer: Option<Frame>,
    vh: usize,
}

impl Scene {
    fn new(width: usize, doc_h: usize, vh: usize, ht: usize, ft: usize, kind: BarKind) -> Scene {
        let doc = document(width, doc_h, 7);
        let header = (ht > 0).then(|| bar(width, ht, kind, 11, true));
        let footer = (ft > 0).then(|| bar(width, ft, kind, 13, false));
        Scene {
            doc,
            header,
            footer,
            vh,
        }
    }

    fn shot(&self, y: usize) -> Frame {
        viewport(
            &self.doc,
            y,
            self.vh,
            self.header.as_ref(),
            self.footer.as_ref(),
        )
    }

    fn max_y(&self) -> usize {
        self.doc.height as usize - self.vh
    }

    fn expected(&self, y_last: usize) -> Frame {
        expected(
            &self.doc,
            self.header.as_ref(),
            self.footer.as_ref(),
            self.vh,
            y_last,
        )
    }

    /// Scrolls by `deltas` (clamped at the document bottom), pushing a frame after each step, and
    /// checks every push reports exactly the rows the page really moved. Returns the stitcher and
    /// the final scroll offset.
    fn scroll(&self, opts: StitchOptions, deltas: &[usize]) -> (Stitcher, usize) {
        let mut st = Stitcher::new(self.shot(0), opts);
        let mut y = 0usize;
        for (i, &d) in deltas.iter().enumerate() {
            let ny = (y + d).min(self.max_y());
            let got = st.push(&self.shot(ny));
            assert_eq!(
                got,
                Ok((ny - y) as u32),
                "push {i}: scroll {y} -> {ny} (delta {d})"
            );
            y = ny;
        }
        (st, y)
    }
}

fn opts() -> StitchOptions {
    StitchOptions::default()
}

/// Deltas that cover a whole document of `doc_h` rows with uneven steps no larger than `max`.
fn uneven_deltas(doc_h: usize, vh: usize, max: usize) -> Vec<usize> {
    const PATTERN: [usize; 9] = [100, 73, 151, 41, 128, 160, 17, 97, 5];
    let mut out = Vec::new();
    let mut y = 0;
    let mut i = 0;
    while y < doc_h - vh {
        let d = PATTERN[i % PATTERN.len()].min(max);
        out.push(d);
        y += d;
        i += 1;
    }
    out
}

#[test]
fn uneven_offsets_with_textured_sticky_bars_match_ground_truth() {
    let s = Scene::new(320, 2400, 300, 36, 24, BarKind::Textured);
    let deltas = uneven_deltas(2400, 300, 190);
    let (st, y_last) = s.scroll(opts(), &deltas);
    assert_eq!(y_last, s.max_y());
    let (top, bottom) = st.detect_sticky();
    assert!((36..=39).contains(&top), "header detected as {top}");
    assert!((24..=27).contains(&bottom), "footer detected as {bottom}");
    assert_same(&st.finish(), &s.expected(y_last));
}

#[test]
fn uniform_colour_bars_are_not_duplicated() {
    let s = Scene::new(320, 2400, 300, 40, 28, BarKind::Uniform);
    let deltas = uneven_deltas(2400, 300, 190);
    let (st, y_last) = s.scroll(opts(), &deltas);
    assert_same(&st.finish(), &s.expected(y_last));
}

#[test]
fn header_only_footer_only_and_none() {
    for (ht, ft) in [(48, 0), (0, 32), (0, 0)] {
        let s = Scene::new(320, 1800, 300, ht, ft, BarKind::Textured);
        let deltas = uneven_deltas(1800, 300, 200);
        let (st, y_last) = s.scroll(opts(), &deltas);
        assert_same(&st.finish(), &s.expected(y_last));
    }
}

#[test]
fn odd_and_wide_widths() {
    // 301 px: one luma cell per pixel; 1300 px: row hashes sample every second pixel.
    for width in [301usize, 1300] {
        let s = Scene::new(width, 1500, 240, 30, 20, BarKind::Textured);
        // Body = 240 - 30 - 20 = 190 rows, minus the 48-row minimum overlap: steps up to 142.
        let deltas = uneven_deltas(1500, 240, 135);
        let (st, y_last) = s.scroll(opts(), &deltas);
        assert_same(&st.finish(), &s.expected(y_last));
    }
}

#[test]
fn smooth_scroll_partial_movement() {
    // Tiny steps (a smooth-scroll animation sampled mid-flight), then a normal one.
    let s = Scene::new(320, 1200, 300, 36, 24, BarKind::Textured);
    let deltas = [1, 2, 3, 1, 5, 2, 7, 1, 4, 11, 1, 1, 90, 3, 40, 2, 150, 6, 1];
    let (st, y_last) = s.scroll(opts(), &deltas);
    assert_same(&st.finish(), &s.expected(y_last));
}

#[test]
fn scroll_that_hits_the_bottom_reports_zero() {
    let s = Scene::new(320, 1000, 300, 36, 24, BarKind::Textured);
    // The last requested scroll overshoots the bottom, so only part of it happens.
    let (mut st, y_last) = s.scroll(opts(), &[150, 150, 150, 150, 150]);
    assert_eq!(y_last, s.max_y());
    let before = st.height();
    // Pushing the same bottom screen again, and again, must say "no movement".
    assert_eq!(st.push(&s.shot(y_last)), Ok(0));
    assert_eq!(st.push(&s.shot(y_last)), Ok(0));
    assert_eq!(st.height(), before);
    assert_same(&st.finish(), &s.expected(y_last));
}

#[test]
fn no_movement_frame_returns_zero_and_changes_nothing() {
    let s = Scene::new(320, 1000, 300, 36, 24, BarKind::Textured);
    let (mut st, _) = s.scroll(opts(), &[120, 90]);
    let before = st.height();
    assert_eq!(st.push(&s.shot(210)), Ok(0));

    // A blinking caret (a few pixels) is not movement either.
    let mut blink = s.shot(210);
    for x in 100..104 {
        for y in 120..136 {
            let i = (y * 320 + x) * 4;
            blink.rgba[i] = 0;
            blink.rgba[i + 1] = 0;
            blink.rgba[i + 2] = 0;
        }
    }
    assert_eq!(st.push(&blink), Ok(0));
    assert_eq!(st.height(), before);
    // ...and the stitcher still works afterwards.
    assert_eq!(st.push(&s.shot(310)), Ok(100));
}

#[test]
fn unrelated_frames_are_rejected_without_side_effects() {
    let s = Scene::new(320, 1200, 300, 36, 24, BarKind::Textured);
    let mut st = Stitcher::new(s.shot(0), opts());
    assert_eq!(st.push(&s.shot(120)), Ok(120));
    let height = st.height();

    // Random noise.
    let noisy = noise(320, 300, 99);
    assert!(matches!(
        st.push(&noisy),
        Err(StitchError::NoAlignment { .. })
    ));
    // A structurally similar but different page.
    let other = Scene {
        doc: document(320, 1200, 4242),
        header: s.header.clone(),
        footer: s.footer.clone(),
        vh: 300,
    };
    assert!(matches!(
        st.push(&other.shot(500)),
        Err(StitchError::NoAlignment { .. })
    ));
    // A uniformly coloured frame.
    let flat = Frame {
        width: 320,
        height: 300,
        rgba: vec![128; 320 * 300 * 4],
    };
    assert!(st.push(&flat).is_err());
    assert_eq!(
        st.height(),
        height,
        "failed pushes must not change the image"
    );

    // The next genuine frame still aligns against the last good one.
    assert_eq!(st.push(&s.shot(260)), Ok(140));
    assert_same(&st.finish(), &s.expected(260));
}

#[test]
fn scrolling_back_up_is_an_alignment_error() {
    let s = Scene::new(320, 1200, 300, 36, 24, BarKind::Textured);
    let mut st = Stitcher::new(s.shot(0), opts());
    assert_eq!(st.push(&s.shot(150)), Ok(150));
    assert!(matches!(
        st.push(&s.shot(60)),
        Err(StitchError::NoAlignment { .. })
    ));
}

#[test]
fn max_height_is_respected() {
    let s = Scene::new(320, 2400, 300, 36, 24, BarKind::Textured);
    let max = 700u32;
    let o = StitchOptions {
        max_height: max,
        ..opts()
    };
    let mut st = Stitcher::new(s.shot(0), o);
    let mut y = 0usize;
    let mut total = 300u32;
    let mut zeros = 0;
    for _ in 0..12 {
        y += 150;
        match st.push(&s.shot(y)) {
            Ok(0) => zeros += 1,
            Ok(n) => total += n,
            Err(e) => panic!("unexpected error {e}"),
        }
    }
    assert!(st.is_full());
    assert!(zeros >= 1, "pushes after the cap report no new rows");
    assert_eq!(total, max);
    assert_eq!(st.height(), max);
    let out = st.finish();
    assert_eq!(out.height, max);
    assert_eq!(out.rgba.len(), 320 * max as usize * 4);
    // Everything above the footer is an exact prefix of the ground truth, then the footer.
    let ground = s.expected(s.max_y());
    let stride = 320 * 4;
    let ft = 24;
    let body = (max as usize - ft) * stride;
    assert_eq!(&out.rgba[..body], &ground.rgba[..body]);
    let footer = s.footer.as_ref().expect("scene has a footer");
    assert_eq!(&out.rgba[body..], &footer.rgba[..]);
}

#[test]
fn first_frame_taller_than_max_height_is_cropped() {
    let s = Scene::new(320, 1200, 300, 0, 0, BarKind::Textured);
    let o = StitchOptions {
        max_height: 100,
        ..opts()
    };
    let mut st = Stitcher::new(s.shot(0), o);
    assert!(st.is_full());
    assert_eq!(st.push(&s.shot(50)), Ok(0));
    let out = st.finish();
    assert_eq!(out.height, 100);
    assert_eq!(&out.rgba[..], &s.shot(0).rgba[..320 * 100 * 4]);
}

#[test]
fn invalid_input_is_reported_not_panicked() {
    let s = Scene::new(320, 1200, 300, 36, 24, BarKind::Textured);

    // Inconsistent first frame.
    let bad = Frame {
        width: 320,
        height: 300,
        rgba: vec![0; 10],
    };
    assert!(matches!(
        Stitcher::try_new(bad.clone(), opts()),
        Err(StitchError::InvalidFrame(FrameError::BadLength { .. }))
    ));
    let mut dead = Stitcher::new(bad, opts());
    assert!(matches!(
        dead.push(&s.shot(0)),
        Err(StitchError::InvalidFrame(_))
    ));
    let empty = dead.finish();
    assert_eq!((empty.width, empty.height, empty.rgba.len()), (0, 0, 0));

    let mut st = Stitcher::new(s.shot(0), opts());
    // Different size.
    let small = Frame {
        width: 160,
        height: 300,
        rgba: vec![0; 160 * 300 * 4],
    };
    assert_eq!(
        st.push(&small),
        Err(StitchError::SizeMismatch {
            expected: (320, 300),
            actual: (160, 300)
        })
    );
    // Right dimensions, wrong buffer.
    let mut wrong_len = s.shot(100);
    wrong_len.rgba.pop();
    assert!(matches!(
        st.push(&wrong_len),
        Err(StitchError::InvalidFrame(FrameError::BadLength { .. }))
    ));
    // Zero-sized.
    let zero = Frame {
        width: 0,
        height: 0,
        rgba: Vec::new(),
    };
    assert_eq!(
        st.push(&zero),
        Err(StitchError::InvalidFrame(FrameError::ZeroSize))
    );
    assert_eq!(st.height(), 300);

    // Frames too short to align.
    let tiny = Frame {
        width: 8,
        height: 8,
        rgba: vec![9; 8 * 8 * 4],
    };
    let mut tiny_st = Stitcher::new(tiny.clone(), opts());
    assert_eq!(tiny_st.push(&tiny), Err(StitchError::FrameTooSmall));
}

#[test]
fn per_pixel_noise_falls_back_to_correlation() {
    // Lossy capture: every pixel of every frame is perturbed independently, so no two rows have
    // identical hashes and alignment must come from the NCC scan.
    let s = Scene::new(320, 1400, 300, 0, 0, BarKind::Textured);
    let mut rng = Rng::new(5);
    let mut jitter = |f: &Frame| {
        let mut f = f.clone();
        for b in f.rgba.iter_mut() {
            let n = rng.below(5) as i32 - 2;
            *b = (i32::from(*b) + n).clamp(0, 255) as u8;
        }
        f
    };
    let mut st = Stitcher::new(jitter(&s.shot(0)), opts());
    let mut y = 0;
    for d in [110usize, 87, 140, 63, 120] {
        y += d;
        assert_eq!(st.push(&jitter(&s.shot(y))), Ok(d as u32), "delta {d}");
    }
    let out = st.finish();
    assert_eq!(out.height as usize, y + 300);
    let truth = s.expected(y);
    let worst = out
        .rgba
        .iter()
        .zip(&truth.rgba)
        .map(|(a, b)| (i32::from(*a) - i32::from(*b)).abs())
        .max()
        .unwrap_or(0);
    assert!(
        worst <= 4,
        "content must still be the right rows (max diff {worst})"
    );
}

#[test]
fn sparse_page_with_long_blank_stretches() {
    // Mostly background with one short text line every 140 rows: very little to match on.
    let w = 320usize;
    let h = 1700usize;
    let bg = [245u8, 243, 238];
    let mut rgba = Vec::with_capacity(w * h * 4);
    let mut rng = Rng::new(21);
    for y in 0..h {
        let in_line = (y % 140) < 14 && y > 60;
        for x in 0..w {
            let on = in_line && (20..120).contains(&x) && rng.below(100) < 50;
            let c = if on { [30u8, 30, 40] } else { bg };
            rgba.extend_from_slice(&[c[0], c[1], c[2], 255]);
        }
    }
    let doc = Frame {
        width: w as u32,
        height: h as u32,
        rgba,
    };
    let shot = |y: usize| viewport(&doc, y, 300, None, None);
    let mut st = Stitcher::new(shot(0), opts());
    let mut y = 0;
    for d in [
        100usize, 90, 110, 95, 120, 100, 85, 100, 105, 90, 100, 110, 100,
    ] {
        y += d;
        assert_eq!(st.push(&shot(y)), Ok(d as u32), "delta {d} at {y}");
    }
    let out = st.finish();
    let truth = expected(&doc, None, None, 300, y);
    assert_same(&out, &truth);
}

#[test]
fn changing_pixels_inside_the_header_need_the_ignore_hint() {
    // A "clock" in the header changes on every frame. Auto-detection sees only the rows above
    // it as fixed; the `ignore_top` hint marks the whole bar.
    let mut s = Scene::new(320, 1800, 300, 40, 24, BarKind::Textured);
    let header0 = s.header.clone().expect("has header");
    let with_clock = |tick: u8| {
        let mut hdr = header0.clone();
        for y in 12..16 {
            for x in 250..300 {
                let i = (y * 320 + x) * 4;
                hdr.rgba[i] = tick.wrapping_mul(37);
                hdr.rgba[i + 1] = tick.wrapping_mul(91);
                hdr.rgba[i + 2] = tick;
            }
        }
        hdr
    };
    s.header = Some(with_clock(0));
    let mut st = Stitcher::new(
        s.shot(0),
        StitchOptions {
            ignore_top: 40,
            ..opts()
        },
    );
    let mut y = 0;
    for (tick, d) in [120usize, 80, 150, 60, 170, 100].into_iter().enumerate() {
        y += d;
        s.header = Some(with_clock(tick as u8 + 1));
        assert_eq!(st.push(&s.shot(y)), Ok(d as u32), "delta {d}");
    }
    assert!(st.detect_sticky().0 >= 40);
    let out = st.finish();
    // The stitched image keeps the first frame's header (clock tick 0).
    s.header = Some(with_clock(0));
    assert_same(&out, &s.expected(y));
}

#[test]
fn step_larger_than_the_allowed_overlap_is_rejected() {
    // Body = 300 - 36 - 24 = 240 rows; the default minimum overlap is 48, so 192 is the maximum.
    let s = Scene::new(320, 1200, 300, 36, 24, BarKind::Textured);
    let mut st = Stitcher::new(s.shot(0), opts());
    assert!(matches!(
        st.push(&s.shot(230)),
        Err(StitchError::NoAlignment { .. })
    ));
    assert_eq!(st.push(&s.shot(192)), Ok(192));
    // A lower minimum overlap allows the bigger jump.
    let mut st = Stitcher::new(
        s.shot(0),
        StitchOptions {
            min_overlap: 16,
            ..opts()
        },
    );
    assert_eq!(st.push(&s.shot(215)), Ok(215));
}

#[test]
fn randomized_scenes_reconstruct_exactly() {
    // Many random pages, bar sizes, widths and scroll patterns. Every result must be a
    // pixel-exact reconstruction of the ground truth.
    for seed in 1..=40u64 {
        let mut rng = Rng::new(seed * 7919);
        let width = 200 + rng.below(220) as usize;
        let vh = 240 + rng.below(160) as usize;
        let ht = [0usize, 0, 24, 40, 64][rng.below(5) as usize];
        let ft = [0usize, 0, 20, 36, 56][rng.below(5) as usize];
        let kind = if rng.below(2) == 0 {
            BarKind::Textured
        } else {
            BarKind::Uniform
        };
        let doc_h = vh * 4 + rng.below(600) as usize;
        let mut s = Scene::new(width, doc_h, vh, ht, ft, kind);
        s.doc = document(width, doc_h, seed);

        let body = vh - ht - ft;
        let dmax = body - 48;
        let mut st = Stitcher::new(s.shot(0), opts());
        let mut y = 0usize;
        while y < s.max_y() {
            let d = 1 + rng.below(dmax as u32) as usize;
            let ny = (y + d).min(s.max_y());
            let got = st.push(&s.shot(ny));
            assert_eq!(
                got,
                Ok((ny - y) as u32),
                "seed {seed} ({width}x{vh}, header {ht}, footer {ft}, {kind:?}): {y} -> {ny}"
            );
            y = ny;
        }
        assert_eq!(st.push(&s.shot(y)), Ok(0), "seed {seed}: bottom reached");
        let out = st.finish();
        let truth = s.expected(y);
        assert_eq!(
            (out.width, out.height),
            (truth.width, truth.height),
            "seed {seed}"
        );
        assert!(out.rgba == truth.rgba, "seed {seed}: pixels differ");
    }
}

#[test]
fn alpha_channel_is_ignored() {
    // Capture backends often leave alpha as garbage (or zero) after a BGRA to RGBA swizzle.
    let s = Scene::new(320, 1200, 300, 36, 24, BarKind::Textured);
    let with_alpha = |mut f: Frame, a: u8| {
        for px in f.rgba.chunks_exact_mut(4) {
            px[3] = a;
        }
        f
    };
    let mut st = Stitcher::new(with_alpha(s.shot(0), 0), opts());
    assert_eq!(st.push(&with_alpha(s.shot(120), 7)), Ok(120));
    assert_eq!(st.push(&with_alpha(s.shot(250), 255)), Ok(130));
    assert_eq!(st.push(&with_alpha(s.shot(250), 3)), Ok(0));
    let out = st.finish();
    let truth = s.expected(250);
    assert_eq!((out.width, out.height), (truth.width, truth.height));
    assert!(out
        .rgba
        .chunks_exact(4)
        .zip(truth.rgba.chunks_exact(4))
        .all(|(a, b)| a[..3] == b[..3]));
}
