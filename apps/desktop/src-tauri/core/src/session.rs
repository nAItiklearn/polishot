//! Rules for the one in-flight capture session, kept free of Tauri so the races they prevent are
//! unit-tested.
//!
//! * A hotkey that fires twice quickly must not grab the screen twice ([`SingleFlight`]).
//! * A slow commit (a window capture can take hundreds of milliseconds) must not tear down a
//!   *newer* session that started meanwhile: every commit remembers the nonce of the session it
//!   came from and only touches the session slot, or hides the overlays, while that nonce is
//!   still current ([`release`], [`reopen`]).

use std::sync::atomic::{AtomicBool, Ordering};

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

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;
    use std::sync::{Arc, Barrier};

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
