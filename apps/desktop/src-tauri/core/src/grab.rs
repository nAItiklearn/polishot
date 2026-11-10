//! Screen grabbing. Three back ends, chosen by measurement (see `capture_latency` test):
//!
//! * `Wgc`: Windows Graphics Capture through `windows-capture` (also the only way to capture an
//!   occluded window).
//! * `Dxgi`: DXGI desktop duplication through `windows-capture`.
//! * `Gdi`: `BitBlt` from the screen DC into a DIB section.
//!
//! Every grab ends as a [`Frame`]: BMP header + top-down BGRX pixels, ready to be served.

use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleDC, CreateDIBSection, DeleteDC, DeleteObject, GetDC, ReleaseDC,
    SelectObject, BITMAPINFO, BITMAPINFOHEADER, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
};
use windows_capture::capture::{Context, GraphicsCaptureApiHandler};
use windows_capture::dxgi_duplication_api::{DxgiDuplicationApi, DxgiDuplicationFormat};
use windows_capture::frame::Frame as WgcFrame;
use windows_capture::graphics_capture_api::InternalCaptureControl;
use windows_capture::monitor::Monitor;
use windows_capture::settings::{
    ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
    MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings,
};
use windows_capture::window::Window;

use crate::geometry::IRect;
use crate::store::Frame;
use crate::winutil::MonitorInfo;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Wgc,
    Dxgi,
    Gdi,
}

impl Method {
    pub fn name(self) -> &'static str {
        match self {
            Method::Wgc => "wgc",
            Method::Dxgi => "dxgi",
            Method::Gdi => "gdi",
        }
    }

    pub fn parse(s: &str) -> Option<Method> {
        match s.trim().to_ascii_lowercase().as_str() {
            "wgc" => Some(Method::Wgc),
            "dxgi" => Some(Method::Dxgi),
            "gdi" => Some(Method::Gdi),
            _ => None,
        }
    }
}

/// Touch the GDI path once (a 64x64 grab) so the first real hotkey does not pay process-level
/// start-up costs. Safe to call from any thread.
pub fn prewarm() {
    let _ = grab_gdi(IRect::new(0, 0, 64, 64));
}

/// Preferred order for monitor grabs; the first entry is the measured fastest.
/// `POLISHOT_GRABBER=wgc|dxgi|gdi` forces a method (the others stay as fallbacks).
pub fn monitor_order() -> Vec<Method> {
    let mut order = vec![DEFAULT_PRIMARY, Method::Wgc, Method::Gdi, Method::Dxgi];
    if let Some(forced) = std::env::var("POLISHOT_GRABBER")
        .ok()
        .and_then(|s| Method::parse(&s))
    {
        order.insert(0, forced);
    }
    let mut seen = Vec::new();
    order.retain(|m| {
        let new = !seen.contains(m);
        seen.push(*m);
        new
    });
    order
}

/// Chosen from measurements on this machine; see `docs/CONTRACT-CHANGES.md` for the numbers.
pub const DEFAULT_PRIMARY: Method = Method::Gdi;

const FRAME_TIMEOUT: Duration = Duration::from_millis(2500);

/// Grab one monitor, trying `order` until a method works.
pub fn grab_monitor(m: &MonitorInfo, order: &[Method]) -> Result<(Frame, Method), String> {
    let mut last_err = String::from("No capture method is available.");
    for &method in order {
        let res = match method {
            Method::Wgc => grab_wgc_monitor(m),
            Method::Dxgi => grab_dxgi_monitor(m),
            Method::Gdi => grab_gdi(m.bounds),
        };
        match res {
            Ok(frame) => return Ok((frame, method)),
            Err(e) => {
                crate::tlog!("grab method {} failed: {e}", method.name());
                last_err = e;
            }
        }
    }
    Err(format!("Could not capture the screen: {last_err}"))
}

// ---- GDI -------------------------------------------------------------------------------------

/// `BitBlt` the region `bounds` (global physical pixels) into a DIB section.
pub fn grab_gdi(bounds: IRect) -> Result<Frame, String> {
    if bounds.w <= 0 || bounds.h <= 0 {
        return Err("Empty capture area.".to_string());
    }
    let (w, h) = (bounds.w, bounds.h);
    // SAFETY: every GDI object created below is released on all paths before returning; `bits`
    // points into the DIB section and is only read while the section is alive.
    unsafe {
        let screen = GetDC(None);
        if screen.is_invalid() {
            return Err("Could not access the screen.".to_string());
        }
        let mem = CreateCompatibleDC(Some(screen));
        let info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down
                biPlanes: 1,
                biBitCount: 32,
                biCompression: 0, // BI_RGB
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bits: *mut c_void = std::ptr::null_mut();
        let section = CreateDIBSection(Some(mem), &info, DIB_RGB_COLORS, &mut bits, None, 0);
        let result = match section {
            Ok(bmp) if !bits.is_null() => {
                let old = SelectObject(mem, bmp.into());
                let blit = BitBlt(
                    mem,
                    0,
                    0,
                    w,
                    h,
                    Some(screen),
                    bounds.x,
                    bounds.y,
                    SRCCOPY | CAPTUREBLT,
                );
                let out = if blit.is_ok() {
                    let len = w as usize * h as usize * 4;
                    let src = std::slice::from_raw_parts(bits as *const u8, len);
                    Frame::from_bgra(w as u32, h as u32, src)
                } else {
                    Err("The screen could not be copied.".to_string())
                };
                SelectObject(mem, old);
                let _ = DeleteObject(bmp.into());
                out
            }
            _ => Err("Could not allocate a screen buffer.".to_string()),
        };
        let _ = DeleteDC(mem);
        ReleaseDC(None, screen);
        result
    }
}

