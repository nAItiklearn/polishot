//! Pixel geometry for capture: rectangles, DPI, cropping from frozen frames.
//!
//! Coordinate spaces:
//! * *global*: physical pixels of the virtual desktop (x/y may be negative on monitors left of or
//!   above the primary).
//! * *local*: physical pixels relative to one monitor's top-left (the pixel grid of its frame).

use serde::{Deserialize, Serialize};

/// Integer rectangle (x, y, w, h).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct IRect {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
}

impl IRect {
    pub const fn new(x: i32, y: i32, w: i32, h: i32) -> Self {
        Self { x, y, w, h }
    }

    pub fn right(&self) -> i32 {
        self.x.saturating_add(self.w)
    }

    pub fn bottom(&self) -> i32 {
        self.y.saturating_add(self.h)
    }

    pub fn contains(&self, px: i32, py: i32) -> bool {
        px >= self.x && px < self.right() && py >= self.y && py < self.bottom()
    }

    pub fn area(&self) -> i64 {
        i64::from(self.w.max(0)) * i64::from(self.h.max(0))
    }

    pub fn intersect(&self, o: &IRect) -> Option<IRect> {
        let x = self.x.max(o.x);
        let y = self.y.max(o.y);
        let r = self.right().min(o.right());
        let b = self.bottom().min(o.bottom());
        (r > x && b > y).then(|| IRect::new(x, y, r - x, b - y))
    }

    /// Translate by (-dx, -dy): global -> local when (dx, dy) is the monitor origin.
    pub fn translated(&self, dx: i32, dy: i32) -> IRect {
        IRect::new(self.x - dx, self.y - dy, self.w, self.h)
    }
}

/// Rectangle as received over IPC: JSON numbers, possibly fractional.
#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
pub struct FBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl FBox {
    /// Round to integers. Rejects NaN/infinity and absurd magnitudes.
    pub fn to_irect(self) -> Result<IRect, String> {
        const LIMIT: f64 = 1.0e7;
        for v in [self.x, self.y, self.w, self.h] {
            if !v.is_finite() || v.abs() > LIMIT {
                return Err("The selection is not valid.".to_string());
            }
        }
        Ok(IRect::new(
            self.x.round() as i32,
            self.y.round() as i32,
            self.w.round() as i32,
            self.h.round() as i32,
        ))
    }
}

impl From<IRect> for FBox {
    fn from(r: IRect) -> Self {
        FBox {
            x: f64::from(r.x),
            y: f64::from(r.y),
            w: f64::from(r.w),
            h: f64::from(r.h),
        }
    }
}

/// Clamp a local rectangle to a `frame_w x frame_h` frame. Errors if nothing is left.
pub fn clamp_to_frame(r: IRect, frame_w: u32, frame_h: u32) -> Result<IRect, String> {
    if r.w <= 0 || r.h <= 0 {
        return Err("The selection is empty.".to_string());
    }
    let frame = IRect::new(0, 0, frame_w as i32, frame_h as i32);
    r.intersect(&frame)
        .ok_or_else(|| "The selection is outside the screen.".to_string())
}

/// Device pixels per CSS pixel for a monitor effective DPI (96 = 100%).
pub fn scale_from_dpi(dpi: u32) -> f64 {
    if dpi == 0 {
        1.0
    } else {
        f64::from(dpi) / 96.0
    }
}

/// Which monitor index holds most of `rect` (global coordinates). Ties go to the lower index.
pub fn best_monitor(rect: &IRect, monitors: &[IRect]) -> Option<usize> {
    let mut best: Option<(usize, i64)> = None;
    for (i, m) in monitors.iter().enumerate() {
        let area = rect.intersect(m).map_or(0, |r| r.area());
        if area > 0 && best.is_none_or(|(_, a)| area > a) {
            best = Some((i, area));
        }
    }
    best.map(|(i, _)| i)
}

/// Crop `rect` (local, already clamped) out of tightly packed 4-byte-per-pixel `src`, producing
/// RGBA. `src_is_bgra` swaps channels; `force_opaque` writes alpha 255.
pub fn crop_to_rgba(
    src: &[u8],
    src_w: u32,
    rect: IRect,
    src_is_bgra: bool,
    force_opaque: bool,
) -> Vec<u8> {
    let (w, h) = (rect.w as usize, rect.h as usize);
    let stride = src_w as usize * 4;
    let mut out = vec![0u8; w * h * 4];
    for row in 0..h {
        let s = (rect.y as usize + row) * stride + rect.x as usize * 4;
        let d = row * w * 4;
        let src_row = &src[s..s + w * 4];
        let dst_row = &mut out[d..d + w * 4];
        if src_is_bgra {
            for (dp, sp) in dst_row.chunks_exact_mut(4).zip(src_row.chunks_exact(4)) {
                dp[0] = sp[2];
                dp[1] = sp[1];
                dp[2] = sp[0];
                dp[3] = if force_opaque { 255 } else { sp[3] };
            }
        } else {
            dst_row.copy_from_slice(src_row);
            if force_opaque {
                for p in dst_row.chunks_exact_mut(4) {
                    p[3] = 255;
                }
            }
        }
    }
    out
}

