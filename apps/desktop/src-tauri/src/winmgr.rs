//! Window lifecycle: the hidden `preview` window (Mica with a solid fallback), one hidden
//! `overlay-<n>` per monitor, and `pin-<id>` windows.

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder, WindowEvent,
};

use crate::routes::{overlay_index, overlay_label};
use crate::state::state;
use crate::store::CaptureMeta;
use crate::tlog;
use crate::winutil::{self, MonitorInfo};

pub const PREVIEW: &str = "preview";

/// Lock a window's webview to the app's own pages: navigation anywhere else is blocked and
/// `window.open` is refused. Every window the app creates goes through this.
pub fn harden<'a, R: tauri::Runtime, M: Manager<R>>(
    builder: WebviewWindowBuilder<'a, R, M>,
) -> WebviewWindowBuilder<'a, R, M> {
    builder
        .on_navigation(|url| {
            let allowed = crate::routes::is_app_origin(
                url.scheme(),
                url.host_str(),
                url.port(),
                cfg!(debug_assertions),
            );
            if !allowed {
                tlog!("blocked a navigation to a foreign page");
            }
            allowed
        })
        .on_new_window(|_url, _features| tauri::webview::NewWindowResponse::Deny)
}
pub const PREVIEW_SIZE: (f64, f64) = (1040.0, 680.0);

pub fn create_preview(app: &AppHandle) -> Result<WebviewWindow, String> {
    let title = app
        .config()
        .product_name
        .clone()
        .unwrap_or_else(|| "Preview".to_string());
    let win = harden(WebviewWindowBuilder::new(
        app,
        PREVIEW,
        WebviewUrl::App("index.html".into()),
    ))
    .title(title)
    .inner_size(PREVIEW_SIZE.0, PREVIEW_SIZE.1)
    .min_inner_size(720.0, 480.0)
    .center()
    .visible(false)
    .focused(false)
    // The preview draws its own title bar and window controls (CONTRACT-CHANGES, preview UI).
    .decorations(false)
    .transparent(true)
    .build()
    .map_err(|e| format!("Could not create the preview window: {e}"))?;

    // Mica needs Windows 11; anything else keeps a solid backdrop.
    let backdrop = match window_vibrancy::apply_mica(&win, None) {
        Ok(()) => "mica",
        Err(_) => "solid",
    };
    if let Ok(mut b) = state(app).backdrop.lock() {
        *b = backdrop;
    }
    tlog!("preview backdrop: {backdrop}");

    // Closing the preview hides it; the app lives in the tray.
    let w2 = win.clone();
    win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = w2.hide();
        }
    });
    Ok(win)
}

/// How long a commit holds the frozen overlay for the preview's acknowledgement.
const PREVIEW_ACK_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(400);

/// Tell the preview about a new capture and, if `show`, bring its window up.
///
/// The event goes out first, so the preview starts loading the image while its window is still
/// hidden. When the UI has shown it acknowledges captures (`preview_ready`), the window is raised
/// only once it has acknowledged this one (or 400 ms have passed), and the caller keeps the
/// overlay's frozen frame on screen meanwhile: the user sees the frozen screen, then the finished
/// preview, never an empty card. A UI that does not acknowledge gets the previous behaviour: the
/// window is shown right after the event.
pub fn announce_capture(app: &AppHandle, meta: &CaptureMeta, show: bool) {
    let gate = &state(app).preview_gate;
    let wait = show && gate.supported();
    if wait {
        gate.begin(&meta.id);
    }
    let _ = app.emit_to(PREVIEW, "capture:ready", meta);
    if !show {
        return;
    }
    if wait {
        let t = std::time::Instant::now();
        let acked = gate.wait(PREVIEW_ACK_TIMEOUT);
        tlog!(
            "preview {} after {:.1} ms",
            if acked { "ready" } else { "did not answer" },
            crate::timing::ms(t)
        );
    }
    show_preview(app);
}

pub fn show_preview(app: &AppHandle) {
    let Some(win) = app.get_webview_window(PREVIEW) else {
        return;
    };
    let _ = win.unminimize();
    let _ = win.show();
    if let Ok(hwnd) = win.hwnd() {
        winutil::force_foreground(hwnd);
    }
    let _ = win.set_focus();
}

/// Create one hidden fullscreen overlay per monitor. Existing overlays are closed first.
pub fn rebuild_overlays(app: &AppHandle, monitors: &[MonitorInfo]) -> Result<(), String> {
    for (label, win) in app.webview_windows() {
        if overlay_index(&label).is_some() {
            let _ = win.destroy();
        }
    }
    for m in monitors {
        let label = overlay_label(m.index);
        let win = harden(WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App("overlay.html".into()),
        ))
        .title("")
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .shadow(false)
        .maximizable(false)
        .minimizable(false)
        .visible(false)
        .focused(false)
        .build()
        .map_err(|e| format!("Could not create the capture overlay: {e}"))?;
        place_overlay(&win, m);
    }
    if let Ok(mut layout) = state(app).overlay_layout.lock() {
        *layout = monitors.iter().map(MonitorInfo::fingerprint).collect();
    }
    tlog!("overlays rebuilt for {} monitor(s)", monitors.len());
    Ok(())
}

/// Position in physical pixels. Moving between monitors of different DPI can make Windows rescale
/// the window, so size is applied again after the move.
fn place_overlay(win: &WebviewWindow, m: &MonitorInfo) {
    let pos = PhysicalPosition::new(m.bounds.x, m.bounds.y);
    let size = PhysicalSize::new(m.bounds.w as u32, m.bounds.h as u32);
    let _ = win.set_size(size);
    let _ = win.set_position(pos);
    let _ = win.set_size(size);
}

/// Rebuild the overlays only when the monitor layout changed since they were created.
/// Returns true if they were rebuilt.
pub fn ensure_overlays(app: &AppHandle, monitors: &[MonitorInfo]) -> Result<bool, String> {
    let wanted: Vec<_> = monitors.iter().map(MonitorInfo::fingerprint).collect();
    let current = state(app)
        .overlay_layout
        .lock()
        .map(|l| l.clone())
        .unwrap_or_default();
    let all_present = monitors
        .iter()
        .all(|m| app.get_webview_window(&overlay_label(m.index)).is_some());
    if current == wanted && all_present {
        return Ok(false);
    }
    rebuild_overlays(app, monitors)?;
    Ok(true)
}

pub fn hide_overlays(app: &AppHandle) {
    for (label, win) in app.webview_windows() {
        if overlay_index(&label).is_some() {
            let _ = win.hide();
        }
    }
}
