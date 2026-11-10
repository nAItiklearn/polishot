//! Scrolling-capture stitching: align consecutive viewport frames and append only the new rows.
//!
//! # How a frame is aligned
//!
//! Every frame is reduced to two cheap signatures (see [`FrameInfo`]):
//!
//! * a 64-bit hash per row, computed from a (possibly strided) sample of the row's RGB pixels, and
//! * a small luma grid (about 160 columns) used for normalised cross-correlation (NCC).
//!
//! With the previous frame `P` and the new frame `N`:
//!
//! 1. **Sticky detection.** Rows whose hash is identical at the same screen position in `P` and
//!    `N` form the fixed header (leading run) and footer (trailing run). Runs of blank rows that
//!    merely continue the page background right after a header are trimmed off, and the regions
//!    are excluded from matching.
//! 2. **Candidate offsets.** Every row hash of `N`'s body is looked up in `P`'s body. A match of
//!    `N[y]` with `P[p]` is a vote for a scroll of `d = p - y` rows; rows that occur many times
//!    (blank rows, repeated rules) are skipped and the rest are weighted by rarity. The best few
//!    offsets are candidates. If the exact hashes agree nowhere (noisy or blended pixels) a coarse
//!    NCC scan over all offsets on a handful of high-contrast probe rows supplies the candidates.
//! 3. **Verification and refinement.** Each candidate (and "no movement", `d = 0`) is scored by
//!    NCC over the whole overlap on the luma grid, and the winner is refined within +-2 rows. A
//!    score below [`MIN_SCORE`] is rejected so the caller can fall back.
//! 4. **Append.** The old footer is dropped from the accumulated image, the `d` newly revealed rows
//!    of `N` are appended, and `N`'s footer is appended once more. The tail of the accumulated
//!    image is therefore always "the previous screen", which is what the next push aligns against.

use crate::frame::{Frame, FrameError};
use std::fmt;

/// Minimum NCC for an alignment (or a "no movement" verdict) to be accepted.
pub const MIN_SCORE: f64 = 0.90;

/// A candidate this good is taken without examining weaker ones or refining.
const PERFECT_SCORE: f64 = 0.999;

/// Rows in a hash bucket above which the bucket is considered uninformative.
const VOTE_CAP: usize = 8;
/// Weighted votes an offset needs to become a candidate.
const MIN_VOTE: f32 = 1.5;
/// Candidates taken from the hash votes.
const TOP_VOTES: usize = 6;
/// Candidates taken from the coarse NCC scan.
const TOP_SCAN: usize = 4;
/// Probe rows used by the coarse scan.
const PROBE_ROWS: usize = 32;
/// Offsets around the best candidate that are re-scored during refinement.
const REFINE_RADIUS: usize = 2;
/// Frames shorter than this cannot be stitched.
const MIN_FRAME_ROWS: usize = 24;
/// A matching body (frame minus sticky regions) must have at least this many rows.
const MIN_BODY_ROWS: usize = 16;
/// Absolute floor for the required overlap, whatever `min_overlap` says.
const MIN_OVERLAP_FLOOR: usize = 8;
/// Target number of luma-grid columns.
const TARGET_CELLS: usize = 160;
/// Row hashes sample at most this many pixels per row.
const HASH_SAMPLES: usize = 1024;
/// Fraction of rows that must have changed before "no movement" is double-checked with a scan.
const MOVING_FRACTION: f64 = 0.10;

/// Tuning knobs for [`Stitcher`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StitchOptions {
    /// Hard cap on the stitched height in rows. Once reached, pushes return `Ok(0)`.
    pub max_height: u32,
    /// Minimum number of rows two consecutive frames must overlap (outside the sticky regions).
    /// Clamped to at least 8 and at most half of the matchable body height.
    pub min_overlap: u32,
    /// Rows at the top that are always treated as a fixed header (in addition to auto-detection).
    pub ignore_top: u32,
    /// Rows at the bottom that are always treated as a fixed footer (in addition to
    /// auto-detection).
    pub ignore_bottom: u32,
}

impl Default for StitchOptions {
    fn default() -> Self {
        StitchOptions {
            max_height: 20_000,
            min_overlap: 48,
            ignore_top: 0,
            ignore_bottom: 0,
        }
    }
}

