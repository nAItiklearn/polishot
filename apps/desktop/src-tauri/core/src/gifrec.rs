//! Screen-to-GIF recording: a capture loop that ticks at a fixed rate and a worker thread that
//! encodes frames as they arrive through a bounded channel. Raw frames are never accumulated.

use std::io::Write;
use std::sync::mpsc::sync_channel;
use std::time::{Duration, Instant};

use polishot_media::{Frame as MediaFrame, GifEncoder, GifOptions};

pub const DEFAULT_FPS: u16 = 15;
pub const DEFAULT_MAX_SECS: f64 = 15.0;
pub const DEFAULT_MAX_WIDTH: u32 = 800;
/// Frames waiting for the encoder; the capture loop blocks (and catches up) beyond this.
const CHANNEL_CAPACITY: usize = 4;
/// After a stall, at most this many ticks' worth of frames are repeated to keep the timeline true.
const MAX_CATCH_UP_TICKS: u64 = 30;

pub trait RegionSource {
    fn grab(&mut self) -> Result<MediaFrame, String>;
    /// True once the user pressed Esc or the Stop button.
    fn stopped(&mut self) -> bool;
    fn sleep(&mut self, d: Duration);
}

#[derive(Debug, Clone, Copy)]
pub struct RecordConfig {
    pub fps: u16,
    pub max_secs: f64,
    pub max_width: u32,
}

