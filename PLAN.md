# Polishot — Plan

Status: **draft, awaiting approval.** No code is written until this is approved.

Polishot turns a raw screenshot into a shareable image in about two seconds: capture, auto-balance, auto-redact, copy text, export. It runs on Windows and Android and has a marketing site with a free in-browser editor. The product name lives in one constant per app (`packages/brand/src/index.ts`, mirrored in `apps/android/.../Brand.kt` and the Tauri config). A test checks that all three agree.

---

## 1. Environment findings (this machine)

| Tool | State | Consequence |
|---|---|---|
| Node 24.11, pnpm, Rust 1.99 (msvc), VS 2022 Build Tools, WebView2 157 | OK | Desktop, website, and shared packages can be built and tested locally. |
| ffmpeg 9 | OK | The Windows demo can be recorded locally. |
| Vercel CLI 65 | OK | Can deploy once you confirm which account and team to use. |
| JDK 24 installed, but the `java` shim segfaults | Broken | AGP/Gradle support JDK 17/21. JDK 21 needs to be installed (see Q3). |
| Android SDK, emulator, adb, Gradle | Missing | Android cannot be built or tested here yet. See Q3. |
| `gh` CLI | Missing | Repo and release setup has to be done with plain git, or by you. |

---

## 2. Architecture

```
polishot/                     pnpm workspace, exact versions pinned (save-exact=true)
├─ packages/
│  ├─ brand/                  APP_NAME, accent tokens, design tokens (CSS vars + TS)
│  ├─ redact/                 pure TS detectors + 100+ fixtures (Vitest)
│  ├─ license/                key format + Ed25519 verify (@noble/ed25519), shared test vectors
│  └─ editor/                 Konva editor: document model, balance, background,
│                              annotations, redaction layer, undo/redo, export, presets
├─ apps/
│  ├─ desktop/                Tauri 2 + React + TS + Tailwind
│  │  └─ src-tauri/           Rust: capture, OCR, history DB, license, quick send, GIF, scroll
│  ├─ web/                    Next.js 15 + Tailwind + shadcn/ui (only components actually used)
│  └─ android/                Kotlin + Compose (Gradle, not part of the pnpm graph)
├─ tools/
│  ├─ license-keygen/         CLI to mint keys; private key read from a file outside the repo
│  ├─ shots/                  Playwright script that captures real screenshots of the app for the site
│  └─ demo/                   scripted demo runs (PowerShell + ffmpeg, adb)
└─ .github/workflows/         ci.yml, release.yml
```

### 2.1 Shared editor (`packages/editor`)
- **Document model:** a plain, serializable `EditorDoc` (source image, crop, padding, background, frame, annotations[], redactions[], export settings). Every edit is a command, so undo/redo is a stack of inverse commands. History and presets store the JSON doc, which keeps edits re-editable.
- **Auto-balance:** compute the content bounding box by trimming near-uniform borders (tolerance in Lab ΔE). Then apply equal padding, with a ratio derived from content size, and center the content in the target aspect ratio.
- **Auto background:** sample a 4 px edge ring, quantize it in OKLab with small k-means (k ≤ 4), and pick the dominant cluster. From that, derive a two-stop gradient (shift lightness and chroma) that keeps 3:1 contrast against the content edge. Custom gradients and image backgrounds are also supported. Image backgrounds use cover-fit and an optional blur.
- **Annotations:** arrow, rectangle, ellipse, line, text, blur, numbered steps, and a redact brush. They live on Konva layers, with keyboard shortcuts for every tool.
- **Export:** render with an offscreen Konva stage at pixel ratio 1–3. Output PNG, JPEG or WebP through `canvas.toBlob` with a quality slider. The free-tier watermark is drawn here and is skipped when a license is valid.
- **Presets:** X (16:9, 1600×900), LinkedIn (1200×627), Instagram square (1080×1080), Instagram story (1080×1920), YouTube thumbnail (1280×720), and custom sizes. User presets are stored as JSON.
- **Hosts:** the same package powers the desktop UI, the web editor, and (recommended, see Q1) the Android editor.

