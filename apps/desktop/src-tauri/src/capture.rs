//! The capture critical path: hotkey -> frozen frames -> overlays -> selection -> preview.
//!
//! Timeline (all logged to `timings.log`):
//!   hotkey -> frames grabbed -> overlays armed -> overlay shown   (target: well under 500 ms)
//!   commit -> crop -> preview shown                               (target: tens of ms)

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::cropping::{crop_region, CommitRequest};
use crate::geometry::{clamp_to_frame, crop_to_rgba, visible_frame_crop, FBox, IRect};
use crate::grab;
use crate::imgio;
use crate::recorder;
use crate::routes::{overlay_index, overlay_label};
use crate::session;
use crate::settings::AfterCapture;
use crate::state::{register_capture, state, Mode, Purpose, Session};
use crate::store::{CaptureMeta, Frame, Source};
use crate::winmgr;
use crate::winutil::{self, MonitorInfo, WinEntry};
use crate::{clipboard, timing, tlog};

/// Frozen sessions older than this are considered abandoned and replaced.
const SESSION_TTL_SECS: u64 = 120;

// ---- IPC payloads ----------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
pub struct WindowInfo {
    pub hwnd: i64,
    pub title: String,
    pub app: String,
    pub rect: FBox,
    pub monitor: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct OverlayInfo {
    pub monitor: usize,
    pub scale: f64,
    pub bounds: FBox,
    pub windows: Vec<WindowInfo>,
    /// Current arm nonce and mode, so an overlay that loaded late can catch up.
    pub nonce: u64,
    pub mode: Mode,
    pub purpose: Purpose,
}

#[derive(Debug, Clone, Serialize)]
struct ArmPayload {
    nonce: u64,
    mode: Mode,
    purpose: Purpose,
    cursor: Option<CursorPos>,
}

#[derive(Debug, Clone, Copy, Serialize)]
struct CursorPos {
    x: i32,
    y: i32,
}

// ---- start -----------------------------------------------------------------------------------

/// Hotkey / tray / `capture_start` entry point. Returns immediately; the work runs on a thread.
pub fn start(app: &AppHandle, mode: Mode, purpose: Purpose) {
    let app = app.clone();
    let t0 = Instant::now();
    // Scrolling captures pick a window and GIFs pick a region, whatever the caller asked for.
    let mode = match purpose {
        Purpose::Scroll => Mode::Window,
        Purpose::Gif => Mode::Region,
        Purpose::Capture => mode,
    };
    std::thread::spawn(move || {
        if let Err(e) = start_blocking(&app, mode, purpose, t0) {
            tlog!("capture start failed: {e}");
            winmgr::hide_overlays(&app);
            if let Ok(mut s) = state(&app).session.lock() {
                *s = None;
            }
            let _ = app.emit_to("preview", "capture:error", e);
        }
    });
}

fn start_blocking(
    app: &AppHandle,
    mode: Mode,
    purpose: Purpose,
    t0: Instant,
) -> Result<(), String> {
    let st = state(app);
    // A running scroll capture or GIF recording owns the screen: ignore the hotkey meanwhile.
    if st.recording.lock().is_ok_and(|r| r.is_some()) {
        return Ok(());
    }
    // One grab at a time: a double tap of the hotkey (or the hotkey and the tray item) would
    // otherwise grab every monitor twice and race two sessions against each other.
    let Some(_flight) = st.start_flight.try_begin() else {
        tlog!("capture start ignored: another start is already grabbing the screen");
        return Ok(());
    };
    {
        let mut guard = st.session.lock().map_err(|_| "Capture is busy.")?;
        if let Some(s) = guard.as_ref() {
            if !s.committed && s.started.elapsed().as_secs() < SESSION_TTL_SECS {
                return Ok(()); // already capturing; ignore the repeated hotkey
            }
        }
        *guard = None;
    }

    let monitors = winutil::enumerate_monitors()?;
    let order = grab::monitor_order();

    // Grab every monitor and enumerate windows concurrently; the frozen frame is the priority.
    let (frames, windows) = std::thread::scope(|scope| {
        let win_job = scope.spawn(|| winutil::enumerate_windows(&monitors));
        let jobs: Vec<_> = monitors
            .iter()
            .map(|m| {
                let order = &order;
                scope.spawn(move || {
                    let t = Instant::now();
                    let r = grab::grab_monitor(m, order);
                    (r, timing::ms(t))
                })
            })
            .collect();
        let frames: Vec<_> = jobs.into_iter().map(|j| j.join()).collect();
        (frames, win_job.join())
    });
    let windows = windows.unwrap_or_default();

    let mut arcs = Vec::with_capacity(monitors.len());
    for (m, res) in monitors.iter().zip(frames) {
        let (r, ms) = res.map_err(|_| "A screen grab thread crashed.".to_string())?;
        let (frame, method) = r?;
        tlog!(
            "grab monitor {} {}x{} via {} in {ms:.1} ms",
            m.index,
            frame.width,
            frame.height,
            method.name()
        );
        arcs.push(Arc::new(frame));
    }
    tlog!("hotkey->frames grabbed {:.1} ms", timing::ms(t0));

    // Overlays are pre-created; rebuild only after a monitor layout change.
    let rebuilt = winmgr::ensure_overlays(app, &monitors)?;

    let nonce = st.nonce.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut guard = st.session.lock().map_err(|_| "Capture is busy.")?;
        *guard = Some(Session {
            nonce,
            mode,
            purpose,
            started: t0,
            monitors: monitors.clone(),
            frames: arcs,
            windows,
            committed: false,
            first_shown: false,
        });
    }

