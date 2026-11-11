# What has not been verified

An honest list, kept current. "Verified" below means it ran for real: a test on the target platform, a CI job on a
real runner, or a manual check. Everything else was reasoned about, compiled, or run in a mock.

## Verified on real infrastructure

- Rust workspace builds, passes clippy `-D warnings` and all tests on **GitHub windows-latest with MSVC**.
- Android app builds Debug and Release (KSP, R8 minify) with the **real Android SDK 37** on GitHub ubuntu, unit
  tests pass, lint passes.
- Website builds and serves on Vercel at polishot.cam; ~110 browser tests (content, a11y with axe, keyboard,
  motion, security headers, download, visitor counter) pass against a production build.
- Shared editor: unit tests, browser e2e including a measured 60 fps 4K slider drag and a slow-CPU undo test.
- Desktop UI: unit tests and ~95 browser e2e tests, but **in mock mode** (Chromium, fake backend).

## Not verified (needs a real Windows PC with the installer)

- The installed app itself has never been launched on a real PC by us. First real run = the owner's test.
- Hotkey → overlay latency and the instant-overlay path; WGC/GDI capture on real multi-monitor and high-DPI setups.
- Clipboard two-phase write (PNG first, CF_DIBV5 appended) with real apps (Word, Slack, Paint, legacy apps).
- Windows Share sheet with the fixed path handling; Explorer "show in folder".
- Scrolling capture against real apps, GIF recording through GDI with status windows excluded.
- Windows OCR with installed language packs.
- WebView2 navigation guard, hidden-window throttling, Mica with the undecorated window, tray light/dark icons.
- `RegGetValueW` taskbar theme, `GetAdaptersAddresses` subnet filtering.
- Unsigned installer: SmartScreen shows "Windows protected your PC" (expected until a code-signing certificate).

## Not verified (needs a real Android phone)

- MediaProjection consent (forced entire screen on Android 14+), the capture bubble launching the editor from the
  background, notification-triggered capture timing.
- `ACCESS_LOCAL_NETWORK` on Android 17, NSD discovery and resolve retries.
- The `PolishotNative` WebView message bridge (ArrayBuffer path) and its legacy fallback.
- Rotation and process death in the editor, share receiver and capture service.
- Robolectric/Compose UI tests ran only in CI, not on a device. Frame smoothness of the home grid and editor load.
- ML Kit OCR quality; ML Kit sends anonymous diagnostics to Google (disclosed on the privacy page).

## Not verified (needs both devices on one Wi-Fi)

- Quick send end to end: pairing with the six-digit code, sending both ways, firewall prompt on first use, mDNS
  advertise/withdraw. The protocol has extensive automated tests (Rust and Kotlin share test vectors), but no real
  PC↔phone transfer has happened yet.

## Product gaps (known, not bugs)

- Pro is not on sale yet (no checkout). Free has every feature with a small watermark.
- Lighthouse performance on CI runners is below 95 on some pages (advisory); local measurements are good (LCP < 0.9 s, CLS ≈ 0).
- The Share-safe check, guide export and social presets are the v0.2 roadmap (`PLAN.md` §7).
