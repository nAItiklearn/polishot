//! Debug timing log: `%LOCALAPPDATA%\<product>\logs\timings.log`.
//!
//! Only durations and event names go here. Never log image data, OCR text, window titles or paths.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use crate::ids::now_millis;

static SINK: OnceLock<Mutex<File>> = OnceLock::new();
const MAX_LOG_BYTES: u64 = 512 * 1024;

/// Open the log (truncating it when it has grown past 512 KB). Safe to call more than once.
pub fn init(logs_dir: &Path) {
    let path = logs_dir.join("timings.log");
    let too_big = std::fs::metadata(&path).is_ok_and(|m| m.len() > MAX_LOG_BYTES);
    let mut opts = OpenOptions::new();
    opts.create(true).append(true);
    if too_big {
        opts.truncate(false);
        let _ = std::fs::remove_file(&path);
    }
    if let Ok(f) = opts.open(&path) {
        let _ = SINK.set(Mutex::new(f));
    }
}

pub fn log(line: &str) {
    #[cfg(debug_assertions)]
    eprintln!("[polishot] {line}");
    if let Some(sink) = SINK.get() {
        if let Ok(mut f) = sink.lock() {
            // One write per line: with two writes (stamp, then text) lines from different threads
            // could interleave in the file.
            let _ = f.write_all(format!("{} {line}\n", now_millis()).as_bytes());
        }
    }
}

/// `tlog!("capture grab {ms:.1} ms")`
#[macro_export]
macro_rules! tlog {
    ($($arg:tt)*) => { $crate::timing::log(&format!($($arg)*)) };
}

pub fn ms(start: std::time::Instant) -> f64 {
    start.elapsed().as_secs_f64() * 1000.0
}
