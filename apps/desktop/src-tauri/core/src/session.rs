//! Rules for the one in-flight capture session, kept free of Tauri so the races they prevent are
//! unit-tested.
//!
//! * A hotkey that fires twice quickly must not grab the screen twice ([`SingleFlight`]).
//! * A slow commit (a window capture can take hundreds of milliseconds) must not tear down a
//!   *newer* session that started meanwhile: every commit remembers the nonce of the session it
//!   came from and only touches the session slot, or hides the overlays, while that nonce is
//!   still current ([`release`], [`reopen`]).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// What the rules need to know about a session.
pub trait Session {
    /// Identifies this capture; a newer capture has a different nonce.
    fn nonce(&self) -> u64;
    /// Allow (or forbid) another commit attempt on this session.
    fn set_committed(&mut self, committed: bool);
}

/// A commit that started from session `nonce` is done with the screen. Takes the session out of
/// `slot` when it is still that one. Returns whether this commit may still hide the overlays
/// (`true` when the session was ours or already gone, `false` when a newer capture owns them) and
/// the session that was taken, so the caller can drop its big buffers off the hot path.
pub fn release<T: Session>(slot: &mut Option<T>, nonce: u64) -> (bool, Option<T>) {
    match slot.as_ref() {
        Some(s) if s.nonce() != nonce => (false, None),
        _ => (true, slot.take()),
    }
}

/// After a failed commit, let the user try again on the same session, but never reopen a newer
/// one. Returns whether a session was reopened.
pub fn reopen<T: Session>(slot: &mut Option<T>, nonce: u64) -> bool {
    match slot.as_mut() {
        Some(s) if s.nonce() == nonce => {
            s.set_committed(false);
            true
        }
        _ => false,
    }
}

/// Allows one operation at a time; later callers are told to go away instead of queueing.
#[derive(Default)]
pub struct SingleFlight(AtomicBool);

/// Held while the operation runs; releasing it (also when the operation panics) lets the next
/// caller in.
pub struct FlightGuard<'a>(&'a AtomicBool);

impl SingleFlight {
    pub const fn new() -> Self {
        Self(AtomicBool::new(false))
    }

    /// `Some(guard)` for the caller that got in, `None` while another operation is running.
    pub fn try_begin(&self) -> Option<FlightGuard<'_>> {
        self.0
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| FlightGuard(&self.0))
    }

    pub fn busy(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

impl Drop for FlightGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

/// A value produced on one thread that others wait for, once. The capture session uses one per
/// monitor frame (and one for the window list) so the overlays can open the moment the hotkey is
/// pressed while the screen is still being grabbed: the frozen frame is requested straight away
/// and answered as soon as it exists.
pub struct OnceSlot<T> {
    value: Mutex<Option<Result<T, String>>>,
    ready: Condvar,
}

impl<T: Clone> OnceSlot<T> {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            value: Mutex::new(None),
            ready: Condvar::new(),
        })
    }

    /// Publish the value (or the reason there is none). Only the first call counts.
    pub fn set(&self, value: Result<T, String>) {
        if let Ok(mut slot) = self.value.lock() {
            if slot.is_none() {
                *slot = Some(value);
            }
        }
        self.ready.notify_all();
    }

    /// The value if it is there already.
    pub fn get(&self) -> Option<Result<T, String>> {
        self.value.lock().ok().and_then(|slot| slot.clone())
    }

    /// Wait for the value, at most \`timeout\`.
    pub fn wait(&self, timeout: Duration) -> Result<T, String> {
        let unavailable = || "The screen is not available.".to_string();
        let guard = self.value.lock().map_err(|_| unavailable())?;
        let (guard, waited) = self
            .ready
            .wait_timeout_while(guard, timeout, |slot| slot.is_none())
            .map_err(|_| unavailable())?;
        match guard.as_ref() {
            Some(result) => result.clone(),
            None if waited.timed_out() => Err("The screen grab took too long.".to_string()),
            None => Err(unavailable()),
        }
    }
}

/// Lets a capture commit hold the frozen overlay on screen until the preview window has the new
/// image decoded and drawn (the UI calls \`preview_ready\`), so the preview never appears empty.
///
/// It only waits once the UI has shown it sends acknowledgements ([\`AckGate::supported\`]); a UI
/// that never acknowledges costs nothing, and one that is late costs at most the timeout.
#[derive(Default)]
pub struct AckGate {
    state: Mutex<GateState>,
    changed: Condvar,
    supported: AtomicBool,
}

