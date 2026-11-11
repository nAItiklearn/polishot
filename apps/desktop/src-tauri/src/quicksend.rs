//! Quick send, Tauri side: the engine (`polishot_core::qsengine`, tested without Tauri) talks to
//! the app through [`AppHost`], and starts on first use so people who never use it never see a
//! firewall prompt.
//!
//! Events (to the preview window): `qs:devices`, `qs:pair-code`, `qs:incoming`, `qs:received`.

use std::sync::Arc;

use tauri::{AppHandle, Emitter};

use crate::qsengine::{local_name_from, Host};
pub use crate::qsengine::{parse_device_text, PairCode, QuickSend};
use crate::qsstore::QsStore;
use crate::state::{register_capture, state};
use crate::store::{CaptureMeta, Source};
use crate::{tlog, winmgr};

/// The engine's view of the app: events go to the preview window, received images become captures.
struct AppHost {
    app: AppHandle,
}

impl Host for AppHost {
    fn emit(&self, event: &str, payload: serde_json::Value) {
        let _ = self.app.emit_to(winmgr::PREVIEW, event, payload);
    }

    fn show_window(&self) {
        winmgr::show_preview(&self.app);
    }

    fn register_image(&self, width: u32, height: u32, rgba: Vec<u8>) -> CaptureMeta {
        register_capture(&self.app, width, height, rgba, Source::File)
    }

    fn warn(&self, message: &str) {
        state(&self.app).add_warning(message.to_string());
    }
}

/// Start quick send on first use. Cheap on later calls.
pub fn ensure(app: &AppHandle) -> Result<Arc<QuickSend>, String> {
    let st = state(app);
    let mut slot = st
        .quicksend
        .lock()
        .map_err(|_| "Quick send is unavailable.".to_string())?;
    if let Some(q) = slot.as_ref() {
        return Ok(q.clone());
    }
    let store = QsStore::new(&st.paths.quicksend_dir());
    let host = Arc::new(AppHost { app: app.clone() });
    let name = local_name_from(&std::env::var("COMPUTERNAME").unwrap_or_default());
    let q = QuickSend::start(host, store, name)?;
    *slot = Some(q.clone());
    Ok(q)
}

/// At app start: bring quick send up only when a device is already paired. Everything,
/// including reading the pair files (a directory scan plus one DPAPI call per file), runs on a
/// background thread so it never delays the tray or the first hotkey.
pub fn start_if_paired(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        let dir = state(&app).paths.quicksend_dir();
        if QsStore::new(&dir).load_pairs().is_empty() {
            return;
        }
        if let Err(e) = ensure(&app) {
            tlog!("quick send start failed: {e}");
        }
    });
}

/// App exit: withdraw the mDNS advertisement and stop the engine's loops.
pub fn shutdown(app: &AppHandle) {
    if let Ok(slot) = state(app).quicksend.lock() {
        if let Some(q) = slot.as_ref() {
            q.shutdown();
        }
    }
}
