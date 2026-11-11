//! Pin to screen: a borderless, always-on-top, resizable window showing one capture.
//! The page (`pin.html`) handles Esc, wheel-opacity and dragging.

use tauri::{
    AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

use crate::ids::validate_id;
use crate::imgio;
use crate::pinmath::{fit_size, label_for, min_size};
use crate::state::state;
use crate::winutil;

fn dimensions(app: &AppHandle, id: &str) -> Result<(u32, u32), String> {
    let st = state(app);
    if let Ok(mut store) = st.store.lock() {
        if let Some(c) = store.get(id) {
            return Ok((c.meta.width, c.meta.height));
        }
    }
    if let Ok(Some(row)) = st.history.get(id) {
        return Ok((row.width, row.height));
    }
    let path = st.paths.capture_file(id).ok_or("Invalid capture id.")?;
    let bytes =
        std::fs::read(path).map_err(|_| "That capture is no longer available.".to_string())?;
    imgio::probe_dimensions(&bytes)
}

pub fn open(app: &AppHandle, id: &str) -> Result<(), String> {
    validate_id(id)?;
    let label = label_for(id);
    if let Some(existing) = app.get_webview_window(&label) {
        let _ = existing.show();
        let _ = existing.set_focus();
        return Ok(());
    }
    let (w, h) = dimensions(app, id)?;
    let monitors = winutil::enumerate_monitors()?;
    let cursor = winutil::cursor_pos();
    let mon = cursor
        .and_then(|(x, y)| monitors.iter().find(|m| m.bounds.contains(x, y)))
        .or_else(|| monitors.iter().find(|m| m.primary))
        .or_else(|| monitors.first())
        .ok_or("No monitor found.")?;
    let (lw, lh) = fit_size(w, h, mon.scale, mon.bounds.w, mon.bounds.h);
    let (min_w, min_h) = min_size(lw, lh);

    let win: WebviewWindow = crate::winmgr::harden(WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("pin.html?id={id}").into()),
    ))
    .title("")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .resizable(true)
    .skip_taskbar(true)
    .shadow(true)
    .inner_size(lw, lh)
    .min_inner_size(min_w, min_h)
    .focused(true)
    .build()
    .map_err(|e| format!("Could not pin the image: {e}"))?;

    // Centre on the cursor's monitor.
    let pw = (lw * mon.scale).round() as i32;
    let ph = (lh * mon.scale).round() as i32;
    let x = mon.bounds.x + (mon.bounds.w - pw) / 2;
    let y = mon.bounds.y + (mon.bounds.h - ph) / 2;
    let _ = win.set_position(PhysicalPosition::new(x, y));
    Ok(())
}

pub fn close(window: &WebviewWindow) -> Result<(), String> {
    if !window.label().starts_with("pin-") {
        return Err("Not a pinned window.".to_string());
    }
    window.destroy().map_err(|e| e.to_string())
}
