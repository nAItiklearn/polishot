//! Saving exports. Locked down: sanitised names, content that matches the extension, a size cap,
//! and writes that can never leave the target folder.

use std::path::{Path, PathBuf};

use crate::ids::{content_matches_ext, sanitize_filename};

/// Largest export accepted over IPC.
pub const MAX_EXPORT_BYTES: usize = 128 * 1024 * 1024;

pub fn lowercase_ext(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
}

/// First free `name.ext`, `name (2).ext`, ... inside `dir`.
pub fn unique_path(dir: &Path, filename: &str, exists: impl Fn(&Path) -> bool) -> PathBuf {
    let first = dir.join(filename);
    if !exists(&first) {
        return first;
    }
    let (stem, ext) = filename.rsplit_once('.').unwrap_or((filename, ""));
    for n in 2..10_000 {
        let candidate = dir.join(format!("{stem} ({n}).{ext}"));
        if !exists(&candidate) {
            return candidate;
        }
    }
    dir.join(format!("{stem} ({}).{ext}", crate::ids::new_id()))
}

/// Percent-encode `s` for use as a URL query value (unreserved characters pass through).
pub fn query_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// Write an export into `folder` and return the final path.
pub fn save_export(folder: &Path, bytes: &[u8], filename: &str) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("There is nothing to save.".to_string());
    }
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("That export is too large to save.".to_string());
    }
    let name = sanitize_filename(filename)?;
    let ext = lowercase_ext(Path::new(&name)).unwrap_or_default();
    if !content_matches_ext(bytes, &ext) {
        return Err("The image data does not match the file type.".to_string());
    }
    std::fs::create_dir_all(folder)
        .map_err(|_| "The save folder could not be created.".to_string())?;
    let target = unique_path(folder, &name, |p| p.exists());
    if target.parent() != Some(folder) {
        return Err("The file name is not valid.".to_string());
    }
    let tmp = target.with_extension(format!("{ext}.part"));
    std::fs::write(&tmp, bytes).map_err(|_| "The file could not be written.".to_string())?;
    std::fs::rename(&tmp, &target).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        "The file could not be saved.".to_string()
    })?;
    Ok(target)
}

/// Decode the output of JavaScript's `encodeURIComponent`: `%XX` escapes, strict UTF-8.
pub fn percent_decode(s: &str) -> Result<String, String> {
    fn hex(b: u8) -> Option<u8> {
        match b {
            b'0'..=b'9' => Some(b - b'0'),
            b'a'..=b'f' => Some(b - b'a' + 10),
            b'A'..=b'F' => Some(b - b'A' + 10),
            _ => None,
        }
    }
    let bad = || "The save location is not valid.".to_string();
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' {
            let (h, l) = match (b.get(i + 1), b.get(i + 2)) {
                (Some(&h), Some(&l)) => (hex(h).ok_or_else(bad)?, hex(l).ok_or_else(bad)?),
                _ => return Err(bad()),
            };
            out.push(h << 4 | l);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).map_err(|_| bad())
}

