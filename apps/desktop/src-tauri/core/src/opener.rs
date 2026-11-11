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

/// True for a plain absolute path on a local or mapped drive (`C:\...`). Network paths
/// (`\\server\share`) are excluded: touching one makes Windows send the user's NTLM credentials
/// to that server, so a path chosen by web content must never reach one. A share mapped to a
/// drive letter works.
pub fn is_local_drive_path(path: &Path) -> bool {
    is_plain_absolute(path)
        && matches!(
            path.components().next(),
            Some(Component::Prefix(p)) if matches!(p.kind(), Prefix::Disk(_))
        )
}

/// The app's own site (`SITE_URL` in `@polishot/brand`, which a test below keeps in step).
pub const SITE_LINK_HOSTS: [&str; 2] = ["polishot.cam", "www.polishot.cam"];

/// Hosts of the payment pages. Empty until checkout goes live; then add the exact host, and a test
/// for it. Nothing else, whatever it looks like, is opened, so a compromised page cannot use the
/// app to open attacker links.
pub const CHECKOUT_LINK_HOSTS: [&str; 0] = [];

fn link_host_allowed(host: &str) -> bool {
    SITE_LINK_HOSTS.contains(&host) || CHECKOUT_LINK_HOSTS.contains(&host)
}

/// A link the app may open: [`validate_https_url`] plus an allowed host and the default port.
pub fn validate_link(raw: &str) -> Result<&str, String> {
    let url = validate_https_url(raw)?;
    let authority = url["https://".len()..]
        .split(['/', '?', '#'])
        .next()
        .unwrap_or("");
    let (host, port) = match authority.split_once(':') {
        Some((h, p)) => (h, Some(p)),
        None => (authority, None),
    };
    let host = host.to_ascii_lowercase();
    if !link_host_allowed(&host) || port.is_some_and(|p| p != "443") {
        return Err("That link is not one this app opens.".to_string());
    }
    Ok(url)
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
    if !is_local_drive_path(&path) {
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

/// Remove the `\\?\` prefix that `std::fs::canonicalize` puts on every path:
/// `\\?\C:\a\b.png` becomes `C:\a\b.png` and `\\?\UNC\srv\share\x.png` becomes
/// `\\srv\share\x.png`. WinRT (`StorageFile::GetFileFromPathAsync`, used by the share sheet) and
/// `explorer /select,` reject the verbatim form. Anything else is returned unchanged.
pub fn strip_verbatim(path: &Path) -> PathBuf {
    let Some(s) = path.to_str() else {
        return path.to_path_buf();
    };
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        return PathBuf::from(format!(r"\\{rest}"));
    }
    if let Some(rest) = s.strip_prefix(r"\\?\") {
        let b = rest.as_bytes();
        if b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'\\' {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

/// Check a path the UI wants shared or revealed: it must resolve (symlinks and `..` resolved by the
/// file system) to an existing image inside one of `roots` (the save folder and the captures
/// folder). The result is a plain absolute path without the verbatim prefix, so the Windows share
/// sheet and Explorer accept it.
pub fn resolve_shareable(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let not_shareable = || "Only saved images can be shared.".to_string();
    if raw.is_empty() || raw.len() > MAX_PATH_LEN || raw.contains('\0') {
        return Err("That file path is not valid.".to_string());
    }
    // Checked before anything touches the file system: resolving a network path contacts the
    // server (and sends credentials to it).
    if !is_local_drive_path(Path::new(raw)) {
        return Err("Only images on a local or mapped drive can be shared.".to_string());
    }
    let canon =
        std::fs::canonicalize(raw).map_err(|_| "That file could not be found.".to_string())?;
    let inside = roots
        .iter()
        .filter_map(|r| std::fs::canonicalize(r).ok())
        .any(|root| canon.starts_with(root));
    if !inside {
        return Err(not_shareable());
    }
    let ext = crate::export::lowercase_ext(&canon).unwrap_or_default();
    let image = crate::ids::EXPORT_EXTS.contains(&ext.as_str()) || ext == "gif";
    if !image || !canon.is_file() {
        return Err(not_shareable());
    }
    let plain = strip_verbatim(&canon);
    if !is_plain_absolute(&plain) {
        return Err("That file's location cannot be shared.".to_string());
    }
    Ok(plain)
}

/// Open `url` in the default browser (after [`validate_link`]).
pub fn open_url(url: &str) -> Result<(), String> {
    let url = validate_link(url)?;
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
    fn network_paths_are_not_local_drive_paths() {
        for ok in [
            r"C:\a\b.png",
            r"d:\x",
            "C:/Users/me/a.png",
            r"Z:\mapped\a.png",
        ] {
            assert!(is_local_drive_path(Path::new(ok)), "{ok}");
        }
        for bad in [
            r"\\server\share\a.png",
            r"\\?\C:\a.png",
            r"\\?\UNC\server\share\a.png",
            r"\\.\C:\a.png",
            r"C:a.png",
            r"a.png",
            "",
        ] {
            assert!(!is_local_drive_path(Path::new(bad)), "{bad:?}");
        }
    }

    #[test]
    fn the_allowed_site_is_the_brand_site() {
        let brand = include_str!("../../../../../packages/brand/src/index.ts");
        let line = brand
            .lines()
            .find(|l| l.contains("SITE_URL"))
            .expect("brand defines SITE_URL");
        let host = line
            .split("https://")
            .nth(1)
            .and_then(|r| r.split(['\'', '"', '/']).next())
            .expect("SITE_URL is an https URL");
        assert!(
            SITE_LINK_HOSTS.contains(&host),
            "{host} is not in SITE_LINK_HOSTS"
        );
        assert!(validate_link(&format!("https://{host}/pricing")).is_ok());
    }

    #[test]
    fn only_the_apps_own_hosts_are_opened() {
        for ok in [
            "https://polishot.cam",
            "https://polishot.cam/",
            "https://www.polishot.cam/pricing?ref=app#buy",
            "HTTPS://Polishot.Cam/Pricing",
            "https://polishot.cam:443/x",
        ] {
            assert_eq!(validate_link(ok), Ok(ok), "{ok}");
        }
        for bad in [
            "https://evil.example/",
            "https://polishot.cam.evil.example/",
            "https://evilpolishot.cam/",
            "https://sub.polishot.cam/",
            "https://polishot.cam:8443/",
            "https://stripe.com/",
            "https://checkout.stripe.com/c/pay/cs_live_abc", // until checkout goes live
            "https://polishot.app/",                         // the old domain
            "https://polishot.cam.evil.example/",
            "https://evil-polishot.cam/",
            "https://a.www.polishot.cam/",
            "https://x.localhost/",
            "https://localhost/",
            "https://polishot.cam@evil.example/",
            "http://polishot.cam/",
            "javascript:alert(1)",
            "file:///C:/Windows/System32/calc.exe",
            "",
        ] {
            assert!(validate_link(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn only_https_links_to_named_hosts_open() {
        for ok in [
            "https://polishot.cam",
            "https://polishot.cam/",
            "https://www.polishot.cam/pricing?ref=app#buy",
            "HTTPS://Polishot.Cam/Pricing",
            "https://checkout.example.co.uk:8443/session/abc123",
            "https://a-b.example.com/%E2%9C%93",
        ] {
            assert_eq!(validate_https_url(ok), Ok(ok), "{ok}");
        }
        for bad in [
            "",
            "https://",
            "http://polishot.cam",
            "ftp://polishot.cam",
            "file:///C:/Windows/System32/calc.exe",
            "javascript:alert(1)",
            "mailto:a@b.com",
            "data:text/html,hi",
            "polishot.cam",
            "//polishot.cam",
            "https:///polishot.cam",
            "https://user@polishot.cam",
            "https://user:pass@polishot.cam",
            "https://polishot.cam@evil.example",
            "https://polishot.cam\\@evil.example",
            "https://polishot.cam/a b",
            "https://polishot.cam/\tx",
            "https://polishot.cam/\nx",
            "https://localhost/",
            "https://intranet/",
            "https://127.0.0.1/",
            "https://192.168.0.1:8080/",
            "https://[::1]/",
            "https://polishot..app/",
            "https://.polishot.cam/",
            "https://polishot.cam./",
            "https://-bad.example.com/",
            "https://bad-.example.com/",
            "https://exa_mple.com/",
            "https://exämple.com/",
            "https://polishot.cam:0/",
            "https://polishot.cam:99999/",
            "https://polishot.cam:80a/",
            "https://polishot.cam:/",
            "https://0x7f.1/",
        ] {
            assert!(validate_https_url(bad).is_err(), "{bad:?}");
        }
        let long = format!("https://polishot.cam/{}", "a".repeat(MAX_URL_LEN));
        assert!(validate_https_url(&long).is_err());
        let long_label = format!("https://{}.com/", "a".repeat(64));
        assert!(validate_https_url(&long_label).is_err());
    }

    #[test]
    fn the_verbatim_prefix_is_removed_only_where_it_is_safe() {
        let p = |s: &str| strip_verbatim(Path::new(s));
        assert_eq!(
            p(r"\\?\C:\Users\me\a.png"),
            PathBuf::from(r"C:\Users\me\a.png")
        );
        assert_eq!(p(r"\\?\c:\x"), PathBuf::from(r"c:\x"));
        assert_eq!(
            p(r"\\?\UNC\srv\share\a.png"),
            PathBuf::from(r"\\srv\share\a.png")
        );
        // Already plain, or a form we do not understand: unchanged.
        assert_eq!(p(r"C:\a\b.png"), PathBuf::from(r"C:\a\b.png"));
        assert_eq!(p(r"\\srv\share\a.png"), PathBuf::from(r"\\srv\share\a.png"));
        assert_eq!(
            p(r"\\?\Volume{1234}\a.png"),
            PathBuf::from(r"\\?\Volume{1234}\a.png")
        );
        assert_eq!(p(r"\\?\C:"), PathBuf::from(r"\\?\C:"));
        assert_eq!(p(r"\\.\pipe\x"), PathBuf::from(r"\\.\pipe\x"));
        assert_eq!(p(""), PathBuf::new());
        // Stripping a canonical path gives something the plain-path rules accept.
        assert!(is_plain_absolute(&p(r"\\?\C:\Users\me\a.png")));
        assert!(is_plain_absolute(&p(r"\\?\UNC\srv\share\a.png")));
    }

    #[test]
    fn shareable_paths_are_canonical_inside_the_roots_and_never_verbatim() {
        let base = std::env::temp_dir().join(format!("ps-share-{}", crate::ids::new_id()));
        let saves = base.join("saves");
        let elsewhere = base.join("elsewhere");
        std::fs::create_dir_all(&saves).unwrap();
        std::fs::create_dir_all(&elsewhere).unwrap();
        let png = saves.join("shot.png");
        let gif = saves.join("clip.gif");
        let txt = saves.join("notes.txt");
        let outside = elsewhere.join("other.png");
        for f in [&png, &gif, &txt, &outside] {
            std::fs::write(f, b"x").unwrap();
        }
        let roots = vec![saves.clone()];

        let got = resolve_shareable(png.to_str().unwrap(), &roots).unwrap();
        let expected = strip_verbatim(&std::fs::canonicalize(&png).unwrap());
        assert_eq!(got, expected);
        assert!(!got.to_string_lossy().starts_with(r"\\?\"), "{got:?}");
        assert!(is_plain_absolute(&got));
        assert!(
            got.is_file(),
            "WinRT and Explorer need to open this exact path"
        );
        assert!(resolve_shareable(gif.to_str().unwrap(), &roots).is_ok());

        // Not an image, outside the roots, a folder, missing, or a traversal out of the root.
        assert!(resolve_shareable(txt.to_str().unwrap(), &roots).is_err());
        assert!(resolve_shareable(outside.to_str().unwrap(), &roots).is_err());
        assert!(resolve_shareable(saves.to_str().unwrap(), &roots).is_err());
        assert!(resolve_shareable(saves.join("missing.png").to_str().unwrap(), &roots).is_err());
        let sneaky = format!(r"{}\..\elsewhere\other.png", saves.display());
        assert!(resolve_shareable(&sneaky, &roots).is_err());
        assert!(resolve_shareable("", &roots).is_err());
        assert!(resolve_shareable("x\0.png", &roots).is_err());
        // A second root works, and no roots means nothing is shareable.
        assert!(
            resolve_shareable(outside.to_str().unwrap(), std::slice::from_ref(&elsewhere)).is_ok()
        );
        assert!(resolve_shareable(png.to_str().unwrap(), &[]).is_err());
        let _ = std::fs::remove_dir_all(&base);
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
        assert!(validate_reveal_path(r"\\server\share\shot.png").is_err());
        assert!(validate_reveal_path(r"\\?\C:\shot.png").is_err());
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
