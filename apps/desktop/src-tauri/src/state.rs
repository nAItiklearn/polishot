//! Shared application state and the helpers every command needs (loading captures, registering
//! new ones, background persistence).

use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{Arc, Mutex, RwLock};

use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_global_shortcut::Shortcut;

use crate::geometry::IRect;
use crate::history::History;
use crate::ids::{new_id, now_millis, validate_id};
use crate::imgio;
use crate::jobs::{write_atomic, OcrJobs, OcrSlot};
use crate::license::{CredentialStore, LicenseStatus};
use crate::ocr::{self, OcrWord};
use crate::paths::Paths;
use crate::settings::Settings;
use crate::store::{Capture, CaptureMeta, CaptureStore, Frame, Source};
use crate::winutil::{MonitorInfo, WinEntry};
use crate::{timing, tlog};

/// Capture mode armed on the overlays.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Region,
    Window,
}

/// What the overlay selection is for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Purpose {
    /// A normal screenshot (region or window).
    Capture,
    /// Pick a window to scroll-capture.
    Scroll,
    /// Pick a region to record as a GIF.
    Gif,
}

/// One in-flight capture: the frozen frames and the windows that were visible at hotkey time.
pub struct Session {
    pub nonce: u64,
    pub mode: Mode,
    pub purpose: Purpose,
    pub started: std::time::Instant,
    pub monitors: Vec<MonitorInfo>,
    pub frames: Vec<Arc<Frame>>,
    pub windows: Vec<WinEntry>,
    pub committed: bool,
    pub first_shown: bool,
}

/// How frozen frames are served: BMP (no encode) or PNG (only used to measure the difference).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameFormat {
    Bmp,
    Png,
}

pub struct AppState {
    pub paths: Paths,
    pub settings: RwLock<Settings>,
    pub store: Mutex<CaptureStore>,
    pub session: Mutex<Option<Session>>,
    pub history: History,
    pub ocr: OcrJobs,
    pub license: Mutex<LicenseStatus>,
    pub license_store: CredentialStore,
    pub warnings: Mutex<Vec<String>>,
    pub backdrop: Mutex<&'static str>,
    pub overlay_layout: Mutex<Vec<(IRect, u64)>>,
    pub registered: Mutex<Vec<Shortcut>>,
    pub frame_format: FrameFormat,
    pub nonce: AtomicU64,
    /// Stop flag of the running scroll capture or GIF recording, if any.
    pub recording: Mutex<Option<Arc<AtomicBool>>>,
    /// Quick send, started on first use.
    pub quicksend: Mutex<Option<Arc<crate::quicksend::QuickSend>>>,
}

