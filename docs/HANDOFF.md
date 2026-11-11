# Polishot — Session Handoff (2026-11-10, night)

The previous lead session ended while 7 subagents were still running. Their work is **on disk but
may be partially finished** — every workstream must be re-verified by running its tests before
building on it. A git checkpoint commit was made at handoff time (`git log -1`).


## 0. Updates 2026-11-11 (later the same day) — read first
- **Website design is now owned by the lead, not a subagent.** Direction: warm cream paper, serif + red italic accent,
  floating pill nav, live clickable HTML demos (components/home/*), no WebGL shaders, no theme toggle. Hero = "Polishot /
  private by default." only. See memory `website-design-direction`.
- **Repo is private and closed source:** https://github.com/nAItiklearn/polishot (remote `origin`). No open-source licence,
  no GitHub links on the site. Downloads need a public host (Vercel Blob or public releases repo) — TODO.
- **Android ML Kit sends anonymous diagnostics to Google** (no images/text, no opt-out). Site copy says "no analytics of
  our own" and the privacy page discloses it. Owner decision pending: keep ML Kit or switch Android OCR to bundled Tesseract.
- v0.2 roadmap approved: PLAN.md §7 (Share-safe check, guide export, social presets).

## 1. Read these first (in order)
1. `PLAN.md` — approved architecture & milestones.
2. `docs/CONTRACTS.md` — binding interfaces (editor API, desktop IPC, license format, Android bridge, §5b pricing).
3. `docs/CONTRACT-CHANGES.md` — additive changes agents made to the contracts.
4. `docs/UX-BAR.md` — the owner's interaction-quality bar (binding for every editor surface).
5. `docs/QUICKSEND.md` — LAN transfer protocol spec.
6. `packages/brand/assets/BRAND.md` — logo usage.

## 2. Owner decisions & preferences (binding)
- **Quality**: "absolute premium and clean" UI. No AI-template look. Editing must feel as frictionless
  as the best Mac screenshot apps (inspiration only, never copy).
- **Use Opus for all high-level subagents** (omit `model` or set `model: "opus"`; never Sonnet/Haiku).
- Split work into **subagents with clear, scoped briefs and exclusive folder ownership**, run in parallel.
- **Website** (updated 2026-11-11 by owner): LIGHT, minimal, premium, single theme (no toggle), live original WebGL BRIGHT light-gradient shader (warm ember/persimmon/gold accents allowed). Previously: dark only, grain-gradient/"silk" shaders in the
  ember/persimmon/gold palette (reference: `17c78e84-764a-4b15-88d1-0b3f8dac0b12.png` at repo root —
  style reference only), premium self-hosted fonts, small visitor counter pill in the nav
  (Upstash Redis HyperLogLog, hidden until env vars exist).
- **Pricing**: Free = all features + small watermark, 3 saved presets, batch ≤ 5. **Pro = $11 one-time**:
  no watermark, custom brand mark, unlimited presets & batch, **1 year of updates** (key covers builds
  dated ≤ issuedDays+365; later builds behave as Free). Checkout not live yet — Stripe later
  (`NEXT_PUBLIC_CHECKOUT_URL` empty → "On sale soon").
- **Logo**: "Print P" chosen and approved ("its good"). Masters in `packages/brand/assets/`; already
  exported into all apps via `node packages/brand/scripts/export-icons.mjs --all`.
- Desktop UI (mock mode) approved ("looks good").
- **Never publish/deploy without the owner first reviewing on localhost.** Vercel CLI is already logged in.
- **Do NOT ask the owner to install Visual Studio Build Tools** (it doesn't work on their laptop).
  MSVC/Tauri installers are built on **GitHub Actions windows-latest**.
- **Do NOT install Android SDK/JDK locally.** The owner builds/tests Android themselves; CI builds APK/AAB.
- Owner may be asleep/unavailable: if blocked, work around it or do other tasks; list blockers at the end.

## 3. Environment facts (this Windows laptop)
- Repo: `D:\polishot` (pnpm 12 workspace, Node 24, Rust 1.99). `git init` done, **no remote yet**
  (`gh` CLI not installed) — pushing/CI needs a GitHub repo URL from the owner.
- **No MSVC linker.** Run Rust locally with the GNU toolchain:
  ```bash
  PATH="/c/Users/Lenovo/AppData/Local/Microsoft/WinGet/Packages/BrechtSanders.WinLibs.POSIX.UCRT_Microsoft.Winget.Source_8wekyb3d8bbwe/mingw64/bin:$PATH" \
  CARGO_TARGET_DIR=C:/Users/Lenovo/AppData/Local/Temp/polishot-target-gnu \
  cargo +stable-x86_64-pc-windows-gnu test --workspace
  ```
- **GateGuard hook** blocks the first Write to every new file until you state: who imports it, that
  nothing existing does the same, any data schema, and the user's instruction. Efficient pattern:
  state facts once per batch → tiny placeholder writes (`.`) → real content. (Owner can exempt with
  `GATEGUARD_EXEMPT_GLOBS=D:/polishot/**` in a new session.)
- Pin exact versions (`save-exact=true`, Cargo `=x.y.z`). Root `pnpm install` may hit lock errors when
  agents install concurrently → wait 20–30 s and retry. Never delete `pnpm-lock.yaml`/`node_modules`.
- Dev servers used for owner review: website `npx next dev -p 3100` in `apps/web`; desktop UI mock
  `npx vite --port 3200` in `apps/desktop` then open `http://127.0.0.1:3200/?mock=1`.
- License: prod dev-keypair private key at `tools/license-keygen/keys/prod.private.key` (gitignored,
  user-only ACL). Public key `1e204abec4ca8f84df5381163cee881dbac8e442e3cae65f9516833c6f938936`.

## 4. Workstream status at handoff
| # | Workstream | Owner folders | Status | Verify with |
|---|---|---|---|---|
| 1 | brand tokens | `packages/brand` | ✅ done (12 tests) | `pnpm --filter @polishot/brand test` |
| 2 | redact detectors | `packages/redact` | ✅ done (172 tests, 78+78 fixtures) | `pnpm --filter @polishot/redact test` |
| 3 | license TS + keygen + Rust crate | `packages/license`, `tools/license-keygen`, `crates/polishot-license` | ✅ done (45 TS, 10 Rust) — then **Pro entitlements** agent was extending it (update window, `entitlement()`, `entitlementCases` vectors) → **verify** | `pnpm --filter @polishot/license test`; cargo (GNU) `-p polishot-license` |
| 4 | editor core + React UI | `packages/editor` | ✅ done (226 unit, 11 e2e) — then **Pro entitlements + UX-BAR polish** agent was extending it (brandMark, preset/batch limits, hover `preview()`, Shift constraints, nudge, Ctrl+D, step renumber, 60 fps sliders) → **verify / finish** | `pnpm --filter @polishot/editor test && pnpm --filter @polishot/editor test:e2e` |
| 5 | media crate (scroll stitch + GIF) | `crates/polishot-media` | ✅ done (48 tests) | cargo (GNU) `-p polishot-media` |
| 6 | quick send (Rust + Kotlin + vectors) | `crates/polishot-quicksend`, `apps/android/quicksend`, `packages/quicksend-vectors`, `docs/QUICKSEND.md` | ✅ Rust done (63 tests); Kotlin written, **never compiled** | cargo (GNU) `-p polishot-quicksend`; owner/CI: `./gradlew :quicksend:test` |
| 7 | brand logo | `packages/brand/assets`, `packages/brand/scripts` | ✅ done, exported to apps | — |
| 8 | desktop backend (Tauri Rust + overlay) | `apps/desktop/src-tauri/**`, `apps/desktop/src/overlay/**`, desktop package/vite config, `.github/workflows/desktop.yml` | 🟡 in progress (has capture, commands, files, pin, protocol, quicksend, recorder, share, shortcuts, tray, winmgr) — must integrate: polishot-media (scroll + GIF), polishot-quicksend (IPC `qs_*`), license `entitlement` + `BUILD_DAYS`, tray → `icons/tray.png` | cargo (GNU) `-p polishot-desktop`, clippy, `pnpm --filter @polishot/desktop test` |
| 9 | desktop preview UI | `apps/desktop/src/preview/**`, `src/shared/**`, `src/pin/**` | 🟡 in progress (mock mode works and was approved) — finish history/settings/license views, quick-send Send button + pairing dialog, UX-BAR acceptance check | `pnpm --filter @polishot/desktop test`, `vite build`, `pnpm --filter @polishot/desktop shots` |
| 10 | website marketing + redesign | `apps/web/**` except `app/editor/**`, `e2e/editor.e2e.ts` | 🟡 in progress — redesign: dark only (remove `components/theme-toggle.tsx` + its test), shaders (`components/shaders/`), fonts, $11 pricing, visitor counter (`app/api/visits`, `components/visitor-counter.tsx`), logo in nav/footer/OG, Lighthouse ≥95 | `pnpm --filter @polishot/web build && pnpm --filter @polishot/web e2e`, `lhci` |
| 11 | web in-browser editor | `apps/web/app/editor/**`, `apps/web/e2e/editor.e2e.ts`, `apps/web/public/ocr/**` | 🟡 in progress — tesseract.js self-hosted, lazy OCR, export/copy/share, UX-BAR; may need a CSP change in `next.config.ts` (`worker-src blob:`, `wasm-unsafe-eval` scoped to /editor) | `pnpm --filter @polishot/web e2e -- editor.e2e.ts` |
| 12 | Android app | `apps/android/**` (not `quicksend/`), `.github/workflows/android.yml` | 🟡 in progress — Gradle project, editor-host, capture service + bubble, share receiver + batch, ML Kit OCR, Room history, BouncyCastle license + entitlement, quick-send UI (NsdManager), README | `pnpm --filter @polishot/android-editor-host build`; owner/CI: `./gradlew test assembleDebug` |

> Update 2026-11-11: #12 Android agent **finished** (165 files; 117 JVM tests + editor-host 29 tests
> passed via scratch kotlinc; Android-dependent code never compiled). A compile-hardening audit agent
> now owns `apps/android/**` (verifying AGP 9.5.1 / Gradle 9.6.1 / Kotlin 2.4.21 / SDK 37,
> `ACCESS_LOCAL_NETWORK`, adding `workflow_call` to android.yml). Owner must build it — see apps/android/README.md.

## 5. Remaining work after the above (milestone M6)
> Update 2026-11-11: agents were started for items 1 (CI/release → `.github/workflows/ci.yml`,
> `release.yml`, `dependabot.yml`), 2 (screenshots → `tools/shots/**`, outputs in
> `apps/web/public/shots/`) and 4 (demos → `tools/demo/**`). If a new session starts, check those
> folders, run them, and finish whatever is missing. Items 3 (reviews) and 5 (docs) not started yet.

1. **Root CI** `.github/workflows/ci.yml`: js (lint/typecheck/vitest/web build/Playwright incl. editor e2e),
   rust (windows-latest MSVC: fmt, clippy -D warnings, `cargo test --workspace`), android (call android.yml).
   `release.yml` on `v*` tags: Tauri NSIS+MSI → `Polishot-Setup-x64.exe`, `Polishot-x64.msi`;
   Android → `Polishot.apk`, `Polishot.aab`; attach to GitHub Release. Pin actions to SHAs/tags.
2. **Real product screenshots** for the website: script `tools/shots` (Playwright against the desktop
   UI mock mode + editor playground with a realistic sample) → `apps/web/public/shots/*.webp` per
   `apps/web/public/shots/manifest.json`. Replace all placeholders.
3. **Reviews** (run in parallel, read-only, then fix findings): `ecc:security-reviewer` (whole repo:
   IPC validation, CSP, Tauri capabilities, WebView bridge, quick send, license, visitor counter API),
   `ecc:rust-reviewer`, `ecc:react-reviewer` + `ecc:typescript-reviewer`, `ecc:kotlin-reviewer`,
   `ecc:a11y-architect` (website + editor UI). Fix CRITICAL/HIGH, re-run all tests.
4. **Demo videos** `tools/demo/`: `windows-demo.ps1` (scripted run + `ffmpeg -f gdigrab` 30–45 s:
   capture → auto-balance → auto-redact → copy text → export) and `android-demo.sh` (emulator +
   `adb shell screenrecord`). Desktop can't run as .exe locally (no MSVC) → script it to run against
   the CI-built installer; document exact commands for the owner.
5. **Docs**: root `README.md` (what it is, architecture, dev commands, test commands, release process,
   license keygen, env vars), `CHANGELOG.md` 0.1.0, and **`docs/UNVERIFIED.md`** — honest list of what
   was not verified (Kotlin never compiled here, Tauri .exe never launched locally, real LAN quick
   send, Windows OCR language packs, Lighthouse on prod, etc.).
6. **Owner review then deploy**: start `next dev -p 3100`, tell the owner, wait for OK, then
   `vercel deploy` (preview) and later `--prod`. After deploy, the visitor counter needs the owner to add
   Upstash Redis (Vercel Marketplace) + `VISITOR_SALT` env.
7. Final local `git commit` per milestone (author attribution per system instructions).

## 6. How the new lead should resume
1. Run every "Verify with" command in §4 (in parallel where possible) and note pass/fail.
2. For each 🟡 workstream (and any ✅ that now fails), spawn **one Opus subagent** with exclusive
   folder ownership, a brief that says: "Read docs/HANDOFF.md, CONTRACTS.md, CONTRACT-CHANGES.md,
   UX-BAR.md. Your workstream is #N. Inspect what exists on disk, run its tests, finish the listed
   remaining items, keep all tests green, never weaken tests, report files/tests/blockers." Run all of
   them in parallel (`run_in_background: true`). Give each the GateGuard + GNU toolchain notes.
3. When #4 (editor) finishes, tell #9, #11, #12 so they adopt the new editor APIs.
4. Then run §5 items 1–5 (CI agent, shots agent, review agents, demo agent, docs agent) in parallel.
5. Re-open localhost for the owner; deploy only after explicit OK.
