//! `capture_commit` request shape and region cropping from a frozen frame.

use serde::Deserialize;

use crate::geometry::{clamp_to_frame, crop_to_rgba, FBox, IRect};
use crate::store::Frame;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum CommitRequest {
    Region { monitor: usize, rect: FBox },
    Window { hwnd: i64 },
}

/// Crop `rect` (physical pixels relative to the frame) out of `frame` as opaque RGBA. The
/// rectangle is clamped to the frame; empty or off-screen selections are errors.
pub fn crop_region(frame: &Frame, rect: IRect) -> Result<(u32, u32, Vec<u8>), String> {
    let r = clamp_to_frame(rect, frame.width, frame.height)?;
    let rgba = crop_to_rgba(frame.pixels(), frame.width, r, true, true);
    Ok((r.w as u32, r.h as u32, rgba))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(w: u32, h: u32, base: u8) -> Frame {
        let mut px = Vec::new();
        for i in 0..(w * h) {
            px.extend_from_slice(&[base, (i % 256) as u8, 7, 0]);
        }
        Frame::from_bgra(w, h, &px).unwrap()
    }

    #[test]
    fn commit_request_deserializes_from_the_contract_shape() {
        let r: CommitRequest = serde_json::from_str(
            r#"{"kind":"region","monitor":1,"rect":{"x":10,"y":20,"w":30,"h":40}}"#,
        )
        .unwrap();
        match r {
            CommitRequest::Region { monitor, rect } => {
                assert_eq!(monitor, 1);
                assert_eq!(rect.to_irect().unwrap(), IRect::new(10, 20, 30, 40));
            }
            CommitRequest::Window { .. } => panic!("wrong variant"),
        }
        let w: CommitRequest = serde_json::from_str(r#"{"kind":"window","hwnd":197842}"#).unwrap();
        assert!(matches!(w, CommitRequest::Window { hwnd: 197842 }));
        assert!(serde_json::from_str::<CommitRequest>(r#"{"kind":"scroll"}"#).is_err());
        assert!(serde_json::from_str::<CommitRequest>(
            r#"{"kind":"region","monitor":-1,"rect":{"x":0,"y":0,"w":1,"h":1}}"#
        )
        .is_err());
    }

    #[test]
    fn crop_swaps_channels_forces_alpha_and_keeps_the_right_pixels() {
        let f = frame(200, 100, 2);
        let (w, h, px) = crop_region(&f, IRect::new(10, 20, 30, 40)).unwrap();
        assert_eq!((w, h), (30, 40));
        assert_eq!(px.len(), 30 * 40 * 4);
        // BGRA source [2, g, 7, 0] -> RGBA [7, g, 2, 255]
        assert_eq!(px[0], 7);
        assert_eq!(px[2], 2);
        assert_eq!(px[3], 255);
        // first cropped pixel is source pixel (10, 20) = index 20*200+10 = 4010 -> 4010 % 256 = 170
        assert_eq!(px[1], 170);
    }

    #[test]
    fn selections_hanging_off_the_frame_are_clamped() {
        let f = frame(100, 50, 1);
        let (w, h, _) = crop_region(&f, IRect::new(90, 40, 50, 50)).unwrap();
        assert_eq!((w, h), (10, 10));
        let (w, h, _) = crop_region(&f, IRect::new(-20, -20, 40, 40)).unwrap();
        assert_eq!((w, h), (20, 20));
    }

    #[test]
    fn empty_and_off_screen_selections_fail() {
        let f = frame(100, 50, 1);
        assert!(crop_region(&f, IRect::new(200, 0, 5, 5)).is_err());
        assert!(crop_region(&f, IRect::new(0, 0, 0, 5)).is_err());
        assert!(crop_region(&f, IRect::new(0, 0, 5, -1)).is_err());
    }
}