    let cursor = winutil::cursor_pos().map(|(x, y)| CursorPos { x, y });
    for m in &monitors {
        let _ = app.emit_to(
            overlay_label(m.index).as_str(),
            "overlay:arm",
            ArmPayload {
                nonce,
                mode,
                purpose,
                cursor,
            },
        );
    }
    tlog!(
        "hotkey->overlays armed {:.1} ms{}",
        timing::ms(t0),
        if rebuilt { " (overlays rebuilt)" } else { "" }
    );
    Ok(())
}

// ---- overlay side ----------------------------------------------------------------------------

fn overlay_monitor(window: &WebviewWindow) -> Result<usize, String> {
    overlay_index(window.label()).ok_or_else(|| "Not an overlay window.".to_string())
}

pub fn overlay_info(app: &AppHandle, window: &WebviewWindow) -> Result<OverlayInfo, String> {
    let idx = overlay_monitor(window)?;
    let st = state(app);
    let guard = st.session.lock().map_err(|_| "Capture is busy.")?;
    let s = guard
        .as_ref()
        .filter(|s| !s.committed)
        .ok_or("No capture is in progress.")?;
    tlog!("t+{:.1} ms overlay_info requested", timing::ms(s.started));
    let m = s.monitors.get(idx).ok_or("Unknown monitor.")?;
    let windows = s
        .windows
        .iter()
        .filter(|w| w.rect.intersect(&m.bounds).is_some())
        .map(|w| WindowInfo {
            hwnd: w.hwnd as i64,
            title: w.title.clone(),
            app: w.app.clone(),
            rect: w.rect.into(),
            monitor: w.monitor,
        })
        .collect();
    Ok(OverlayInfo {
        monitor: idx,
        scale: m.scale,
        bounds: m.bounds.into(),
        windows,
        nonce: s.nonce,
        mode: s.mode,
        purpose: s.purpose,
    })
}