impl Default for RecordConfig {
    fn default() -> Self {
        Self {
            fps: DEFAULT_FPS,
            max_secs: DEFAULT_MAX_SECS,
            max_width: DEFAULT_MAX_WIDTH,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RecordEnd {
    Stopped,
    TimeLimit,
    GrabFailed,
    /// The encoder thread died (disk full, write error); recording more would be wasted work.
    EncoderFailed,
}

#[derive(Debug, Clone, Copy)]
pub struct RecordStats {
    /// Ticks fed to the encoder (repeated frames included).
    pub ticks: u64,
    /// Frames the GIF actually contains (identical neighbours are merged).
    pub gif_frames: u32,
    pub elapsed: Duration,
    pub end: RecordEnd,
}

/// How many frames are owed at `elapsed` given `sent` so far: one at t=0, then one per `1/fps`.
pub fn ticks_due(elapsed: Duration, fps: u16, sent: u64) -> u64 {
    let fps = u64::from(fps.clamp(1, 30));
    let due = (elapsed.as_secs_f64() * fps as f64).floor() as u64 + 1;
    due.saturating_sub(sent)
}

/// Time of the next tick after `sent` ticks.
pub fn next_tick_at(start: Instant, fps: u16, sent: u64) -> Instant {
    let fps = f64::from(fps.clamp(1, 30));
    start + Duration::from_secs_f64(sent as f64 / fps)
}

/// Record until stopped or `max_secs`, encoding into `writer`. Returns the writer and stats.
pub fn record<S, W>(src: &mut S, writer: W, cfg: RecordConfig) -> Result<(W, RecordStats), String>
where
    S: RegionSource,
    W: Write + Send + 'static,
{
    let fps = cfg.fps.clamp(1, 30);
    let max_ticks = (cfg.max_secs * f64::from(fps)).floor().max(1.0) as u64;

    let (tx, rx) = sync_channel::<MediaFrame>(CHANNEL_CAPACITY);
    let opts = GifOptions {
        fps,
        max_width: cfg.max_width,
        ..GifOptions::default()
    };
    let worker = std::thread::spawn(move || -> Result<(W, u32), String> {
        let mut enc = GifEncoder::new(writer, opts);
        while let Ok(frame) = rx.recv() {
            enc.add_frame(&frame)
                .map_err(|e| format!("The recording could not be encoded: {e}"))?;
        }
        // The newest frame is still pending until `finish`, so count it too.
        let frames = enc.frames_written() + 1;
        let w = enc
            .finish()
            .map_err(|e| format!("The recording could not be finished: {e}"))?;
        Ok((w, frames))
    });

    let start = Instant::now();
    let mut sent = 0u64;
    let end = loop {
        if src.stopped() {
            break RecordEnd::Stopped;
        }
        if sent >= max_ticks {
            break RecordEnd::TimeLimit;
        }
        let due = ticks_due(start.elapsed(), fps, sent);
        if due == 0 {
            let at = next_tick_at(start, fps, sent);
            let wait = at.saturating_duration_since(Instant::now());
            // Sleep in short slices so Stop is noticed promptly.
            src.sleep(wait.min(Duration::from_millis(20)));
            continue;
        }
        let frame = match src.grab() {
            Ok(f) => f,
            Err(_) => break RecordEnd::GrabFailed,
        };
        // A stall (slow grab or encoder) owes several ticks: repeat this frame to keep the
        // recording's timeline true. Identical frames cost almost nothing in the GIF. Only the
        // extra repeats are copies; the last one moves the grabbed frame itself.
        let n = due.min(MAX_CATCH_UP_TICKS).min(max_ticks - sent);
        let mut frame = Some(frame);
        let mut encoder_died = false;
        for i in 0..n {
            let next = if i + 1 == n {
                frame.take()
            } else {
                frame.clone()
            };
            if next.is_none_or(|f| tx.send(f).is_err()) {
                encoder_died = true;
                break;
            }
        }
        if encoder_died {
            // Stop grabbing: the worker's error is reported below.
            break RecordEnd::EncoderFailed;
        }
        sent += due.min(max_ticks - sent);
    };
    drop(tx);
    let (writer, gif_frames) = worker
        .join()
        .map_err(|_| "The recording thread crashed.".to_string())??;
    Ok((
        writer,
        RecordStats {
            ticks: sent,
            gif_frames,
            elapsed: start.elapsed(),
            end,
        },
    ))
}

/// `Recording YYYY-MM-DD HH.MM.SS.gif` in UTC for a Unix timestamp in seconds.
pub fn recording_file_name(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as u32;
    let rem = unix_secs % 86_400;
    format!(
        "Recording {} {:02}.{:02}.{:02}.gif",
        crate::license::iso_date(days),
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    fn frame(w: u32, h: u32, shade: u8) -> MediaFrame {
        let mut rgba = Vec::new();
        for i in 0..(w * h) {
            rgba.extend_from_slice(&[shade, (i % 251) as u8, 40, 255]);
        }
        MediaFrame {
            width: w,
            height: h,
            rgba,
        }
    }

    struct Fake {
        grabs: usize,
        stop_after_grabs: Option<usize>,
        fail_at_grab: Option<usize>,
        started: Instant,
        stop_after: Option<Duration>,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                grabs: 0,
                stop_after_grabs: None,
                fail_at_grab: None,
                started: Instant::now(),
                stop_after: None,
            }
        }
    }

    impl RegionSource for Fake {
        fn grab(&mut self) -> Result<MediaFrame, String> {
            self.grabs += 1;
            if self.fail_at_grab == Some(self.grabs) {
                return Err("boom".into());
            }
            // Changes every 5th grab; otherwise identical frames.
            Ok(frame(64, 48, (self.grabs / 5) as u8 * 20))
        }
        fn stopped(&mut self) -> bool {
            self.stop_after_grabs.is_some_and(|n| self.grabs >= n)
                || self.stop_after.is_some_and(|d| self.started.elapsed() >= d)
        }
        fn sleep(&mut self, d: Duration) {
            std::thread::sleep(d);
        }
    }

    /// A writer that can be inspected after the worker owns it.
    #[derive(Clone, Default)]
    struct Shared(Arc<Mutex<Vec<u8>>>);

    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn tick_schedule() {
        let s = |ms| Duration::from_millis(ms);
        assert_eq!(ticks_due(s(0), 15, 0), 1); // first frame immediately
        assert_eq!(ticks_due(s(10), 15, 1), 0);
        assert_eq!(ticks_due(s(67), 15, 1), 1); // 1/15 s = 66.7 ms
        assert_eq!(ticks_due(s(1000), 15, 1), 15);
        assert_eq!(ticks_due(s(500), 30, 16), 0); // exactly on schedule
        assert_eq!(ticks_due(s(500), 0, 0), 1); // fps clamped to 1
        let t0 = Instant::now();
        assert_eq!(next_tick_at(t0, 10, 5) - t0, Duration::from_millis(500));
    }

    #[test]
    fn records_at_the_requested_rate_and_writes_a_valid_gif() {
        let out = Shared::default();
        let mut src = Fake::new();
        src.stop_after = Some(Duration::from_millis(600));
        let (_, stats) = record(
            &mut src,
            out.clone(),
            RecordConfig {
                fps: 20,
                max_secs: 5.0,
                max_width: 0,
            },
        )
        .unwrap();
        assert_eq!(stats.end, RecordEnd::Stopped);
        // 0.6 s at 20 fps = 12 ticks (+1 for the frame at t=0); allow scheduler jitter.
        assert!((10..=16).contains(&stats.ticks), "ticks {}", stats.ticks);
        assert!(
            stats.gif_frames >= 2,
            "the frame changed, so at least two GIF frames"
        );
        let bytes = out.0.lock().unwrap();
        assert_eq!(&bytes[..6], b"GIF89a");
        assert_eq!(*bytes.last().unwrap(), 0x3B, "GIF trailer");
    }

    #[test]
    fn identical_frames_are_merged_not_stored() {
        let out = Shared::default();
        let mut src = Fake::new();
        src.stop_after_grabs = Some(4); // frames 1..=4 are all shade 0 (grabs/5 == 0)
        let (_, stats) = record(
            &mut src,
            out,
            RecordConfig {
                fps: 30,
                ..Default::default()
            },
        )
        .unwrap();
        assert!(stats.ticks >= 4);
        assert_eq!(
            stats.gif_frames, 1,
            "identical frames merge into one long frame"
        );
    }

    #[test]
    fn the_time_limit_ends_the_recording() {
        let out = Shared::default();
        let mut src = Fake::new();
        let (_, stats) = record(
            &mut src,
            out,
            RecordConfig {
                fps: 30,
                max_secs: 0.2,
                max_width: 0,
            },
        )
        .unwrap();
        assert_eq!(stats.end, RecordEnd::TimeLimit);
        assert_eq!(stats.ticks, 6); // 0.2 s * 30 fps
    }

    /// A destination that always fails, like a full disk.
    struct Broken;

    impl Write for Broken {
        fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("disk full"))
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Err(std::io::Error::other("disk full"))
        }
    }

