//! Scrolling capture and GIF recording: owns the worker threads and the small status windows
//! (pill, recording border, controls, toast). All status windows are excluded from screen capture
//! (`content_protected`), so they never appear in the result even when they overlap it.

use std::io::BufWriter;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

use crate::export::{query_escape, unique_path};
use crate::geometry::IRect;
use crate::gifrec::{self, RecordConfig, RecordEnd};
use crate::ids::now_millis;
use crate::layout::{border_rect, controls_rect, pill_rect, toast_rect};
use crate::scroll::{self, ScrollConfig, StopReason};
use crate::state::{register_capture, state};
use crate::store::Source;
use crate::winmgr;
use crate::winsrc::{PaneScroller, RegionGrabber};
use crate::winutil::{self, MonitorInfo, WinEntry};
use crate::{timing, tlog};

/// Never record a region smaller than this (physical pixels).
const MIN_REGION: i32 = 16;

// ---- job bookkeeping -------------------------------------------------------------------------

fn begin_job(app: &AppHandle) -> Result<Arc<AtomicBool>, String> {
    let st = state(app);
    let mut slot = st
        .recording
        .lock()
        .map_err(|_| "A recording is already running.".to_string())?;
    if slot.is_some() {
        return Err("A recording is already running. Press Esc to stop it first.".to_string());
    }
    let flag = Arc::new(AtomicBool::new(false));
    *slot = Some(flag.clone());
    Ok(flag)
}

fn end_job(app: &AppHandle) {
    if let Ok(mut slot) = state(app).recording.lock() {
        *slot = None;
    }
}

/// Ask the running scroll capture or GIF recording to finish (no-op when idle).
pub fn stop(app: &AppHandle) {
    if let Ok(slot) = state(app).recording.lock() {
        if let Some(flag) = slot.as_ref() {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

// ---- status windows --------------------------------------------------------------------------

struct StatusSpec<'a> {
    label: &'a str,
    query: String,
    rect: IRect,
    click_through: bool,
}

fn open_status(app: &AppHandle, spec: StatusSpec<'_>) -> Result<WebviewWindow, String> {
    if let Some(old) = app.get_webview_window(spec.label) {
        let _ = old.destroy();
    }
    let win = WebviewWindowBuilder::new(
        app,
        spec.label,
        WebviewUrl::App(format!("status.html?{}", spec.query).into()),
    )
    .title("")
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(false)
    .shadow(false)
    .maximizable(false)
    .minimizable(false)
    .content_protected(true)
    .focused(false)
    .visible(false)
    .build()
    .map_err(|e| format!("Could not open the status window: {e}"))?;
    let _ = win.set_size(PhysicalSize::new(spec.rect.w as u32, spec.rect.h as u32));
    let _ = win.set_position(PhysicalPosition::new(spec.rect.x, spec.rect.y));
    let _ = win.set_size(PhysicalSize::new(spec.rect.w as u32, spec.rect.h as u32));
    if spec.click_through {
        let _ = win.set_ignore_cursor_events(true);
    }
    let _ = win.show();
    Ok(win)
}

fn close_status(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview_window(label) {
        let _ = w.destroy();
    }
}

fn show_toast(
    app: &AppHandle,
    monitor: &MonitorInfo,
    kind: &str,
    name: &str,
    size: u64,
    path: &str,
    message: &str,
) {
    let query = format!(
        "view=toast&kind={}&name={}&size={}&path={}&message={}",
        query_escape(kind),
        query_escape(name),
        size,
        query_escape(path),
        query_escape(message)
    );
    let rect = toast_rect(&monitor.bounds, monitor.scale);
    if let Err(e) = open_status(
        app,
        StatusSpec {
            label: "status-toast",
            query,
            rect,
            click_through: false,
        },
    ) {
        tlog!("toast failed: {e}");
    }
}

// ---- scrolling capture -----------------------------------------------------------------------

/// Begin a scrolling capture of `win`. Returns once the worker is running.
pub fn start_scroll(app: &AppHandle, win: WinEntry, monitor: MonitorInfo) -> Result<(), String> {
    let stop = begin_job(app)?;
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = run_scroll(&app, &win, &monitor, stop);
        end_job(&app);
        if let Err(e) = outcome {
            tlog!("scroll capture failed: {e}");
            show_toast(&app, &monitor, "error", "", 0, "", &e);
        }
    });
    Ok(())
}

fn run_scroll(
    app: &AppHandle,
    win: &WinEntry,
    monitor: &MonitorInfo,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    let t0 = Instant::now();
    let pane = winutil::client_rect_global(win.hwnd)
        .unwrap_or(win.rect)
        .intersect(&monitor.bounds)
        .ok_or("That window is not on screen.")?;
    if pane.w < 64 || pane.h < 96 {
        return Err("That window is too small to scroll-capture.".to_string());
    }
    let saved_cursor = winutil::cursor_pos();

    // Bring the window forward and let the overlays finish disappearing.
    winutil::force_foreground(windows::Win32::Foundation::HWND(
        win.hwnd as *mut std::ffi::c_void,
    ));
    std::thread::sleep(Duration::from_millis(250));

    let pill = pill_rect(&monitor.bounds, monitor.scale);
    let _ = open_status(
        app,
        StatusSpec {
            label: "status-pill",
            query: "view=pill".to_string(),
            rect: pill,
            click_through: true,
        },
    );

    let mut src = PaneScroller {
        pane,
        stop: stop.clone(),
    };
    let result = scroll::run(&mut src, &ScrollConfig::default());
    close_status(app, "status-pill");
    if let Some((x, y)) = saved_cursor {
        let _ = winutil::set_cursor_pos(x, y);
    }
    let out = result?;
    tlog!(
        "scroll capture: {} steps, {}x{} px, stopped by {:?} in {:.0} ms",
        out.steps,
        out.frame.width,
        out.frame.height,
        out.reason,
        timing::ms(t0)
    );

    let meta = register_capture(
        app,
        out.frame.width,
        out.frame.height,
        out.frame.rgba,
        Source::Scroll,
    );
    winmgr::show_preview(app);
    let _ = app.emit_to(winmgr::PREVIEW, "capture:ready", &meta);
    if matches!(out.reason, StopReason::StitchFailed) {
        // The image is still delivered; say why it may end early.
        show_toast(
            app,
            monitor,
            "error",
            "",
            0,
            "",
            "The page could not be stitched past a point. The part captured so far is in the preview.",
        );
    }
    Ok(())
}