// ---- WGC -------------------------------------------------------------------------------------

type GrabResult = Result<Frame, String>;

struct OneShot {
    tx: mpsc::Sender<GrabResult>,
    sent: bool,
}

impl GraphicsCaptureApiHandler for OneShot {
    type Flags = mpsc::Sender<GrabResult>;
    type Error = Box<dyn std::error::Error + Send + Sync>;

    fn new(ctx: Context<Self::Flags>) -> Result<Self, Self::Error> {
        Ok(Self {
            tx: ctx.flags,
            sent: false,
        })
    }

    fn on_frame_arrived(
        &mut self,
        frame: &mut WgcFrame,
        control: InternalCaptureControl,
    ) -> Result<(), Self::Error> {
        if self.sent {
            control.stop();
            return Ok(());
        }
        let (w, h) = (frame.width(), frame.height());
        let buffer = frame.buffer()?;
        let mut scratch = Vec::new();
        let data = buffer.as_nopadding_buffer(&mut scratch);
        let res = Frame::from_bgra(w, h, &data[..(w as usize * h as usize * 4).min(data.len())]);
        self.sent = true;
        let _ = self.tx.send(res);
        control.stop();
        Ok(())
    }
}

fn run_wgc<T>(item: T, border: DrawBorderSettings) -> GrabResult
where
    T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Send + 'static,
{
    let (tx, rx) = mpsc::channel::<GrabResult>();
    let settings = Settings::new(
        item,
        CursorCaptureSettings::WithoutCursor,
        border,
        SecondaryWindowSettings::Default,
        MinimumUpdateIntervalSettings::Default,
        DirtyRegionSettings::Default,
        ColorFormat::Bgra8,
        tx,
    );
    let control = OneShot::start_free_threaded(settings)
        .map_err(|e| format!("Graphics Capture could not start: {e}"))?;
    let res = rx
        .recv_timeout(FRAME_TIMEOUT)
        .map_err(|_| "Graphics Capture produced no frame in time.".to_string())
        .and_then(|r| r);
    // Tear the session down off the hot path.
    std::thread::spawn(move || {
        let _ = control.stop();
    });
    res
}

fn wgc_with_border_fallback<T, F>(make: F) -> GrabResult
where
    T: TryInto<windows_capture::settings::GraphicsCaptureItemType> + Send + 'static,
    F: Fn() -> T,
{
    // Suppress the yellow capture border where supported; fall back if the OS refuses.
    match run_wgc(make(), DrawBorderSettings::WithoutBorder) {
        Ok(f) => Ok(f),
        Err(_) => run_wgc(make(), DrawBorderSettings::Default),
    }
}

pub fn grab_wgc_monitor(m: &MonitorInfo) -> GrabResult {
    let h = m.hmonitor;
    wgc_with_border_fallback(move || Monitor::from_raw_hmonitor(h as *mut c_void))
}

/// Capture a window through WGC, even when it is covered by other windows.
/// Returns the surface exactly as WGC delivers it (BGRA).
pub fn grab_wgc_window(hwnd: isize) -> GrabResult {
    wgc_with_border_fallback(move || Window::from_raw_hwnd(hwnd as *mut c_void))
}

// ---- DXGI ------------------------------------------------------------------------------------