### 2.2 Redaction (`packages/redact`)
- **Input:** OCR words with bounding boxes. Lines are re-joined, so multi-token matches (card numbers split by spaces, IPv6) map back to the union of the word boxes they cover.
- **Detectors:**
  - Email: RFC-lite pattern with TLD sanity checks.
  - Credit card: 13–19 digits, spaces or dashes allowed, IIN prefix check, then Luhn.
  - IPv4: octets 0–255, with version strings like `v1.2.3.4` rejected.
  - IPv6: full and compressed forms, validated with a real parser rather than a regex.
  - API keys and tokens:
    - Known prefixes: `sk-`, `sk_live_`, `pk_live_`, `ghp_`/`gho_`/`ghs_`/`github_pat_`, `xox[abpr]-`, `AKIA`/`ASIA`, `AIza`, `glpat-`, `npm_`, JWT `eyJ…`, and others.
    - Unknown tokens: a Shannon-entropy check (≥ 3.5 bits/char, ≥ 20 chars, mixed classes), with hex hashes and UUIDs in prose excluded.
- **OCR error handling:** OCR confusions are tolerated in a controlled way (O→0 and l→1 inside digit runs only).
- **Output:** spans with type, confidence and boxes. The UI shows each detection as a toggleable chip before applying it, then applies blur (pixelate plus Gaussian) or solid bars in one click.
- **Fixtures:** ≥ 60 positive and ≥ 60 negative samples per suite, as JSON files that both the TS tests and the Android tests can load.

### 2.3 Desktop (Tauri 2)
- **Capture-to-preview under 500 ms** depends on four things:
  1. The app stays resident in the tray, and the preview and overlay windows are created hidden at startup and reused.
  2. When the hotkey fires, each monitor is grabbed immediately with Windows Graphics Capture (`windows-capture`, with `xcap` as fallback). A fullscreen overlay then shows that frozen frame.
  3. You drag a region. **Space** toggles window mode: windows are hit-tested via `EnumWindows` plus DWM extended frame bounds and highlighted, and a click captures that window with WGC, even when it is occluded.
  4. Pixels go to the webview through a custom `polishot://` protocol (raw RGBA or PNG straight from memory), not base64 IPC. Timings are logged.
- **OCR:** `Windows.Media.Ocr` through the `windows` crate. It runs in a background task right after capture and returns word boxes. A selectable text overlay supports drag-select and Ctrl+C.
- **History:** SQLite (`rusqlite`, bundled) with an FTS5 table over OCR text. Images and thumbnails are stored in `%LOCALAPPDATA%\Polishot\history`. Search, delete, and clear-all (with a confirmation) are supported.
- **Other features:**
  - **Tray, autostart, shortcut:** `tauri-plugin-global-shortcut` with a recorder UI that detects conflicts, plus `tauri-plugin-autostart` and the tray.
  - **Opening images:** open from file, paste from clipboard, or drag-drop.
  - **Pin to screen:** a borderless, always-on-top, resizable window with opacity controls. Esc closes it.
  - **Scrolling capture:** pick a window, then send wheel input with `SendInput`, grab frames, and stitch them by matching row hashes and then refining with normalized cross-correlation in the overlap band. Fixed headers are handled. Stops on Esc, at a height limit, or when content stops changing.
  - **GIF:** region capture at 15 fps, up to 15 s. Encoding uses the `gif` crate with NeuQuant palettes. gifski is avoided because it is AGPL.
  - **Batch beautify:** pick files and a preset, render through the editor in a hidden webview, and write the results to a folder.
- **Look and feel:** a Mica window effect (`window-vibrancy`) with a solid fallback. The window is compact (default 1040×680): canvas on the left, a 280 px inspector on the right, and a command bar on Ctrl+K.
- **Security:**
  - A strict Tauri capability allowlist per window and a CSP with no remote origins.
  - The fs scope is limited to the app data folder and paths the user picks.
  - No shell plugin and no remote content.

### 2.4 Licensing (offline, Ed25519)
- **Key format:** `PSHOT-` followed by base32 of `payload ‖ signature`. The payload is a version, an edition, an issued-at date, a licensee hash (SHA-256 of the email, so no plaintext PII), and a key id.
- **Verification:** the public key is embedded in the apps, and the private key never enters the repo. Verification happens in Rust (`ed25519-dalek`) on desktop and in `packages/license` (noble) for the web and Android. Shared test vectors make sure all implementations agree.
- **License screen:** a manager screen to activate, view, and deactivate a key. The key is stored in Windows Credential Manager on desktop and in EncryptedSharedPreferences/Keystore on Android.
- **Purchasing:** as you asked, it isn't built yet. The pricing page reads `NEXT_PUBLIC_CHECKOUT_URL`, and when it's empty the button reads "Licenses go on sale soon". `tools/license-keygen` mints keys for testing.
- **Limit:** like any client-side license check, this can be patched out. The goal is honest users, not DRM.