// ---- GIF recording ---------------------------------------------------------------------------

/// Begin recording `region` (global physical pixels) to a GIF in the save folder.
pub fn start_gif(app: &AppHandle, region: IRect, monitor: MonitorInfo) -> Result<(), String> {
    if region.w < MIN_REGION || region.h < MIN_REGION {
        return Err("Select a larger area to record.".to_string());
    }
    let folder = state(app).settings().save_folder;
    crate::settings::validate_save_folder(&folder)?;
    let stop = begin_job(app)?;
    let app = app.clone();
    std::thread::spawn(move || {
        let outcome = run_gif(&app, region, &monitor, &folder, stop);
        close_status(&app, "status-border");
        close_status(&app, "status-controls");
        end_job(&app);
        match outcome {
            Ok((path, bytes)) => {
                let name = path
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let path_str = path.to_string_lossy().into_owned();
                let _ = app.emit_to(
                    winmgr::PREVIEW,
                    "gif:saved",
                    serde_json::json!({ "path": path_str, "name": name, "bytes": bytes }),
                );
                show_toast(&app, &monitor, "gif", &name, bytes, &path_str, "");
            }
            Err(e) => {
                tlog!("gif recording failed: {e}");
                show_toast(&app, &monitor, "error", "", 0, "", &e);
            }
        }
    });
    Ok(())
}

fn run_gif(
    app: &AppHandle,
    region: IRect,
    monitor: &MonitorInfo,
    folder: &str,
    stop: Arc<AtomicBool>,
) -> Result<(PathBuf, u64), String> {
    let t0 = Instant::now();
    // The overlays are being hidden; keep them out of the first frame.
    std::thread::sleep(Duration::from_millis(200));
    let dir = PathBuf::from(folder.trim());
    std::fs::create_dir_all(&dir)
        .map_err(|_| "The save folder could not be created.".to_string())?;
    let name = gifrec::recording_file_name(now_millis() / 1000);
    let path = unique_path(&dir, &name, |p| p.exists());
    let file = std::fs::File::create(&path)
        .map_err(|_| "The recording could not be saved to the save folder.".to_string())?;

    // Recording frame just outside the region, and the controls beside it.
    let border = border_rect(&region);
    let _ = open_status(
        app,
        StatusSpec {
            label: "status-border",
            query: "view=border".to_string(),
            rect: border,
            click_through: true,
        },
    );
    let _ = open_status(
        app,
        StatusSpec {
            label: "status-controls",
            query: "view=controls".to_string(),
            rect: controls_rect(&region, &monitor.bounds, monitor.scale),
            click_through: false,
        },
    );

    // Timer ticks for the controls window.
    let cfg = RecordConfig::default();
    let tick_stop = stop.clone();
    let tick_app = app.clone();
    let max_ms = (cfg.max_secs * 1000.0) as u64;
    let ticker = std::thread::spawn(move || {
        let start = Instant::now();
        while !tick_stop.load(Ordering::Relaxed) && (start.elapsed().as_millis() as u64) < max_ms {
            let _ = tick_app.emit_to(
                "status-controls",
                "status:tick",
                serde_json::json!({ "elapsedMs": start.elapsed().as_millis() as u64, "maxMs": max_ms }),
            );
            std::thread::sleep(Duration::from_millis(250));
        }
    });

    let mut src = RegionGrabber {
        region,
        stop: stop.clone(),
    };
    let res = gifrec::record(&mut src, BufWriter::new(file), cfg);
    stop.store(true, Ordering::Relaxed);
    let _ = ticker.join();
    let (writer, stats) = match res {
        Ok(v) => v,
        Err(e) => {
            let _ = std::fs::remove_file(&path);
            return Err(e);
        }
    };
    // Flush and close the file before measuring it.
    drop(
        writer
            .into_inner()
            .map_err(|_| "The recording could not be written.".to_string())?,
    );
    let bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    tlog!(
        "gif recording: {} ticks, {} gif frames, {:.1} s, {} bytes, ended by {:?}, total {:.0} ms",
        stats.ticks,
        stats.gif_frames,
        stats.elapsed.as_secs_f64(),
        bytes,
        stats.end,
        timing::ms(t0)
    );
    if stats.end == RecordEnd::GrabFailed && stats.ticks == 0 {
        let _ = std::fs::remove_file(&path);
        return Err("The screen could not be recorded.".to_string());
    }
    Ok((path, bytes))
}
