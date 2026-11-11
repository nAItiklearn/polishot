//! What the preview window may ask the shell to do: open a web link and reveal a saved image in
//! File Explorer. Both are narrow on purpose: https links to named hosts only, and existing image
//! files on plain absolute paths only. The validators are pure so they are fully unit-tested.

use std::path::{Component, Path, PathBuf, Prefix};

use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// Longest link or path accepted over IPC.
const MAX_URL_LEN: usize = 2048;
const MAX_PATH_LEN: usize = 1024;
/// File types Explorer may be asked to select.
pub const REVEAL_EXTS: [&str; 5] = ["png", "jpg", "jpeg", "webp", "gif"];

/// True for a plain absolute Windows path: a drive letter or a UNC share, then a root, then
/// ordinary names. No `..`, no drive-relative `C:foo`, no `\\?\` or `\\.\` device namespaces, no
/// alternate data streams (`:`), no wildcard or control characters in any name.
pub fn is_plain_absolute(path: &Path) -> bool {
    let mut comps = path.components();
    match comps.next() {
        Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_) | Prefix::UNC(..)) => {}
        _ => return false,
    }
    if !matches!(comps.next(), Some(Component::RootDir)) {
        return false;
    }
    comps.all(|c| match c {
        Component::Normal(name) => name.to_str().is_some_and(|n| {
            !n.is_empty()
                && !n
                    .chars()
                    .any(|c| c.is_control() || matches!(c, ':' | '<' | '>' | '"' | '|' | '?' | '*'))
        }),
        _ => false,
    })
}

/// Check a link the UI wants opened in the default browser. Accepts `https://` links to a named
/// host (at least two labels, a TLD that is not purely numeric, optional port) with no credentials
/// in them. Returns the link unchanged.
pub fn validate_https_url(raw: &str) -> Result<&str, String> {
    let bad = || "Only secure web links can be opened.".to_string();
    if raw.is_empty() || raw.len() > MAX_URL_LEN || !raw.bytes().all(|b| (0x21..=0x7e).contains(&b))
    {
        return Err(bad());
    }
    let prefix = "https://";
    if raw.len() <= prefix.len() || !raw[..prefix.len()].eq_ignore_ascii_case(prefix) {
        return Err(bad());
    }
    let rest = &raw[prefix.len()..];
    if rest.contains('\\') {
        return Err(bad());
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() || authority.contains(['@', '[', ']']) {
        return Err(bad());
    }
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    if let Some(p) = port {
        let ok = !p.is_empty() && p.len() <= 5 && p.bytes().all(|b| b.is_ascii_digit());
        if !ok || p.parse::<u32>().map_or(true, |n| n == 0 || n > 65_535) {
            return Err(bad());
        }
    }
    if host.is_empty() || host.len() > 253 {
        return Err(bad());
    }
    let labels: Vec<&str> = host.split('.').collect();
    let label_ok = |l: &str| {
        !l.is_empty()
            && l.len() <= 63
            && !l.starts_with('-')
            && !l.ends_with('-')
            && l.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    };
    let tld_has_letter = labels
        .last()
        .is_some_and(|t| t.bytes().any(|b| b.is_ascii_alphabetic()));
    if labels.len() < 2 || !labels.iter().all(|l| label_ok(l)) || !tld_has_letter {
        return Err(bad());
    }
    Ok(raw)
}

/// Check a path the UI wants shown in File Explorer: a plain absolute path to an image file that
/// exists. Returns the path.
pub fn validate_reveal_path(raw: &str) -> Result<PathBuf, String> {
    let bad = || "That file could not be found.".to_string();
    if raw.is_empty() || raw.len() > MAX_PATH_LEN || raw.contains('\0') {
        return Err(bad());
    }
    let path = PathBuf::from(raw);
    if !is_plain_absolute(&path) {
        return Err(bad());
    }
    let ext = crate::export::lowercase_ext(&path).unwrap_or_default();
    if !REVEAL_EXTS.contains(&ext.as_str()) {
        return Err("Only saved images can be shown in the folder.".to_string());
    }
    if !std::fs::metadata(&path).is_ok_and(|m| m.is_file()) {
        return Err(bad());
    }
    Ok(path)
}

/// Open `url` in the default browser (after [`validate_https_url`]).
pub fn open_url(url: &str) -> Result<(), String> {
    let url = validate_https_url(url)?;
    let target = HSTRING::from(url);
    // SAFETY: `target` is a valid NUL-terminated wide string that outlives the call; the other
    // pointer arguments are intentionally null.
    let result = unsafe {
        ShellExecuteW(
            None,
            w!("open"),
            &target,
            PCWSTR::null(),
            PCWSTR::null(),
            SW_SHOWNORMAL,
        )
    };
    // ShellExecute reports success with a value greater than 32.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("Could not open the web browser.".to_string())
    }
}

