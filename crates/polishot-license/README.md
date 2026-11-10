# polishot-license

Offline Ed25519 licence keys for Polishot, plus the Pro entitlement rules from `docs/CONTRACTS.md`
section 5b. The TypeScript twin is `@polishot/license`; both run the same vectors in
`packages/license/test-vectors.json`.

```rust
use polishot_license::{entitlement, verify_prod, Entitlement};

// `BUILD_DAYS` is embedded at build time, see below.
let e: Entitlement = entitlement(stored_key.as_deref(), BUILD_DAYS);
if e.pro {
    // unlock Pro: no watermark, brand mark, unlimited presets and batch
} else {
    match e.reason {
        Some("no-key") => {}                       // never activated
        Some("invalid") => {}                      // stored key does not verify
        Some("updates-expired") => {
            // key is genuine but this build is newer than its window; e.updates_until_days says when it ended
        }
        _ => {}
    }
}
```

## Update window

A key covers every app version whose build date is at most `issued_days + 365`.

| API | meaning |
|---|---|
| `LicenseInfo::updates_until_days() -> u32` | `issued_days + 365`, **saturating** at `u32::MAX` |
| `LicenseInfo::covers_build(build_days: u32) -> bool` | `build_days <= updates_until_days()` (the last day is included) |
| `Entitlement::for_info(&info, build_days)` | entitlement for a key you already verified |
| `entitlement(key: Option<&str>, build_days)` | verifies against the production key; `None` or a blank string is `no-key`; a key that does not verify is `invalid` |
| `entitlement_with_key(key, &public_key, build_days)` | same, against a key you supply (tests use the test key) |

`Entitlement { pro, reason, updates_until_days }`: `reason` is `Some("no-key" | "invalid" | "updates-expired")`
exactly when `pro` is false; `updates_until_days` is set whenever a genuine key was checked, so the UI can
print "Your license includes updates released until <date>" for an `updates-expired` build.

Never use plain `issued_days + 365`: the vectors include a key issued on day `u32::MAX`, which wraps to a
tiny number and would mark every normal build as expired.

## Embedding `BUILD_DAYS`

The app, not this crate, knows its own build date. Add a `build.rs` that exports the days since
1970-01-01 (UTC) and turn it into a constant. It honours `SOURCE_DATE_EPOCH` so reproducible builds get
the same value, and otherwise uses the current time.

```rust
// build.rs
use std::time::{SystemTime, UNIX_EPOCH};

fn main() {
    println!("cargo:rerun-if-env-changed=SOURCE_DATE_EPOCH");
    println!("cargo:rerun-if-changed=build.rs");
    let secs = match std::env::var("SOURCE_DATE_EPOCH") {
        // Reproducible builds pin the timestamp; refuse garbage rather than guessing.
        Ok(v) => v
            .trim()
            .parse::<u64>()
            .expect("SOURCE_DATE_EPOCH must be Unix seconds"),
        Err(_) => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before 1970")
            .as_secs(),
    };
    println!("cargo:rustc-env=POLISHOT_BUILD_DAYS={}", secs / 86_400);
}
```

```rust
// src/lib.rs (or main.rs)
/// Days since 1970-01-01 (UTC) when this binary was built.
pub const BUILD_DAYS: u32 = parse_days(env!("POLISHOT_BUILD_DAYS"));

/// Compile-time decimal parse; a malformed or oversized value is a build error, never a silent 0.
const fn parse_days(text: &str) -> u32 {
    let bytes = text.as_bytes();
    assert!(!bytes.is_empty(), "POLISHOT_BUILD_DAYS is empty");
    let mut value: u32 = 0;
    let mut i = 0;
    while i < bytes.len() {
        let digit = bytes[i];
        assert!(digit.is_ascii_digit(), "POLISHOT_BUILD_DAYS is not a number");
        value = match value.checked_mul(10) {
            Some(v) => match v.checked_add((digit - b'0') as u32) {
                Some(v) => v,
                None => panic!("POLISHOT_BUILD_DAYS overflows u32"),
            },
            None => panic!("POLISHOT_BUILD_DAYS overflows u32"),
        };
        i += 1;
    }
    value
}
```

Do not fall back to `0` when the value is missing or unreadable. A build day of 0 is covered by every
key, so that fallback would silently make the build Pro for everyone. Failing the build is the safe
choice (the snippet above does).

Android does the same in Gradle (`app/build.gradle.kts`):

```kotlin
// -PbuildDays=<n> pins the value (reproducible builds, tests).
val buildDays: Long = providers.gradleProperty("buildDays")
    .map { it.trim().toLong() }
    .orElse(System.currentTimeMillis() / 86_400_000L)
    .get()

android {
    defaultConfig { buildConfigField("long", "BUILD_DAYS", "${buildDays}L") }
    buildFeatures { buildConfig = true }
}
```

Web and other TypeScript builds use `buildDaysFromDate(new Date())` from `@polishot/license`.

## Tests

```bash
cargo test -p polishot-license
cargo clippy -p polishot-license --all-targets -- -D warnings
cargo fmt -p polishot-license -- --check
```

`tests/vectors.rs` runs `cases` (key parsing and signature rules); `tests/entitlement.rs` runs
`entitlementCases` (window, inclusive boundary, one day after, saturation, invalid key, no key).
Regenerate both with `node tools/license-keygen/index.mjs vectors`.
