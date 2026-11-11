//! Custom protocol routes (CONTRACTS section 5) and window-label helpers.
//!
//! Ids are validated before they get anywhere near a path; anything unexpected is `None`.

use crate::ids::is_valid_id;

#[derive(Debug, PartialEq, Eq)]
pub enum Route<'a> {
    Frame(usize),
    Capture(&'a str),
    History(&'a str),
    Thumb(&'a str),
}

/// Parse a URL path such as `/capture/<id>`. Extra segments, percent-encoding, backslashes and
/// invalid ids are all rejected.
pub fn parse_route(path: &str) -> Option<Route<'_>> {
    let rest = path.strip_prefix('/')?;
    let (kind, arg) = rest.split_once('/')?;
    if arg.contains('/') || arg.contains('%') || arg.contains('\\') {
        return None;
    }
    match kind {
        "frame" => {
            if arg.is_empty() || arg.len() > 3 || !arg.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            arg.parse().ok().map(Route::Frame)
        }
        "capture" if is_valid_id(arg) => Some(Route::Capture(arg)),
        "history" if is_valid_id(arg) => Some(Route::History(arg)),
        "thumb" if is_valid_id(arg) => Some(Route::Thumb(arg)),
        _ => None,
    }
}

/// Whether a webview may navigate to this URL: only the app's own pages. Release builds serve
/// them from `tauri://localhost` or `http(s)://tauri.localhost`; debug builds also load the Vite
/// dev server on port 1420. Everything else (a link, a redirect, `window.location`) is blocked, so
/// a bug that lets foreign content navigate a window cannot hand it the app's IPC.
pub fn is_app_origin(scheme: &str, host: Option<&str>, port: Option<u16>, dev: bool) -> bool {
    match (scheme, host) {
        ("tauri", _) => true,
        ("http" | "https", Some("tauri.localhost")) => port.is_none(),
        ("http", Some("127.0.0.1" | "localhost")) => dev && port == Some(1420),
        ("about", _) => true,
        _ => false,
    }
}

/// Which webview labels may fetch a route: a frozen frame only by its own overlay, everything
/// else by the preview and pin windows.
pub fn allowed(route: &Route<'_>, label: &str) -> bool {
    match route {
        Route::Frame(n) => label == overlay_label(*n),
        _ => label == "preview" || label.starts_with("pin-"),
    }
}

pub fn overlay_label(index: usize) -> String {
    format!("overlay-{index}")
}

/// Monitor index from an `overlay-<n>` label.
pub fn overlay_index(label: &str) -> Option<usize> {
    label.strip_prefix("overlay-")?.parse().ok()
}

#[cfg(test)]
mod tests {
    #[test]
    fn only_the_apps_own_pages_may_be_navigated_to() {
        use super::is_app_origin as ok;
        assert!(ok("tauri", Some("localhost"), None, false));
        assert!(ok("http", Some("tauri.localhost"), None, false));
        assert!(ok("https", Some("tauri.localhost"), None, false));
        assert!(ok("about", None, None, false));
        // The dev server is trusted in debug builds only, and only on its port.
        assert!(ok("http", Some("127.0.0.1"), Some(1420), true));
        assert!(ok("http", Some("localhost"), Some(1420), true));
        assert!(!ok("http", Some("127.0.0.1"), Some(1420), false));
        assert!(!ok("http", Some("127.0.0.1"), Some(8080), true));
        assert!(!ok("https", Some("127.0.0.1"), Some(1420), true));
        // Foreign content, look-alikes, and other schemes.
        for (scheme, host, port) in [
            ("https", Some("polishot.cam"), None),
            ("https", Some("evil.example"), None),
            ("http", Some("tauri.localhost.evil.example"), None),
            ("http", Some("evil-tauri.localhost"), None),
            ("http", Some("tauri.localhost"), Some(8080)),
            ("http", Some("polishot.localhost"), None),
            ("file", None, None),
            ("javascript", None, None),
            ("data", None, None),
            ("blob", None, None),
            ("ftp", Some("tauri.localhost"), None),
        ] {
            assert!(!ok(scheme, host, port, true), "{scheme} {host:?} {port:?}");
        }
    }

    use super::*;

    #[test]
    fn routes_parse() {
        assert_eq!(parse_route("/frame/0"), Some(Route::Frame(0)));
        assert_eq!(parse_route("/frame/12"), Some(Route::Frame(12)));
        assert_eq!(
            parse_route("/capture/abc_DEF-123"),
            Some(Route::Capture("abc_DEF-123"))
        );
        assert_eq!(parse_route("/history/x"), Some(Route::History("x")));
        assert_eq!(parse_route("/thumb/x"), Some(Route::Thumb("x")));
    }

    #[test]
    fn hostile_paths_are_rejected() {
        let long = format!("/capture/{}", "x".repeat(65));
        for bad in [
            "",
            "/",
            "/frame",
            "/frame/",
            "/frame/a",
            "/frame/-1",
            "/frame/1000",
            "/frame/1/2",
            "/capture/",
            "/capture/../x",
            "/capture/a/b",
            "/capture/a%2fb",
            "/capture/a.png",
            "/capture/a b",
            "/capture\\x",
            "/capture/a\\b",
            "/other/x",
            "capture/x",
            "/capture/%2e%2e",
            long.as_str(),
        ] {
            assert_eq!(parse_route(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn access_control_per_window_label() {
        let frame1 = Route::Frame(1);
        assert!(allowed(&frame1, "overlay-1"));
        assert!(!allowed(&frame1, "overlay-0"));
        assert!(!allowed(&frame1, "preview"));
        assert!(!allowed(&frame1, "pin-abc"));
        let cap = Route::Capture("abc");
        assert!(allowed(&cap, "preview"));
        assert!(allowed(&cap, "pin-abc"));
        assert!(!allowed(&cap, "overlay-0"));
        assert!(!allowed(&Route::Thumb("a"), "overlay-0"));
    }

    #[test]
    fn overlay_labels_round_trip() {
        assert_eq!(overlay_label(3), "overlay-3");
        assert_eq!(overlay_index("overlay-3"), Some(3));
        assert_eq!(overlay_index("overlay-"), None);
        assert_eq!(overlay_index("overlay-x"), None);
        assert_eq!(overlay_index("preview"), None);
        assert_eq!(overlay_index("pin-overlay-1"), None);
    }
}
