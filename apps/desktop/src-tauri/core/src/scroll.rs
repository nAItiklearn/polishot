//! Scrolling capture: drives a [`ScrollSource`] (wheel input + screen grabs) and feeds the frames
//! to `polishot_media::Stitcher`. The stop and retry rules follow the media crate's integration
//! notes; everything platform-specific sits behind the trait so the loop is unit-tested with a
//! synthetic page.

use std::time::{Duration, Instant};

use polishot_media::{frames_differ, Frame as MediaFrame, StitchOptions, Stitcher};

use crate::geometry::IRect;
use crate::store::Frame;

/// One mouse-wheel notch, in `WHEEL_DELTA` units.
pub const NOTCH: i32 = 120;

/// Convert a grabbed BGRX frame to the RGBA frame the media crate expects. (Skipping this swaps
/// red and blue in the result.)
pub fn media_frame(frame: &Frame) -> MediaFrame {
    let full = IRect::new(0, 0, frame.width as i32, frame.height as i32);
    MediaFrame {
        width: frame.width,
        height: frame.height,
        rgba: crate::geometry::crop_to_rgba(frame.pixels(), frame.width, full, true, true),
    }
}

/// Everything the loop needs from the outside world.
pub trait ScrollSource {
    /// Grab the scrollable pane as RGBA.
    fn grab(&mut self) -> Result<MediaFrame, String>;
    /// Scroll by `notches` wheel notches: positive moves the content down (towards the end of the
    /// page), negative scrolls back up.
    fn scroll(&mut self, notches: i32) -> Result<(), String>;
    fn sleep(&mut self, ms: u64);
    /// True once the user pressed Esc or asked to stop.
    fn aborted(&mut self) -> bool;
}

#[derive(Debug, Clone, Copy)]
pub struct ScrollConfig {
    /// Cap on the stitched height in rows.
    pub max_height: u32,
    /// Wall-clock limit for the whole capture.
    pub max_duration: Duration,
    /// Wait after each wheel event before the first grab.
    pub settle_ms: u64,
    /// Gap between the re-grabs that detect a finished scroll animation.
    pub settle_poll_ms: u64,
    /// Re-grabs while the animation is still moving (the last grab is used after this many).
    pub max_settle_grabs: u32,
    /// Hints for animated headers and footers the automatic detection might miss.
    pub ignore_top: u32,
    pub ignore_bottom: u32,
    /// Safety net on the number of wheel steps.
    pub max_steps: u32,
}

/// The stitched image stays under 256 MB of RGBA (64 megapixels): the result is held in memory,
/// copied for the PNG encode and handed to the editor, so a taller capture would cost more than
/// the machine can spare for little gain.
pub const SCROLL_MAX_PIXELS: u64 = 64_000_000;

/// Tallest stitched image for a pane of `width` pixels that the rest of the app can still open:
/// the result is registered like any capture, saved as PNG, reloaded from history and sent to the
/// editor, and all of those refuse images beyond the decoder's per-side and pixel limits
/// (`imgio::MAX_DIMENSION`, `imgio::MAX_PIXELS`). The media crate's own default (20 000 rows)
/// would produce a capture that cannot be reopened from history.
pub fn max_height_for_width(width: u32) -> u32 {
    let by_pixels = SCROLL_MAX_PIXELS.min(crate::imgio::MAX_PIXELS) / u64::from(width.max(1));
    by_pixels.min(u64::from(crate::imgio::MAX_DIMENSION)) as u32
}

impl ScrollConfig {
    /// Defaults for a pane `width` pixels wide.
    pub fn for_pane_width(width: u32) -> Self {
        Self {
            max_height: max_height_for_width(width),
            ..Self::default()
        }
    }
}