/// Show `raw` selected in File Explorer (after [`validate_reveal_path`]).
pub fn reveal(raw: &str) -> Result<(), String> {
    let path = validate_reveal_path(raw)?;
    crate::winutil::reveal_in_explorer(&path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_absolute_paths() {
        for ok in [
            r"C:\Users\Naitik Sahu\Pictures\Polishot\shot.png",
            r"D:\a\b.png",
            r"c:\x",
            r"\\server\share\folder\shot.png",
            "C:/Users/me/shot.png",
            "C:\\Users\\Zoë\\Bilder\\日本語.png",
        ] {
            assert!(is_plain_absolute(Path::new(ok)), "{ok}");
        }
        for bad in [
            "",
            "shot.png",
            r"relative\dir\shot.png",
            r"C:shot.png",
            r"\rooted\no\drive.png",
            r"C:\a\..\b.png",
            r"..\b.png",
            r"\\?\C:\a\b.png",
            r"\\.\pipe\name",
            r"\\?\UNC\server\share\b.png",
            r"C:\a\b.png:stream",
            r"C:\a\b.png::$DATA",
            r"C:\a\b?.png",
            r"C:\a\*.png",
            "C:\\a\\b\u{7}.png",
            r#"C:\a\"quote.png"#,
            r"C:\a\p|pe.png",
        ] {
            assert!(!is_plain_absolute(Path::new(bad)), "{bad:?}");
        }
    }

    #[test]
    fn only_https_links_to_named_hosts_open() {
        for ok in [
            "https://polishot.app",
            "https://polishot.app/",
            "https://www.polishot.app/pricing?ref=app#buy",
            "HTTPS://Polishot.App/Pricing",
            "https://checkout.example.co.uk:8443/session/abc123",
            "https://a-b.example.com/%E2%9C%93",
        ] {
            assert_eq!(validate_https_url(ok), Ok(ok), "{ok}");
        }
        for bad in [
            "",
            "https://",
            "http://polishot.app",
            "ftp://polishot.app",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "mailto:a@b.com",
            "data:text/html,hi",
            "polishot.app",
            "//polishot.app",
            "https:///polishot.app",
            "https://user@polishot.app",
            "https://user:pass@polishot.app",
            "https://polishot.app@evil.example",
            "https://polishot.app\\@evil.example",
            "https://polishot.app/a b",
            "https://polishot.app/\tx",
            "https://polishot.app/\nx",
            "https://localhost/",
            "https://intranet/",
            "https://127.0.0.1/",
            "https://192.168.0.1:8080/",
            "https://[::1]/",
            "https://polishot..app/",
            "https://.polishot.app/",
            "https://polishot.app./",
            "https://-bad.example.com/",
            "https://bad-.example.com/",
            "https://exa_mple.com/",
            "https://exämple.com/",
            "https://polishot.app:0/",
            "https://polishot.app:99999/",
            "https://polishot.app:80a/",
            "https://polishot.app:/",
            "https://0x7f.1/",
        ] {
            assert!(validate_https_url(bad).is_err(), "{bad:?}");
        }
        let long = format!("https://polishot.app/{}", "a".repeat(MAX_URL_LEN));
        assert!(validate_https_url(&long).is_err());
        let long_label = format!("https://{}.com/", "a".repeat(64));
        assert!(validate_https_url(&long_label).is_err());
    }

    #[test]
    fn reveal_accepts_only_existing_images_on_plain_paths() {
        let dir = std::env::temp_dir().join(format!("ps-open-{}", crate::ids::new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let png = dir.join("shot.png");
        std::fs::write(&png, b"x").unwrap();
        let txt = dir.join("notes.txt");
        std::fs::write(&txt, b"x").unwrap();
        let exe = dir.join("calc.exe");
        std::fs::write(&exe, b"x").unwrap();

        assert_eq!(validate_reveal_path(png.to_str().unwrap()), Ok(png.clone()));
        assert!(validate_reveal_path(txt.to_str().unwrap()).is_err());
        assert!(validate_reveal_path(exe.to_str().unwrap()).is_err());
        assert!(
            validate_reveal_path(dir.to_str().unwrap()).is_err(),
            "a folder"
        );
        assert!(validate_reveal_path(dir.join("missing.png").to_str().unwrap()).is_err());
        assert!(validate_reveal_path("").is_err());
        assert!(validate_reveal_path("shot.png").is_err());
        assert!(validate_reveal_path(&format!("{}\\..\\shot.png", dir.display())).is_err());
        assert!(validate_reveal_path(&format!("{}:stream.png", png.display())).is_err());
        assert!(validate_reveal_path(&"C:\\".repeat(600)).is_err());
        assert!(validate_reveal_path("C:\\a\0.png").is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