/// Why [`Stitcher::push`] could not use a frame.
#[derive(Debug, Clone, PartialEq)]
pub enum StitchError {
    /// The frame's buffer does not match its dimensions (or is empty).
    InvalidFrame(FrameError),
    /// The frame is not the same size as the first frame.
    SizeMismatch {
        expected: (u32, u32),
        actual: (u32, u32),
    },
    /// The frames are too short (under 24 rows) to align.
    FrameTooSmall,
    /// No vertical offset matched well enough. `best_score` is the best NCC seen (-1 to 1).
    /// Typical causes: the page jumped further than the overlap, the content changed completely,
    /// the user scrolled back up, or the viewport contains fixed columns that do not scroll.
    NoAlignment { best_score: f32 },
}

impl fmt::Display for StitchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StitchError::InvalidFrame(e) => write!(f, "invalid frame: {e}"),
            StitchError::SizeMismatch { expected, actual } => write!(
                f,
                "frame is {}x{} but the capture started at {}x{}",
                actual.0, actual.1, expected.0, expected.1
            ),
            StitchError::FrameTooSmall => write!(f, "frame is too small to stitch"),
            StitchError::NoAlignment { best_score } => {
                write!(
                    f,
                    "frames could not be aligned (best score {best_score:.2})"
                )
            }
        }
    }
}

impl std::error::Error for StitchError {}

impl From<FrameError> for StitchError {
    fn from(e: FrameError) -> Self {
        StitchError::InvalidFrame(e)
    }
}

/// Incrementally builds one tall image from viewport frames captured while scrolling downwards.
///
/// ```
/// use polishot_media::{Frame, StitchOptions, Stitcher};
///
/// let first = Frame { width: 64, height: 64, rgba: vec![255; 64 * 64 * 4] };
/// let mut stitcher = Stitcher::new(first.clone(), StitchOptions::default());
/// // Identical frame: nothing moved, so the caller should stop scrolling.
/// assert_eq!(stitcher.push(&first), Ok(0));
/// let tall = stitcher.finish();
/// assert_eq!((tall.width, tall.height), (64, 64));
/// ```
pub struct Stitcher {
    opts: StitchOptions,
    /// Set when the first frame was invalid; every push then reports it.
    invalid: Option<FrameError>,
    geo: Geometry,
    /// The accumulated image as consecutive row groups (appending never copies earlier rows, so
    /// a push costs the same however tall the image has grown). The last rows always equal the
    /// bottom of the previous screen.
    segments: Vec<Vec<u8>>,
    rows: usize,
    prev: Option<FrameInfo>,
    sticky: (u32, u32),
    full: bool,
}

impl Stitcher {
    /// Starts a capture with `first` as the top of the image.
    ///
    /// This never fails: an invalid first frame (buffer length not matching its dimensions)
    /// produces a stitcher whose [`push`](Self::push) reports the problem and whose
    /// [`finish`](Self::finish) yields an empty 0x0 frame. Use [`try_new`](Self::try_new) to
    /// surface the error immediately. If the first frame is taller than `max_height` it is cropped
    /// to the top `max_height` rows.
    #[must_use]
    pub fn new(first: Frame, opts: StitchOptions) -> Self {
        match first.validate() {
            Ok(()) => Self::build(first, opts),
            Err(e) => Stitcher {
                opts,
                invalid: Some(e),
                geo: Geometry::new(0, 0),
                segments: Vec::new(),
                rows: 0,
                prev: None,
                sticky: (0, 0),
                full: true,
            },
        }
    }

    /// Like [`new`](Self::new) but returns the validation error instead of deferring it.
    pub fn try_new(first: Frame, opts: StitchOptions) -> Result<Self, StitchError> {
        first.validate()?;
        Ok(Self::build(first, opts))
    }

    fn build(first: Frame, opts: StitchOptions) -> Self {
        let w = first.width as usize;
        let h = first.height as usize;
        let geo = Geometry::new(w, h);
        let info = FrameInfo::build(&geo, &first.rgba);
        let max_rows = opts.max_height.max(1) as usize;
        let mut top = first.rgba;
        let mut rows = h;
        let mut full = false;
        if rows >= max_rows {
            top.truncate(max_rows * w * 4);
            rows = max_rows;
            full = true;
        }
        Stitcher {
            opts,
            invalid: None,
            geo,
            segments: vec![top],
            rows,
            prev: Some(info),
            sticky: (
                opts.ignore_top.min(first.height),
                opts.ignore_bottom.min(first.height),
            ),
            full,
        }
    }