impl Default for ScrollConfig {
    fn default() -> Self {
        Self {
            max_height: crate::imgio::MAX_DIMENSION,
            max_duration: Duration::from_secs(90),
            settle_ms: 120,
            settle_poll_ms: 40,
            max_settle_grabs: 8,
            ignore_top: 0,
            ignore_bottom: 0,
            max_steps: 400,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StopReason {
    /// Nothing moved twice in a row: the end of the page.
    Bottom,
    /// The stitched image reached `max_height`.
    Full,
    Aborted,
    TimeLimit,
    StepLimit,
    /// A frame could not be aligned, twice in a row.
    StitchFailed,
}

pub struct ScrollOutcome {
    pub frame: MediaFrame,
    pub steps: u32,
    pub reason: StopReason,
}

/// Notches per step so one step moves the content by about half the pane body:
/// `floor(0.5 * body_height / rows_per_notch)`, at least one notch.
pub fn notches_per_step(body_height: u32, rows_per_notch: u32) -> i32 {
    if rows_per_notch == 0 {
        return 1;
    }
    let n = (0.5 * f64::from(body_height) / f64::from(rows_per_notch)).floor();
    (n as i32).max(1)
}

/// Wait for the wheel animation to finish, then grab until two consecutive grabs are identical.
fn settled_grab<S: ScrollSource>(src: &mut S, cfg: &ScrollConfig) -> Result<MediaFrame, String> {
    src.sleep(cfg.settle_ms);
    let mut prev = src.grab()?;
    for _ in 0..cfg.max_settle_grabs {
        src.sleep(cfg.settle_poll_ms);
        let cur = src.grab()?;
        if !frames_differ(&prev, &cur, 0.0) {
            return Ok(cur);
        }
        prev = cur;
    }
    Ok(prev)
}

fn finish(stitcher: Stitcher, steps: u32, reason: StopReason) -> ScrollOutcome {
    ScrollOutcome {
        frame: stitcher.finish(),
        steps,
        reason,
    }
}

/// Run a scrolling capture to completion.
pub fn run<S: ScrollSource>(src: &mut S, cfg: &ScrollConfig) -> Result<ScrollOutcome, String> {
    let started = Instant::now();
    let first = src.grab()?;
    let pane_h = first.height;
    let mut st = Stitcher::try_new(
        first,
        StitchOptions {
            max_height: cfg.max_height,
            ignore_top: cfg.ignore_top,
            ignore_bottom: cfg.ignore_bottom,
            ..StitchOptions::default()
        },
    )
    .map_err(|e| format!("The window could not be captured: {e}"))?;
    let mut steps = 0u32;

    // Calibration: one notch tells us how far this app scrolls per notch.
    let mut rows_per_notch = 0u32;
    for notches in [1i32, 3] {
        if src.aborted() {
            return Ok(finish(st, steps, StopReason::Aborted));
        }
        src.scroll(notches)?;
        let f = settled_grab(src, cfg)?;
        steps += 1;
        match st.push(&f) {
            Ok(0) => continue, // nothing moved: try a bigger nudge once
            Ok(rows) => {
                rows_per_notch = (rows / notches as u32).max(1);
                break;
            }
            Err(_) => {
                // Could not even align one notch: put the page back and keep what we have.
                src.scroll(-notches)?;
                return Ok(finish(st, steps, StopReason::StitchFailed));
            }
        }
    }
    if rows_per_notch == 0 {
        // The pane does not scroll, or it is already at the bottom.
        return Ok(finish(st, steps, StopReason::Bottom));
    }

    let (top, bottom) = st.detect_sticky();
    let base_step = notches_per_step(pane_h.saturating_sub(top + bottom), rows_per_notch);
    let max_step = base_step.saturating_mul(4);
    let mut step = base_step;
    let (mut zero_streak, mut err_streak) = (0u32, 0u32);

    let reason = loop {
        if src.aborted() {
            break StopReason::Aborted;
        }
        if started.elapsed() >= cfg.max_duration {
            break StopReason::TimeLimit;
        }
        if st.is_full() {
            break StopReason::Full;
        }
        if steps >= cfg.max_steps {
            break StopReason::StepLimit;
        }
        src.scroll(step)?;
        let f = settled_grab(src, cfg)?;
        steps += 1;
        match st.push(&f) {
            Ok(0) => {
                if st.is_full() {
                    break StopReason::Full;
                }
                zero_streak += 1;
                err_streak = 0;
                if zero_streak >= 2 {
                    break StopReason::Bottom;
                }
                // A featureless stretch looks like "nothing moved": try once with a bigger step.
                step = step.saturating_mul(2).min(max_step);
            }
            Ok(_) => {
                zero_streak = 0;
                err_streak = 0;
                step = base_step;
            }
            Err(_) => {
                err_streak += 1;
                if err_streak >= 2 {
                    break StopReason::StitchFailed;
                }
                // The frame was not used. Go back to the last good position and retry at half
                // the step.
                src.scroll(-step)?;
                src.sleep(cfg.settle_ms);
                step = (step / 2).max(1);
            }
        }
    };
    Ok(finish(st, steps, reason))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(x: u32, y: u32) -> [u8; 4] {
        let mut h = x
            .wrapping_mul(0x9E37_79B1)
            .wrapping_add(y.wrapping_mul(0x85EB_CA6B))
            .wrapping_add(0x27D4_EB2F);
        h ^= h >> 15;
        h = h.wrapping_mul(0x2C1B_3C6D);
        h ^= h >> 12;
        h = h.wrapping_mul(0x297A_2D39);
        h ^= h >> 15;
        [h as u8, (h >> 8) as u8, (h >> 16) as u8, 255]
    }

    fn texture(w: u32, h: u32, seed: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity((w * h * 4) as usize);
        for y in 0..h {
            for x in 0..w {
                v.extend_from_slice(&noise(x + seed * 1000, y + seed * 77));
            }
        }
        v
    }

    /// A page of `page_h` rows shown through a `view_h`-row window with an optional fixed header.
    struct FakePage {
        w: u32,
        page: Vec<u8>,
        page_h: u32,
        view_h: u32,
        header: Vec<u8>,
        header_h: u32,
        notch_px: i64,
        pos: i64,
        anim_from: i64,
        anim_steps_left: u32,
        smooth_frames: u32,
        scrolls: usize,
        corrupt_from_scroll: Option<usize>,
        corrupt_only_scroll: Option<usize>,
        abort_after_scrolls: Option<usize>,
        grabs: usize,
        sleeps: u64,
    }

    impl FakePage {
        fn new(w: u32, page_h: u32, view_h: u32, header_h: u32, notch_px: i64) -> Self {
            Self {
                w,
                page: texture(w, page_h, 1),
                page_h,
                view_h,
                header: texture(w, header_h.max(1), 2),
                header_h,
                notch_px,
                pos: 0,
                anim_from: 0,
                anim_steps_left: 0,
                smooth_frames: 0,
                scrolls: 0,
                corrupt_from_scroll: None,
                corrupt_only_scroll: None,
                abort_after_scrolls: None,
                grabs: 0,
                sleeps: 0,
            }
        }

        fn body_h(&self) -> i64 {
            i64::from(self.view_h - self.header_h)
        }

        fn max_pos(&self) -> i64 {
            (i64::from(self.page_h) - self.body_h()).max(0)
        }

        fn shown_pos(&self) -> i64 {
            if self.anim_steps_left == 0 {
                self.pos
            } else {
                let total = i64::from(self.smooth_frames) + 1;
                let done = total - i64::from(self.anim_steps_left);
                self.anim_from + (self.pos - self.anim_from) * done / total
            }
        }

        /// What the page looks like when fully scrolled everywhere: header + all page rows.
        fn expected(&self) -> Vec<u8> {
            let mut v = self.header[..(self.header_h * self.w * 4) as usize].to_vec();
            v.extend_from_slice(&self.page);
            v
        }
    }

    impl ScrollSource for FakePage {
        fn grab(&mut self) -> Result<MediaFrame, String> {
            self.grabs += 1;
            let pos = self.shown_pos();
            self.anim_steps_left = self.anim_steps_left.saturating_sub(1);
            let row = (self.w * 4) as usize;
            let mut rgba = Vec::with_capacity(row * self.view_h as usize);
            rgba.extend_from_slice(&self.header[..self.header_h as usize * row]);
            let first = pos as usize * row;
            let rows = self.body_h() as usize;
            rgba.extend_from_slice(&self.page[first..first + rows * row]);
            let corrupt = self.corrupt_from_scroll.is_some_and(|n| self.scrolls >= n)
                || self.corrupt_only_scroll == Some(self.scrolls);
            if corrupt {
                for b in rgba.iter_mut() {
                    *b = 255 - *b;
                }
            }
            Ok(MediaFrame {
                width: self.w,
                height: self.view_h,
                rgba,
            })
        }

        fn scroll(&mut self, notches: i32) -> Result<(), String> {
            self.scrolls += 1;
            self.anim_from = self.pos;
            self.pos = (self.pos + i64::from(notches) * self.notch_px).clamp(0, self.max_pos());
            self.anim_steps_left = if self.pos == self.anim_from {
                0
            } else {
                self.smooth_frames + 1
            };
            Ok(())
        }

        fn sleep(&mut self, ms: u64) {
            self.sleeps += ms;
        }

        fn aborted(&mut self) -> bool {
            self.abort_after_scrolls.is_some_and(|n| self.scrolls >= n)
        }
    }

    fn cfg() -> ScrollConfig {
        ScrollConfig::default()
    }

    #[test]
    fn the_stitched_height_cap_always_leaves_a_reopenable_image() {
        use crate::imgio::{MAX_DIMENSION, MAX_PIXELS};
        for width in [1u32, 64, 800, 1280, 1920, 2560, 3840, 7680, 16_384] {
            let cap = max_height_for_width(width);
            assert!(cap >= 1, "width {width}");
            assert!(cap <= MAX_DIMENSION, "width {width}: {cap} rows");
            assert!(
                u64::from(width) * u64::from(cap) <= MAX_PIXELS,
                "width {width}: {cap} rows"
            );
            assert_eq!(ScrollConfig::for_pane_width(width).max_height, cap);
        }
        // Typical panes get the full side limit; very wide ones are limited by pixel count.
        assert_eq!(max_height_for_width(1920), MAX_DIMENSION);
        assert_eq!(max_height_for_width(3840), MAX_DIMENSION);
        assert_eq!(max_height_for_width(16_384), 3_906);
        assert_eq!(max_height_for_width(7_680), 8_333);
        // 256 MB of RGBA at most, whatever the width.
        for width in [1u32, 800, 1920, 2560, 3840, 7680, 16_384] {
            let bytes = u64::from(width) * u64::from(max_height_for_width(width)) * 4;
            assert!(bytes <= 256 * 1024 * 1024, "width {width}: {bytes} bytes");
        }
        assert_eq!(ScrollConfig::default().max_height, MAX_DIMENSION);
    }

    #[test]
    fn notch_step_formula() {
        assert_eq!(notches_per_step(800, 100), 4);
        assert_eq!(notches_per_step(800, 120), 3); // floor(3.33)
        assert_eq!(notches_per_step(100, 400), 1); // never below one notch
        assert_eq!(notches_per_step(0, 10), 1);
        assert_eq!(notches_per_step(500, 0), 1);
    }

    #[test]
    fn stitches_a_whole_page_exactly() {
        let mut page = FakePage::new(48, 1200, 200, 0, 20);
        let out = run(&mut page, &cfg()).unwrap();
        assert_eq!(out.reason, StopReason::Bottom);
        assert_eq!(out.frame.width, 48);
        assert_eq!(out.frame.height, 1200);
        assert!(out.frame.rgba == page.expected(), "stitched pixels differ");
        // Calibration (1 notch) then 5-notch steps with half-pane overlap, plus the two empty ones.
        assert!(out.steps < 20, "steps {}", out.steps);
        assert!(page.sleeps > 0);
    }

    #[test]
    fn smooth_scrolling_is_waited_out() {
        let mut page = FakePage::new(48, 900, 200, 0, 25);
        page.smooth_frames = 3;
        let out = run(&mut page, &cfg()).unwrap();
        assert_eq!(out.reason, StopReason::Bottom);
        assert!(out.frame.rgba == page.expected());
    }

    #[test]
    fn a_fixed_header_appears_once() {
        let mut page = FakePage::new(48, 1000, 200, 24, 16);
        let out = run(&mut page, &cfg()).unwrap();
        assert_eq!(out.reason, StopReason::Bottom);
        assert_eq!(out.frame.height, 24 + 1000);
        assert!(
            out.frame.rgba == page.expected(),
            "header duplicated or rows lost"
        );
    }

    #[test]
    fn a_pane_that_does_not_scroll_returns_the_single_frame() {
        let mut page = FakePage::new(48, 200, 200, 0, 20); // page fits: max_pos = 0
        let out = run(&mut page, &cfg()).unwrap();
        assert_eq!(out.reason, StopReason::Bottom);
        assert_eq!(out.frame.height, 200);
        assert_eq!(out.steps, 2, "one notch, then the bigger nudge");
    }

    #[test]
    fn esc_stops_with_what_was_captured() {
        let mut page = FakePage::new(48, 2000, 200, 0, 20);
        page.abort_after_scrolls = Some(5);
        let out = run(&mut page, &cfg()).unwrap();
        assert_eq!(out.reason, StopReason::Aborted);
        assert!(out.frame.height > 200 && out.frame.height < 2000);
    }

    #[test]
    fn the_wall_clock_limit_stops_the_loop() {
        let mut page = FakePage::new(48, 2000, 200, 0, 20);
        let out = run(
            &mut page,
            &ScrollConfig {
                max_duration: Duration::ZERO,
                ..cfg()
            },
        )
        .unwrap();
        assert_eq!(out.reason, StopReason::TimeLimit);
    }

    #[test]
    fn the_height_cap_stops_with_full() {
        let mut page = FakePage::new(48, 4000, 200, 0, 20);
        let out = run(
            &mut page,
            &ScrollConfig {
                max_height: 600,
                ..cfg()
            },
        )
        .unwrap();
        assert_eq!(out.reason, StopReason::Full);
        assert_eq!(out.frame.height, 600);
    }

    #[test]
    fn the_step_limit_is_a_safety_net() {
        let mut page = FakePage::new(48, 4000, 200, 0, 20);
        let out = run(
            &mut page,
            &ScrollConfig {
                max_steps: 4,
                ..cfg()
            },
        )
        .unwrap();
        assert_eq!(out.reason, StopReason::StepLimit);
        assert_eq!(out.steps, 4);
    }

    #[test]
    fn one_bad_frame_is_retried_at_half_the_step() {
        let mut page = FakePage::new(48, 1200, 200, 0, 20);
        // The 4th wheel event produces an unalignable (inverted) frame; later scrolls are fine.
        page.corrupt_only_scroll = Some(4);
        let out = run(&mut page, &cfg()).unwrap();
        assert_eq!(out.reason, StopReason::Bottom);
        assert!(
            out.frame.rgba == page.expected(),
            "retry lost or duplicated rows"
        );
    }

    #[test]
    fn two_bad_frames_in_a_row_finish_with_a_partial_image() {
        let mut page = FakePage::new(48, 2000, 200, 0, 20);
        page.corrupt_from_scroll = Some(4);
        let out = run(&mut page, &cfg()).unwrap();
        assert_eq!(out.reason, StopReason::StitchFailed);
        assert!(out.frame.height > 200 && out.frame.height < 2000);
    }

    #[test]
    fn rgba_conversion_from_the_bgrx_capture_format() {
        let f = Frame::from_bgra(2, 1, &[1, 2, 3, 0, 10, 20, 30, 0]).unwrap();
        let m = media_frame(&f);
        assert_eq!((m.width, m.height), (2, 1));
        assert_eq!(m.rgba, vec![3, 2, 1, 255, 30, 20, 10, 255]);
    }
}
