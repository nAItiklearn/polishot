//! Tauri commands: the IPC surface from CONTRACTS section 5. Every command validates its input
//! and returns `Result<_, String>` with a message a person can read.

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;

use crate::capture::{self, OverlayInfo};
use crate::cropping::CommitRequest;
use crate::history::HistoryItem;
use crate::ids::validate_id;
use crate::imgio;
use crate::license::{self, LicenseStatus};
use crate::ocr::OcrWord;
use crate::settings::{Settings, SettingsPatch};
use crate::state::{self, load_capture, state, Mode, Purpose};
use crate::store::{CaptureMeta, Source};
use crate::{clipboard, files, pin, quicksend, recorder, share, shortcuts, tray, winmgr};

type CmdResult<T> = Result<T, String>;

async fn blocking<T, F>(f: F) -> CmdResult<T>
where
    T: Send + 'static,
    F: FnOnce() -> CmdResult<T> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "The operation was interrupted.".to_string())?
}

/// Raw binary body of an `invoke(cmd, bytes, ...)` call, copied only if it is at most `max` bytes
/// (the check comes first: copying a body just to reject it would double the memory for nothing).
fn raw_body(request: &Request<'_>, max: usize) -> CmdResult<Vec<u8>> {
    match request.body() {
        InvokeBody::Raw(bytes) if bytes.len() > max => {
            Err("That file is too large to handle.".to_string())
        }
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err("Expected binary data.".to_string()),
    }
}

// ---- overlay ---------------------------------------------------------------------------------

#[tauri::command]
pub fn overlay_info(app: AppHandle, window: WebviewWindow) -> CmdResult<OverlayInfo> {
    capture::overlay_info(&app, &window)
}

#[tauri::command]
pub fn overlay_ready(
    app: AppHandle,
    window: WebviewWindow,
    nonce: u64,
    decode_ms: Option<f64>,
) -> CmdResult<()> {
    capture::overlay_ready(&app, &window, nonce, decode_ms)
}

#[tauri::command]
pub fn overlay_focus(window: WebviewWindow) -> CmdResult<()> {
    capture::overlay_focus(&window)
}

#[tauri::command]
pub fn overlay_set_mode(app: AppHandle, mode: Mode) -> CmdResult<()> {
    capture::set_mode(&app, mode)
}

/// Resolves to the new capture, or `null` when the selection started a scroll/GIF recording.
#[tauri::command]
pub async fn capture_commit(app: AppHandle, req: CommitRequest) -> CmdResult<Option<CaptureMeta>> {
    blocking(move || capture::commit(&app, req)).await
}

#[tauri::command]
pub fn capture_cancel(app: AppHandle) {
    capture::cancel(&app);
}

/// The preview window has the capture `id` decoded and drawn. While a capture is being committed
/// the frozen overlay stays on screen until this arrives (or 400 ms pass), so the preview never
/// appears empty. Cheap and idempotent; unknown or stale ids are ignored.
#[tauri::command]
pub fn preview_ready(app: AppHandle, id: String) -> CmdResult<()> {
    validate_id(&id)?;
    state(&app).preview_gate.ack(&id);
    Ok(())
}

/// What `capture_start` can begin: the two contract modes plus the two recording flows.
#[derive(Debug, Clone, Copy, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StartKind {
    Region,
    Window,
    Scroll,
    Gif,
}

#[tauri::command]
pub fn capture_start(app: AppHandle, mode: StartKind) {
    match mode {
        StartKind::Region => capture::start(&app, Mode::Region, Purpose::Capture),
        StartKind::Window => capture::start(&app, Mode::Window, Purpose::Capture),
        StartKind::Scroll => capture::start(&app, Mode::Window, Purpose::Scroll),
        StartKind::Gif => capture::start(&app, Mode::Region, Purpose::Gif),
    }
}

/// Finish the running scroll capture or GIF recording (the Stop button; Esc does the same).
#[tauri::command]
pub fn recording_stop(app: AppHandle) {
    recorder::stop(&app);
}