#[derive(Default)]
struct GateState {
    expecting: Option<String>,
    acked: bool,
}

impl AckGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Whether the UI has ever acknowledged a capture.
    pub fn supported(&self) -> bool {
        self.supported.load(Ordering::Acquire)
    }

    /// Start expecting an acknowledgement for \`id\`. Call this *before* announcing the capture, so
    /// an acknowledgement that arrives quickly is not lost.
    pub fn begin(&self, id: &str) {
        if let Ok(mut s) = self.state.lock() {
            s.expecting = Some(id.to_string());
            s.acked = false;
        }
    }

    /// The UI says its preview shows \`id\`. Returns whether this was the awaited capture.
    pub fn ack(&self, id: &str) -> bool {
        self.supported.store(true, Ordering::Release);
        let Ok(mut s) = self.state.lock() else {
            return false;
        };
        let awaited = s.expecting.as_deref() == Some(id);
        if awaited {
            s.acked = true;
            self.changed.notify_all();
        }
        awaited
    }

    /// Wait for the acknowledgement of the capture passed to [\`AckGate::begin\`]; \`true\` if it
    /// came, \`false\` on timeout. Stops expecting either way.
    pub fn wait(&self, timeout: Duration) -> bool {
        let Ok(s) = self.state.lock() else {
            return false;
        };
        let Ok((mut s, _)) = self.changed.wait_timeout_while(s, timeout, |s| !s.acked) else {
            return false;
        };
        s.expecting = None;
        std::mem::take(&mut s.acked)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Barrier};
    use std::time::Instant;

    use super::*;

    struct Fake {
        nonce: u64,
        committed: bool,
    }

    impl Session for Fake {
        fn nonce(&self) -> u64 {
            self.nonce
        }
        fn set_committed(&mut self, committed: bool) {
            self.committed = committed;
        }
    }

    fn fake(nonce: u64) -> Option<Fake> {
        Some(Fake {
            nonce,
            committed: true,
        })
    }

    #[test]
    fn a_commit_takes_its_own_session_and_may_hide_the_overlays() {
        let mut slot = fake(7);
        let (owns, taken) = release(&mut slot, 7);
        assert!(owns);
        assert_eq!(taken.map(|s| s.nonce), Some(7));
        assert!(slot.is_none());
    }

    #[test]
    fn a_slow_commit_does_not_tear_down_a_newer_session() {
        // Commit for session 7 is still running when the user starts session 8.
        let mut slot = fake(8);
        let (owns, taken) = release(&mut slot, 7);
        assert!(!owns, "the overlays now belong to session 8");
        assert!(taken.is_none());
        assert_eq!(
            slot.as_ref().map(|s| s.nonce),
            Some(8),
            "session 8 survives"
        );
    }

    #[test]
    fn a_cancelled_session_leaves_nothing_to_take_but_hiding_is_harmless() {
        let mut slot: Option<Fake> = None;
        let (owns, taken) = release(&mut slot, 7);
        assert!(owns);
        assert!(taken.is_none());
    }

    #[test]
    fn only_the_failed_session_is_reopened() {
        let mut slot = fake(7);
        assert!(reopen(&mut slot, 7));
        assert!(!slot.as_ref().unwrap().committed);

        let mut newer = fake(8);
        assert!(
            !reopen(&mut newer, 7),
            "a failed old commit must not reopen session 8"
        );
        assert!(newer.as_ref().unwrap().committed);

        let mut none: Option<Fake> = None;
        assert!(!reopen(&mut none, 7));
    }

    #[test]
    fn single_flight_lets_one_in_and_releases_on_drop() {
        let f = SingleFlight::new();
        assert!(!f.busy());
        let g = f.try_begin().expect("first caller gets in");
        assert!(f.busy());
        assert!(f.try_begin().is_none(), "a second hotkey press is ignored");
        drop(g);
        assert!(!f.busy());
        assert!(f.try_begin().is_some(), "free again afterwards");
    }

    #[test]
    fn single_flight_is_released_when_the_operation_panics() {
        let f = Arc::new(SingleFlight::new());
        let f2 = f.clone();
        let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || {
            let _guard = f2.try_begin().unwrap();
            panic!("capture blew up");
        }));
        assert!(r.is_err());
        assert!(
            f.try_begin().is_some(),
            "a panic must not lock capture forever"
        );
    }

    #[test]
    fn a_slot_hands_its_value_to_waiters_and_late_comers() {
        let slot: Arc<OnceSlot<u32>> = OnceSlot::new();
        assert!(slot.get().is_none());
        let waiter = {
            let slot = slot.clone();
            std::thread::spawn(move || slot.wait(Duration::from_secs(10)))
        };
        std::thread::sleep(Duration::from_millis(30));
        slot.set(Ok(7));
        assert_eq!(waiter.join().unwrap(), Ok(7));
        assert_eq!(slot.get(), Some(Ok(7)));
        assert_eq!(slot.wait(Duration::from_millis(1)), Ok(7));
        // The first value wins.
        slot.set(Ok(8));
        slot.set(Err("late".into()));
        assert_eq!(slot.get(), Some(Ok(7)));
    }

    #[test]
    fn a_slot_reports_failure_and_timeout() {
        let failed: Arc<OnceSlot<u32>> = OnceSlot::new();
        failed.set(Err("grab failed".into()));
        assert_eq!(
            failed.wait(Duration::from_secs(1)),
            Err("grab failed".into())
        );

        let never: Arc<OnceSlot<u32>> = OnceSlot::new();
        let t = Instant::now();
        let e = never.wait(Duration::from_millis(40)).unwrap_err();
        assert!(e.contains("took too long"), "{e}");
        assert!(t.elapsed() < Duration::from_secs(5));
        // A value arriving after a timeout is still delivered to the next wait.
        never.set(Ok(1));
        assert_eq!(never.wait(Duration::from_millis(1)), Ok(1));
    }

    #[test]
    fn the_gate_does_not_wait_for_a_ui_that_never_acknowledges() {
        let gate = AckGate::new();
        assert!(!gate.supported());
        // An acknowledgement nobody awaits still proves the UI speaks the protocol.
        assert!(!gate.ack("some-capture"));
        assert!(gate.supported());
    }

    #[test]
    fn an_acknowledgement_that_comes_first_is_not_lost() {
        let gate = AckGate::new();
        gate.begin("a");
        assert!(gate.ack("a"));
        let t = Instant::now();
        assert!(gate.wait(Duration::from_secs(5)));
        assert!(t.elapsed() < Duration::from_secs(1), "returned at once");
        // It is consumed: the next capture starts from scratch.
        gate.begin("b");
        assert!(!gate.wait(Duration::from_millis(30)), "no ack for b");
    }

    #[test]
    fn only_the_awaited_capture_releases_the_gate() {
        let gate = Arc::new(AckGate::new());
        gate.begin("current");
        assert!(!gate.ack("older"));
        assert!(!gate.ack(""));
        let waiter = {
            let gate = gate.clone();
            std::thread::spawn(move || gate.wait(Duration::from_secs(10)))
        };
        std::thread::sleep(Duration::from_millis(30));
        assert!(gate.ack("current"));
        assert!(waiter.join().unwrap());
        // Late acknowledgements after the wait are ignored.
        assert!(!gate.ack("current"));
    }

    #[test]
    fn a_missing_acknowledgement_times_out_instead_of_hanging() {
        let gate = AckGate::new();
        gate.begin("x");
        let t = Instant::now();
        assert!(!gate.wait(Duration::from_millis(50)));
        assert!(t.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn exactly_one_of_many_simultaneous_callers_wins() {
        let f = Arc::new(SingleFlight::new());
        let winners = Arc::new(AtomicUsize::new(0));
        let start = Arc::new(Barrier::new(8));
        let hold = Arc::new(Barrier::new(8));
        let handles: Vec<_> = (0..8)
            .map(|_| {
                let (f, winners, start, hold) =
                    (f.clone(), winners.clone(), start.clone(), hold.clone());
                std::thread::spawn(move || {
                    start.wait();
                    let guard = f.try_begin();
                    if guard.is_some() {
                        winners.fetch_add(1, Ordering::SeqCst);
                    }
                    // Everyone attempts before the winner lets go.
                    hold.wait();
                    drop(guard);
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        assert_eq!(winners.load(Ordering::SeqCst), 1);
    }
}
