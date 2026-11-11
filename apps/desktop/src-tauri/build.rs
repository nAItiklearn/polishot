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

/// Commands of the in-app `opener` plugin (see `src/opener_plugin.rs`).
const OPENER_COMMANDS: &[&str] = &["reveal_item_in_dir", "open_url"];

/// Days since 1970-01-01 of the build, from `SOURCE_DATE_EPOCH` (reproducible builds) or now.
/// Compared against a license key's update window (CONTRACTS section 5b).
///
/// Never falls back to 0: day 0 is covered by every key. A malformed `SOURCE_DATE_EPOCH` or an
/// unreadable clock fails the build; the range check (2026..2100) happens when the value is parsed
/// into `BUILD_DAYS` at compile time.
fn build_days() -> u64 {
    let secs = match std::env::var("SOURCE_DATE_EPOCH") {
        Ok(v) if !v.trim().is_empty() => v.trim().parse::<u64>().unwrap_or_else(|_| {
            panic!("SOURCE_DATE_EPOCH must be a Unix timestamp in seconds, got {v:?}")
        }),
        _ => std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_else(|_| panic!("the system clock is before 1970; cannot date this build"))
            .as_secs(),
    };
    secs / 86_400
}

fn main() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var_os("SOURCE_DATE_EPOCH").is_none() {
        // Without a pinned date the embedded day must be today's, not whatever an old cached
        // build used (an older date would be covered by more license keys). A path that does not
        // exist makes Cargo treat the script as stale, so it re-runs on every build; the crate
        // itself only recompiles when the resulting value changes.
        println!("cargo:rerun-if-changed=.rebuild-for-build-date");
    }
    println!("cargo:rustc-env=POLISHOT_BUILD_DAYS={}", build_days());
    let manifest = tauri_build::AppManifest::new().commands(COMMANDS);
    // The preview calls `plugin:opener|reveal_item_in_dir` and `plugin:opener|open_url`; they are
    // implemented in `src/opener_plugin.rs`, and this generates `opener:allow-*` permissions.
    let opener = tauri_build::InlinedPlugin::new().commands(OPENER_COMMANDS);
    let attrs = tauri_build::Attributes::new()
        .app_manifest(manifest)
        .plugin("opener", opener);
    if let Err(e) = tauri_build::try_build(attrs) {
        panic!("tauri-build failed: {e:#}");
    }
}
