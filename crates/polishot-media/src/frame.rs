//! The RGBA frame type shared by the stitcher and the GIF encoder, plus duplicate-frame detection.

use std::fmt;

/// A tightly packed RGBA8 image (`rgba.len() == width * height * 4`, rows top to bottom, no stride
/// padding). The alpha channel is ignored by every algorithm in this crate: screen captures are
/// treated as opaque.
///
/// The fields are public so callers can hand over a buffer they already own without copying, which
/// also means a `Frame` can be inconsistent. Every API in this crate validates the buffer length
/// against the dimensions and returns an error instead of panicking; use [`Frame::new`] to validate
/// once up front.
#[derive(Clone, PartialEq, Eq)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

impl fmt::Debug for Frame {
    // Never print pixel data (it can contain screen contents).
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Frame")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("rgba_len", &self.rgba.len())
            .finish()
    }
}

/// Why a [`Frame`] was rejected.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameError {
    /// Width or height is zero.
    ZeroSize,
    /// `width * height * 4` does not fit in memory addressing.
    TooLarge,
    /// The pixel buffer length does not equal `width * height * 4`.
    BadLength { expected: usize, actual: usize },
}

impl fmt::Display for FrameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameError::ZeroSize => write!(f, "frame has zero width or height"),
            FrameError::TooLarge => write!(f, "frame dimensions are too large"),
            FrameError::BadLength { expected, actual } => write!(
                f,
                "frame buffer has {actual} bytes but its dimensions require {expected}"
            ),
        }
    }
}

impl std::error::Error for FrameError {}

impl Frame {
    /// Builds a frame, checking that `rgba` matches the dimensions.
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Result<Frame, FrameError> {
        let frame = Frame {
            width,
            height,
            rgba,
        };
        frame.validate()?;
        Ok(frame)
    }

    /// Checks the dimensions are non-zero and match the buffer length.
    pub fn validate(&self) -> Result<(), FrameError> {
        if self.width == 0 || self.height == 0 {
            return Err(FrameError::ZeroSize);
        }
        let expected = (self.width as usize)
            .checked_mul(self.height as usize)
            .and_then(|px| px.checked_mul(4))
            .filter(|&n| n <= isize::MAX as usize)
            .ok_or(FrameError::TooLarge)?;
        if self.rgba.len() != expected {
            return Err(FrameError::BadLength {
                expected,
                actual: self.rgba.len(),
            });
        }
        Ok(())
    }
}

/// Reports whether two frames differ by more than `threshold`, where `threshold` is the allowed
/// *fraction of pixels* (0.0 to 1.0) whose RGB value changed. Alpha is ignored.
///
/// * `0.0` means "any single changed pixel counts as a difference" (use this to merge only
///   bit-identical frames).
/// * `0.001` tolerates a changed area of 0.1 % of the frame (for example a blinking caret).
///
/// Frames with different dimensions, or with an inconsistent buffer, always count as different.
/// The scan stops as soon as the verdict is known, so identical frames cost one pass and clearly
/// different ones return almost immediately.
#[must_use]
pub fn frames_differ(a: &Frame, b: &Frame, threshold: f32) -> bool {
    if a.width != b.width || a.height != b.height || a.validate().is_err() || b.validate().is_err()
    {
        return true;
    }
    pixels_differ(&a.rgba, &b.rgba, threshold)
}

/// Same as [`frames_differ`] on two equally sized, already validated RGBA buffers.
pub(crate) fn pixels_differ(a: &[u8], b: &[u8], threshold: f32) -> bool {
    if a.len() != b.len() {
        return true;
    }
    // Fast path: a byte-identical buffer (memcmp speed) is the common "nothing moved" case.
    if a == b {
        return false;
    }
    let total = a.len() / 4;
    let threshold = if threshold.is_nan() {
        0.0
    } else {
        threshold.clamp(0.0, 1.0)
    };
    // Number of changed pixels that is still tolerated: the largest `n` with
    // `n / total <= threshold` in f32, so a threshold typed as 0.01 behaves as written.
    let mut allowed = (f64::from(threshold) * total as f64).floor() as usize;
    while allowed < total && (allowed + 1) as f32 / total as f32 <= threshold {
        allowed += 1;
    }
    let mut changed = 0usize;
    for (pa, pb) in a.chunks_exact(4).zip(b.chunks_exact(4)) {
        if pa[0] != pb[0] || pa[1] != pb[1] || pa[2] != pb[2] {
            changed += 1;
            if changed > allowed {
                return true;
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(w: u32, h: u32, v: u8) -> Frame {
        Frame {
            width: w,
            height: h,
            rgba: vec![v; (w * h * 4) as usize],
        }
    }

    #[test]
    fn validate_catches_bad_buffers() {
        assert_eq!(Frame::new(0, 4, vec![]).unwrap_err(), FrameError::ZeroSize);
        assert!(matches!(
            Frame::new(2, 2, vec![0; 15]),
            Err(FrameError::BadLength {
                expected: 16,
                actual: 15
            })
        ));
        assert!(Frame::new(2, 2, vec![0; 16]).is_ok());
        let huge = Frame {
            width: u32::MAX,
            height: u32::MAX,
            rgba: Vec::new(),
        };
        assert_eq!(huge.validate(), Err(FrameError::TooLarge));
    }

    #[test]
    fn differ_threshold_is_a_pixel_fraction() {
        let a = solid(10, 10, 7);
        let mut b = a.clone();
        assert!(!frames_differ(&a, &b, 0.0));
        b.rgba[0] = 8; // one pixel of 100
        assert!(frames_differ(&a, &b, 0.0));
        assert!(!frames_differ(&a, &b, 0.01));
        assert!(frames_differ(&a, &b, 0.0099));
        // Alpha-only changes are ignored.
        let mut c = a.clone();
        c.rgba[3] = 0;
        assert!(!frames_differ(&a, &c, 0.0));
    }

    #[test]
    fn differ_handles_mismatched_input() {
        let a = solid(4, 4, 0);
        let b = solid(4, 5, 0);
        assert!(frames_differ(&a, &b, 1.0));
        let bad = Frame {
            width: 4,
            height: 4,
            rgba: vec![0; 3],
        };
        assert!(frames_differ(&a, &bad, 0.5));
        assert!(frames_differ(&bad, &bad, 0.5));
        assert!(!frames_differ(&a, &a.clone(), f32::NAN));
    }
}
