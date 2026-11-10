//! Sliding-window limiter for pairing attempts (spec section 8: 5 per 60 seconds by default).

use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// Allows at most `max` pairing attempts in any `window`. Share one instance per listener.
#[derive(Debug)]
pub struct PairingRateLimiter {
    max: usize,
    window: Duration,
    hits: Mutex<VecDeque<Instant>>,
}

impl Default for PairingRateLimiter {
    fn default() -> Self {
        PairingRateLimiter::new(5, Duration::from_secs(60))
    }
}

impl PairingRateLimiter {
    /// A limiter allowing `max` attempts per `window`.
    pub fn new(max: usize, window: Duration) -> Self {
        PairingRateLimiter {
            max,
            window,
            hits: Mutex::new(VecDeque::new()),
        }
    }

    /// Record an attempt now; false means the attempt must be refused.
    pub fn try_acquire(&self) -> bool {
        self.try_acquire_at(Instant::now())
    }

    /// Like [`try_acquire`](Self::try_acquire) with an explicit clock (for tests).
    pub fn try_acquire_at(&self, now: Instant) -> bool {
        let mut hits = self.hits.lock().unwrap_or_else(|e| e.into_inner());
        while let Some(front) = hits.front() {
            if now.saturating_duration_since(*front) >= self.window {
                hits.pop_front();
            } else {
                break;
            }
        }
        if hits.len() >= self.max {
            return false;
        }
        hits.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn five_per_minute() {
        let rl = PairingRateLimiter::default();
        let t0 = Instant::now();
        for i in 0..5 {
            assert!(
                rl.try_acquire_at(t0 + Duration::from_secs(i)),
                "attempt {i}"
            );
        }
        assert!(!rl.try_acquire_at(t0 + Duration::from_secs(30)));
        assert!(!rl.try_acquire_at(t0 + Duration::from_secs(59)));
        // the first hit (t0) leaves the window at t0 + 60
        assert!(rl.try_acquire_at(t0 + Duration::from_secs(60)));
        assert!(!rl.try_acquire_at(t0 + Duration::from_secs(60)));
    }
}