impl AppState {
    pub fn settings(&self) -> Settings {
        self.settings.read().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn add_warning(&self, msg: String) {
        if let Ok(mut w) = self.warnings.lock() {
            w.push(msg);
        }
    }
}

pub fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

// ---- captures --------------------------------------------------------------------------------

/// Register freshly produced RGBA pixels as a capture and start background persistence.
pub fn register_capture(
    app: &AppHandle,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
    source: Source,
) -> CaptureMeta {
    let st = state(app);
    let meta = CaptureMeta {
        id: new_id(),
        width,
        height,
        created_at: now_millis(),
        source,
    };
    let opaque = !imgio::has_transparency(&rgba);
    let capture = Arc::new(Capture::new(meta.clone(), rgba, opaque));
    if let Ok(mut store) = st.store.lock() {
        store.insert(capture.clone());
    }
    let app2 = app.clone();
    std::thread::spawn(move || finalize_capture(&app2, &capture));
    meta
}

/// Off the hot path: encode PNG, write capture + thumbnail, add the history row, start OCR.
fn finalize_capture(app: &AppHandle, capture: &Arc<Capture>) {
    let st = state(app);
    let t = std::time::Instant::now();
    let id = &capture.meta.id;
    let (w, h) = (capture.meta.width, capture.meta.height);
    match imgio::encode_png_fast(w, h, &capture.rgba) {
        Ok(png) => {
            let png = Arc::new(png);
            capture.set_png(png.clone());
            if let Some(path) = st.paths.capture_file(id) {
                if let Err(e) = write_atomic(&path, &png) {
                    tlog!("persist capture failed: {e}");
                }
            }
        }
        Err(e) => tlog!("png encode failed: {e}"),
    }
    let encode_ms = timing::ms(t);
    match imgio::thumbnail_png(w, h, &capture.rgba) {
        Ok(thumb) => {
            if let Some(path) = st.paths.thumb_file(id) {
                if let Err(e) = write_atomic(&path, &thumb) {
                    tlog!("persist thumbnail failed: {e}");
                }
            }
        }
        Err(e) => tlog!("thumbnail failed: {e}"),
    }
    if let Err(e) =
        st.history
            .insert_capture(id, capture.meta.created_at, w, h, capture.meta.source)
    {
        tlog!("history insert failed: {e}");
    }
    tlog!(
        "persist {}x{}: png+write {:.1} ms, total {:.1} ms",
        w,
        h,
        encode_ms,
        timing::ms(t)
    );
    ensure_ocr(app, id);
}

/// Fetch a capture from memory, or load it back from disk (history items).
pub fn load_capture(app: &AppHandle, id: &str) -> Result<Arc<Capture>, String> {
    validate_id(id)?;
    let st = state(app);
    if let Ok(mut store) = st.store.lock() {
        if let Some(c) = store.get(id) {
            return Ok(c);
        }
    }
    let path = st
        .paths
        .capture_file(id)
        .ok_or_else(|| "Invalid capture id.".to_string())?;
    let bytes =
        std::fs::read(&path).map_err(|_| "That capture is no longer available.".to_string())?;
    let d = imgio::decode_limited(&bytes)?;
    let created_at = st
        .history
        .get(id)
        .ok()
        .flatten()
        .map_or_else(now_millis, |r| r.created_at);
    let meta = CaptureMeta {
        id: id.to_string(),
        width: d.width,
        height: d.height,
        created_at,
        source: Source::Region,
    };
    let opaque = !imgio::has_transparency(&d.rgba);
    let capture = Arc::new(Capture::new(meta, d.rgba, opaque));
    capture.set_png(Arc::new(bytes));
    if let Ok(mut store) = st.store.lock() {
        store.insert(capture.clone());
    }
    Ok(capture)
}

// ---- OCR -------------------------------------------------------------------------------------

fn run_ocr(app: &AppHandle, id: &str, slot: &Arc<OcrSlot>) {
    let t = std::time::Instant::now();
    let outcome = load_capture(app, id)
        .and_then(|c| ocr::recognize(c.meta.width, c.meta.height, &c.rgba))
        .map(Arc::new);
    match &outcome {
        Ok(words) => {
            tlog!("ocr {} words in {:.1} ms", words.len(), timing::ms(t));
            let st = state(app);
            let text = ocr::words_to_text(words);
            if let Err(e) = st.history.set_ocr_text(id, &text) {
                tlog!("ocr index failed: {e}");
            }
            let list: &Vec<OcrWord> = words;
            let _ = app.emit_to(
                "preview",
                "ocr:ready",
                serde_json::json!({ "id": id, "words": list }),
            );
        }
        Err(e) => tlog!("ocr failed after {:.1} ms: {e}", timing::ms(t)),
    }
    if outcome.is_err() {
        // Let a later request retry (e.g. after the user installs an OCR language).
        state(app).ocr.forget(id);
    }
    slot.complete(outcome);
}

/// Start OCR for `id` in the background unless it is already running or done.
pub fn ensure_ocr(app: &AppHandle, id: &str) {
    let (slot, created) = state(app).ocr.slot(id);
    if created {
        let app2 = app.clone();
        let id2 = id.to_string();
        std::thread::spawn(move || run_ocr(&app2, &id2, &slot));
    }
}

/// OCR result for `id`, waiting for a running job. Blocking.
pub fn ocr_result(app: &AppHandle, id: &str) -> Result<Arc<Vec<OcrWord>>, String> {
    validate_id(id)?;
    let (slot, created) = state(app).ocr.slot(id);
    if created {
        let app2 = app.clone();
        let id2 = id.to_string();
        let slot2 = slot.clone();
        std::thread::spawn(move || run_ocr(&app2, &id2, &slot2));
    }
    slot.wait()
}
