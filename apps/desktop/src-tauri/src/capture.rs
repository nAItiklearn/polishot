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
use crate::session::OnceSlot;
use crate::settings::AfterCapture;
use crate::state::{register_capture, state, FrameSlot, Mode, Purpose, Session, WindowsSlot};
use crate::store::{CaptureMeta, Source};
use crate::winmgr;
use crate::winutil::{self, MonitorInfo, WinEntry};
use crate::{clipboard, timing, tlog};

/// Frozen sessions older than this are considered abandoned and replaced.
const SESSION_TTL_SECS: u64 = 120;
/// How long the frozen frame of a monitor may take to arrive (for `/frame/<n>` and for a commit
/// that is made before the grab has finished).
pub const FRAME_WAIT: std::time::Duration = std::time::Duration::from_millis(5000);
/// How long a window commit waits for the window list.
const WINDOWS_WAIT: std::time::Duration = std::time::Duration::from_millis(3000);

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
    /// False while the window list is still being enumerated (see the `overlay:windows` event).
    #[serde(rename = "windowsReady")]
    pub windows_ready: bool,
    /// Current arm nonce and mode, so an overlay that loaded late can catch up.
    pub nonce: u64,
    pub mode: Mode,
    pub purpose: Purpose,
}

#[derive(Debug, Clone, Serialize)]
struct ArmPayload {
    /// Which monitor this overlay covers, so it can request `/frame/<monitor>` straight away.
    monitor: usize,
    nonce: u64,
    mode: Mode,
    purpose: Purpose,
    cursor: Option<CursorPos>,
}

/// Payload of `overlay:windows`: the window list arrived after the overlay was armed.
#[derive(Debug, Clone, Serialize)]
struct WindowsPayload {
    nonce: u64,
    windows: Vec<WindowInfo>,
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
    // Overlays are pre-created; rebuild only after a monitor layout change.
    let rebuilt = winmgr::ensure_overlays(app, &monitors)?;

    // The overlays are armed *before* the screen is grabbed: they open (dimmed, with the hint and
    // crosshair) at once and ask for their frozen frame, which the protocol handler answers as
    // soon as the grab below has filled its slot. Showing something in tens of milliseconds
    // instead of waiting for grab, transfer and image decode is what makes the hotkey feel instant.
    let frame_slots: Vec<Arc<FrameSlot>> = monitors.iter().map(|_| OnceSlot::new()).collect();
    let windows_slot: Arc<WindowsSlot> = OnceSlot::new();
    let nonce = st.nonce.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut guard = st.session.lock().map_err(|_| "Capture is busy.")?;
        *guard = Some(Session {
            nonce,
            mode,
            purpose,
            started: t0,
            monitors: monitors.clone(),
            frames: frame_slots.clone(),
            windows: windows_slot.clone(),
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
                monitor: m.index,
                nonce,
                mode,
                purpose,
                cursor,
            },
        );
    }
    // Wake the (hidden) preview too: the capture it is about to show is a moment away.
    let _ = app.emit_to(winmgr::PREVIEW, "capture:arming", ());
    tlog!(
        "hotkey->overlays armed {:.1} ms{}",
        timing::ms(t0),
        if rebuilt { " (overlays rebuilt)" } else { "" }
    );

    // Grab every monitor concurrently. The window list is needed at once only when the overlay
    // starts in window mode (or picks a window to scroll-capture); otherwise it is enumerated
    // after the frames so it never competes with them, and still arrives long before anyone
    // presses Space.
    let windows_first = mode == Mode::Window || purpose == Purpose::Scroll;
    std::thread::scope(|scope| {
        let early_windows = windows_first
            .then(|| scope.spawn(|| publish_windows(app, &monitors, nonce, &windows_slot)));
        let jobs: Vec<_> = monitors
            .iter()
            .zip(&frame_slots)
            .map(|(m, slot)| {
                let order = &order;
                scope.spawn(move || {
                    let t = Instant::now();
                    match grab::grab_monitor(m, order) {
                        Ok((frame, method)) => {
                            tlog!(
                                "grab monitor {} {}x{} via {} in {:.1} ms",
                                m.index,
                                frame.width,
                                frame.height,
                                method.name(),
                                timing::ms(t)
                            );
                            slot.set(Ok(Arc::new(frame)));
                        }
                        Err(e) => slot.set(Err(e)),
                    }
                })
            })
            .collect();
        for job in jobs {
            let _ = job.join();
        }
        // A grab thread that crashed never set its slot; nobody may wait for it forever.
        for slot in &frame_slots {
            slot.set(Err("A screen grab thread crashed.".to_string()));
        }
        if let Some(job) = early_windows {
            let _ = job.join();
        } else {
            publish_windows(app, &monitors, nonce, &windows_slot);
        }
    });
    tlog!("hotkey->frames grabbed {:.1} ms", timing::ms(t0));
    match frame_slots
        .iter()
        .find_map(|slot| slot.get().and_then(Result::err))
    {
        Some(e) => Err(e), // the caller hides the overlays and reports the error
        None => Ok(()),
    }
}

