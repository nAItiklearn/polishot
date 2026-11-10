//! Sizing for pinned-screenshot windows.

const MIN_LOGICAL: f64 = 120.0;
const MAX_SCREEN_FRACTION: f64 = 0.8;

pub fn label_for(id: &str) -> String {
    format!("pin-{id}")
}

/// Fit an image of `w x h` physical pixels onto a monitor: shown at 1:1 logical size when it fits,
/// otherwise scaled down to at most 80% of the monitor, never below `MIN_LOGICAL`.
pub fn fit_size(w: u32, h: u32, scale: f64, mon_w: i32, mon_h: i32) -> (f64, f64) {
    let (lw, lh) = (f64::from(w) / scale, f64::from(h) / scale);
    let max_w = f64::from(mon_w) / scale * MAX_SCREEN_FRACTION;
    let max_h = f64::from(mon_h) / scale * MAX_SCREEN_FRACTION;
    let k = (max_w / lw).min(max_h / lh).min(1.0);
    (
        (lw * k).max(MIN_LOGICAL.min(lw)),
        (lh * k).max(MIN_LOGICAL.min(lh)),
    )
}

/// Smallest window size the pin may be resized to.
pub fn min_size(lw: f64, lh: f64) -> (f64, f64) {
    (MIN_LOGICAL.min(lw), MIN_LOGICAL.min(lh))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn small_images_show_at_logical_size() {
        // 400x300 physical on a 200% monitor = 200x150 logical
        assert_eq!(fit_size(400, 300, 2.0, 3840, 2160), (200.0, 150.0));
    }

    #[test]
    fn large_images_shrink_to_80_percent_of_the_screen_keeping_aspect() {
        let (w, h) = fit_size(3840, 2160, 1.0, 1920, 1080);
        assert!(
            (w - 1536.0).abs() < 1e-6 && (h - 864.0).abs() < 1e-6,
            "{w}x{h}"
        );
        let (w, h) = fit_size(1000, 4000, 1.0, 1920, 1080);
        assert!((h - 864.0).abs() < 1e-6);
        assert!((w / h - 0.25).abs() < 1e-6);
    }

    #[test]
    fn tiny_images_are_not_shrunk_below_themselves() {
        assert_eq!(fit_size(50, 40, 1.0, 1920, 1080), (50.0, 40.0));
        assert_eq!(min_size(50.0, 400.0), (50.0, 120.0));
    }

    #[test]
    fn labels() {
        assert_eq!(label_for("abc-1"), "pin-abc-1");
    }
}