/// Close the small status window that called this (toast and friends).
#[tauri::command]
pub fn status_close(window: WebviewWindow) -> CmdResult<()> {
    if !window.label().starts_with("status-") {
        return Err("Not a status window.".to_string());
    }
    window.destroy().map_err(|e| e.to_string())
}

/// Show a saved recording in File Explorer. Only files inside the save folder qualify.
#[tauri::command]
pub async fn reveal_in_folder(app: AppHandle, path: String) -> CmdResult<()> {
    blocking(move || {
        let p = files::shareable_path(&app, &path)?;
        crate::winutil::reveal_in_explorer(&p)
    })
    .await
}

// ---- OCR -------------------------------------------------------------------------------------

#[tauri::command]
pub async fn ocr_recognize(app: AppHandle, id: String) -> CmdResult<Vec<OcrWord>> {
    blocking(move || state::ocr_result(&app, &id).map(|w| (*w).clone())).await
}

// ---- files and clipboard ---------------------------------------------------------------------

#[tauri::command]
pub async fn open_file(app: AppHandle, path: String) -> CmdResult<CaptureMeta> {
    blocking(move || files::open_file(&app, &path)).await
}

fn preview_hwnd(app: &AppHandle) -> CmdResult<windows::Win32::Foundation::HWND> {
    app.get_webview_window(winmgr::PREVIEW)
        .ok_or_else(|| "The main window is not available.".to_string())?
        .hwnd()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn paste_clipboard_image(app: AppHandle) -> CmdResult<Option<CaptureMeta>> {
    blocking(move || {
        let hwnd = preview_hwnd(&app)?;
        Ok(clipboard::get_image(hwnd)?
            .map(|d| state::register_capture(&app, d.width, d.height, d.rgba, Source::Clipboard)))
    })
    .await
}

#[tauri::command]
pub async fn export_save(app: AppHandle, request: Request<'_>) -> CmdResult<String> {
    let name = request
        .headers()
        .get("x-filename")
        .and_then(|v| v.to_str().ok())
        .ok_or("Missing file name.")?
        .to_string();
    // Optional Save As destination, percent-encoded UTF-8. Present but unusable is an error: the
    // file must never land somewhere other than where the user pointed.
    let save_path = match request.headers().get("x-save-path") {
        None => None,
        Some(v) => Some(
            v.to_str()
                .ok()
                .filter(|s| !s.is_empty() && s.len() <= 3072)
                .ok_or("The save location is not valid.")?
                .to_string(),
        ),
    };
    let bytes = raw_body(&request, crate::export::MAX_EXPORT_BYTES)?;
    blocking(move || files::export_save(&app, &bytes, &name, save_path.as_deref())).await
}

#[tauri::command]
pub async fn copy_image(app: AppHandle, request: Request<'_>) -> CmdResult<()> {
    let bytes = raw_body(&request, imgio::MAX_FILE_BYTES as usize)?;
    blocking(move || {
        let hwnd = preview_hwnd(&app)?;
        if crate::ids::content_matches_ext(&bytes, "png") {
            // The usual case (the editor exports PNG): check the header only, put the PNG on the
            // clipboard now, and let a background thread decode it and add the bitmap formats.
            // A full decode used to sit in front of the "Copied" toast (about 60 ms at 4K).
            let (w, h) = imgio::probe_dimensions(&bytes)?;
            imgio::check_dimensions(w, h)?;
            clipboard::copy_png_fast(hwnd, bytes, None)
        } else {
            // Another format: convert once, then the same two phases (the decoded pixels are
            // already in hand, so the background thread has nothing left to decode).
            let decoded = imgio::decode_limited(&bytes)?;
            let png = imgio::encode_png_fast(decoded.width, decoded.height, &decoded.rgba)?;
            clipboard::copy_png_fast(hwnd, png, Some(decoded))
        }
    })
    .await
}

#[tauri::command]
pub async fn copy_text(app: AppHandle, text: String) -> CmdResult<()> {
    blocking(move || clipboard::set_text(preview_hwnd(&app)?, &text)).await
}

#[tauri::command]
pub async fn share_file(app: AppHandle, path: String) -> CmdResult<()> {
    blocking(move || {
        let p = files::shareable_path(&app, &path)?;
        share::share_file(&app, &p)
    })
    .await
}

// ---- history ---------------------------------------------------------------------------------

#[tauri::command]
pub async fn history_list(
    app: AppHandle,
    query: Option<String>,
    limit: u32,
    offset: u32,
) -> CmdResult<Vec<HistoryItem>> {
    blocking(move || state(&app).history.list(query.as_deref(), limit, offset)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    meta: CaptureMeta,
    doc_json: Option<String>,
}

#[tauri::command]
pub async fn history_get(app: AppHandle, id: String) -> CmdResult<HistoryEntry> {
    blocking(move || {
        validate_id(&id)?;
        let row = state(&app)
            .history
            .get(&id)?
            .ok_or("That capture is not in the history.")?;
        Ok(HistoryEntry {
            meta: CaptureMeta {
                id: row.id,
                width: row.width,
                height: row.height,
                created_at: row.created_at,
                source: row.source,
            },
            doc_json: row.doc_json,
        })
    })
    .await
}

#[tauri::command]
pub async fn history_save(app: AppHandle, id: String, doc_json: String) -> CmdResult<()> {
    blocking(move || {
        validate_id(&id)?;
        let st = state(&app);
        // The row normally exists already; create it if persistence has not caught up yet.
        if st.history.get(&id)?.is_none() {
            let c = load_capture(&app, &id)?;
            st.history.insert_capture(
                &id,
                c.meta.created_at,
                c.meta.width,
                c.meta.height,
                c.meta.source,
            )?;
        }
        if st.history.save_doc(&id, &doc_json)? {
            Ok(())
        } else {
            Err("That capture is not in the history.".to_string())
        }
    })
    .await
}

fn remove_files(app: &AppHandle, id: &str) {
    let st = state(app);
    for path in [st.paths.capture_file(id), st.paths.thumb_file(id)]
        .into_iter()
        .flatten()
    {
        let _ = std::fs::remove_file(path);
    }
    let Ok(mut store) = st.store.lock() else {
        return;
    };
    store.remove(id);
}

#[tauri::command]
pub async fn history_delete(app: AppHandle, id: String) -> CmdResult<()> {
    blocking(move || {
        validate_id(&id)?;
        state(&app).history.delete(&id)?;
        remove_files(&app, &id);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn history_clear(app: AppHandle) -> CmdResult<()> {
    blocking(move || {
        let st = state(&app);
        let ids = st.history.clear()?;
        for id in &ids {
            remove_files(&app, id);
        }
        // Also sweep image files that never made it into the database.
        for dir in [st.paths.captures_dir(), st.paths.thumbs_dir()] {
            if let Ok(rd) = std::fs::read_dir(dir) {
                for entry in rd.flatten() {
                    let p = entry.path();
                    let valid = p.extension().is_some_and(|e| e == "png")
                        && p.file_stem()
                            .and_then(|s| s.to_str())
                            .is_some_and(crate::ids::is_valid_id);
                    if valid && p.is_file() {
                        let _ = std::fs::remove_file(p);
                    }
                }
            }
        }
        if let Ok(mut store) = st.store.lock() {
            store.clear();
        }
        st.ocr.drop_all();
        Ok(())
    })
    .await
}

// ---- settings --------------------------------------------------------------------------------

#[tauri::command]
pub fn settings_get(app: AppHandle) -> Settings {
    state(&app).settings()
}

fn set_autostart(app: &AppHandle, enabled: bool) -> CmdResult<()> {
    let mgr = app.autolaunch();
    let current = mgr.is_enabled().unwrap_or(false);
    if current == enabled {
        return Ok(());
    }
    let res = if enabled { mgr.enable() } else { mgr.disable() };
    res.map_err(|_| "Could not change the start-with-Windows setting.".to_string())
}

#[tauri::command]
pub async fn settings_set(app: AppHandle, patch: SettingsPatch) -> CmdResult<Settings> {
    blocking(move || {
        let st = state(&app);
        // One change at a time, start to finish. Without this two quick changes (a slider and a
        // toggle, or two windows) both read the same "current" settings and the second save
        // silently undoes the first.
        let _serial = st
            .settings_lock
            .lock()
            .map_err(|_| "Settings are busy. Try again.".to_string())?;
        let current = st.settings();
        let next = current.patched(patch)?;
        if next == current {
            return Ok(current);
        }
        let autostart_changed = next.autostart != current.autostart;
        if autostart_changed {
            set_autostart(&app, next.autostart)?;
        }
        // Every later failure puts the start-with-Windows entry back as it was.
        let undo_autostart = || {
            if autostart_changed {
                let _ = set_autostart(&app, current.autostart);
            }
        };
        let shortcuts_changed = next.shortcut != current.shortcut
            || next.scroll_shortcut != current.scroll_shortcut
            || next.gif_shortcut != current.gif_shortcut;
        if shortcuts_changed {
            if let Err(e) = shortcuts::apply(&app, &next) {
                undo_autostart();
                return Err(e);
            }
        }
        if let Err(e) = crate::settings::save(&st.paths.settings_file(), &next) {
            if shortcuts_changed {
                let _ = shortcuts::apply(&app, &current);
            }
            undo_autostart();
            return Err(e);
        }
        if let Ok(mut w) = st.settings.write() {
            *w = next.clone();
        }
        if shortcuts_changed {
            tray::refresh(&app);
        }
        let _ = app.emit("settings:changed", &next);
        Ok(next)
    })
    .await
}

// ---- license ---------------------------------------------------------------------------------

fn refresh_license(app: &AppHandle) -> LicenseStatus {
    let st = state(app);
    let status = match license::current_checked(
        &st.license_store,
        &license::prod_verifier,
        crate::BUILD_DAYS,
    ) {
        Ok(status) => status,
        Err(e) => {
            // Credential Manager could not be read: that is not "no key". Say so, and keep what
            // was known (a Pro user is not demoted by a transient failure).
            st.add_warning(e);
            st.license
                .lock()
                .map(|l| l.clone())
                .unwrap_or_else(|_| LicenseStatus::unlicensed())
        }
    };
    if let Ok(mut l) = st.license.lock() {
        *l = status.clone();
    }
    status
}

#[tauri::command]
pub async fn license_status(app: AppHandle) -> CmdResult<LicenseStatus> {
    blocking(move || Ok(refresh_license(&app))).await
}

#[tauri::command]
pub async fn license_activate(app: AppHandle, key: String) -> CmdResult<LicenseStatus> {
    blocking(move || {
        let st = state(&app);
        let status = license::activate(
            &st.license_store,
            &license::prod_verifier,
            &key,
            crate::BUILD_DAYS,
        )?;
        if let Ok(mut l) = st.license.lock() {
            *l = status.clone();
        }
        Ok(status)
    })
    .await
}

#[tauri::command]
pub async fn license_deactivate(app: AppHandle) -> CmdResult<LicenseStatus> {
    blocking(move || {
        let st = state(&app);
        let status = license::deactivate(&st.license_store)?;
        if let Ok(mut l) = st.license.lock() {
            *l = status.clone();
        }
        Ok(status)
    })
    .await
}

/// Startup re-verification of the stored key.
pub fn verify_license_at_startup(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let s = refresh_license(&app);
        crate::tlog!("license at startup: licensed={}", s.licensed);
    });
}

// ---- quick send ------------------------------------------------------------------------------

#[tauri::command]
pub async fn qs_devices(app: AppHandle) -> CmdResult<Vec<crate::qspeers::DeviceEntry>> {
    blocking(move || Ok(quicksend::ensure(&app)?.devices())).await
}

/// Open or close the window in which new devices may pair (the pairing dialog is open).
#[tauri::command]
pub async fn qs_pairing_mode(app: AppHandle, open: bool) -> CmdResult<()> {
    blocking(move || {
        quicksend::ensure(&app)?.set_pairing_open(open);
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn qs_pair_start(app: AppHandle, device_id: String) -> CmdResult<quicksend::PairCode> {
    blocking(move || {
        let device_id = quicksend::parse_device_text(&device_id)?;
        quicksend::ensure(&app)?.pair_start(&device_id)
    })
    .await
}

#[tauri::command]
pub async fn qs_pair_confirm(
    app: AppHandle,
    peer_id: String,
    sas: String,
    accepted: bool,
) -> CmdResult<crate::qspeers::DeviceEntry> {
    blocking(move || {
        // The answer names the pairing the user was looking at: the device id and the code from
        // `qs:pair-code`. A different pairing on the PC is never confirmed by it.
        let peer_id = quicksend::parse_device_text(&peer_id)?;
        if sas.len() > 16 {
            return Err("Invalid pairing code.".to_string());
        }
        quicksend::ensure(&app)?.pair_confirm(&peer_id, &sas, accepted)
    })
    .await
}

/// Send PNG bytes (raw body) to a paired device. Headers: `x-device-id`, `x-filename`.
#[tauri::command]
pub async fn qs_send(app: AppHandle, request: Request<'_>) -> CmdResult<()> {
    let header = |name: &str| {
        request
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let device = header("x-device-id").ok_or("Missing device.")?;
    // The file name is sanitised by the protocol layer; cap it here so a huge header never gets there.
    let file_name = header("x-filename")
        .filter(|n| n.len() <= 512)
        .unwrap_or_else(|| "screenshot.png".to_string());
    let device = quicksend::parse_device_text(&device)?;
    let bytes = raw_body(&request, polishot_quicksend::MAX_FILE_SIZE as usize)
        .map_err(|_| "That image is too large to send (limit 50 MB).".to_string())?;
    blocking(move || quicksend::ensure(&app)?.send_png(&device, &file_name, &bytes)).await
}

#[tauri::command]
pub async fn qs_forget(app: AppHandle, device_id: String) -> CmdResult<()> {
    blocking(move || {
        let device_id = quicksend::parse_device_text(&device_id)?;
        quicksend::ensure(&app)?.forget(&device_id)
    })
    .await
}

/// The answer to a `qs:incoming` prompt.
#[tauri::command]
pub async fn qs_incoming_respond(app: AppHandle, request_id: u64, accept: bool) -> CmdResult<()> {
    blocking(move || {
        quicksend::ensure(&app)?.respond(request_id, accept);
        Ok(())
    })
    .await
}

// ---- pin -------------------------------------------------------------------------------------

#[tauri::command]
pub async fn pin_open(app: AppHandle, id: String) -> CmdResult<()> {
    // Looking up the capture can read a file; keep that off the async runtime's threads.
    blocking(move || pin::open(&app, &id)).await
}

#[tauri::command]
pub fn pin_close(window: WebviewWindow) -> CmdResult<()> {
    pin::close(&window)
}

// ---- app -------------------------------------------------------------------------------------

#[derive(Serialize)]
pub struct AppInfo {
    version: &'static str,
    backdrop: &'static str,
    warnings: Vec<String>,
}

#[tauri::command]
pub fn app_info(app: AppHandle) -> AppInfo {
    let st = state(&app);
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        backdrop: st.backdrop.lock().map(|b| *b).unwrap_or("solid"),
        warnings: st.warnings.lock().map(|w| w.clone()).unwrap_or_default(),
    }
}