/// The overlay entries for the windows that touch monitor \`m\`.
fn window_infos(list: &[WinEntry], m: &MonitorInfo) -> Vec<WindowInfo> {
    list.iter()
        .filter(|w| w.rect.intersect(&m.bounds).is_some())
        .map(|w| WindowInfo {
            hwnd: w.hwnd as i64,
            title: w.title.clone(),
            app: w.app.clone(),
            rect: w.rect.into(),
            monitor: w.monitor,
        })
        .collect()
}

/// Enumerate the visible windows, publish them to the session, and tell every overlay (they may
/// already be open with an empty list).
fn publish_windows(app: &AppHandle, monitors: &[MonitorInfo], nonce: u64, slot: &WindowsSlot) {
    let t = Instant::now();
    let list = Arc::new(winutil::enumerate_windows(monitors));
    slot.set(Ok(list.clone()));
    tlog!(
        "enumerated {} windows in {:.1} ms",
        list.len(),
        timing::ms(t)
    );
    for m in monitors {
        let _ = app.emit_to(
            overlay_label(m.index).as_str(),
            "overlay:windows",
            WindowsPayload {
                nonce,
                windows: window_infos(&list, m),
            },
        );
    }
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
    // The list may still be coming (see `overlay:windows`); the overlay opens without it.
    let (windows, windows_ready) = match s.windows.get() {
        Some(Ok(list)) => (window_infos(&list, m), true),
        _ => (Vec::new(), false),
    };
    Ok(OverlayInfo {
        monitor: idx,
        scale: m.scale,
        bounds: m.bounds.into(),
        windows,
        windows_ready,
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
    frames: Vec<Arc<FrameSlot>>,
    windows: Arc<WindowsSlot>,
}

impl Snapshot {
    /// The window list; a commit that names a window has already seen it, so this returns at
    /// once, and an empty list is the safe answer if enumeration somehow failed.
    fn window_list(&self) -> Arc<Vec<WinEntry>> {
        self.windows.wait(WINDOWS_WAIT).unwrap_or_default()
    }
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
    // A very quick drag can commit before the grab has finished; wait for the frame.
    let frame = snap
        .frames
        .get(monitor)
        .ok_or("Unknown monitor.")?
        .wait(FRAME_WAIT)?;
    crop_region(&frame, rect)
}

/// Pixels of a window: live WGC capture (works when occluded), or a crop of the frozen frame.
fn window_pixels(snap: &Snapshot, hwnd: isize) -> Result<(u32, u32, Vec<u8>), String> {
    let windows = snap.window_list();
    let win = windows
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
                .window_list()
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

    // Tell the preview about the new capture *before* its window appears, and keep the overlay's
    // frozen frame on screen until the preview has the image drawn (or 400 ms pass), so the user
    // sees the frozen screen and then the finished preview, never an empty card. Then the preview
    // goes up and the overlays drop, in that order, so the desktop never flashes between them.
    winmgr::announce_capture(app, &meta, after == AfterCapture::Preview);
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
    // PNG first, bitmap formats a moment later (the pixels are in hand, so nothing is decoded).
    clipboard::copy_png_fast(
        hwnd,
        png,
        Some(imgio::Decoded {
            width: w,
            height: h,
            rgba,
        }),
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