pub fn grab_dxgi_monitor(m: &MonitorInfo) -> GrabResult {
    let monitor = Monitor::from_raw_hmonitor(m.hmonitor as *mut c_void);
    let mut dup = DxgiDuplicationApi::new_options(monitor, &[DxgiDuplicationFormat::Bgra8])
        .map_err(|e| format!("Desktop duplication could not start: {e}"))?;
    let mut frame = dup
        .acquire_next_frame(250)
        .map_err(|e| format!("Desktop duplication produced no frame: {e}"))?;
    let (w, h) = (frame.width(), frame.height());
    let buffer = frame
        .buffer()
        .map_err(|e| format!("Desktop duplication could not read the frame: {e}"))?;
    let mut scratch = Vec::new();
    let data = buffer.as_nopadding_buffer(&mut scratch);
    Frame::from_bgra(w, h, &data[..(w as usize * h as usize * 4).min(data.len())])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::winutil::enumerate_monitors;

    #[test]
    fn order_has_every_method_once() {
        let o = monitor_order();
        assert_eq!(o.len(), 3);
        assert!(o.contains(&Method::Wgc) && o.contains(&Method::Gdi) && o.contains(&Method::Dxgi));
        assert_eq!(o[0], DEFAULT_PRIMARY);
    }

    #[test]
    fn method_parse() {
        assert_eq!(Method::parse(" WGC "), Some(Method::Wgc));
        assert_eq!(Method::parse("gdi"), Some(Method::Gdi));
        assert_eq!(Method::parse("nope"), None);
    }

    #[test]
    fn gdi_rejects_empty_areas() {
        assert!(grab_gdi(IRect::new(0, 0, 0, 10)).is_err());
        assert!(grab_gdi(IRect::new(0, 0, 10, -1)).is_err());
    }

    /// Needs a desktop session: grabs every monitor with every method and checks the frame shape.
    #[test]
    #[ignore]
    fn grab_smoke() {
        let monitors = enumerate_monitors().unwrap();
        for m in &monitors {
            for method in [Method::Gdi, Method::Wgc, Method::Dxgi] {
                let (f, used) = grab_monitor(m, &[method]).unwrap();
                assert_eq!(used, method);
                assert_eq!((f.width as i32, f.height as i32), (m.bounds.w, m.bounds.h));
                assert_eq!(f.pixels().len(), f.width as usize * f.height as usize * 4);
            }
        }
    }

    /// `cargo test --release -- --ignored capture_latency --nocapture`
    /// Measures hotkey-to-frames time for each back end on every monitor, plus encode costs.
    #[test]
    #[ignore]
    fn capture_latency() {
        const RUNS: usize = 12;
        // Match the real app, which is per-monitor DPI aware: measure physical pixels.
        // SAFETY: plain process-wide setting at the start of the test.
        let _ = unsafe {
            windows::Win32::UI::HiDpi::SetProcessDpiAwarenessContext(
                windows::Win32::UI::HiDpi::DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
            )
        };
        let monitors = enumerate_monitors().unwrap();
        println!("monitors: {}", monitors.len());
        for m in &monitors {
            println!(
                "monitor {}: {}x{} scale {:.2} at ({}, {})",
                m.index, m.bounds.w, m.bounds.h, m.scale, m.bounds.x, m.bounds.y
            );
        }
        for method in [Method::Gdi, Method::Wgc, Method::Dxgi] {
            let mut singles = Vec::new();
            let mut alls = Vec::new();
            for run in 0..RUNS {
                let t = std::time::Instant::now();
                // All monitors in parallel, as the hotkey path does.
                std::thread::scope(|s| {
                    let hs: Vec<_> = monitors
                        .iter()
                        .map(|m| {
                            s.spawn(move || {
                                let t1 = std::time::Instant::now();
                                let r = grab_monitor(m, &[method]);
                                (r.is_ok(), t1.elapsed().as_secs_f64() * 1000.0)
                            })
                        })
                        .collect();
                    for h in hs {
                        if let Ok((ok, ms)) = h.join() {
                            if ok && run > 0 {
                                singles.push(ms);
                            }
                        }
                    }
                });
                if run > 0 {
                    alls.push(t.elapsed().as_secs_f64() * 1000.0);
                }
            }
            println!(
                "{:>4}: per-monitor median {:6.1} ms (min {:6.1}), all monitors median {:6.1} ms (min {:6.1}) over {} runs",
                method.name(),
                median(&mut singles),
                singles.iter().cloned().fold(f64::MAX, f64::min),
                median(&mut alls),
                alls.iter().cloned().fold(f64::MAX, f64::min),
                alls.len()
            );
        }
        // Encode cost for the primary monitor's pixels.
        let m = &monitors[0];
        let (f, _) = grab_monitor(m, &[Method::Gdi]).unwrap();
        let rgba = crate::geometry::crop_to_rgba(
            f.pixels(),
            f.width,
            IRect::new(0, 0, f.width as i32, f.height as i32),
            true,
            true,
        );
        let mut enc = Vec::new();
        let mut size = 0;
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let png = crate::imgio::encode_png_fast(f.width, f.height, &rgba).unwrap();
            enc.push(t.elapsed().as_secs_f64() * 1000.0);
            size = png.len();
        }
        let mut bmp_ms = Vec::new();
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let b = crate::bmp::from_rgba(f.width, f.height, &rgba);
            bmp_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(b);
        }
        let mut clone_ms = Vec::new();
        for _ in 0..5 {
            let t = std::time::Instant::now();
            let c = f.buf.clone();
            clone_ms.push(t.elapsed().as_secs_f64() * 1000.0);
            std::hint::black_box(c);
        }
        println!(
            "frame buffer clone (served to the webview) median {:.1} ms",
            median(&mut clone_ms)
        );
        println!(
            "primary {}x{}: png(fast) encode median {:.1} ms -> {:.2} MB; bmp build median {:.1} ms -> {:.2} MB",
            f.width,
            f.height,
            median(&mut enc),
            size as f64 / 1e6,
            median(&mut bmp_ms),
            (f.buf.len()) as f64 / 1e6
        );
    }

    fn median(v: &mut [f64]) -> f64 {
        if v.is_empty() {
            return f64::NAN;
        }
        v.sort_by(|a, b| a.total_cmp(b));
        v[v.len() / 2]
    }
}
