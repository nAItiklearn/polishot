//! The two `opener` commands the preview window calls: `plugin:opener|reveal_item_in_dir` and
//! `plugin:opener|open_url`.
//!
//! This is a small in-app plugin (declared with `tauri_build::InlinedPlugin` in `build.rs`) rather
//! than the general-purpose `tauri-plugin-opener`: the same command names and arguments, but only
//! what the UI needs. Links must be `https://` to a named host, and only existing image files can
//! be revealed; see `polishot_core::opener` for the rules and their tests.

use tauri::plugin::{Builder, TauriPlugin};
use tauri::Wry;

use polishot_core::opener as rules;

type CmdResult<T> = Result<T, String>;

/// Most paths accepted in one `reveal_item_in_dir` call.
const MAX_PATHS: usize = 16;

/// Run a blocking shell call off the async runtime's worker threads.
async fn blocking<F>(f: F) -> CmdResult<()>
where
    F: FnOnce() -> CmdResult<()> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|_| "The operation was interrupted.".to_string())?
}

/// Show saved images in File Explorer. Every path is checked first; the first one is revealed.
#[tauri::command]
async fn reveal_item_in_dir(paths: Vec<String>) -> CmdResult<()> {
    if paths.is_empty() || paths.len() > MAX_PATHS {
        return Err("Choose a file to show in the folder.".to_string());
    }
    blocking(move || {
        for p in &paths {
            rules::validate_reveal_path(p)?;
        }
        rules::reveal(&paths[0])
    })
    .await
}

/// Open an `https://` link in the default browser.
#[tauri::command]
async fn open_url(url: String) -> CmdResult<()> {
    blocking(move || rules::open_url(&url)).await
}

pub fn plugin() -> TauriPlugin<Wry> {
    Builder::new("opener")
        .invoke_handler(tauri::generate_handler![reveal_item_in_dir, open_url])
        .build()
}