    #[test]
    fn a_dead_encoder_stops_the_recording_at_once() {
        let mut src = Fake::new();
        let started = Instant::now();
        let res = record(
            &mut src,
            Broken,
            RecordConfig {
                fps: 30,
                max_secs: 10.0,
                max_width: 0,
            },
        );
        let err = res.err().expect("the encoder error is reported");
        assert!(err.contains("could not be"), "{err}");
        // Ten seconds at 30 fps would be 300 grabs; a dead encoder must end it within a few.
        assert!(src.grabs <= 12, "kept grabbing: {}", src.grabs);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn a_failed_grab_keeps_what_was_recorded() {
        let out = Shared::default();
        let mut src = Fake::new();
        src.fail_at_grab = Some(4);
        let (_, stats) = record(&mut src, out.clone(), RecordConfig::default()).unwrap();
        assert_eq!(stats.end, RecordEnd::GrabFailed);
        assert!(stats.ticks >= 3);
        assert_eq!(&out.0.lock().unwrap()[..6], b"GIF89a");
    }

    #[test]
    fn file_names_are_filesystem_safe_and_sort_by_time() {
        // 2026-01-15 03:04:05 UTC = 20468 days + 11045 s
        let n = recording_file_name(20_468 * 86_400 + 3 * 3600 + 4 * 60 + 5);
        assert_eq!(n, "Recording 2026-01-15 03.04.05.gif");
        assert!(!n.contains(':'));
        assert!(recording_file_name(1_000_000) < recording_file_name(2_000_000));
    }
}
