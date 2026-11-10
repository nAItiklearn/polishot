//! Quick send persistence in `%APPDATA%\<product>\quicksend\`:
//!   identity.bin        the device identity secret, DPAPI-protected
//!   <device id>.pair    one DPAPI-protected `PairRecord` per paired device
//! Unreadable files are skipped, never trusted.

use std::path::{Path, PathBuf};

use polishot_quicksend::{DeviceId, Identity, PairRecord};

use crate::jobs::write_atomic;
use crate::secure::{protect, unprotect};

pub struct QsStore {
    dir: PathBuf,
}

fn valid_stem(stem: &str) -> bool {
    stem.len() == 16
        && stem
            .bytes()
            .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
}

impl QsStore {
    pub fn new(dir: &Path) -> Self {
        Self {
            dir: dir.to_path_buf(),
        }
    }

    fn ensure(&self) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|_| "Could not create the quick send folder.".to_string())
    }

    fn identity_file(&self) -> PathBuf {
        self.dir.join("identity.bin")
    }

    fn pair_file(&self, id: &DeviceId) -> PathBuf {
        self.dir.join(format!("{id}.pair"))
    }

    /// Load the identity, creating it on first use. If the stored one cannot be unlocked (another
    /// Windows account, a corrupt file) a fresh identity replaces it and the old pairs, which were
    /// bound to it, are removed.
    pub fn load_or_create_identity(&self) -> Result<Identity, String> {
        self.ensure()?;
        if let Ok(sealed) = std::fs::read(self.identity_file()) {
            if let Some(identity) = unprotect(&sealed)
                .ok()
                .and_then(|plain| Identity::from_bytes(&plain).ok())
            {
                return Ok(identity);
            }
            self.clear_pairs();
        }
        let identity = Identity::try_generate()
            .map_err(|_| "Could not create a device identity.".to_string())?;
        let sealed = protect(&identity.to_bytes()[..])?;
        write_atomic(&self.identity_file(), &sealed)?;
        Ok(identity)
    }

    fn clear_pairs(&self) {
        if let Ok(rd) = std::fs::read_dir(&self.dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.extension().is_some_and(|x| x == "pair") {
                    let _ = std::fs::remove_file(p);
                }
            }
        }
    }

    /// Every readable pair record.
    pub fn load_pairs(&self) -> Vec<PairRecord> {
        let Ok(rd) = std::fs::read_dir(&self.dir) else {
            return Vec::new();
        };
        let mut out = Vec::new();
        for e in rd.flatten() {
            let p = e.path();
            let named_ok = p.extension().is_some_and(|x| x == "pair")
                && p.file_stem()
                    .and_then(|s| s.to_str())
                    .is_some_and(valid_stem);
            if !named_ok {
                continue;
            }
            let record = std::fs::read(&p)
                .ok()
                .and_then(|sealed| unprotect(&sealed).ok())
                .and_then(|plain| PairRecord::from_bytes(&plain).ok());
            if let Some(r) = record {
                out.push(r);
            }
        }
        out.sort_by(|a, b| a.peer_name.cmp(&b.peer_name));
        out
    }

    pub fn save_pair(&self, record: &PairRecord) -> Result<(), String> {
        self.ensure()?;
        let sealed = protect(&record.to_bytes()[..])?;
        write_atomic(&self.pair_file(&record.peer_id), &sealed)
    }

    /// Forget a device. Missing records are fine.
    pub fn remove_pair(&self, id: &DeviceId) -> Result<(), String> {
        match std::fs::remove_file(self.pair_file(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Could not forget that device.".to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::new_id;

    fn temp() -> PathBuf {
        std::env::temp_dir().join(format!("ps-qs-{}", new_id()))
    }

    fn record(seed: u8, name: &str) -> PairRecord {
        // A valid P-256 point comes from a real identity.
        let id = Identity::generate();
        PairRecord::new(id.public(), [seed; 32], name).unwrap()
    }

    #[test]
    fn identity_is_created_once_and_reloaded() {
        let dir = temp();
        let store = QsStore::new(&dir);
        let a = store.load_or_create_identity().unwrap();
        let b = store.load_or_create_identity().unwrap();
        assert_eq!(a.id(), b.id());
        assert_eq!(a.to_bytes()[..], b.to_bytes()[..]);
        // The secret is not stored in the clear.
        let raw = std::fs::read(dir.join("identity.bin")).unwrap();
        assert!(!raw.windows(32).any(|w| w == &a.to_bytes()[..]));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pairs_round_trip_and_are_protected() {
        let dir = temp();
        let store = QsStore::new(&dir);
        store.load_or_create_identity().unwrap();
        let r1 = record(1, "Pixel");
        let r2 = record(2, "Galaxy");
        store.save_pair(&r1).unwrap();
        store.save_pair(&r2).unwrap();
        let loaded = store.load_pairs();
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0].peer_name, "Galaxy"); // sorted by name
        let got = loaded.iter().find(|r| r.peer_id == r1.peer_id).unwrap();
        assert_eq!(got.pair_key, [1; 32]);
        assert_eq!(got.peer_public, r1.peer_public);
        let raw = std::fs::read(dir.join(format!("{}.pair", r1.peer_id))).unwrap();
        assert!(
            !raw.windows(32).any(|w| w == [1u8; 32]),
            "pair key must not be stored in the clear"
        );
        store.remove_pair(&r1.peer_id).unwrap();
        store.remove_pair(&r1.peer_id).unwrap(); // idempotent
        assert_eq!(store.load_pairs().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn unreadable_and_foreign_files_are_ignored() {
        let dir = temp();
        let store = QsStore::new(&dir);
        store.load_or_create_identity().unwrap();
        let good = record(3, "Phone");
        store.save_pair(&good).unwrap();
        std::fs::write(dir.join("AAAAAAAAAAAAAAAA.pair"), b"garbage").unwrap();
        std::fs::write(dir.join("not-an-id.pair"), b"x").unwrap();
        let loaded = store.load_pairs();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].peer_id, good.peer_id);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_corrupt_identity_is_replaced_and_old_pairs_dropped() {
        let dir = temp();
        let store = QsStore::new(&dir);
        let first = store.load_or_create_identity().unwrap();
        store.save_pair(&record(4, "Old phone")).unwrap();
        std::fs::write(dir.join("identity.bin"), b"corrupted").unwrap();
        let second = store.load_or_create_identity().unwrap();
        assert_ne!(first.id(), second.id());
        assert!(
            store.load_pairs().is_empty(),
            "pairs bound to the lost identity are unusable"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn stems_are_validated() {
        assert!(valid_stem("ABCDEFGH23456723"));
        assert!(!valid_stem("abcdefgh23456723"));
        assert!(!valid_stem("ABCDEFGH2345672"));
        assert!(!valid_stem("../../../etc/pas"));
        assert!(!valid_stem("ABCDEFGH23456781"));
    }
}
