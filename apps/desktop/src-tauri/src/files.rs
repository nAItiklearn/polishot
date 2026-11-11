//! Opening images from disk and saving exports. Both directions are locked down: allowed
//! extensions only, size and dimension caps, sanitised names, and writes never leave the save
//! folder.

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::export::{lowercase_ext, percent_decode, save_export, save_export_at};
use crate::imgio::{self, ALLOWED_INPUT_EXTS, MAX_FILE_BYTES};
use crate::settings::validate_save_folder;
use crate::state::{register_capture, state};
use crate::store::{CaptureMeta, Source};

/// `open_file`: png/jpg/jpeg/webp/bmp only, at most 64 MB and 16384 px per side.
pub fn open_file(app: &AppHandle, raw_path: &str) -> Result<CaptureMeta, String> {
    if raw_path.is_empty() || raw_path.len() > 1024 || raw_path.contains('\0') {
        return Err("That file path is not valid.".to_string());
    }
    let path = PathBuf::from(raw_path);
    let ext = lowercase_ext(&path).ok_or("That file type is not supported.")?;
    if !ALLOWED_INPUT_EXTS.contains(&ext.as_str()) {
        return Err("Only PNG, JPEG, WebP and BMP images can be opened.".to_string());
    }
    let meta = std::fs::metadata(&path).map_err(|_| "That file could not be found.".to_string())?;
    if !meta.is_file() {
        return Err("That is not a file.".to_string());
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err("That image is larger than the 64 MB limit.".to_string());
    }
    let bytes = std::fs::read(&path).map_err(|_| "That file could not be read.".to_string())?;
    let d = imgio::decode_limited(&bytes)?;
    Ok(register_capture(
        app,
        d.width,
        d.height,
        d.rgba,
        Source::File,
    ))
}

/// `export_save`: into the save folder under a sanitised name, or, when the Save As dialog picked
/// a place (header `x-save-path`, percent-encoded), exactly there after strict checks.
pub fn export_save(
    app: &AppHandle,
    bytes: &[u8],
    filename: &str,
    save_path: Option<&str>,
) -> Result<String, String> {
    if let Some(encoded) = save_path {
        let decoded = percent_decode(encoded)?;
        let target = save_export_at(Path::new(&decoded), bytes)?;
        return Ok(target.to_string_lossy().into_owned());
    }
    let folder = state(app).settings().save_folder;
    validate_save_folder(&folder)?;
    let target = save_export(Path::new(folder.trim()), bytes, filename)?;
    Ok(target.to_string_lossy().into_owned())
}

/// A path the share sheet may hand to other apps: an image inside the save or captures folder.
pub fn shareable_path(app: &AppHandle, raw_path: &str) -> Result<PathBuf, String> {
    if raw_path.is_empty() || raw_path.len() > 1024 || raw_path.contains('\0') {
        return Err("That file path is not valid.".to_string());
    }
    let canon =
        std::fs::canonicalize(raw_path).map_err(|_| "That file could not be found.".to_string())?;
    let st = state(app);
    let save = std::fs::canonicalize(st.settings().save_folder.trim()).ok();
    let caps = std::fs::canonicalize(st.paths.captures_dir()).ok();
    let inside = [save, caps]
        .into_iter()
        .flatten()
        .any(|root| canon.starts_with(root));
    if !inside {
        return Err("Only saved images can be shared.".to_string());
    }
    let ext = lowercase_ext(&canon).unwrap_or_default();
    if !canon.is_file() || !(crate::ids::EXPORT_EXTS.contains(&ext.as_str()) || ext == "gif") {
        return Err("Only saved images can be shared.".to_string());
    }
    Ok(canon)
}
