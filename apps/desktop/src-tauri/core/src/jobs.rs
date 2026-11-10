//! Single-flight OCR jobs keyed by capture id, plus an atomic file writer.

use std::collections::{HashMap, VecDeque};
use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};

use crate::ocr::OcrWord;

pub type OcrOutcome = Result<Arc<Vec<OcrWord>>, String>;

/// One OCR run: completes once, any number of waiters block until then.
pub struct OcrSlot {
    result: Mutex<Option<OcrOutcome>>,
    cv: Condvar,
}

impl OcrSlot {
    fn new() -> Self {
        Self {
            result: Mutex::new(None),
            cv: Condvar::new(),
        }
    }

    pub fn complete(&self, outcome: OcrOutcome) {
        if let Ok(mut r) = self.result.lock() {
            *r = Some(outcome);
        }
        self.cv.notify_all();
    }

    /// Block until the job has finished.
    pub fn wait(&self) -> OcrOutcome {
        let unavailable = || "Text recognition is unavailable.".to_string();
        let mut guard = self.result.lock().map_err(|_| unavailable())?;
        while guard.is_none() {
            guard = self.cv.wait(guard).map_err(|_| unavailable())?;
        }
        guard
            .clone()
            .unwrap_or_else(|| Err("Text recognition produced no result.".to_string()))
    }
}

const OCR_CACHE_ITEMS: usize = 32;

/// Slots by id, plus insertion order for eviction.
type SlotTable = (HashMap<String, Arc<OcrSlot>>, VecDeque<String>);

#[derive(Default)]
pub struct OcrJobs {
    inner: Mutex<SlotTable>,
}

impl OcrJobs {
    /// The slot for `id` and whether this call created it (the creator must run the job).
    pub fn slot(&self, id: &str) -> (Arc<OcrSlot>, bool) {
        let Ok(mut g) = self.inner.lock() else {
            return (Arc::new(OcrSlot::new()), true);
        };
        if let Some(s) = g.0.get(id) {
            return (s.clone(), false);
        }
        let slot = Arc::new(OcrSlot::new());
        g.0.insert(id.to_string(), slot.clone());
        g.1.push_back(id.to_string());
        while g.1.len() > OCR_CACHE_ITEMS {
            if let Some(old) = g.1.pop_front() {
                g.0.remove(&old);
            }
        }
        (slot, true)
    }

    /// Forget a result so the next request runs OCR again (used after failures).
    pub fn forget(&self, id: &str) {
        if let Ok(mut g) = self.inner.lock() {
            g.0.remove(id);
            g.1.retain(|k| k != id);
        }
    }

    pub fn drop_all(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.0.clear();
            g.1.clear();
        }
    }
}

/// Write `bytes` to a sibling temp file, then rename it over `path`.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write failed: {e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("rename failed: {e}")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ids::new_id;

    #[test]
    fn slots_are_single_flight_and_bounded() {
        let jobs = OcrJobs::default();
        let (a1, created1) = jobs.slot("a");
        let (a2, created2) = jobs.slot("a");
        assert!(created1 && !created2);
        assert!(Arc::ptr_eq(&a1, &a2));
        for i in 0..(OCR_CACHE_ITEMS + 5) {
            jobs.slot(&format!("id{i}"));
        }
        let g = jobs.inner.lock().unwrap();
        assert_eq!(g.0.len(), OCR_CACHE_ITEMS);
        assert_eq!(g.1.len(), OCR_CACHE_ITEMS);
        drop(g);
        jobs.forget("id40");
        assert!(jobs.slot("id40").1, "forgotten ids can be retried");
        jobs.drop_all();
        assert!(jobs.slot("a").1);
    }

    #[test]
    fn waiters_receive_the_completed_result() {
        let jobs = OcrJobs::default();
        let (slot, _) = jobs.slot("x");
        let waiter = {
            let slot = slot.clone();
            std::thread::spawn(move || slot.wait())
        };
        std::thread::sleep(std::time::Duration::from_millis(20));
        slot.complete(Ok(Arc::new(Vec::new())));
        assert!(waiter.join().unwrap().unwrap().is_empty());
        // Late waiters get the same answer immediately.
        assert!(slot.wait().is_ok());

        let (failed, _) = jobs.slot("y");
        failed.complete(Err("no language".to_string()));
        assert_eq!(failed.wait().unwrap_err(), "no language");
    }

    #[test]
    fn write_atomic_replaces_files() {
        let dir = std::env::temp_dir().join(format!("ps-atomic-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("x.png");
        write_atomic(&f, b"one").unwrap();
        write_atomic(&f, b"two").unwrap();
        assert_eq!(std::fs::read(&f).unwrap(), b"two");
        assert!(!dir.join("x.tmp").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
