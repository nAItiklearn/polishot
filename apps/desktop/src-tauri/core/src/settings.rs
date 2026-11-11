//! Typed, validated settings stored as JSON in `%APPDATA%\<product>\settings.json`.

use std::path::{Component, Path, PathBuf};
use std::str::FromStr;

use global_hotkey::hotkey::{HotKey as Shortcut, Modifiers};
use serde::{Deserialize, Serialize};

pub const DEFAULT_SHORTCUT: &str = "Ctrl+Shift+2";
const MAX_USER_PRESETS_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    Png,
    Jpeg,
    Webp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AfterCapture {
    Preview,
    Copy,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

/// `Settings` from CONTRACTS section 5. An empty `scrollShortcut` / `gifShortcut` means "unset".
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub shortcut: String,
    pub scroll_shortcut: String,
    pub gif_shortcut: String,
    pub autostart: bool,
    pub save_folder: String,
    pub format: Format,
    pub quality: f64,
    pub after_capture: AfterCapture,
    pub theme: Theme,
    pub default_preset: String,
    /// JSON array, owned by the editor.
    pub user_presets: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            shortcut: DEFAULT_SHORTCUT.to_string(),
            scroll_shortcut: String::new(),
            gif_shortcut: String::new(),
            autostart: false,
            save_folder: String::new(),
            format: Format::Png,
            quality: 0.92,
            after_capture: AfterCapture::Preview,
            theme: Theme::System,
            default_preset: "auto".to_string(),
            user_presets: "[]".to_string(),
        }
    }
}

/// A partial update. Unknown keys are rejected so typos do not silently do nothing.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsPatch {
    pub shortcut: Option<String>,
    pub scroll_shortcut: Option<String>,
    pub gif_shortcut: Option<String>,
    pub autostart: Option<bool>,
    pub save_folder: Option<String>,
    pub format: Option<Format>,
    pub quality: Option<f64>,
    pub after_capture: Option<AfterCapture>,
    pub theme: Option<Theme>,
    pub default_preset: Option<String>,
    pub user_presets: Option<String>,
}

impl Settings {
    /// Defaults with the platform pictures folder as the save location.
    pub fn with_save_folder(save_folder: &Path) -> Self {
        Self {
            save_folder: save_folder.to_string_lossy().into_owned(),
            ..Self::default()
        }
    }

    /// Apply `patch` on a copy and validate the result.
    pub fn patched(&self, patch: SettingsPatch) -> Result<Settings, String> {
        let mut s = self.clone();
        if let Some(v) = patch.shortcut {
            s.shortcut = v;
        }
        if let Some(v) = patch.scroll_shortcut {
            s.scroll_shortcut = v;
        }
        if let Some(v) = patch.gif_shortcut {
            s.gif_shortcut = v;
        }
        if let Some(v) = patch.autostart {
            s.autostart = v;
        }
        if let Some(v) = patch.save_folder {
            s.save_folder = v;
        }
        if let Some(v) = patch.format {
            s.format = v;
        }
        if let Some(v) = patch.quality {
            s.quality = v;
        }
        if let Some(v) = patch.after_capture {
            s.after_capture = v;
        }
        if let Some(v) = patch.theme {
            s.theme = v;
        }
        if let Some(v) = patch.default_preset {
            s.default_preset = v;
        }
        if let Some(v) = patch.user_presets {
            s.user_presets = v;
        }
        s.validate()?;
        Ok(s)
    }