/// The overlay decoded its frozen frame: show it. The window under the cursor takes focus.
pub fn overlay_ready(
    app: &AppHandle,
    window: &WebviewWindow,
    nonce: u64,
    decode_ms: Option<f64>,
) -> Result<(), String> {
    let idx = overlay_monitor(window)?;
    let st = state(app);
    let (bounds, first, started) = {
        let mut guard = st.session.lock().map_err(|_| "Capture is busy.")?;
        let s = guard.as_mut().ok_or("No capture is in progress.")?;
        if s.nonce != nonce {
            return Ok(()); // stale arm
        }
        let first = !s.first_shown;
        s.first_shown = true;
        let b = s.monitors.get(idx).ok_or("Unknown monitor.")?.bounds;
        (b, first, s.started)
    };
    tlog!("t+{:.1} ms overlay_ready received", timing::ms(started));
    let _ = window.set_always_on_top(true);
    window.show().map_err(|e| e.to_string())?;
    tlog!("t+{:.1} ms window.show returned", timing::ms(started));
    let has_cursor = winutil::cursor_pos().is_some_and(|(x, y)| bounds.contains(x, y));
    if has_cursor || first {
        if let Ok(hwnd) = window.hwnd() {
            winutil::force_foreground(hwnd);
        }
        let _ = window.set_focus();
    }
    tlog!(
        "hotkey->overlay {} shown {:.1} ms (frame decode in webview: {})",
        idx,
        timing::ms(started),
        decode_ms.map_or("n/a".to_string(), |d| format!("{d:.1} ms"))
    );
    Ok(())
}

pub fn overlay_focus(window: &WebviewWindow) -> Result<(), String> {
    overlay_monitor(window)?;
    if let Ok(hwnd) = window.hwnd() {
        winutil::force_foreground(hwnd);
    }
    window.set_focus().map_err(|e| e.to_string())
}

/// Mirror a mode switch (Space) to every overlay and remember it.
pub fn set_mode(app: &AppHandle, mode: Mode) -> Result<(), String> {
    let st = state(app);
    let labels: Vec<String> = {
        let mut guard = st.session.lock().map_err(|_| "Capture is busy.")?;
        let s = guard.as_mut().ok_or("No capture is in progress.")?;
        s.mode = mode;
        (0..s.monitors.len()).map(overlay_label).collect()
    };
    for label in labels {
        let _ = app.emit_to(label.as_str(), "overlay:mode", mode);
    }
    Ok(())
}

pub fn cancel(app: &AppHandle) {
    winmgr::hide_overlays(app);
    let old = state(app).session.lock().ok().and_then(|mut g| g.take());
    // Freeing tens of megabytes of frames is not worth blocking the caller for.
    std::thread::spawn(move || drop(old));
    tlog!("capture cancelled");
}

// ---- commit ----------------------------------------------------------------------------------

/// A commit is done with the screen: drop its session and hide the overlays, but only while that
/// session is still the current one. A window capture can take hundreds of milliseconds, long
/// enough for the user to start a new capture; its session and overlays are not ours to remove.
fn release_session(app: &AppHandle, nonce: u64) {
    let (owns, old) = match state(app).session.lock() {
        Ok(mut g) => session::release(&mut g, nonce),
        Err(_) => (true, None),
    };
    if owns {
        winmgr::hide_overlays(app);
    }
    // Freeing tens of megabytes of frames is not worth blocking the caller for.
    std::thread::spawn(move || drop(old));
}

struct Snapshot {
    /// Nonce of the session this commit came from; see `session::release`.
    nonce: u64,
    purpose: Purpose,
    started: Instant,
    monitors: Vec<MonitorInfo>,
    frames: Vec<Arc<Frame>>,
    windows: Vec<WinEntry>,
}

fn take_snapshot(app: &AppHandle) -> Result<Snapshot, String> {
    let st = state(app);
    let mut guard = st.session.lock().map_err(|_| "Capture is busy.")?;
    let s = guard.as_mut().ok_or("No capture is in progress.")?;
    if s.committed {
        return Err("A capture is already being saved.".to_string());
    }
    s.committed = true;
    Ok(Snapshot {
        nonce: s.nonce,
        purpose: s.purpose,
        started: s.started,
        monitors: s.monitors.clone(),
        frames: s.frames.clone(),
        windows: s.windows.clone(),
    })
}