    /// Feeds the next frame after a scroll.
    ///
    /// * `Ok(n)` with `n > 0`: `n` new rows were appended to the image.
    /// * `Ok(0)`: nothing moved (the page is at its bottom, or the capture hit `max_height`).
    ///   The caller should stop scrolling. The frame is not used.
    /// * `Err(_)`: the frame could not be aligned to the previous one. Nothing was changed, so the
    ///   caller may scroll by a smaller amount and push again, or finish with what it has.
    ///
    /// Frames must be the same size as the first one and only scroll downwards.
    pub fn push(&mut self, next: &Frame) -> Result<u32, StitchError> {
        if let Some(e) = self.invalid {
            return Err(StitchError::InvalidFrame(e));
        }
        next.validate()?;
        let (w, h) = (self.geo.w, self.geo.h);
        if next.width as usize != w || next.height as usize != h {
            return Err(StitchError::SizeMismatch {
                expected: (w as u32, h as u32),
                actual: (next.width, next.height),
            });
        }
        if h < MIN_FRAME_ROWS {
            return Err(StitchError::FrameTooSmall);
        }
        if self.full {
            return Ok(0);
        }
        let Some(prev) = self.prev.as_ref() else {
            return Ok(0);
        };

        let info = FrameInfo::build(&self.geo, &next.rgba);

        // Rows that did not change at all between the two screens.
        let lead = (0..h)
            .take_while(|&y| info.hashes[y] == prev.hashes[y])
            .count();
        if lead == h {
            return Ok(0); // identical frames: nothing moved
        }
        let trail = (0..h)
            .rev()
            .take_while(|&y| info.hashes[y] == prev.hashes[y])
            .count();
        let changed = (0..h).filter(|&y| info.hashes[y] != prev.hashes[y]).count();

        let hint_t = (self.opts.ignore_top as usize).min(h);
        let hint_b = (self.opts.ignore_bottom as usize).min(h - hint_t);
        let cap = h / 3;
        let auto_t = trim_leading(&info.hashes, lead).min(cap);
        let auto_b = trim_trailing(&info.hashes, h, trail).min(cap);
        let sticky_auto = (auto_t.max(hint_t), auto_b.max(hint_b));
        let sticky_hint = (hint_t, hint_b);

        let aligner = Aligner {
            geo: &self.geo,
            min_overlap: self.opts.min_overlap as usize,
            n: &info,
            p: prev,
        };
        let eval0 = aligner.eval_still();
        let moving = changed as f64 / h as f64;

        let mut best_seen = eval0.ncc;
        let mut chosen = None;
        for (t, b) in [sticky_auto, sticky_hint] {
            match aligner.attempt(t, b, eval0, moving) {
                Outcome::Accept(e) => {
                    chosen = Some((e, t, b));
                    break;
                }
                Outcome::Reject(score) => best_seen = best_seen.max(score),
            }
            if sticky_auto == sticky_hint {
                break;
            }
        }
        let Some((best, t, b)) = chosen else {
            return Err(StitchError::NoAlignment {
                best_score: best_seen as f32,
            });
        };
        if best.d == 0 {
            return Ok(0);
        }

        // Append: drop the old footer, add the `d` newly revealed rows, then the new footer.
        let stride = w * 4;
        let room = (self.opts.max_height.max(1) as usize).saturating_sub(self.rows);
        let add = best.d.min(room);
        self.pop_rows(b, stride);
        let body_end = (h - b) * stride;
        let src_start = (h - b - best.d) * stride;
        let mut segment = Vec::with_capacity((add + b) * stride);
        segment.extend_from_slice(&next.rgba[src_start..src_start + add * stride]);
        segment.extend_from_slice(&next.rgba[body_end..h * stride]);
        self.segments.push(segment);
        self.rows = self.rows - b + add + b;
        if add < best.d || self.rows >= self.opts.max_height.max(1) as usize {
            self.full = true;
        }
        self.prev = Some(info);
        self.sticky = (t as u32, b as u32);
        Ok(add as u32)
    }

    /// The fixed header and footer heights (top, bottom) used by the most recent successful
    /// alignment: the auto-detected rows identical at the same screen position in consecutive
    /// frames, never less than the `ignore_top` / `ignore_bottom` options. Before the first
    /// successful push it returns the option values.
    #[must_use]
    pub fn detect_sticky(&self) -> (u32, u32) {
        self.sticky
    }

    /// Current height of the stitched image in rows.
    #[must_use]
    pub fn height(&self) -> u32 {
        self.rows as u32
    }

    /// Width of the stitched image in pixels (the width of the first frame).
    #[must_use]
    pub fn width(&self) -> u32 {
        self.geo.w as u32
    }

