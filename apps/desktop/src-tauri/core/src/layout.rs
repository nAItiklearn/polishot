//! Placement of the small status windows (pill, recording border, controls, toast).
//! Everything is in global physical pixels; sizes are specified in logical pixels.

use crate::geometry::IRect;

pub const PILL_SIZE: (f64, f64) = (232.0, 40.0);
pub const CONTROLS_SIZE: (f64, f64) = (196.0, 44.0);
pub const TOAST_SIZE: (f64, f64) = (400.0, 68.0);
/// The recording frame sits this many physical pixels outside the recorded region.
pub const BORDER_MARGIN: i32 = 3;

/// Logical size to physical pixels at `scale`.
pub fn phys(size: (f64, f64), scale: f64) -> (i32, i32) {
    (
        (size.0 * scale).round() as i32,
        (size.1 * scale).round() as i32,
    )
}

/// Top-centre of the monitor, 24 logical pixels from the top edge.
pub fn pill_rect(monitor: &IRect, scale: f64) -> IRect {
    let (w, h) = phys(PILL_SIZE, scale);
    IRect::new(
        monitor.x + (monitor.w - w) / 2,
        monitor.y + (24.0 * scale).round() as i32,
        w,
        h,
    )
}

/// A frame just outside `region`.
pub fn border_rect(region: &IRect) -> IRect {
    IRect::new(
        region.x - BORDER_MARGIN,
        region.y - BORDER_MARGIN,
        region.w + 2 * BORDER_MARGIN,
        region.h + 2 * BORDER_MARGIN,
    )
}

/// Bottom-right of the monitor, above the taskbar.
pub fn toast_rect(monitor: &IRect, scale: f64) -> IRect {
    let (w, h) = phys(TOAST_SIZE, scale);
    let margin = (24.0 * scale).round() as i32;
    let taskbar = (56.0 * scale).round() as i32;
    IRect::new(
        monitor.right() - w - margin,
        monitor.bottom() - h - margin - taskbar,
        w,
        h,
    )
}

/// Centred under the region; above it when there is no room below; inside its bottom edge when
/// the region fills the monitor. Always horizontally inside the monitor.
pub fn controls_rect(region: &IRect, monitor: &IRect, scale: f64) -> IRect {
    let (w, h) = phys(CONTROLS_SIZE, scale);
    let gap = (10.0 * scale).round() as i32 + BORDER_MARGIN;
    let x = (region.x + (region.w - w) / 2).clamp(monitor.x, (monitor.right() - w).max(monitor.x));
    let below = region.bottom() + gap;
    let above = region.y - gap - h;
    let y = if below + h <= monitor.bottom() {
        below
    } else if above >= monitor.y {
        above
    } else {
        (region.bottom() - h - gap).max(monitor.y)
    };
    IRect::new(x, y, w, h)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MON: IRect = IRect::new(0, 0, 1920, 1080);

    #[test]
    fn phys_scales_and_rounds() {
        assert_eq!(phys((200.0, 40.0), 1.25), (250, 50));
        assert_eq!(phys((196.0, 44.0), 1.5), (294, 66));
    }

    #[test]
    fn controls_go_below_when_there_is_room() {
        let r = controls_rect(&IRect::new(400, 200, 600, 300), &MON, 1.0);
        assert_eq!(r.y, 500 + 10 + BORDER_MARGIN);
        assert_eq!(r.x, 400 + (600 - 196) / 2);
    }

    #[test]
    fn controls_go_above_at_the_bottom_of_the_screen() {
        let region = IRect::new(400, 700, 600, 370);
        let r = controls_rect(&region, &MON, 1.0);
        assert!(r.bottom() <= region.y, "{r:?}");
        assert!(r.y >= 0);
    }

    #[test]
    fn controls_sit_inside_a_full_screen_region() {
        let r = controls_rect(&MON, &MON, 1.0);
        assert!(r.bottom() <= MON.bottom() && r.y >= 0);
        assert!(r.y > 900, "near the bottom edge: {r:?}");
    }

    #[test]
    fn controls_stay_horizontally_on_the_monitor() {
        let left = controls_rect(&IRect::new(0, 100, 40, 40), &MON, 1.0);
        assert_eq!(left.x, 0);
        let right = controls_rect(&IRect::new(1900, 100, 20, 40), &MON, 1.0);
        assert_eq!(right.right(), 1920);
    }

    #[test]
    fn works_on_a_monitor_with_negative_coordinates() {
        let mon = IRect::new(-1920, 0, 1920, 1080);
        let r = controls_rect(&IRect::new(-1500, 200, 400, 300), &mon, 1.0);
        assert!(r.x >= mon.x && r.right() <= mon.right());
        let t = toast_rect(&mon, 1.0);
        assert!(t.x >= mon.x && t.right() <= mon.right() && t.bottom() <= mon.bottom());
        let p = pill_rect(&mon, 1.0);
        assert_eq!(p.x + p.w / 2, mon.x + mon.w / 2);
    }

    #[test]
    fn border_and_toast_geometry() {
        assert_eq!(
            border_rect(&IRect::new(100, 100, 200, 100)),
            IRect::new(97, 97, 206, 106)
        );
        let t = toast_rect(&MON, 1.25);
        assert_eq!(t.w, 500);
        assert!(t.right() < MON.right() && t.bottom() < MON.bottom() - 56);
    }
}
