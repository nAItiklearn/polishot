//! Windows implementations of the capture sources: wheel input plus GDI grabs of a screen
//! rectangle. The status windows are excluded from capture (`WDA_EXCLUDEFROMCAPTURE`), so they
//! never show up in frames even when they overlap the pane.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use polishot_media::Frame as MediaFrame;

use crate::geometry::IRect;
use crate::gifrec::RegionSource;
use crate::grab::grab_gdi;
use crate::scroll::{media_frame, ScrollSource, NOTCH};
use crate::winutil;

/// A scrollable pane on screen (global physical pixels).
pub struct PaneScroller {
    pub pane: IRect,
    pub stop: Arc<AtomicBool>,
}

impl PaneScroller {
    fn center(&self) -> (i32, i32) {
        (self.pane.x + self.pane.w / 2, self.pane.y + self.pane.h / 2)
    }
}

impl ScrollSource for PaneScroller {
    fn grab(&mut self) -> Result<MediaFrame, String> {
        Ok(media_frame(&grab_gdi(self.pane)?))
    }

    fn scroll(&mut self, notches: i32) -> Result<(), String> {
        let (x, y) = self.center();
        // Wheel-forward (positive delta) scrolls the view *up*; our positive notches mean "down".
        winutil::send_wheel(x, y, -notches.saturating_mul(NOTCH))
    }

    fn sleep(&mut self, ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn aborted(&mut self) -> bool {
        self.stop.load(Ordering::Relaxed) || winutil::escape_pressed()
    }
}

/// A fixed screen rectangle recorded to GIF.
pub struct RegionGrabber {
    pub region: IRect,
    pub stop: Arc<AtomicBool>,
}

impl RegionSource for RegionGrabber {
    fn grab(&mut self) -> Result<MediaFrame, String> {
        Ok(media_frame(&grab_gdi(self.region)?))
    }

    fn stopped(&mut self) -> bool {
        self.stop.load(Ordering::Relaxed) || winutil::escape_pressed()
    }

    fn sleep(&mut self, d: Duration) {
        std::thread::sleep(d);
    }
}
