//! On-disk layout:
//!   %APPDATA%\<product>\settings.json
//!   %LOCALAPPDATA%\<product>\captures\<id>.png
//!   %LOCALAPPDATA%\<product>\history\history.db
//!   %LOCALAPPDATA%\<product>\history\thumbs\<id>.png
//!   %LOCALAPPDATA%\<product>\logs\timings.log

use std::path::{Path, PathBuf};

use crate::ids::is_valid_id;

#[derive(Debug, Clone)]
pub struct Paths {
    roaming: PathBuf,
    local: PathBuf,
}

impl Paths {
    /// Resolve from the process environment. `product` is the product name from the Tauri config.
    pub fn from_env(product: &str) -> Result<Self, String> {
        let roaming = std::env::var_os("APPDATA").ok_or("APPDATA is not set.")?;
        let local = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is not set.")?;
        Ok(Self::with_roots(
            Path::new(&roaming),
            Path::new(&local),
            product,
        ))
    }

    pub fn with_roots(roaming_root: &Path, local_root: &Path, product: &str) -> Self {
        Self {
            roaming: roaming_root.join(product),
            local: local_root.join(product),
        }
    }

    pub fn settings_file(&self) -> PathBuf {
        self.roaming.join("settings.json")
    }

    /// Quick send identity and pair records (DPAPI-protected).
    pub fn quicksend_dir(&self) -> PathBuf {
        self.roaming.join("quicksend")
    }

    pub fn captures_dir(&self) -> PathBuf {
        self.local.join("captures")
    }

    pub fn history_dir(&self) -> PathBuf {
        self.local.join("history")
    }

    pub fn db_file(&self) -> PathBuf {
        self.history_dir().join("history.db")
    }

    pub fn thumbs_dir(&self) -> PathBuf {
        self.history_dir().join("thumbs")
    }

    pub fn logs_dir(&self) -> PathBuf {
        self.local.join("logs")
    }

    /// `<captures>/<id>.png`, or `None` if the id is not valid.
    pub fn capture_file(&self, id: &str) -> Option<PathBuf> {
        is_valid_id(id).then(|| self.captures_dir().join(format!("{id}.png")))
    }

    /// `<history>/thumbs/<id>.png`, or `None` if the id is not valid.
    pub fn thumb_file(&self, id: &str) -> Option<PathBuf> {
        is_valid_id(id).then(|| self.thumbs_dir().join(format!("{id}.png")))
    }

    pub fn ensure_dirs(&self) -> Result<(), String> {
        for dir in [
            self.roaming.clone(),
            self.captures_dir(),
            self.history_dir(),
            self.thumbs_dir(),
            self.logs_dir(),
        ] {
            std::fs::create_dir_all(&dir)
                .map_err(|e| format!("Could not create {}: {e}", dir.display()))?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p() -> Paths {
        Paths::with_roots(Path::new("R"), Path::new("L"), "Prod")
    }

    #[test]
    fn layout() {
        let p = p();
        assert_eq!(
            p.settings_file(),
            Path::new("R").join("Prod").join("settings.json")
        );
        assert_eq!(
            p.db_file(),
            Path::new("L")
                .join("Prod")
                .join("history")
                .join("history.db")
        );
        assert_eq!(
            p.capture_file("abc-1").unwrap(),
            Path::new("L")
                .join("Prod")
                .join("captures")
                .join("abc-1.png")
        );
    }

    #[test]
    fn invalid_ids_never_produce_a_path() {
        let p = p();
        for bad in ["", "..", "../x", "a/b", "a\\b", "a.png", "x:y"] {
            assert!(p.capture_file(bad).is_none(), "{bad}");
            assert!(p.thumb_file(bad).is_none(), "{bad}");
        }
    }
}
