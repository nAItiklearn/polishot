//! Declares every app command so Tauri generates `allow-<command>` permissions.
//! Capabilities (see `capabilities/`) then grant each window label only what it needs.

const COMMANDS: &[&str] = &[
    // overlay windows
    "overlay_info",
    "overlay_ready",
    "overlay_focus",
    "overlay_set_mode",
    "capture_commit",
    "capture_cancel",
    // preview window
    "capture_start",
    "ocr_recognize",
    "open_file",
    "paste_clipboard_image",
    "export_save",
    "copy_image",
    "copy_text",
    "share_file",
    "history_list",
    "history_get",
    "history_save",
    "history_delete",
    "history_clear",
    "settings_get",
    "settings_set",
    "license_status",
    "license_activate",
    "license_deactivate",
    "pin_open",
    "app_info",
    // quick send
    "qs_devices",
    "qs_pairing_mode",
    "qs_pair_start",
    "qs_pair_confirm",
    "qs_send",
    "qs_forget",
    "qs_incoming_respond",
    // recording status windows
    "recording_stop",
    "reveal_in_folder",
    "status_close",
    // pin windows
    "pin_close",
];

/// Days since 1970-01-01 of the build, from `SOURCE_DATE_EPOCH` (reproducible builds) or now.
/// Compared against a license key's update window (CONTRACTS section 5b).
fn build_days() -> u64 {
    let secs = std::env::var("SOURCE_DATE_EPOCH")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .ok()
                .map(|d| d.as_secs())
        })
        .unwrap_or(0);
    secs / 86_400
}

fn main() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rustc-env=POLISHOT_BUILD_DAYS={}", build_days());
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    let attrs = tauri_build::Attributes::new().app_manifest(manifest);
    if let Err(e) = tauri_build::try_build(attrs) {
        panic!("tauri-build failed: {e:#}");
    }
}