/// Save an export at a path the user picked in a Save As dialog (header `x-save-path`).
///
/// Stricter than a name check because the folder is not ours: the path must be a plain absolute
/// Windows path (no `..`, device namespaces or alternate streams), its file name must already be
/// clean (a reserved or oddly spelled name is refused, not silently renamed) and end in
/// png/jpg/jpeg/webp matching the content, and the folder must already exist. An existing file is
/// replaced (the dialog asked the user about that); an existing folder is never touched.
pub fn save_export_at(path: &Path, bytes: &[u8]) -> Result<PathBuf, String> {
    if bytes.is_empty() {
        return Err("There is nothing to save.".to_string());
    }
    if bytes.len() > MAX_EXPORT_BYTES {
        return Err("That export is too large to save.".to_string());
    }
    if path.as_os_str().len() > 1024 || !crate::opener::is_plain_absolute(path) {
        return Err("The save location is not valid.".to_string());
    }
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("The save location is not valid.")?;
    let clean = sanitize_filename(name)?;
    if clean != name {
        return Err(
            "That file name is not allowed. Use a plain name ending in .png, .jpg or .webp."
                .to_string(),
        );
    }
    let ext = lowercase_ext(path).unwrap_or_default();
    if !content_matches_ext(bytes, &ext) {
        return Err("The image data does not match the file type.".to_string());
    }
    let parent = path.parent().ok_or("The save location is not valid.")?;
    if !std::fs::metadata(parent).is_ok_and(|m| m.is_dir()) {
        return Err("That folder does not exist.".to_string());
    }
    if std::fs::metadata(path).is_ok_and(|m| !m.is_file()) {
        return Err("There is already a folder with that name.".to_string());
    }
    let tmp = parent.join(format!(".polishot-{}.part", crate::ids::new_id()));
    std::fs::write(&tmp, bytes).map_err(|_| "The file could not be written.".to_string())?;
    std::fs::rename(&tmp, path).map_err(|_| {
        let _ = std::fs::remove_file(&tmp);
        "The file could not be saved there. Is it open in another app?".to_string()
    })?;
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];

    fn temp() -> PathBuf {
        let d = std::env::temp_dir().join(format!("ps-files-{}", crate::ids::new_id()));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn saves_inside_the_folder_and_never_overwrites() {
        let dir = temp();
        let a = save_export(&dir, PNG, "shot.png").unwrap();
        let b = save_export(&dir, PNG, "shot.png").unwrap();
        let c = save_export(&dir, PNG, "shot.png").unwrap();
        assert_eq!(a, dir.join("shot.png"));
        assert_eq!(b, dir.join("shot (2).png"));
        assert_eq!(c, dir.join("shot (3).png"));
        assert_eq!(std::fs::read(&a).unwrap(), PNG);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn traversal_in_names_cannot_escape() {
        let dir = temp().join("exports");
        for evil in [
            "..\\..\\evil.png",
            "../../evil.png",
            "C:\\Windows\\evil.png",
            "/etc/x.png",
        ] {
            let p = save_export(&dir, PNG, evil).unwrap();
            assert_eq!(p.parent(), Some(dir.as_path()), "{evil}");
        }
        assert!(!dir.parent().unwrap().join("evil.png").exists());
        let _ = std::fs::remove_dir_all(dir.parent().unwrap());
    }

    #[test]
    fn rejects_bad_names_mismatched_content_and_oversize() {
        let dir = temp();
        assert!(save_export(&dir, PNG, "x.exe").is_err());
        assert!(save_export(&dir, PNG, "").is_err());
        assert!(save_export(&dir, b"MZ not an image", "x.png").is_err());
        assert!(save_export(&dir, PNG, "x.jpg").is_err()); // PNG bytes under a .jpg name
        assert!(save_export(&dir, &[], "x.png").is_err());
        let big = vec![0u8; MAX_EXPORT_BYTES + 1];
        assert!(save_export(&dir, &big, "x.png").is_err());
        assert_eq!(
            std::fs::read_dir(&dir).unwrap().count(),
            0,
            "nothing written on failure"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unique_path_numbering() {
        let taken = [PathBuf::from("d/a.png"), PathBuf::from("d/a (2).png")];
        let p = unique_path(Path::new("d"), "a.png", |p| taken.iter().any(|t| t == p));
        assert_eq!(p, PathBuf::from("d/a (3).png"));
        let p = unique_path(Path::new("d"), "fresh.png", |_| false);
        assert_eq!(p, PathBuf::from("d/fresh.png"));
    }

    #[test]
    fn query_values_are_fully_escaped() {
        assert_eq!(
            query_escape("Recording 2026-01-15 03.04.05.gif"),
            "Recording%202026-01-15%2003.04.05.gif"
        );
        assert_eq!(
            query_escape("C:\\Users\\me\\a&b=c.gif"),
            "C%3A%5CUsers%5Cme%5Ca%26b%3Dc.gif"
        );
        assert_eq!(query_escape("é😀"), "%C3%A9%F0%9F%98%80");
        assert_eq!(query_escape(""), "");
    }

    #[test]
    fn extension_helper() {
        assert_eq!(lowercase_ext(Path::new("a.PNG")).as_deref(), Some("png"));
        assert_eq!(lowercase_ext(Path::new("noext")), None);
    }

    #[test]
    fn percent_decoding_matches_encode_uri_component() {
        assert_eq!(percent_decode("abc").unwrap(), "abc");
        assert_eq!(
            percent_decode("C%3A%5CUsers%5CZo%C3%AB%5Cshot%20one.png").unwrap(),
            "C:\\Users\\Zoë\\shot one.png"
        );
        assert_eq!(percent_decode("%e2%9c%93").unwrap(), "✓");
        for bad in ["%", "%4", "%zz", "%C3", "%FF%FF", "100%"] {
            assert!(percent_decode(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn save_as_writes_exactly_where_the_user_picked() {
        let dir = temp();
        let target = dir.join("My shot.png");
        assert_eq!(save_export_at(&target, PNG).unwrap(), target);
        assert_eq!(std::fs::read(&target).unwrap(), PNG);
        // Replacing is allowed (the dialog asked), and leaves no temp file behind.
        let newer = [PNG, &[9, 9]].concat();
        save_export_at(&target, &newer).unwrap();
        assert_eq!(std::fs::read(&target).unwrap(), newer);
        let leftovers = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .count();
        assert_eq!(leftovers, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_as_refuses_unsafe_locations_and_mismatched_content() {
        let dir = temp();
        let at = |n: &str| dir.join(n);
        // Content must match the extension; only image extensions.
        assert!(save_export_at(&at("a.png"), b"not a png").is_err());
        assert!(save_export_at(&at("a.jpg"), PNG).is_err());
        assert!(save_export_at(&at("a.exe"), PNG).is_err());
        assert!(save_export_at(&at("a"), PNG).is_err());
        assert!(save_export_at(&at("a.png"), &[]).is_err());
        // Names that would be silently altered are refused instead.
        assert!(save_export_at(&at("con.png"), PNG).is_err());
        assert!(save_export_at(&at("CON.backup.png"), PNG).is_err());
        assert!(save_export_at(&at("a.png "), PNG).is_err());
        assert!(save_export_at(&at("a?.png"), PNG).is_err());
        // Not absolute, traversal, device namespaces, alternate streams.
        assert!(save_export_at(Path::new("shot.png"), PNG).is_err());
        assert!(save_export_at(Path::new(r"C:shot.png"), PNG).is_err());
        assert!(save_export_at(&dir.join("..").join("x.png"), PNG).is_err());
        assert!(save_export_at(Path::new(r"\\?\C:\x.png"), PNG).is_err());
        assert!(save_export_at(Path::new(r"\\.\pipe\x.png"), PNG).is_err());
        assert!(save_export_at(&at("a.png:stream"), PNG).is_err());
        // The folder must exist; folders are never replaced.
        assert!(save_export_at(&dir.join("missing").join("a.png"), PNG).is_err());
        std::fs::create_dir_all(dir.join("taken.png")).unwrap();
        assert!(save_export_at(&dir.join("taken.png"), PNG).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