/// Offsets of the visible window frame inside a captured window surface.
///
/// WGC may deliver the full window rect (including the invisible resize border on Windows 10) or
/// just the visible frame. Returns the local crop rect inside a `frame_w x frame_h` surface, or
/// `None` when no crop is needed.
pub fn visible_frame_crop(
    frame_w: u32,
    frame_h: u32,
    window_rect: IRect,
    visible: IRect,
) -> Option<IRect> {
    if frame_w as i32 != window_rect.w || frame_h as i32 != window_rect.h {
        return None; // surface already is the visible frame (or something unexpected)
    }
    let local = visible.translated(window_rect.x, window_rect.y);
    let crop = local.intersect(&IRect::new(0, 0, frame_w as i32, frame_h as i32))?;
    (crop.w != frame_w as i32 || crop.h != frame_h as i32).then_some(crop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn intersect_and_translate() {
        let a = IRect::new(0, 0, 100, 100);
        let b = IRect::new(50, 60, 100, 100);
        assert_eq!(a.intersect(&b), Some(IRect::new(50, 60, 50, 40)));
        assert_eq!(a.intersect(&IRect::new(100, 0, 10, 10)), None);
        assert_eq!(b.translated(50, 60), IRect::new(0, 0, 100, 100));
    }

    #[test]
    fn negative_virtual_desktop_coordinates() {
        // A monitor to the left of the primary: x is negative.
        let left = IRect::new(-1920, 0, 1920, 1080);
        let primary = IRect::new(0, 0, 2560, 1440);
        // Window straddling both monitors.
        let win = IRect::new(-500, 100, 1000, 600);
        assert_eq!(best_monitor(&win, &[primary, left]), Some(0)); // 500 px right, 500 px left: tie -> lower index
        let win2 = IRect::new(-800, 100, 1000, 600);
        assert_eq!(best_monitor(&win2, &[primary, left]), Some(1));
        let local = win2.intersect(&left).unwrap().translated(left.x, left.y);
        assert_eq!(local, IRect::new(1120, 100, 800, 600));
        assert_eq!(
            best_monitor(&IRect::new(9000, 0, 10, 10), &[primary, left]),
            None
        );
    }

    #[test]
    fn fbox_rounds_and_rejects_garbage() {
        let r = FBox {
            x: 10.4,
            y: 10.6,
            w: 99.5,
            h: 0.2,
        }
        .to_irect()
        .unwrap();
        assert_eq!(r, IRect::new(10, 11, 100, 0));
        assert!(FBox {
            x: f64::NAN,
            y: 0.0,
            w: 1.0,
            h: 1.0
        }
        .to_irect()
        .is_err());
        assert!(FBox {
            x: 0.0,
            y: 0.0,
            w: f64::INFINITY,
            h: 1.0
        }
        .to_irect()
        .is_err());
        assert!(FBox {
            x: 1e12,
            y: 0.0,
            w: 1.0,
            h: 1.0
        }
        .to_irect()
        .is_err());
    }

    #[test]
    fn clamp_to_frame_cases() {
        assert_eq!(
            clamp_to_frame(IRect::new(-10, -10, 50, 50), 100, 100).unwrap(),
            IRect::new(0, 0, 40, 40)
        );
        assert_eq!(
            clamp_to_frame(IRect::new(90, 90, 50, 50), 100, 100).unwrap(),
            IRect::new(90, 90, 10, 10)
        );
        assert!(clamp_to_frame(IRect::new(0, 0, 0, 10), 100, 100).is_err());
        assert!(clamp_to_frame(IRect::new(100, 0, 10, 10), 100, 100).is_err());
        assert!(clamp_to_frame(IRect::new(0, 0, -5, 10), 100, 100).is_err());
    }

    #[test]
    fn dpi_scale() {
        assert_eq!(scale_from_dpi(96), 1.0);
        assert_eq!(scale_from_dpi(120), 1.25);
        assert_eq!(scale_from_dpi(144), 1.5);
        assert_eq!(scale_from_dpi(192), 2.0);
        assert_eq!(scale_from_dpi(0), 1.0);
    }

    #[test]
    fn crop_swaps_channels_and_sets_alpha() {
        // 3x2 BGRA image, pixel value encodes position: B=i, G=i+1, R=i+2, A=0
        let (w, h) = (3u32, 2u32);
        let mut src = Vec::new();
        for i in 0..(w * h) as u8 {
            src.extend_from_slice(&[i, i + 1, i + 2, 0]);
        }
        let out = crop_to_rgba(&src, w, IRect::new(1, 1, 2, 1), true, true);
        // pixels 4 and 5 of the source
        assert_eq!(out, vec![6, 5, 4, 255, 7, 6, 5, 255]);
        let keep = crop_to_rgba(&src, w, IRect::new(0, 0, 1, 1), true, false);
        assert_eq!(keep, vec![2, 1, 0, 0]);
        let rgba = crop_to_rgba(&src, w, IRect::new(2, 0, 1, 2), false, false);
        assert_eq!(rgba, vec![2, 3, 4, 0, 5, 6, 7, 0]);
    }

    #[test]
    fn visible_frame_crop_removes_invisible_border() {
        // Win10-style: surface = window rect (1016x739), visible frame inset by 7px on 3 sides.
        let window = IRect::new(100, 100, 1016, 739);
        let visible = IRect::new(107, 100, 1002, 732);
        assert_eq!(
            visible_frame_crop(1016, 739, window, visible),
            Some(IRect::new(7, 0, 1002, 732))
        );
        // Win11-style: surface already equals the visible frame.
        assert_eq!(visible_frame_crop(1002, 732, window, visible), None);
        // Nothing to crop.
        assert_eq!(visible_frame_crop(1016, 739, window, window), None);
    }
}
