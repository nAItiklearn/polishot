//! Debug-build smoke test, driven by `POLISHOT_SELFTEST=capture,gif` (never compiled into release
//! builds). It runs the real hotkey -> overlay -> commit -> preview path and a short GIF recording
//! without any synthetic mouse or keyboard input, and writes the outcome to the timing log.
//! With `POLISHOT_SELFTEST_EXIT=1` the app quits when it is done.

use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager};

use crate::cropping::CommitRequest;
use crate::geometry::FBox;
use crate::state::{state, Mode, Purpose};
use crate::{capture, recorder, tlog, winmgr};

fn wait_for(what: &str, limit: Duration, mut done: impl FnMut() -> bool) -> bool {
    let start = Instant::now();
    while start.elapsed() < limit {
        if done() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    tlog!("selftest: timed out waiting for {what}");
    false
}

fn overlay_shown(app: &AppHandle) -> bool {
    state(app)
        .session
        .lock()
        .is_ok_and(|g| g.as_ref().is_some_and(|s| s.first_shown))
}

fn region(x: f64, y: f64, w: f64, h: f64) -> CommitRequest {
    CommitRequest::Region {
        monitor: 0,
        rect: FBox { x, y, w, h },
    }
}

pub fn spawn(app: &AppHandle) {
    let Ok(plan) = std::env::var("POLISHOT_SELFTEST") else {
        return;
    };
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(4)); // let the hidden windows finish loading
        if plan.contains("capture") {
            capture::start(&app, Mode::Region, Purpose::Capture);
            if wait_for("overlay", Duration::from_secs(8), || overlay_shown(&app)) {
                std::thread::sleep(Duration::from_millis(400));
                let res = capture::commit(&app, region(100.0, 100.0, 600.0, 400.0));
                std::thread::sleep(Duration::from_millis(800));
                let visible = app
                    .get_webview_window(winmgr::PREVIEW)
                    .is_some_and(|w| w.is_visible().unwrap_or(false));
                tlog!(
                    "selftest capture: commit_ok={} preview_visible={visible}",
                    res.is_ok()
                );
            }
        }
        if plan.contains("gif") {
            capture::start(&app, Mode::Region, Purpose::Gif);
            if wait_for("overlay", Duration::from_secs(8), || overlay_shown(&app)) {
                std::thread::sleep(Duration::from_millis(300));
                let res = capture::commit(&app, region(300.0, 200.0, 400.0, 240.0));
                tlog!("selftest gif: start_ok={}", res.is_ok());
                std::thread::sleep(Duration::from_millis(2500));
                recorder::stop(&app);
                wait_for("recording to finish", Duration::from_secs(15), || {
                    state(&app).recording.lock().is_ok_and(|r| r.is_none())
                });
                std::thread::sleep(Duration::from_millis(1500));
                tlog!("selftest gif: finished");
            }
        }
        if std::env::var("POLISHOT_SELFTEST_EXIT").is_ok() {
            std::thread::sleep(Duration::from_secs(2));
            app.exit(0);
        }
    });
}
