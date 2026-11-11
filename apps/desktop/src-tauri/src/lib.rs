//! Polishot desktop backend (Tauri 2). Lives in the tray; hotkey -> frozen screen -> overlay ->
//! preview. See `docs/CONTRACTS.md` section 5 for the IPC surface.

mod capture;
mod commands;
mod files;
mod opener_plugin;
mod pin;
mod protocol;
mod quicksend;
mod recorder;
#[cfg(debug_assertions)]
mod selftest;
mod share;
mod shortcuts;
mod state;
mod tray;
mod winmgr;

// Platform logic lives in the Tauri-free core crate; re-imported here so modules can keep using
// `crate::geometry`, `crate::ids`, ... paths.
pub(crate) use polishot_core::{
    bmp, clipboard, cropping, export, geometry, gifrec, grab, history, ids, imgio, jobs, layout,
    license, ocr, opener, paths, pinmath, qsengine, qspeers, qsstore, routes, scroll, session,
    settings, store, timing, tlog, winsrc, winutil,
};

use std::sync::atomic::AtomicU64;
use std::sync::{Mutex, RwLock};

use tauri::{Manager, RunEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};

use crate::history::History;
use crate::jobs::{OcrJobs, WorkerPool};
use crate::license::{CredentialStore, LicenseStatus};
use crate::paths::Paths;
use crate::session::SingleFlight;
use crate::state::{AppState, FrameFormat};
use crate::store::CaptureStore;

/// Days since the Unix epoch when this build was made (set by `build.rs`). A license key covers
/// the build when `BUILD_DAYS <= issuedDays + 365`. A missing or implausible value is a compile
/// error, never day 0 (which every key would cover).
pub const BUILD_DAYS: u32 = license::parse_build_days(env!("POLISHOT_BUILD_DAYS"));

/// At most this many decoded captures stay in memory (older ones reload from disk).
const MAX_CACHED_CAPTURES: usize = 8;
const MAX_CACHED_BYTES: usize = 384 * 1024 * 1024;

fn build_state(app: &tauri::AppHandle) -> Result<AppState, String> {
    let product = app
        .config()
        .product_name
        .clone()
        .ok_or("The product name is missing from the app configuration.")?;
    let paths = Paths::from_env(&product)?;
    paths.ensure_dirs()?;
    timing::init(&paths.logs_dir());

    let pictures = app
        .path()
        .picture_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("Could not find the Pictures folder: {e}"))?;
    let defaults = settings::Settings::with_save_folder(&pictures.join(&product));
    let loaded = settings::load(&paths.settings_file(), &defaults);

    let mut warnings = Vec::new();
    let history = match History::open(&paths.db_file()) {
        Ok(h) => h,
        Err(e) => {
            warnings.push(format!("History is unavailable this session: {e}"));
            History::open_in_memory()?
        }
    };
    let frame_format = match std::env::var("POLISHOT_FRAME_FORMAT").as_deref() {
        Ok("png") => FrameFormat::Png,
        _ => FrameFormat::Bmp,
    };

    Ok(AppState {
        license_store: CredentialStore::new(format!("{product}/license")),
        paths,
        settings: RwLock::new(loaded),
        store: Mutex::new(CaptureStore::new(MAX_CACHED_CAPTURES, MAX_CACHED_BYTES)),
        session: Mutex::new(None),
        history,
        ocr: OcrJobs::default(),
        finalize_pool: WorkerPool::new("finalize", 2, 32, false),
        ocr_pool: WorkerPool::new("ocr", 2, 32, true),
        start_flight: SingleFlight::new(),
        settings_lock: Mutex::new(()),
        license: Mutex::new(LicenseStatus::unlicensed()),
        warnings: Mutex::new(warnings),
        backdrop: Mutex::new("solid"),
        overlay_layout: Mutex::new(Vec::new()),
        registered: Mutex::new(Vec::new()),
        frame_format,
        nonce: AtomicU64::new(0),
        recording: Mutex::new(None),
        quicksend: Mutex::new(None),
    })
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let st = build_state(&handle)?;
    let settings = st.settings();
    app.manage(st);
    tlog!(
        "startup: {} {} build_days={} grab order {}",
        env!("CARGO_PKG_NAME"),
        env!("CARGO_PKG_VERSION"),
        BUILD_DAYS,
        capture::describe_methods()
    );

    winmgr::create_preview(&handle)?;
    match winutil::enumerate_monitors() {
        Ok(monitors) => winmgr::rebuild_overlays(&handle, &monitors)?,
        Err(e) => state::state(&handle).add_warning(e),
    }
    tray::build(&handle)?;
    shortcuts::register_initial(&handle, &settings);

    // Keep the OS autostart entry in step with the setting (it may have been changed externally).
    let launch = handle.autolaunch();
    if launch.is_enabled().unwrap_or(false) != settings.autostart {
        let _ = if settings.autostart {
            launch.enable()
        } else {
            launch.disable()
        };
    }
    commands::verify_license_at_startup(&handle);
    // Pay the one-time GDI start-up cost now instead of on the first hotkey.
    std::thread::spawn(grab::prewarm);
    quicksend::start_if_paired(&handle);
    #[cfg(debug_assertions)]
    selftest::spawn(&handle);
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        // Must be first: a second launch just surfaces the running instance.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::focus_existing(app);
        }))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_dialog::init())
        // `plugin:opener|...` commands for the preview window (https links, reveal in Explorer).
        .plugin(opener_plugin::plugin())
        .register_asynchronous_uri_scheme_protocol("polishot", protocol::handle)
        .setup(setup)
        .invoke_handler(tauri::generate_handler![
            commands::overlay_info,
            commands::overlay_ready,
            commands::overlay_focus,
            commands::overlay_set_mode,
            commands::capture_commit,
            commands::capture_cancel,
            commands::capture_start,
            commands::recording_stop,
            commands::qs_devices,
            commands::qs_pairing_mode,
            commands::qs_pair_start,
            commands::qs_pair_confirm,
            commands::qs_send,
            commands::qs_forget,
            commands::qs_incoming_respond,
            commands::reveal_in_folder,
            commands::status_close,
            commands::ocr_recognize,
            commands::open_file,
            commands::paste_clipboard_image,
            commands::export_save,
            commands::copy_image,
            commands::copy_text,
            commands::share_file,
            commands::history_list,
            commands::history_get,
            commands::history_save,
            commands::history_delete,
            commands::history_clear,
            commands::settings_get,
            commands::settings_set,
            commands::license_status,
            commands::license_activate,
            commands::license_deactivate,
            commands::pin_open,
            commands::pin_close,
            commands::app_info,
        ])
        .build(tauri::generate_context!());

    let app = match app {
        Ok(app) => app,
        Err(e) => {
            eprintln!("failed to start: {e}");
            std::process::exit(1);
        }
    };

    app.run(|app, event| match event {
        // The tray keeps the app alive when every window is hidden or closed.
        RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        // A real exit: take this PC off the network's device list instead of leaving a stale
        // advertisement until it times out.
        RunEvent::Exit => quicksend::shutdown(app),
        _ => {}
    });
}