### 2.5 Quick send (Windows ↔ Android, local network, no account)
- **Discovery:** mDNS service `_polishot._tcp` (`mdns-sd` on Windows, `NsdManager` on Android).
- **Pairing:**
  1. The devices exchange ephemeral P-256 keys and run ECDH.
  2. Both screens show a 6-digit code derived from the transcript hash, and you confirm that they match. This blocks man-in-the-middle attacks on the LAN.
  3. Each side stores the long-term pair key and the peer's identity.
- **Transfer:** AES-256-GCM over TCP, with per-transfer nonces, a size cap, PNG-only content checks, and accept/decline on the receiving side. Unpaired peers are rejected.
- **Firewall:** the Windows Firewall prompt is expected the first time.

### 2.6 Android (Kotlin + Compose)
- **Capture:** a MediaProjection foreground service with a floating capture bubble (SYSTEM_ALERT_WINDOW, requested with an explanation). Grabbing the frame goes through ImageReader, followed by an instant preview.
- **Share sheet:** a target labelled "Beautify with Polishot" (ACTION_SEND/SEND_MULTIPLE image/*).
- **OCR:** ML Kit on-device text recognition with the bundled model, so it works offline.
- **History and quick send:** Room with FTS4 for history, plus quick send and license support.
- **Editor:** see Q1. The recommendation is to host `packages/editor` from local assets in a WebView, with a typed JS bridge and no network access. That keeps features identical and reuses one tested codebase. Capture, OCR, files, share, and quick send stay native.
- **Builds:** minSdk 29, target the latest stable SDK. Releases use R8.

### 2.7 Website (Next.js 15, Vercel)
- **Pages:** home, features, pricing, changelog (from `CHANGELOG.md`), download (links to the latest GitHub release assets through a configurable repo slug), privacy, terms, and `/editor`.
- **`/editor`:** a client-only route that lazy-loads the editor. OCR there uses `tesseract.js` with self-hosted worker and language data, loaded only when you click "Find text". Nothing is uploaded, and the page says so.
- **Performance (Lighthouse 95+):** static rendering, `next/font` with self-hosted subsets, AVIF/WebP images from real app captures, no client JS on marketing pages beyond small islands, and the editor code-split.

### 2.8 Design direction
- **Palette:** neutrals from `#FAFAF9` to `#0C0C0B` (warm-neutral, not blue-grey), plus one accent, **Persimmon**: `#E4572E` for fills, and `#B93E17` for accent text on light backgrounds (passes AA 4.5:1). There are light and dark themes. Pure white is never used on the dark theme.
- **Type:**
  - Headings: *Instrument Serif* (OFL), used sparingly and large.
  - UI and body: *Geist Sans*, with *Geist Mono* for keys and shortcuts.
  - Desktop: same pairing, with Segoe UI Variable as a fallback for a native Windows feel.
- **Spacing and motion:** an 8 px grid, radii of 6/10/14, and two shadow levels. Motion runs 160–200 ms on standard ease-out and is fully disabled under `prefers-reduced-motion`.
- **Website hero:** a real app capture is the hero, a before/after of an actual screenshot going through Polishot. There are no gradient blobs, no emoji, and no icon-card grids. Features are shown as alternating real screenshots with one-sentence captions.
- **Tooling:** I'll use ECC skills and agents: `frontend-design-direction`, `accessibility`/`a11y-architect`, `typescript-reviewer`, `react-reviewer`, `rust-reviewer`, `kotlin-reviewer`, `security-reviewer`, `e2e-runner`, `performance-optimizer`, and the Vercel deploy skill.

---

## 3. Testing and CI

| Layer | Tooling | Key coverage |
|---|---|---|
| packages/redact | Vitest | ≥ 120 fixtures, Luhn, IPv6 parser, entropy edge cases, box mapping |
| packages/editor | Vitest + jsdom/canvas | balance, edge-color extraction, presets, undo/redo, export dims, watermark gating |
| packages/license | Vitest | shared vectors, tampered/expired/malformed keys |
| desktop Rust | `cargo test` | license verify vectors, stitching on synthetic frames, crop math, DB/FTS, quick-send crypto round-trip and tamper rejection, capture smoke test (Windows runner) |
| web + web editor | Playwright | page renders, nav, keyboard path through the editor, open file → balance → redact → export download, axe a11y checks, Lighthouse CI budget |
| android | JUnit + Compose UI (Robolectric for CI speed; instrumented on emulator in CI) | redact fixture parity, license vectors, share-receiver intent, editor bridge |

`ci.yml` has three jobs:
- `js` (ubuntu): lint, typecheck, Vitest, web build, Playwright.
- `desktop` (windows-latest): cargo fmt/clippy/test, Tauri build.
- `android` (ubuntu, JDK 21): unit, Robolectric, and emulator tests via `reactivecircus/android-emulator-runner`.

`release.yml` runs on a `v*` tag. It builds the MSI and NSIS installers plus the APK and AAB and attaches them to the GitHub release. Signing secrets are optional: without them the builds are unsigned (Windows SmartScreen will warn) or debug-signed.

---

## 4. Milestones

1. **M1 — Shared packages:** monorepo skeleton, brand tokens, redact, license, and editor core, all with tests passing.
2. **M2 — Desktop:** tray, hotkey, region/window capture, preview, inspector, OCR overlay, auto-redact, history, open/paste/drop, presets, export, license screen. Includes the cold-start and capture latency measurements.
3. **M3 — Website:** all pages, the web editor, Playwright, Lighthouse, `vercel.json`, `.env.example`. Then a preview deploy, and production only after your OK.
4. **M4 — Android:** capture bubble, share receiver, ML Kit OCR, editor, history, license. Tests run in CI, and locally if Q3 = install.
5. **M5 — Extras:** quick send, scrolling capture, mockup frames (original SVG frames: generic laptop, phone, browser chrome in light and dark), pin, batch, GIF.
6. **M6 — Demos and release:** demo scripts and recordings, README, CHANGELOG, an unverified-items list, and the release workflow dry run.

After each milestone: run all tests, fix failures, run the review agents, and give you a short status note.

---

## 5. Risks (honest)

1. **Scope.** This is several months of work for a team. I'll build every listed feature to a working state, but some will need real-world polish later, especially scrolling capture across apps and GIF quality. I'll list what's thin rather than overclaim.
2. **Android can't be verified here today.** There's no SDK or emulator. Unless Q3 = install, the Android code can only be checked by CI, which I can't run without a GitHub remote.
3. **Scrolling capture is the most fragile feature.** It depends on the target app honoring wheel input and on what the page does while scrolling (lazy loading, sticky elements, smooth scrolling). I'll support common cases (browsers, Explorer, editors) and fail clearly otherwise.
4. **500 ms capture-to-preview** depends on the resident tray process and pre-created windows. A truly cold first capture will be slower. Both numbers will be measured and reported.
5. **Windows.Media.Ocr language packs.** OCR quality depends on the installed Windows OCR languages. The app detects a missing pack and links to Settings.
6. **Unsigned installers** will trigger SmartScreen until you add a code-signing certificate.
7. **The "real screenshots" on the website** depend on the desktop app being finished first, so M3 will include re-shooting assets after M2.
8. **Lighthouse 95+** applies to marketing pages. The `/editor` route is heavier by nature, but OCR is lazy-loaded so its first load stays fast.
9. **Client-side licensing** can be bypassed. That is acceptable for this product.

---

## 6. Questions before I start

**Q1. Android editor:** WebView hosting the shared `packages/editor` (recommended: identical features, one test suite, about 250 ms warm-up hidden by prewarming), or a fully native Compose editor (more native feel, but a second implementation of every tool)?

**Q2. Location:** build in `D:\polishot` and `git init` there? I won't push anywhere until you give me a remote.

**Q3. Android toolchain:** may I install JDK 21 (Temurin) and the Android command-line tools, SDK, and an x86_64 emulator image locally (about 6–8 GB on D:)? That lets me build, test and record the Android demo here. Otherwise Android is CI-only and the demo script is left for you to run.

**Q4. Vercel:** may I create preview deploys under your logged-in Vercel account once the site is ready? Production waits for your explicit OK either way.

## 7. v0.2 roadmap (approved by owner 2026-11-11 — start only after v0.1 ships)
Positioning: "CleanShot-quality for Windows + Android, private by default, $11 once."
1. **Share-safe check** — before copy/export, on-device scan (reuse `packages/redact`) for emails,
   API keys, cards, faces, QR codes; one-click blur. Lead marketing feature.
2. **Guide export** — 3–10 captures with step numbers → Markdown / PDF / one tall image (Pro value).
3. **Social presets** — one-click sizes/backgrounds for X, LinkedIn, Product Hunt, app stores + device frames.
Later candidates: OCR translate / copy-as-code; optional cloud share links (separate decision — cost + privacy).
Website now: lead with Share-safe and Windows + Android.
