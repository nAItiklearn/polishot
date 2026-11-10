//! Global shortcut registration. Changes are transactional: if any new shortcut cannot be
//! registered, the previous set is restored and a readable error is returned.

use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::capture;
use crate::settings::{shortcut_plan, Action, Settings};
use crate::state::{state, Mode, Purpose};
use crate::tlog;

fn register_one(app: &AppHandle, action: Action, shortcut: Shortcut) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, move |app, _sc, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            match action {
                Action::Region => capture::start(app, Mode::Region, Purpose::Capture),
                Action::Scroll => capture::start(app, Mode::Window, Purpose::Scroll),
                Action::Gif => capture::start(app, Mode::Region, Purpose::Gif),
            }
        })
        .map_err(|e| {
            tlog!("shortcut registration failed: {e}");
            format!(
                "{} is already in use by another application. Choose a different shortcut.",
                shortcut_label(&shortcut)
            )
        })
}

fn shortcut_label(s: &Shortcut) -> String {
    s.into_string()
}

/// Replace the registered shortcuts with those in `settings`.
pub fn apply(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let new = shortcut_plan(settings)?;
    let st = state(app);
    let old: Vec<Shortcut> = st.registered.lock().map(|g| g.clone()).unwrap_or_default();
    let gs = app.global_shortcut();

    for s in &old {
        let _ = gs.unregister(*s);
    }
    let mut done: Vec<Shortcut> = Vec::new();
    for (action, sc) in &new {
        if let Err(e) = register_one(app, *action, *sc) {
            for s in &done {
                let _ = gs.unregister(*s);
            }
            // Restore the previous registrations (best effort).
            if let Ok(prev) = shortcut_plan(&st.settings()) {
                for (action, sc) in prev {
                    if old.contains(&sc) {
                        let _ = register_one(app, action, sc);
                    }
                }
            }
            return Err(e);
        }
        done.push(*sc);
    }
    if let Ok(mut g) = st.registered.lock() {
        *g = done;
    }
    Ok(())
}

/// Startup registration: failures become warnings instead of aborting the app.
pub fn register_initial(app: &AppHandle, settings: &Settings) {
    if let Err(e) = apply(app, settings) {
        state(app).add_warning(e);
    }
}
