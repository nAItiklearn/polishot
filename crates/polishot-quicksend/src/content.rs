//! Content rules: MIME allowlist, magic bytes, name validation and sanitization (spec sections 2.2 and 9).

use crate::error::{Error, Result};
use crate::proto::{ALLOWED_MIME, MAX_DEVICE_NAME_CHARS, MAX_FILE_NAME_BYTES};

/// Code points never allowed in device names or file names.
pub(crate) fn is_forbidden_char(c: char) -> bool {
    matches!(c as u32,
        0x0000..=0x001F
        | 0x007F..=0x009F
        | 0x2028
        | 0x2029
        | 0x200E
        | 0x200F
        | 0x202A..=0x202E
        | 0x2066..=0x2069)
}

/// True when `mime` is exactly one of the allowed image types.
pub fn is_allowed_mime(mime: &str) -> bool {
    ALLOWED_MIME.contains(&mime)
}

/// Check the leading bytes of `data` against the offered MIME type.
pub fn check_magic(mime: &str, data: &[u8]) -> bool {
    match mime {
        "image/png" => data.starts_with(&[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        "image/jpeg" => data.starts_with(&[0xFF, 0xD8, 0xFF]),
        "image/webp" => data.len() >= 12 && &data[0..4] == b"RIFF" && &data[8..12] == b"WEBP",
        _ => false,
    }
}

/// Validate a device name received from the wire or an advertisement.
pub fn validate_device_name(name: &str) -> Result<()> {
    let n = name.chars().count();
    if n == 0 || n > MAX_DEVICE_NAME_CHARS {
        return Err(Error::Protocol("device name must be 1 to 32 characters"));
    }
    if name.chars().any(is_forbidden_char) {
        return Err(Error::Protocol("device name contains forbidden characters"));
    }
    Ok(())
}

/// Validate a file name received from the wire.
pub(crate) fn validate_wire_file_name(name: &str) -> Result<()> {
    if name.is_empty() || name.len() > MAX_FILE_NAME_BYTES {
        return Err(Error::Protocol("file name must be 1 to 128 bytes"));
    }
    if name.chars().any(is_forbidden_char) {
        return Err(Error::Protocol("file name contains forbidden characters"));
    }
    Ok(())
}

/// Turn any string into a valid device name (see the spec, section 2.2).
pub fn clean_device_name(raw: &str) -> String {
    let filtered: String = raw.chars().filter(|c| !is_forbidden_char(*c)).collect();
    let trimmed = filtered.trim_matches(' ');
    let cut: String = trimmed.chars().take(MAX_DEVICE_NAME_CHARS).collect();
    let cut = cut.trim_matches(' ');
    if cut.is_empty() {
        "Device".to_string()
    } else {
        cut.to_string()
    }
}

const RESERVED_DEVICE_NAMES: [&str; 22] = [
    "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
    "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
];

/// Make a file name safe to show and to use as a path component (see the spec, section 2.2).
pub fn sanitize_file_name(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|c| {
            if is_forbidden_char(c)
                || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut name = replaced.trim_matches(|c| c == ' ' || c == '.').to_string();
    if name.is_empty() {
        name = "image".to_string();
    }
    let stem = name.split('.').next().unwrap_or("");
    if RESERVED_DEVICE_NAMES
        .iter()
        .any(|r| r.eq_ignore_ascii_case(stem))
    {
        name.insert(0, '_');
    }
    if name.len() > MAX_FILE_NAME_BYTES {
        let mut end = 0;
        for (i, c) in name.char_indices() {
            if i + c.len_utf8() > MAX_FILE_NAME_BYTES {
                break;
            }
            end = i + c.len_utf8();
        }
        name.truncate(end);
        name = name.trim_matches(|c| c == ' ' || c == '.').to_string();
        if name.is_empty() {
            name = "image".to_string();
        }
    }
    name
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mime_and_magic() {
        assert!(is_allowed_mime("image/png"));
        assert!(!is_allowed_mime("image/gif"));
        assert!(!is_allowed_mime("IMAGE/PNG"));
        assert!(check_magic(
            "image/png",
            &[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0]
        ));
        assert!(!check_magic("image/png", b"GIF89a"));
        assert!(check_magic("image/jpeg", &[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(check_magic("image/webp", b"RIFF\x00\x00\x00\x00WEBPVP8 "));
        assert!(!check_magic("image/webp", b"RIFF\x00\x00\x00\x00WAVEfmt "));
        assert!(!check_magic("image/webp", b"RIFF"));
        assert!(!check_magic("text/plain", b"hello"));
    }

    #[test]
    fn device_names() {
        assert!(validate_device_name("Pixel 9").is_ok());
        assert!(validate_device_name("").is_err());
        assert!(validate_device_name(&"a".repeat(33)).is_err());
        assert!(validate_device_name(&"a".repeat(32)).is_ok());
        assert!(validate_device_name("bad\nname").is_err());
        assert!(validate_device_name("rtl\u{202E}name").is_err());
        assert_eq!(clean_device_name("  \u{202E}Pixel\n 9  "), "Pixel 9");
        assert_eq!(clean_device_name("\n\n"), "Device");
        assert_eq!(clean_device_name(&"é".repeat(40)).chars().count(), 32);
    }

    #[test]
    fn file_names() {
        assert_eq!(sanitize_file_name("shot.png"), "shot.png");
        assert_eq!(sanitize_file_name("../../etc/passwd"), "_.._etc_passwd");
        assert_eq!(sanitize_file_name("a:b*c?.png"), "a_b_c_.png");
        assert_eq!(sanitize_file_name("  ...  "), "image");
        assert_eq!(sanitize_file_name("con.png"), "_con.png");
        assert_eq!(sanitize_file_name("NUL"), "_NUL");
        assert_eq!(sanitize_file_name("COM10.png"), "COM10.png");
        let long = format!("{}.png", "ä".repeat(100));
        let s = sanitize_file_name(&long);
        assert!(s.len() <= MAX_FILE_NAME_BYTES);
        assert!(validate_wire_file_name(&s).is_ok());
        for raw in ["x/y", "con", "..a..", &long, "\u{202E}evil.png"] {
            let once = sanitize_file_name(raw);
            assert_eq!(sanitize_file_name(&once), once, "idempotent for {raw:?}");
            assert!(validate_wire_file_name(&once).is_ok());
        }
    }
}