    pub fn validate(&self) -> Result<(), String> {
        parse_shortcut(&self.shortcut, "Capture shortcut", false)?;
        parse_shortcut(&self.scroll_shortcut, "Scrolling capture shortcut", true)?;
        parse_shortcut(&self.gif_shortcut, "GIF shortcut", true)?;
        let ids: Vec<u32> = [&self.shortcut, &self.scroll_shortcut, &self.gif_shortcut]
            .into_iter()
            .filter(|s| !s.trim().is_empty())
            .filter_map(|s| Shortcut::from_str(s).ok())
            .map(|s| s.id())
            .collect();
        for (i, a) in ids.iter().enumerate() {
            if ids[i + 1..].contains(a) {
                return Err("Each action needs its own shortcut.".to_string());
            }
        }
        if !(self.quality.is_finite() && (0.1..=1.0).contains(&self.quality)) {
            return Err("Quality must be between 0.1 and 1.".to_string());
        }
        validate_save_folder(&self.save_folder)?;
        let preset_ok = !self.default_preset.is_empty()
            && self.default_preset.len() <= 64
            && self
                .default_preset
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
        if !preset_ok {
            return Err("The default preset id is not valid.".to_string());
        }
        if self.user_presets.len() > MAX_USER_PRESETS_BYTES {
            return Err("Saved presets are too large.".to_string());
        }
        match serde_json::from_str::<serde_json::Value>(&self.user_presets) {
            Ok(serde_json::Value::Array(_)) => {}
            _ => return Err("Saved presets must be a JSON array.".to_string()),
        }
        Ok(())
    }
}

/// Parse an accelerator such as `Ctrl+Shift+2`. `allow_empty` permits "no shortcut".
pub fn parse_shortcut(s: &str, what: &str, allow_empty: bool) -> Result<Option<Shortcut>, String> {
    let t = s.trim();
    if t.is_empty() {
        return if allow_empty {
            Ok(None)
        } else {
            Err(format!("{what} cannot be empty."))
        };
    }
    if t.len() > 64 {
        return Err(format!("{what} is not a valid shortcut."));
    }
    let sc =
        Shortcut::from_str(t).map_err(|_| format!("{what} \"{t}\" is not a valid shortcut."))?;
    // A bare key, or Shift alone, would hijack normal typing system-wide, and the Windows key is
    // reserved by the shell. Ctrl or Alt must be part of every global shortcut.
    if t.split('+').count() < 2 || !sc.mods.intersects(Modifiers::CONTROL | Modifiers::ALT) {
        return Err(format!(
            "{what} needs Ctrl or Alt, for example Ctrl+Shift+2."
        ));
    }
    Ok(Some(sc))
}

pub fn validate_save_folder(folder: &str) -> Result<(), String> {
    let t = folder.trim();
    if t.is_empty() {
        return Err("Choose a folder to save into.".to_string());
    }
    if t.len() > 240 || t.contains('\0') {
        return Err("The save folder path is not valid.".to_string());
    }
    let p = Path::new(t);
    if !p.is_absolute() {
        return Err("The save folder must be an absolute path.".to_string());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir)) {
        return Err("The save folder cannot contain \"..\".".to_string());
    }
    // Device namespaces (`\\?\`, `\\.\`), alternate streams and wildcard characters are never a
    // folder the user meant.
    if !crate::opener::is_plain_absolute(p) {
        return Err("The save folder path is not valid.".to_string());
    }
    Ok(())
}

/// What a registered global shortcut does.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Region,
    Scroll,
    Gif,
}

/// The shortcuts that must be registered for these settings (empty optional ones are skipped).
pub fn shortcut_plan(settings: &Settings) -> Result<Vec<(Action, Shortcut)>, String> {
    let mut out = Vec::new();
    if let Some(s) = parse_shortcut(&settings.shortcut, "Capture shortcut", false)? {
        out.push((Action::Region, s));
    }
    if let Some(s) = parse_shortcut(
        &settings.scroll_shortcut,
        "Scrolling capture shortcut",
        true,
    )? {
        out.push((Action::Scroll, s));
    }
    if let Some(s) = parse_shortcut(&settings.gif_shortcut, "GIF shortcut", true)? {
        out.push((Action::Gif, s));
    }
    Ok(out)
}

/// Load settings; missing or unreadable files yield defaults. A corrupt file is moved aside.
pub fn load(path: &Path, defaults: &Settings) -> Settings {
    let Ok(text) = std::fs::read_to_string(path) else {
        return defaults.clone();
    };
    let parsed: Result<Settings, _> = serde_json::from_str(&text);
    match parsed {
        Ok(mut s) => {
            // Fields added in later versions fall back to defaults via `#[serde(default)]`, but an
            // empty save folder (older file) should take the platform default too.
            if s.save_folder.trim().is_empty() {
                s.save_folder = defaults.save_folder.clone();
            }
            if s.validate().is_ok() {
                s
            } else {
                quarantine(path);
                defaults.clone()
            }
        }
        Err(_) => {
            quarantine(path);
            defaults.clone()
        }
    }
}

