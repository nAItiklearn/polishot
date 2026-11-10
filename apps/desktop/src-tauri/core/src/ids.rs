//! Capture ids and file-name hygiene. Every id that reaches the file system or the protocol
//! handler goes through [`is_valid_id`]; paths are never built from raw input.

use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// `^[A-Za-z0-9_-]{1,64}$`
pub fn is_valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

pub fn validate_id(id: &str) -> Result<&str, String> {
    if is_valid_id(id) {
        Ok(id)
    } else {
        Err("Invalid capture id.".to_string())
    }
}

pub fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// Unique, sortable-by-time id: 11 hex digits of epoch milliseconds, then 8 random hex digits.
pub fn new_id() -> String {
    let mut h = RandomState::new().build_hasher();
    h.write_u64(COUNTER.fetch_add(1, Ordering::Relaxed));
    h.write_u64(now_millis());
    let rnd = (h.finish() & 0xffff_ffff) as u32;
    format!("{:011x}{:08x}", now_millis(), rnd)
}

const RESERVED: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// File extensions an export may use.
pub const EXPORT_EXTS: [&str; 4] = ["png", "jpg", "jpeg", "webp"];

/// Make an untrusted file name safe to join onto a folder. The result never contains a path
/// separator, a drive prefix, control characters or a Windows reserved device name, and always has
/// one of [`EXPORT_EXTS`] as its extension.
pub fn sanitize_filename(raw: &str) -> Result<String, String> {
    // Keep only the last path component, whichever separator was used.
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut cleaned: String = base
        .chars()
        .filter(|c| !c.is_control())
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '|' | '?' | '*' => '_',
            c => c,
        })
        .collect();
    // Trailing dots and spaces are silently dropped by Windows; make that explicit.
    while cleaned.ends_with('.') || cleaned.ends_with(' ') {
        cleaned.pop();
    }
    let cleaned = cleaned.trim_start().to_string();
    if cleaned.is_empty() {
        return Err("The file name is empty.".to_string());
    }
    let (stem, ext) = match cleaned.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), e.to_ascii_lowercase()),
        None => return Err("The file name needs an extension (png, jpg or webp).".to_string()),
    };
    if !EXPORT_EXTS.contains(&ext.as_str()) {
        return Err("Only png, jpg and webp files can be saved.".to_string());
    }
    let mut stem: String = stem
        .trim_end_matches([' ', '.'])
        .chars()
        .take(120)
        .collect();
    if stem.is_empty() {
        stem = "image".to_string();
    }
    // Reserved device names are reserved with or without an extension, any case.
    let upper = stem.split('.').next().unwrap_or("").to_ascii_uppercase();
    if RESERVED.contains(&upper.as_str()) {
        stem.insert(0, '_');
    }
    Ok(format!("{stem}.{ext}"))
}

/// True when `bytes` start with the magic number matching `ext` (png, jpg/jpeg or webp).
pub fn content_matches_ext(bytes: &[u8], ext: &str) -> bool {
    match ext {
        "png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a]),
        "jpg" | "jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "webp" => bytes.len() > 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_validation_matches_the_contract_regex() {
        for ok in ["a", "A-z_9", &"x".repeat(64), "019a2b3c4d5e00112233"] {
            assert!(is_valid_id(ok), "{ok}");
        }
        let long = "x".repeat(65);
        for bad in [
            "", " ", "a b", "../x", "a/b", "a\\b", "a.png", "a%20", "é", "a\n", "a\0", &long,
        ] {
            assert!(!is_valid_id(bad), "{bad:?}");
        }
    }

    #[test]
    fn generated_ids_are_valid_and_unique() {
        let a = new_id();
        let b = new_id();
        assert!(is_valid_id(&a));
        assert_ne!(a, b);
        assert_eq!(a.len(), 19);
    }

    #[test]
    fn sanitize_strips_directories_and_bad_characters() {
        assert_eq!(sanitize_filename("shot.png").unwrap(), "shot.png");
        assert_eq!(sanitize_filename("..\\..\\evil.png").unwrap(), "evil.png");
        assert_eq!(sanitize_filename("C:\\x\\y\\a.PNG").unwrap(), "a.png");
        assert_eq!(sanitize_filename("/etc/passwd.jpg").unwrap(), "passwd.jpg");
        assert_eq!(
            sanitize_filename("a<b>c:d|e?f*g\".webp").unwrap(),
            "a_b_c_d_e_f_g_.webp"
        );
        assert_eq!(
            sanitize_filename("tab\there\u{7}.png").unwrap(),
            "tabhere.png"
        );
    }

    #[test]
    fn sanitize_rejects_bad_extensions_and_empty_names() {
        assert!(sanitize_filename("").is_err());
        assert!(sanitize_filename("   ").is_err());
        assert!(sanitize_filename("..").is_err());
        assert!(sanitize_filename("noext").is_err());
        assert!(sanitize_filename("run.exe").is_err());
        assert!(sanitize_filename("a.png.exe").is_err());
        assert!(sanitize_filename("dir/").is_err());
    }

    #[test]
    fn sanitize_defuses_reserved_device_names_and_trailing_dots() {
        assert_eq!(sanitize_filename("CON.png").unwrap(), "_CON.png");
        assert_eq!(sanitize_filename("nul.png").unwrap(), "_nul.png");
        assert_eq!(sanitize_filename("com1.jpg").unwrap(), "_com1.jpg");
        assert_eq!(sanitize_filename("name . .png").unwrap(), "name.png");
        assert_eq!(sanitize_filename(".png").unwrap(), "image.png");
        assert_eq!(sanitize_filename("trail.png.").unwrap(), "trail.png");
    }

    #[test]
    fn sanitize_limits_length() {
        let long = format!("{}.png", "a".repeat(500));
        let out = sanitize_filename(&long).unwrap();
        assert_eq!(out.len(), 124);
    }

    #[test]
    fn magic_numbers() {
        assert!(content_matches_ext(
            &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 0],
            "png"
        ));
        assert!(content_matches_ext(&[0xff, 0xd8, 0xff, 0xe0], "jpg"));
        assert!(content_matches_ext(b"RIFF\0\0\0\0WEBPVP8 ", "webp"));
        assert!(!content_matches_ext(b"MZ\x90\0", "png"));
        assert!(!content_matches_ext(b"", "jpg"));
    }
}
