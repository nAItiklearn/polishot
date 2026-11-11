//! Background work for captures: a small bounded worker pool, single-flight OCR jobs keyed by
//! capture id, and an atomic file writer.

use std::collections::{HashMap, VecDeque};
use std::io::Write;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::mpsc::{sync_channel, SyncSender};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use windows::Win32::System::Threading::{
    GetCurrentThread, SetThreadPriority, THREAD_PRIORITY_BELOW_NORMAL,
};

use crate::ocr::OcrWord;

type Job = Box<dyn FnOnce() + Send + 'static>;

/// A fixed number of worker threads fed by a bounded queue. Capture finishing (PNG encode, disk,
/// history) and OCR used to start a fresh thread per capture, so a burst of captures, a batch
/// import or a flood of received files could start dozens of encoders and recognisers at once.
/// Now at most `threads` jobs run; a full queue makes `submit` wait, which is back-pressure rather
/// than unbounded memory (every queued job holds a capture's pixels).
pub struct WorkerPool {
    tx: SyncSender<Job>,
}

impl WorkerPool {
    /// `below_normal` runs the workers at below-normal priority so background recognition never
    /// competes with the capture overlay or the editor for CPU.
    pub fn new(name: &str, threads: usize, queue: usize, below_normal: bool) -> Self {
        let (tx, rx) = sync_channel::<Job>(queue.max(1));
        let rx = Arc::new(Mutex::new(rx));
        for i in 0..threads.max(1) {
            let rx = rx.clone();
            let spawned = std::thread::Builder::new()
                .name(format!("{name}-{i}"))
                .spawn(move || {
                    if below_normal {
                        // SAFETY: affects only the calling thread.
                        let _ = unsafe {
                            SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_BELOW_NORMAL)
                        };
                    }
                    loop {
                        let next = match rx.lock() {
                            Ok(guard) => guard.recv(),
                            Err(_) => break,
                        };
                        let Ok(job) = next else { break };
                        // A panicking job must not take its worker down with it.
                        let _ = catch_unwind(AssertUnwindSafe(job));
                    }
                });
            if spawned.is_err() {
                crate::tlog!("could not start worker thread {name}-{i}");
            }
        }
        Self { tx }
    }

    /// Queue `job`; waits while the queue is full.
    pub fn submit(&self, job: impl FnOnce() + Send + 'static) -> Result<(), String> {
        self.tx
            .send(Box::new(job))
            .map_err(|_| "The background worker is not running.".to_string())
    }
}

pub type OcrOutcome = Result<Arc<Vec<OcrWord>>, String>;

/// How long a caller waits for recognition before giving up (the job keeps running).
const OCR_WAIT: Duration = Duration::from_secs(30);

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

    /// Block until the job has finished, for at most 30 seconds.
    pub fn wait(&self) -> OcrOutcome {
        self.wait_for(OCR_WAIT)
    }

    /// Block until the job has finished or `timeout` has passed. A wedged recogniser must not
    /// hold a command thread (and the text layer's spinner) forever.
    pub fn wait_for(&self, timeout: Duration) -> OcrOutcome {
        let unavailable = || "Text recognition is unavailable.".to_string();
        let guard = self.result.lock().map_err(|_| unavailable())?;
        let (guard, waited) = self
            .cv
            .wait_timeout_while(guard, timeout, |r| r.is_none())
            .map_err(|_| unavailable())?;
        if waited.timed_out() && guard.is_none() {
            return Err("Text recognition is taking too long. Try again in a moment.".to_string());
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

/// A temp name next to `path` that no other writer uses.
fn unique_tmp(path: &Path) -> PathBuf {
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    path.with_file_name(format!(".{name}.{}.tmp", crate::ids::new_id()))
}

/// Write `bytes` to a unique sibling temp file, flush it to disk, then rename it over `path`. The
/// flush matters: without it a power cut shortly after the rename can leave a zero-length file
/// under the final name (the rename can reach the disk before the data does).
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp = unique_tmp(path);
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("write failed: {e}")
    })?;
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
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(names, ["x.png"], "no temp file is left behind");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn concurrent_writers_never_share_a_temp_file_or_leave_one_behind() {
        let dir = std::env::temp_dir().join(format!("ps-atomic-{}", new_id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("settings.json");
        let payloads: Vec<Vec<u8>> = (0..8u8).map(|i| vec![b'a' + i; 64 * 1024]).collect();
        let handles: Vec<_> = payloads
            .iter()
            .cloned()
            .map(|p| {
                let f = f.clone();
                std::thread::spawn(move || {
                    for _ in 0..10 {
                        write_atomic(&f, &p).unwrap();
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let got = std::fs::read(&f).unwrap();
        assert!(
            payloads.contains(&got),
            "the file holds exactly one writer's whole payload"
        );
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn waiting_for_ocr_gives_up_instead_of_hanging() {
        let jobs = OcrJobs::default();
        let (slot, _) = jobs.slot("never");
        let t = std::time::Instant::now();
        let err = slot.wait_for(Duration::from_millis(60)).unwrap_err();
        assert!(err.contains("taking too long"), "{err}");
        assert!(t.elapsed() < Duration::from_secs(5));
        // A late completion is still delivered to later waiters.
        slot.complete(Ok(Arc::new(Vec::new())));
        assert!(slot.wait_for(Duration::from_millis(60)).is_ok());
    }

    #[test]
    fn the_pool_never_runs_more_jobs_than_it_has_workers() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let pool = WorkerPool::new("test", 2, 4, false);
        let running = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let done = Arc::new(AtomicUsize::new(0));
        for _ in 0..24 {
            let (running, peak, done) = (running.clone(), peak.clone(), done.clone());
            pool.submit(move || {
                let now = running.fetch_add(1, Ordering::SeqCst) + 1;
                peak.fetch_max(now, Ordering::SeqCst);
                std::thread::sleep(Duration::from_millis(5));
                running.fetch_sub(1, Ordering::SeqCst);
                done.fetch_add(1, Ordering::SeqCst);
            })
            .unwrap();
        }
        let t = std::time::Instant::now();
        while done.load(Ordering::SeqCst) < 24 && t.elapsed() < Duration::from_secs(20) {
            std::thread::sleep(Duration::from_millis(5));
        }
        assert_eq!(done.load(Ordering::SeqCst), 24, "every job ran");
        assert!(peak.load(Ordering::SeqCst) <= 2, "peak {peak:?}");
        assert!(peak.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn a_panicking_job_does_not_kill_its_worker() {
        use std::sync::mpsc::channel;
        let pool = WorkerPool::new("test", 1, 2, true);
        pool.submit(|| panic!("job failed")).unwrap();
        let (tx, rx) = channel();
        pool.submit(move || tx.send(42).unwrap()).unwrap();
        assert_eq!(rx.recv_timeout(Duration::from_secs(10)).unwrap(), 42);
    }
}