/// Pixels of a region of one frozen monitor frame, as RGBA.
fn region_pixels(
    snap: &Snapshot,
    monitor: usize,
    rect: IRect,
) -> Result<(u32, u32, Vec<u8>), String> {
    let frame = snap.frames.get(monitor).ok_or("Unknown monitor.")?;
    crop_region(frame, rect)
}

/// Pixels of a window: live WGC capture (works when occluded), or a crop of the frozen frame.
fn window_pixels(snap: &Snapshot, hwnd: isize) -> Result<(u32, u32, Vec<u8>), String> {
    let win = snap
        .windows
        .iter()
        .find(|w| w.hwnd == hwnd)
        .ok_or("That window is no longer available.")?;

    let t = Instant::now();
    match grab::grab_wgc_window(hwnd) {
        Ok(frame) => {
            tlog!("window via wgc {:.1} ms", timing::ms(t));
            let full = IRect::new(0, 0, frame.width as i32, frame.height as i32);
            let crop = visible_frame_crop(frame.width, frame.height, win.window_rect, win.rect)
                .unwrap_or(full);
            let mut rgba = crop_to_rgba(frame.pixels(), frame.width, crop, true, false);
            // Some surfaces report alpha 0 everywhere; treat those as opaque.
            if rgba.chunks_exact(4).all(|p| p[3] == 0) {
                for p in rgba.chunks_exact_mut(4) {
                    p[3] = 255;
                }
            }
            return Ok((crop.w as u32, crop.h as u32, rgba));
        }
        Err(e) => tlog!("window wgc failed, cropping frozen frame: {e}"),
    }

    // Fallback: whatever of the window was visible when the hotkey fired.
    let rects: Vec<IRect> = snap.monitors.iter().map(|m| m.bounds).collect();
    let idx =
        crate::geometry::best_monitor(&win.rect, &rects).ok_or("The window is off screen.")?;
    let m = &snap.monitors[idx];
    let visible = win
        .rect
        .intersect(&m.bounds)
        .ok_or("The window is off screen.")?
        .translated(m.bounds.x, m.bounds.y);
    region_pixels(snap, idx, visible)
}

pub fn commit(app: &AppHandle, req: CommitRequest) -> Result<Option<CaptureMeta>, String> {
    let t_commit = Instant::now();
    let snap = take_snapshot(app)?;
    let result = match snap.purpose {
        Purpose::Capture => commit_capture(app, req, &snap, t_commit).map(Some),
        Purpose::Scroll | Purpose::Gif => commit_recording(app, req, &snap).map(|()| None),
    };
    if result.is_err() {
        // Allow another attempt: the overlay stays up and the session stays valid. Only this
        // commit's own session is reopened; a newer capture that started meanwhile is left alone.
        if let Ok(mut g) = state(app).session.lock() {
            session::reopen(&mut g, snap.nonce);
        }
    }
    result
}

