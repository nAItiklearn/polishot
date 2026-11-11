# Developing Polishot

Everything a contributor or maintainer needs beyond the README.

## What is in here

| Path | What |
|---|---|
| `apps/desktop` | Windows app: Tauri 2 (Rust in `src-tauri/`, core logic in `src-tauri/core/`), React UI for the overlay, preview/editor, pin and status windows |
| `apps/android` | Android app: Kotlin + Compose, MediaProjection capture, ML Kit OCR, Room history, editor in a WebView (`editor-host/`), `quicksend/` module |
| `apps/web` | Website (Next.js 15, Vercel): marketing pages with live HTML demos (`components/home`), pricing, download, legal, in-browser editor (`app/editor`) |
| `packages/editor` | The shared Konva + React screenshot editor used by all three apps |
| `packages/redact` | On-device detectors (email, card with Luhn, IPv4/IPv6, API keys) |
| `packages/license` | Offline Ed25519 license format (TS), with shared test vectors |
| `packages/brand` | Design tokens, logo masters, icon export |
| `crates/polishot-license` | The same license format in Rust |
| `crates/polishot-media` | Scrolling-capture stitcher and GIF encoder |
| `crates/polishot-quicksend` | Phone-to-PC LAN transfer protocol (spec: `docs/QUICKSEND.md`) |
| `tools/license-keygen` | Issues license keys (the private key lives outside git) |
| `tools/shots`, `tools/demo` | Product screenshots for the site, demo video recorders |

Binding docs: `PLAN.md`, `docs/CONTRACTS.md` + `docs/CONTRACT-CHANGES.md`, `docs/UX-BAR.md`, `docs/QUICKSEND.md`,
`docs/HANDOFF.md`. What has not been verified on real hardware: `docs/UNVERIFIED.md`.

## Develop

Node 24, pnpm 12, Rust stable. `pnpm install` at the root.

```bash
pnpm dev:web                                   # website on http://localhost:3000
cd apps/desktop && npx vite --port 3200        # desktop UI in mock mode: http://127.0.0.1:3200/?mock=1
pnpm dev:desktop                               # real Tauri app (needs MSVC; CI builds it)
```

Android: open `apps/android` in Android Studio, or `./gradlew assembleDebug` (JDK 17+, SDK 37). See
`apps/android/README.md`.

## Test

```bash
pnpm test                                      # all JS/TS unit tests
pnpm typecheck
pnpm --filter @polishot/editor test:e2e        # editor browser tests (incl. perf)
pnpm --filter @polishot/desktop shots          # desktop UI e2e in mock mode
pnpm --filter @polishot/web e2e                # website browser tests (builds first)
cargo test --workspace                         # Rust (Windows MSVC in CI)
cd apps/android && ./gradlew test lint         # Android
```

If you have no MSVC, run Rust locally with the GNU toolchain (see `docs/HANDOFF.md` §3).

## CI and releases

- `.github/workflows/ci.yml` runs on every push: workflow lint, JS (lint, types, unit, build, three e2e suites),
  Rust on Windows MSVC (fmt, clippy `-D warnings`, tests), Linux crate tests, Android (calls `android.yml`:
  build, unit tests, lint), dependency audits, advisory Lighthouse. Branch protection should require
  **All checks**.
- `.github/workflows/release.yml` runs on a `v*` tag. It refuses to publish unless the tag is on `main`, CI is
  green for that commit, the version matches `tauri.conf.json` and `CHANGELOG.md` has a section for it. It builds
  `Polishot-Setup-x64.exe`, `Polishot-x64.msi`, `Polishot.apk` and `Polishot.aab`, signs the Android build with the
  release key (required), signs the Windows installers if a certificate is configured (optional), publishes a
  GitHub Release and, with `PUBLIC_DOWNLOADS=true`, uploads the files to the public Vercel Blob store under
  `releases/<tag>/` and `releases/latest/`.
- Release secrets live in the GitHub environment **release** (tags `v*` only): `POLISHOT_KEYSTORE_BASE64`,
  `POLISHOT_KEYSTORE_PASSWORD`, `POLISHOT_KEY_ALIAS`, `POLISHOT_KEY_PASSWORD`, `BLOB_READ_WRITE_TOKEN`, and
  optionally `WINDOWS_CERT_PFX` / `WINDOWS_CERT_PASSWORD`.

To release: bump the version in `apps/desktop/src-tauri/tauri.conf.json` and the Android `versionName`/`versionCode`,
add a `## x.y.z — date` section to `CHANGELOG.md`, push to `main`, wait for green CI, then
`git tag -a vx.y.z -m "Polishot x.y.z" && git push origin vx.y.z`.

**The Android release key** (`polishot-release.p12`, alias `polishot`) and its password are kept outside git in
a folder outside the repository. Back that folder up somewhere safe and offline. If the key is lost, existing
Android installs can never be updated in place.

## Website

Vercel project `polishot`, connected to this repo: every push to `main` deploys production at
<https://polishot.cam> (`www` redirects). Environment variables (all optional):

| Variable | Effect |
|---|---|
| `NEXT_PUBLIC_DOWNLOAD_BASE_URL` | Public base for release files, e.g. `https://<store>.public.blob.vercel-storage.com/releases/latest`. Empty = download buttons disabled ("switch on when the first release is published") |
| `NEXT_PUBLIC_CHECKOUT_URL` | Pro checkout link. Empty = "On sale soon" |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Contact address on the legal pages |
| `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`, `VISITOR_SALT` | Anonymous visitor counter pill; hidden unless all three are set |

Note: Vercel's Hobby plan is for non-commercial use. Move to Pro (or another host) before selling Pro licenses.

## License keys

`tools/license-keygen` signs keys with the production private key (gitignored, user-only ACL, at
`tools/license-keygen/keys/prod.private.key`). Public key: `1e204abec4ca8f84df5381163cee881dbac8e442e3cae65f9516833c6f938936`.
A key covers builds dated up to its issue day + 365 (one year of updates); later builds run as Free.
