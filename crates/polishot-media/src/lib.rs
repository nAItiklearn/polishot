//! Pure-Rust media algorithms for Polishot: **scrolling-capture stitching** and **short
//! screen-to-GIF encoding**.
//!
//! The crate contains no platform capture code. It works on tightly packed RGBA8 [`Frame`]s that
//! the desktop app grabs (for example with Windows Graphics Capture) and hands over.
//!
//! # Scrolling capture
//!
//! ```
//! use polishot_media::{Frame, StitchOptions, Stitcher};
//!
//! # fn grab_viewport() -> Frame { Frame { width: 64, height: 64, rgba: vec![255; 64 * 64 * 4] } }
//! let mut stitcher = Stitcher::new(grab_viewport(), StitchOptions::default());
//! loop {
//!     // ... send a mouse-wheel scroll, wait for the page to settle ...
//!     match stitcher.push(&grab_viewport()) {
//!         Ok(0) => break,                    // nothing moved: bottom reached
//!         Ok(_new_rows) => {}                // keep going
//!         Err(_) => break,                   // could not align: retry smaller or stop
//!     }
//! }
//! let tall_image = stitcher.finish();
//! # assert_eq!(tall_image.height, 64);
//! ```
//!
//! ## Integration notes for the desktop host
//!
//! * **Capture only the scrolling pane.** Fixed headers and footers inside the captured rectangle
//!   are detected and handled, but fixed *columns* (a sidebar that does not scroll) are not: crop
//!   the capture rectangle to the scrollable area.
//! * **Scroll step.** Send mouse-wheel input in whole notches of 120 units (`WHEEL_DELTA`). Pick
//!   the step so one scroll moves the content by roughly 40 to 60 percent of the viewport height
//!   (most apps scroll about 100 px per notch at 100 percent scaling, so 3 to 6 notches for a
//!   1080 p window). The matcher accepts any single movement up to the viewport body height minus
//!   [`StitchOptions::min_overlap`] (default 48 rows) but is most reliable with a generous overlap.
//! * **Let the page settle.** Smooth-scrolling animations are still moving right after the wheel
//!   event. Wait about 120 ms, grab, and optionally grab again until two consecutive grabs are
//!   identical (`!frames_differ(&a, &b, 0.0)`) before calling [`Stitcher::push`].
//! * **Stop conditions.** Stop when `push` returns `Ok(0)` twice in a row (a single `Ok(0)` can
//!   also be a featureless stretch of page, because a blank frame looks identical to a frame that
//!   did not move; scroll once more with a larger step before giving up), when
//!   [`Stitcher::is_full`] is true, on Esc, or after a wall-clock limit. On `Err(_)` retry once
//!   with half the scroll step (the frame was not used, so the state is unchanged); a second
//!   failure means the content cannot be stitched and the capture should finish with what it has.
//! * **Cost.** One push is a few milliseconds for a 1920x1080 frame. The stitched image grows
//!   row by row; 20 000 rows of 1920 px is about 150 MB, so keep `max_height` modest.
//!
//! # GIF encoding
//!
//! [`GifEncoder`] streams frames to any [`std::io::Write`]. It downscales with an area-average
//! filter, quantises each frame with NeuQuant into its own palette, merges consecutive identical
//! frames into one longer delay, and never emits transparency. It does not use gifski (AGPL).

mod frame;
mod gif_encoder;
mod scale;
mod stitch;

pub use frame::{frames_differ, Frame, FrameError};
pub use gif_encoder::{GifEncoder, GifError, GifOptions};
pub use stitch::{StitchError, StitchOptions, Stitcher, MIN_SCORE};