/// A selection that starts a scrolling capture or GIF recording instead of a screenshot.
fn commit_recording(app: &AppHandle, req: CommitRequest, snap: &Snapshot) -> Result<(), String> {
    match (snap.purpose, req) {
        (Purpose::Scroll, CommitRequest::Window { hwnd }) => {
            let hwnd = isize::try_from(hwnd).map_err(|_| "Invalid window.".to_string())?;
            let win = snap
                .windows
                .iter()
                .find(|w| w.hwnd == hwnd)
                .cloned()
                .ok_or("That window is no longer available.")?;
            let rects: Vec<IRect> = snap.monitors.iter().map(|m| m.bounds).collect();
            let idx = crate::geometry::best_monitor(&win.rect, &rects)
                .ok_or("The window is off screen.")?;
            recorder::start_scroll(app, win, snap.monitors[idx].clone())?;
        }
        (Purpose::Gif, CommitRequest::Region { monitor, rect }) => {
            let m = snap
                .monitors
                .get(monitor)
                .cloned()
                .ok_or("Unknown monitor.")?;
            let local = clamp_to_frame(rect.to_irect()?, m.bounds.w as u32, m.bounds.h as u32)?;
            let global = local.translated(-m.bounds.x, -m.bounds.y);
            recorder::start_gif(app, global, m)?;
        }
        (Purpose::Scroll, _) => return Err("Click a window to scroll-capture.".to_string()),
        (Purpose::Gif, _) => return Err("Drag the area to record.".to_string()),
        (Purpose::Capture, _) => return Err("Internal error: not a recording.".to_string()),
    }
    release_session(app, snap.nonce);
    tlog!("recording started from the overlay");
    Ok(())
}

fn commit_capture(
    app: &AppHandle,
    req: CommitRequest,
    snap: &Snapshot,
    t_commit: Instant,
) -> Result<CaptureMeta, String> {
    let result = (|| -> Result<(u32, u32, Vec<u8>, Source), String> {
        match req {
            CommitRequest::Region { monitor, rect } => {
                let (w, h, px) = region_pixels(snap, monitor, rect.to_irect()?)?;
                Ok((w, h, px, Source::Region))
            }
            CommitRequest::Window { hwnd } => {
                let hwnd = isize::try_from(hwnd).map_err(|_| "Invalid window.".to_string())?;
                let (w, h, px) = window_pixels(snap, hwnd)?;
                Ok((w, h, px, Source::Window))
            }
        }
    })();

    let (w, h, rgba, source) = result?;
    let t_crop = timing::ms(t_commit);

    let after = state(app).settings().after_capture;
    let for_clipboard = (after == AfterCapture::Copy).then(|| rgba.clone());
    let meta = register_capture(app, w, h, rgba, source);
    tlog!("commit registered capture {:.1} ms", timing::ms(t_commit));

    // Tell the preview about the new capture *before* the window appears, so it never shows the
    // previous capture for a frame. Then the preview goes up and the overlays drop, in that order,
    // so the desktop never flashes between them.
    let _ = app.emit_to("preview", "capture:ready", &meta);
    if after == AfterCapture::Preview {
        winmgr::show_preview(app);
    }
    tlog!("commit preview shown {:.1} ms", timing::ms(t_commit));
    release_session(app, snap.nonce);
    tlog!(
        "commit->preview shown {:.1} ms (crop {t_crop:.1} ms); hotkey->preview {:.1} ms",
        timing::ms(t_commit),
        timing::ms(snap.started)
    );

    if let Some(px) = for_clipboard {
        let app2 = app.clone();
        let (cw, ch) = (w, h);
        std::thread::spawn(move || {
            if let Err(e) = copy_rgba_to_clipboard(&app2, cw, ch, px) {
                tlog!("copy after capture failed: {e}");
            }
        });
    }

    Ok(meta)
}

fn copy_rgba_to_clipboard(app: &AppHandle, w: u32, h: u32, rgba: Vec<u8>) -> Result<(), String> {
    let png = imgio::encode_png_fast(w, h, &rgba)?;
    let hwnd = app
        .get_webview_window(winmgr::PREVIEW)
        .ok_or("The main window is not available.")?
        .hwnd()
        .map_err(|e| e.to_string())?;
    clipboard::set_image(
        hwnd,
        &png,
        &imgio::Decoded {
            width: w,
            height: h,
            rgba,
        },
    )
}

/// Which grab methods are in play (for diagnostics in `app_info`-style logging).
pub fn describe_methods() -> String {
    grab::monitor_order()
        .iter()
        .map(|m| m.name())
        .collect::<Vec<_>>()
        .join(">")
}
