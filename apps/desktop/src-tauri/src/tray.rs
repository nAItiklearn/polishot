//! System tray: the app's only visible surface until a capture happens.

use tauri::image::Image;
use tauri::menu::{Menu, MenuEvent, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter};

use crate::state::{state, Mode, Purpose};
use crate::{capture, winmgr};

const TRAY_ID: &str = "main";
/// One-colour persimmon mark: readable on any taskbar, used when the theme is unknown.
const ICON_DEFAULT: &[u8] = include_bytes!("../icons/tray.png");
/// Dark mark for a light taskbar.
const ICON_LIGHT_TASKBAR: &[u8] = include_bytes!("../icons/tray-light.png");
/// White mark for a dark taskbar.
const ICON_DARK_TASKBAR: &[u8] = include_bytes!("../icons/tray-dark.png");

fn tray_icon() -> tauri::Result<Image<'static>> {
    let bytes = match crate::winutil::taskbar_is_light() {
        Some(true) => ICON_LIGHT_TASKBAR,
        Some(false) => ICON_DARK_TASKBAR,
        None => ICON_DEFAULT,
    };
    Image::from_bytes(bytes)
}

/// "Label<TAB>Shortcut" when a shortcut is set (Windows right-aligns the part after the tab).
fn shortcut_label(label: &str, shortcut: &str) -> String {
    if shortcut.trim().is_empty() {
        label.to_string()
    } else {
        format!("{label}	{shortcut}")
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let shortcut = state(app).settings().shortcut;
    // A tab makes Windows right-align the remainder as the item's shortcut hint.
    let region = MenuItem::with_id(
        app,
        "capture_region",
        format!("Capture region\t{shortcut}"),
        true,
        None::<&str>,
    )?;
    let window = MenuItem::with_id(app, "capture_window", "Capture window", true, None::<&str>)?;
    let scroll_shortcut = state(app).settings().scroll_shortcut;
    let scroll = MenuItem::with_id(
        app,
        "capture_scroll",
        shortcut_label("Capture scrolling", &scroll_shortcut),
        true,
        None::<&str>,
    )?;
    let gif_shortcut = state(app).settings().gif_shortcut;
    let gif = MenuItem::with_id(
        app,
        "record_gif",
        shortcut_label("Record GIF", &gif_shortcut),
        true,
        None::<&str>,
    )?;
    let history = MenuItem::with_id(app, "open_history", "Open history", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "open_settings", "Settings", true, None::<&str>)?;
    let license = MenuItem::with_id(app, "open_license", "License", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    Menu::with_items(
        app,
        &[
            &region, &window, &scroll, &gif, &sep1, &history, &settings, &license, &sep2, &quit,
        ],
    )
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    let tooltip = app.config().product_name.clone().unwrap_or_default();
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(tray_icon()?)
        .tooltip(tooltip)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(on_menu_event)
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                open_view(tray.app_handle(), "history");
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the menu so the shortcut hint follows the settings.
pub fn refresh(app: &AppHandle) {
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY_ID), build_menu(app)) {
        let _ = tray.set_menu(Some(menu));
        if let Ok(icon) = tray_icon() {
            let _ = tray.set_icon(Some(icon));
        }
    }
}

fn open_view(app: &AppHandle, target: &'static str) {
    winmgr::show_preview(app);
    let _ = app.emit_to(winmgr::PREVIEW, "navigate", target);
}

fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    match event.id().as_ref() {
        "capture_region" => capture::start(app, Mode::Region, Purpose::Capture),
        "capture_window" => capture::start(app, Mode::Window, Purpose::Capture),
        "capture_scroll" => capture::start(app, Mode::Window, Purpose::Scroll),
        "record_gif" => capture::start(app, Mode::Region, Purpose::Gif),
        "open_history" => open_view(app, "history"),
        "open_settings" => open_view(app, "settings"),
        "open_license" => open_view(app, "license"),
        "quit" => app.exit(0),
        _ => {}
    }
}

/// Shown when a second instance is launched.
pub fn focus_existing(app: &AppHandle) {
    open_view(app, "history");
}