fn quarantine(path: &Path) {
    let bad: PathBuf = path.with_extension("json.bad");
    let _ = std::fs::rename(path, bad);
}

/// Atomic save: write a sibling temp file, then rename over the target.
pub fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let dir = path.parent().ok_or("Invalid settings path.")?;
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("Could not create the settings folder: {e}"))?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| format!("Could not serialise settings: {e}"))?;
    // Unique temp file, flushed to disk before the rename (see `jobs::write_atomic`).
    crate::jobs::write_atomic(path, json.as_bytes())
        .map_err(|e| format!("Could not save settings: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> Settings {
        Settings::with_save_folder(Path::new("C:\\Users\\me\\Pictures\\Shots"))
    }

    fn patch(json: &str) -> SettingsPatch {
        serde_json::from_str(json).unwrap()
    }

    #[test]
    fn defaults_are_valid_and_match_the_contract() {
        let s = base();
        s.validate().unwrap();
        assert_eq!(s.shortcut, "Ctrl+Shift+2");
        assert_eq!(s.format, Format::Png);
        assert_eq!(s.after_capture, AfterCapture::Preview);
        let v = serde_json::to_value(&s).unwrap();
        for key in [
            "shortcut",
            "scrollShortcut",
            "gifShortcut",
            "autostart",
            "saveFolder",
            "format",
            "quality",
            "afterCapture",
            "theme",
            "defaultPreset",
            "userPresets",
        ] {
            assert!(v.get(key).is_some(), "missing {key}");
        }
    }

    #[test]
    fn patch_applies_only_given_fields() {
        let s = base()
            .patched(patch(r#"{"quality":0.5,"theme":"dark"}"#))
            .unwrap();
        assert_eq!(s.quality, 0.5);
        assert_eq!(s.theme, Theme::Dark);
        assert_eq!(s.shortcut, "Ctrl+Shift+2");
    }

    #[test]
    fn unknown_keys_are_rejected() {
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"shortcutt":"x"}"#).is_err());
    }

    #[test]
    fn shortcut_validation() {
        assert!(base()
            .patched(patch(r#"{"shortcut":"Ctrl+Alt+S"}"#))
            .is_ok());
        assert!(base().patched(patch(r#"{"shortcut":""}"#)).is_err());
        assert!(base()
            .patched(patch(r#"{"shortcut":"Ctrl+Nonsense+"}"#))
            .is_err());
        assert!(base().patched(patch(r#"{"shortcut":"S"}"#)).is_err()); // no modifier
                                                                        // Shift or the Windows key alone would hijack typing or the shell.
        for weak in ["Shift+S", "Super+S", "Shift+Super+S", "Shift+F9"] {
            let e = base()
                .patched(patch(&format!(r#"{{"shortcut":"{weak}"}}"#)))
                .unwrap_err();
            assert!(e.contains("Ctrl or Alt"), "{weak}: {e}");
        }
        for strong in ["Alt+S", "Ctrl+F9", "Ctrl+Shift+Alt+S", "Alt+Shift+4"] {
            assert!(
                base()
                    .patched(patch(&format!(r#"{{"shortcut":"{strong}"}}"#)))
                    .is_ok(),
                "{strong}"
            );
        }
        assert!(base()
            .patched(patch(r#"{"scrollShortcut":"Ctrl+Shift+3"}"#))
            .is_ok());
        // optional shortcuts may be cleared
        assert!(base().patched(patch(r#"{"gifShortcut":""}"#)).is_ok());
    }

    #[test]
    fn shortcuts_must_be_distinct_even_if_spelled_differently() {
        let e = base()
            .patched(patch(r#"{"scrollShortcut":"shift+control+2"}"#))
            .unwrap_err();
        assert!(e.contains("own shortcut"), "{e}");
    }

    #[test]
    fn plan_defaults_to_one_shortcut() {
        let w = shortcut_plan(&Settings::default()).unwrap();
        assert_eq!(w.len(), 1);
        assert_eq!(w[0].0, Action::Region);
    }

    #[test]
    fn plan_includes_optional_shortcuts_when_set() {
        let s = Settings {
            scroll_shortcut: "Ctrl+Shift+3".into(),
            gif_shortcut: "Ctrl+Shift+4".into(),
            ..Settings::default()
        };
        let actions: Vec<_> = shortcut_plan(&s).unwrap().iter().map(|(a, _)| *a).collect();
        assert_eq!(actions, [Action::Region, Action::Scroll, Action::Gif]);
    }

    #[test]
    fn plan_reports_invalid_shortcuts_readably() {
        let s = Settings {
            shortcut: "Ctrl+Bogus".into(),
            ..Settings::default()
        };
        let e = shortcut_plan(&s).unwrap_err();
        assert!(e.contains("not a valid shortcut"), "{e}");
    }

    #[test]
    fn quality_range() {
        for q in ["0.05", "1.5", "-1"] {
            assert!(
                base()
                    .patched(patch(&format!(r#"{{"quality":{q}}}"#)))
                    .is_err(),
                "{q}"
            );
        }
        assert!(base().patched(patch(r#"{"quality":1}"#)).is_ok());
        assert!(base().patched(patch(r#"{"quality":0.1}"#)).is_ok());
    }

    #[test]
    fn enums_reject_unknown_values() {
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"format":"gif"}"#).is_err());
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"theme":"neon"}"#).is_err());
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"afterCapture":"upload"}"#).is_err());
    }

    #[test]
    fn save_folder_rules() {
        assert!(validate_save_folder("C:\\Pictures\\Shots").is_ok());
        assert!(validate_save_folder("").is_err());
        assert!(validate_save_folder("relative\\dir").is_err());
        assert!(validate_save_folder("C:\\a\\..\\b").is_err());
        assert!(validate_save_folder(&format!("C:\\{}", "x".repeat(300))).is_err());
        assert!(validate_save_folder("C:\\a\0b").is_err());
        assert!(validate_save_folder(r"\\?\C:\Pictures").is_err());
        assert!(validate_save_folder(r"\\.\pipe\x").is_err());
        assert!(validate_save_folder(r"C:\Pictures\a:b").is_err());
        assert!(validate_save_folder(r"C:\Pictures\*").is_err());
        assert!(validate_save_folder(r"C:\Users\Zoë\Bilder\Polishot").is_ok());
        assert!(validate_save_folder(r"\\nas\share\Shots").is_ok());
    }

    #[test]
    fn preset_fields() {
        assert!(base()
            .patched(patch(r#"{"defaultPreset":"ig-square"}"#))
            .is_ok());
        assert!(base()
            .patched(patch(r#"{"defaultPreset":"../x"}"#))
            .is_err());
        assert!(base().patched(patch(r#"{"defaultPreset":""}"#)).is_err());
        assert!(base()
            .patched(patch(r#"{"userPresets":"[{\"id\":\"a\"}]"}"#))
            .is_ok());
        assert!(base().patched(patch(r#"{"userPresets":"{}"}"#)).is_err());
        assert!(base()
            .patched(patch(r#"{"userPresets":"not json"}"#))
            .is_err());
    }

    #[test]
    fn save_and_load_round_trip_and_recover_from_corruption() {
        let dir = std::env::temp_dir().join(format!("ps-settings-{}", crate::ids::new_id()));
        let file = dir.join("settings.json");
        let defaults = base();
        let mut s = defaults.clone();
        s.quality = 0.7;
        s.theme = Theme::Light;
        save(&file, &s).unwrap();
        assert_eq!(load(&file, &defaults), s);

        std::fs::write(&file, "{ not json").unwrap();
        assert_eq!(load(&file, &defaults), defaults);
        assert!(dir.join("settings.json.bad").exists());

        // Valid JSON, invalid value: also quarantined.
        std::fs::write(&file, r#"{"quality": 9}"#).unwrap();
        assert_eq!(load(&file, &defaults), defaults);

        // Missing fields take defaults.
        std::fs::write(&file, r#"{"theme":"dark"}"#).unwrap();
        let partial = load(&file, &defaults);
        assert_eq!(partial.theme, Theme::Dark);
        assert_eq!(partial.shortcut, "Ctrl+Shift+2");
        assert_eq!(partial.save_folder, defaults.save_folder);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