    /// `true` once `max_height` has been reached; further pushes return `Ok(0)`.
    #[must_use]
    pub fn is_full(&self) -> bool {
        self.full
    }

    /// Consumes the stitcher and returns the stitched image: the first frame, every newly revealed
    /// row in order, and the footer once at the very end.
    #[must_use]
    pub fn finish(mut self) -> Frame {
        let rgba = if self.segments.len() == 1 {
            self.segments.pop().unwrap_or_default()
        } else {
            let mut out = Vec::with_capacity(self.rows * self.geo.w * 4);
            for segment in self.segments {
                out.extend_from_slice(&segment);
            }
            out
        };
        Frame {
            width: self.geo.w as u32,
            height: self.rows as u32,
            rgba,
        }
    }

    /// Removes the last `n` rows of the accumulated image (the previous screen's footer).
    fn pop_rows(&mut self, mut n: usize, stride: usize) {
        while n > 0 {
            let Some(last) = self.segments.last_mut() else {
                break;
            };
            let rows = last.len() / stride;
            if rows <= n {
                n -= rows;
                self.segments.pop();
            } else {
                last.truncate((rows - n) * stride);
                n = 0;
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------
// Frame signatures
// ---------------------------------------------------------------------------------------------

/// Sampling geometry derived from the frame size (fixed for a capture session).
#[derive(Debug, Clone, Copy)]
struct Geometry {
    w: usize,
    h: usize,
    /// Every `hash_step`-th pixel of a row feeds the row hash.
    hash_step: usize,
    /// Width in pixels of one luma-grid cell.
    cell_w: usize,
    /// Number of luma-grid columns.
    gw: usize,
}

impl Geometry {
    fn new(w: usize, h: usize) -> Self {
        let hash_step = w.div_ceil(HASH_SAMPLES).next_power_of_two();
        let cell_w = (w / TARGET_CELLS).max(1);
        let gw = if w == 0 { 0 } else { (w / cell_w).max(1) };
        Geometry {
            w,
            h,
            hash_step,
            cell_w,
            gw,
        }
    }
}

/// Per-frame signatures used by the aligner.
struct FrameInfo {
    hashes: Vec<u64>,
    /// Row sample is a single colour.
    uniform: Vec<bool>,
    /// Luma grid, `gw` columns per row.
    luma: Vec<u8>,
    /// Per-row sum of luma cells.
    rs: Vec<u32>,
    /// Per-row sum of squared luma cells.
    rss: Vec<u32>,
}

impl FrameInfo {
    fn build(geo: &Geometry, rgba: &[u8]) -> Self {
        let (w, h, gw) = (geo.w, geo.h, geo.gw);
        let stride = w * 4;
        let mut hashes = Vec::with_capacity(h);
        let mut uniform = Vec::with_capacity(h);
        let mut luma = vec![0u8; h * gw];
        let mut rs = Vec::with_capacity(h);
        let mut rss = Vec::with_capacity(h);
        for (row, lrow) in rgba
            .chunks_exact(stride)
            .zip(luma.chunks_exact_mut(gw))
            .take(h)
        {
            let (hash, uni) = hash_row(row, geo.hash_step);
            hashes.push(hash);
            uniform.push(uni);
            let (mut s, mut ss) = (0u32, 0u32);
            for (c, cell) in lrow.iter_mut().enumerate() {
                let v = cell_luma(row, c * geo.cell_w, geo.cell_w);
                *cell = v;
                s += u32::from(v);
                ss += u32::from(v) * u32::from(v);
            }
            rs.push(s);
            rss.push(ss);
        }
        FrameInfo {
            hashes,
            uniform,
            luma,
            rs,
            rss,
        }
    }
}

/// RGB of the pixel starting at byte offset `i` (alpha dropped).
#[inline(always)]
fn rgb_at(b: &[u8], i: usize) -> u32 {
    u32::from(b[i]) | (u32::from(b[i + 1]) << 8) | (u32::from(b[i + 2]) << 16)
}

/// 64-bit hash of a strided sample of a row's RGB values (alpha ignored), plus whether all
/// sampled pixels were identical. Four independent lanes keep the multiply chains parallel.
fn hash_row(row: &[u8], step: usize) -> (u64, bool) {
    const K: u64 = 0x9E37_79B9_7F4A_7C15;
    let stride = 4 * step;
    let first = rgb_at(row, 0);
    let mut lanes = [
        0x243F_6A88_85A3_08D3u64,
        0x1319_8A2E_0370_7344,
        0xA409_3822_299F_31D0,
        0x082E_FA98_EC4E_6C89,
    ];
    let mut diff = 0u32;
    let mut blocks = row.chunks_exact(stride * 4);
    for b in &mut blocks {
        for (l, lane) in lanes.iter_mut().enumerate() {
            let v = rgb_at(b, l * stride);
            diff |= v ^ first;
            *lane = (lane.rotate_left(23) ^ u64::from(v)).wrapping_mul(K);
        }
    }
    for (i, p) in blocks.remainder().chunks(stride).enumerate() {
        let v = rgb_at(p, 0);
        diff |= v ^ first;
        let lane = &mut lanes[i & 3];
        *lane = (lane.rotate_left(23) ^ u64::from(v)).wrapping_mul(K);
    }
    let mut h =
        lanes[0] ^ lanes[1].rotate_left(17) ^ lanes[2].rotate_left(31) ^ lanes[3].rotate_left(47);
    // Final avalanche so nearby inputs spread over the whole word.
    h ^= h >> 32;
    h = h.wrapping_mul(0xD6E8_FEB8_6659_FD93);
    h ^= h >> 29;
    (h, diff == 0)
}

/// Luma (`(r + 2g + b) / 4`) of the pixel at column `x`.
#[inline(always)]
fn luma_at(row: &[u8], x: usize) -> u32 {
    let i = x * 4;
    (u32::from(row[i]) + 2 * u32::from(row[i + 1]) + u32::from(row[i + 2])) >> 2
}

/// Luma of one grid cell: the mean of two sample pixels (one when the cell is a single pixel).
fn cell_luma(row: &[u8], x0: usize, cw: usize) -> u8 {
    if cw < 2 {
        luma_at(row, x0) as u8
    } else {
        ((luma_at(row, x0 + cw / 4) + luma_at(row, x0 + 3 * cw / 4) + 1) >> 1) as u8
    }
}

/// Shrinks a leading run of unchanged rows: when it ends in a run of identical rows that follows
/// an edge, that tail is page background continuing below the header, not part of the header.
fn trim_leading(hashes: &[u64], run: usize) -> usize {
    if run < 2 {
        return run;
    }
    let last = hashes[run - 1];
    let mut start = run - 1;
    while start > 0 && hashes[start - 1] == last {
        start -= 1;
    }
    if start > 0 && run - start >= 2 {
        start
    } else {
        run
    }
}

/// Mirror of [`trim_leading`] for the trailing run of unchanged rows (`run` rows at the bottom of
/// a frame `h` rows tall).
fn trim_trailing(hashes: &[u64], h: usize, run: usize) -> usize {
    if run < 2 {
        return run;
    }
    let start = h - run;
    let first = hashes[start];
    let mut end = start + 1;
    while end < h && hashes[end] == first {
        end += 1;
    }
    if end < h && end - start >= 2 {
        h - end
    } else {
        run
    }
}

// ---------------------------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------------------------

/// One scored candidate offset.
#[derive(Debug, Clone, Copy)]
struct Eval {
    /// Rows the content moved up between the previous frame and the new one (0 = no movement).
    d: usize,
    /// Normalised cross-correlation over the compared region (-1 when it has no contrast).
    ncc: f64,
    /// Rows with identical, non-uniform content at this offset.
    exact: usize,
}

enum Outcome {
    Accept(Eval),
    Reject(f64),
}

struct Aligner<'a> {
    geo: &'a Geometry,
    min_overlap: usize,
    /// The new frame.
    n: &'a FrameInfo,
    /// The previous frame.
    p: &'a FrameInfo,
}

impl Aligner<'_> {
    /// Verdict for "the page did not move", over the whole frame.
    fn eval_still(&self) -> Eval {
        Eval {
            d: 0,
            ncc: self.ncc_range(0, 0, self.geo.h),
            exact: self.exact_range(0, 0, self.geo.h),
        }
    }

    /// Overlap rows required for a body of `hb` rows.
    fn required_overlap(&self, hb: usize) -> usize {
        self.min_overlap
            .clamp(MIN_OVERLAP_FLOOR, (hb / 2).max(MIN_OVERLAP_FLOOR))
    }

    /// Scores every plausible offset for the given sticky regions and picks the winner.
    fn attempt(&self, t: usize, b: usize, still: Eval, moving: f64) -> Outcome {
        let h = self.geo.h;
        let mut evals = vec![still];
        let hb = h.saturating_sub(t + b);
        if hb >= MIN_BODY_ROWS {
            let dmax = hb.saturating_sub(self.required_overlap(hb));
            if dmax >= 1 {
                let mut tried = Vec::new();
                for d in self.vote_candidates(t, b, dmax) {
                    self.try_offset(d, t, b, &mut evals, &mut tried);
                    if evals
                        .last()
                        .is_some_and(|e| e.d == d && e.ncc >= PERFECT_SCORE)
                    {
                        break; // the strongest-voted offsets come first: nothing can beat this
                    }
                }
                self.refine(t, b, dmax, &mut evals, &mut tried);
                let need_scan = match select(&evals) {
                    Some(e) => e.ncc < MIN_SCORE || (e.d == 0 && moving > MOVING_FRACTION),
                    None => true,
                };
                if need_scan {
                    for d in self.scan_candidates(t, b, dmax) {
                        self.try_offset(d, t, b, &mut evals, &mut tried);
                    }
                    self.refine(t, b, dmax, &mut evals, &mut tried);
                }
            }
        }
        let best_ncc = evals.iter().map(|e| e.ncc).fold(-1.0, f64::max);
        match select(&evals) {
            Some(e) if e.ncc >= MIN_SCORE => Outcome::Accept(e),
            _ => Outcome::Reject(best_ncc),
        }
    }

    fn try_offset(
        &self,
        d: usize,
        t: usize,
        b: usize,
        evals: &mut Vec<Eval>,
        tried: &mut Vec<usize>,
    ) {
        if d == 0 || tried.contains(&d) {
            return;
        }
        tried.push(d);
        if let Some(e) = self.evaluate(d, t, b) {
            evals.push(e);
        }
    }

    /// Re-scores the offsets next to the best non-zero candidate.
    fn refine(
        &self,
        t: usize,
        b: usize,
        dmax: usize,
        evals: &mut Vec<Eval>,
        tried: &mut Vec<usize>,
    ) {
        let best = evals
            .iter()
            .filter(|e| e.d > 0)
            .max_by(|a, b| a.ncc.total_cmp(&b.ncc))
            .map(|e| (e.d, e.ncc));
        let Some((center, ncc)) = best else {
            return;
        };
        if ncc >= PERFECT_SCORE {
            return;
        }
        let lo = center.saturating_sub(REFINE_RADIUS).max(1);
        let hi = (center + REFINE_RADIUS).min(dmax);
        for d in lo..=hi {
            self.try_offset(d, t, b, evals, tried);
        }
    }

    /// Scores offset `d >= 1` over the matchable body; `None` if the overlap would be too short.
    fn evaluate(&self, d: usize, t: usize, b: usize) -> Option<Eval> {
        let h = self.geo.h;
        let end = h.checked_sub(b + d)?;
        let hb = h.checked_sub(t + b)?;
        if end <= t || end - t < self.required_overlap(hb) {
            return None;
        }
        Some(Eval {
            d,
            ncc: self.ncc_range(d, t, end),
            exact: self.exact_range(d, t, end),
        })
    }

    /// NCC of rows `y0..y1` of the new frame against rows `y0+d..y1+d` of the previous frame on
    /// the luma grid. Returns -1 when either side has (almost) no contrast.
    fn ncc_range(&self, d: usize, y0: usize, y1: usize) -> f64 {
        let gw = self.geo.gw;
        if y1 <= y0 || gw == 0 || y1 + d > self.geo.h {
            return -1.0;
        }
        let (mut sa, mut saa, mut sb, mut sbb, mut sab) = (0u64, 0u64, 0u64, 0u64, 0u64);
        for y in y0..y1 {
            let a = &self.n.luma[y * gw..(y + 1) * gw];
            let yp = y + d;
            let b = &self.p.luma[yp * gw..(yp + 1) * gw];
            sab += u64::from(dot(a, b));
            sa += u64::from(self.n.rs[y]);
            saa += u64::from(self.n.rss[y]);
            sb += u64::from(self.p.rs[yp]);
            sbb += u64::from(self.p.rss[yp]);
        }
        ncc_from_sums((y1 - y0) * gw, sa, saa, sb, sbb, sab)
    }

    /// Number of rows in `y0..y1` of the new frame that equal row `y + d` of the previous frame
    /// and carry content (are not a single colour).
    fn exact_range(&self, d: usize, y0: usize, y1: usize) -> usize {
        (y0..y1)
            .filter(|&y| {
                y + d < self.geo.h && self.n.hashes[y] == self.p.hashes[y + d] && !self.n.uniform[y]
            })
            .count()
    }

    /// Offsets suggested by exact row-hash agreement, best first.
    fn vote_candidates(&self, t: usize, b: usize, dmax: usize) -> Vec<usize> {
        let hi = self.geo.h - b;
        let mut nb: Vec<(u64, u32)> = (t..hi).map(|y| (self.n.hashes[y], y as u32)).collect();
        let mut pb: Vec<(u64, u32)> = (t..hi).map(|y| (self.p.hashes[y], y as u32)).collect();
        nb.sort_unstable();
        pb.sort_unstable();
        let mut votes = vec![0f32; dmax + 1];
        let (mut i, mut j) = (0, 0);
        while i < nb.len() && j < pb.len() {
            let (hn, hp) = (nb[i].0, pb[j].0);
            if hn < hp {
                i = group_end(&nb, i);
            } else if hn > hp {
                j = group_end(&pb, j);
            } else {
                let ie = group_end(&nb, i);
                let je = group_end(&pb, j);
                let (na, nbk) = (ie - i, je - j);
                if na <= VOTE_CAP && nbk <= VOTE_CAP {
                    let weight = 1.0 / (na * nbk) as f32;
                    for &(_, y) in &nb[i..ie] {
                        for &(_, p) in &pb[j..je] {
                            if p > y {
                                let d = (p - y) as usize;
                                if d <= dmax {
                                    votes[d] += weight;
                                }
                            }
                        }
                    }
                }
                i = ie;
                j = je;
            }
        }
        let mut ranked: Vec<(f32, usize)> = (1..=dmax)
            .filter(|&d| votes[d] >= MIN_VOTE)
            .map(|d| (votes[d], d))
            .collect();
        ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
        ranked.into_iter().take(TOP_VOTES).map(|(_, d)| d).collect()
    }

    /// Offsets suggested by a coarse NCC scan of a few high-contrast probe rows over every
    /// possible shift. Used when exact row hashes do not agree (noise, blended scroll frames).
    fn scan_candidates(&self, t: usize, b: usize, dmax: usize) -> Vec<usize> {
        let (h, gw) = (self.geo.h, self.geo.gw);
        let hi = h - b;
        let hb = hi - t;
        if gw == 0 || hb < MIN_BODY_ROWS {
            return Vec::new();
        }
        // One probe per window: the row with the most horizontal contrast.
        let window = hb.div_ceil(PROBE_ROWS.min(hb));
        let mut probes = Vec::with_capacity(PROBE_ROWS);
        let mut start = t;
        while start < hi {
            let end = (start + window).min(hi);
            let mut best = (4.0f64, None);
            for y in start..end {
                let v = self.row_variance(y);
                if v > best.0 {
                    best = (v, Some(y));
                }
            }
            if let Some(y) = best.1 {
                probes.push(y);
            }
            start = end;
        }
        if probes.len() < 4 {
            return Vec::new();
        }
        let (mut sa, mut saa) = (0u64, 0u64);
        // Prefix sums of the probe statistics on the new frame.
        let mut pre_a = Vec::with_capacity(probes.len() + 1);
        let mut pre_aa = Vec::with_capacity(probes.len() + 1);
        pre_a.push(0u64);
        pre_aa.push(0u64);
        for &y in &probes {
            sa += u64::from(self.n.rs[y]);
            saa += u64::from(self.n.rss[y]);
            pre_a.push(sa);
            pre_aa.push(saa);
        }
        let mut scored: Vec<(f64, usize)> = Vec::with_capacity(dmax);
        for d in 1..=dmax {
            let limit = hi - d;
            let cnt = probes.partition_point(|&y| y < limit);
            if cnt < 4 {
                break;
            }
            let (mut sb, mut sbb, mut sab) = (0u64, 0u64, 0u64);
            for &y in &probes[..cnt] {
                let yp = y + d;
                sb += u64::from(self.p.rs[yp]);
                sbb += u64::from(self.p.rss[yp]);
                sab += u64::from(dot(
                    &self.n.luma[y * gw..(y + 1) * gw],
                    &self.p.luma[yp * gw..(yp + 1) * gw],
                ));
            }
            let ncc = ncc_from_sums(cnt * gw, pre_a[cnt], pre_aa[cnt], sb, sbb, sab);
            scored.push((ncc, d));
        }
        scored.sort_by(|a, b| b.0.total_cmp(&a.0));
        let mut picked: Vec<usize> = Vec::with_capacity(TOP_SCAN);
        for (ncc, d) in scored {
            if picked.len() == TOP_SCAN || ncc < 0.5 {
                break;
            }
            if picked.iter().all(|&q| q.abs_diff(d) > 3) {
                picked.push(d);
            }
        }
        picked
    }

    /// Variance of the luma cells of row `y` (horizontal contrast).
    fn row_variance(&self, y: usize) -> f64 {
        let gw = self.geo.gw as f64;
        let mean = f64::from(self.n.rs[y]) / gw;
        f64::from(self.n.rss[y]) / gw - mean * mean
    }
}

/// Picks the best evaluation: the highest NCC, with ties (within 0.002) broken towards more
/// identical content rows and then the smaller offset.
fn select(evals: &[Eval]) -> Option<Eval> {
    let best = evals
        .iter()
        .map(|e| e.ncc)
        .fold(f64::NEG_INFINITY, f64::max);
    evals
        .iter()
        .filter(|e| e.ncc >= best - 0.002)
        .max_by(|a, b| a.exact.cmp(&b.exact).then(b.d.cmp(&a.d)))
        .copied()
}

/// End (exclusive) of the run of equal hashes starting at `start`.
fn group_end(v: &[(u64, u32)], start: usize) -> usize {
    let key = v[start].0;
    let mut end = start + 1;
    while end < v.len() && v[end].0 == key {
        end += 1;
    }
    end
}

/// Sum of products of two equally long byte slices.
fn dot(a: &[u8], b: &[u8]) -> u32 {
    a.iter()
        .zip(b)
        .map(|(&x, &y)| u32::from(x) * u32::from(y))
        .sum()
}

/// NCC from running sums over `cells` samples; -1 when either side is nearly flat.
fn ncc_from_sums(cells: usize, sa: u64, saa: u64, sb: u64, sbb: u64, sab: u64) -> f64 {
    let n = cells as f64;
    let (sa, saa, sb, sbb, sab) = (sa as f64, saa as f64, sb as f64, sbb as f64, sab as f64);
    let var_a = n * saa - sa * sa;
    let var_b = n * sbb - sb * sb;
    // Less than 0.25 luma levels^2 of variance per cell: no usable contrast.
    let floor = 0.25 * n * n;
    if var_a < floor || var_b < floor {
        return -1.0;
    }
    ((n * sab - sa * sb) / (var_a * var_b).sqrt()).clamp(-1.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trims_background_run_after_header() {
        // header (3 rows of distinct content), then 4 identical blank rows
        let hashes = [1, 2, 3, 9, 9, 9, 9, 5];
        assert_eq!(trim_leading(&hashes, 7), 3);
        // a solid header bar alone is one run and is kept whole
        let bar = [7, 7, 7, 7, 5];
        assert_eq!(trim_leading(&bar, 4), 4);
    }

    #[test]
    fn trims_background_run_before_footer() {
        // 4 blank rows (9) then a 3-row footer; the rest above is content
        let hashes = [5, 9, 9, 9, 9, 1, 2, 3];
        assert_eq!(trim_trailing(&hashes, 8, 7), 3);
        let bar = [5, 7, 7, 7, 7];
        assert_eq!(trim_trailing(&bar, 5, 4), 4);
    }

    #[test]
    fn hashes_ignore_alpha_and_see_every_colour_change() {
        let a = [10u8, 20, 30, 255, 40, 50, 60, 255];
        let mut b = a;
        b[3] = 0;
        assert_eq!(hash_row(&a, 1), hash_row(&b, 1));
        b[5] = 51;
        assert_ne!(hash_row(&a, 1).0, hash_row(&b, 1).0);
        assert!(!hash_row(&a, 1).1);
        assert!(hash_row(&[1, 2, 3, 4, 1, 2, 3, 9], 1).1);
    }

    #[test]
    fn ncc_of_identical_signals_is_one_and_flat_is_rejected() {
        let a: Vec<u32> = (0..64).map(|i| (i * 37 % 251) as u32).collect();
        let s: u64 = a.iter().map(|&v| u64::from(v)).sum();
        let ss: u64 = a.iter().map(|&v| u64::from(v) * u64::from(v)).sum();
        assert!((ncc_from_sums(64, s, ss, s, ss, ss) - 1.0).abs() < 1e-9);
        assert_eq!(ncc_from_sums(64, 6400, 640_000, s, ss, 1), -1.0);
    }
}
