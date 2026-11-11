# Demo videos

Three scripts that record the 30 to 45 second product demo: capture, auto-balance, auto-redact, copy text (OCR), export.
Everything they write goes to `tools/demo/out/` (gitignored). Nothing here is part of the product or the CI build.

| Script | Records | Needs | Where it can run |
|---|---|---|---|
| `web-flow-demo.mjs` | The website's in-browser editor, in headless Chromium | Node, the repo's `pnpm install`, optionally ffmpeg | Any machine; **verified here** |
| `windows-demo.ps1` | The installed Windows app, with `ffmpeg -f gdigrab` | The CI-built `Polishot-Setup-x64.exe`, ffmpeg, Edge or Chrome | A Windows 10/11 desktop session; **owner runs it** |
| `android-demo.sh` | The Android app, with `adb shell screenrecord` | The APK, `adb`, a device or emulator, Node | Git Bash, WSL, macOS or Linux; **owner runs it** |

All three use the same made-up billing screen, `assets/sample.html` (fake email, a payment-card test number and a
documentation IP address). Nothing in it is real.

Pinned and tested versions: Node 24.11.1, pnpm 12.16.1 (from the root `package.json`), `@playwright/test` 1.65.0 (from
`apps/web`; the script checks this and its `page.screencast` API needs 1.59 or newer), ffmpeg 9.0.2 (Gyan full build),
Windows PowerShell 5.1 (PowerShell 7 also works).

Run every command below from the repository root (`D:\polishot`).

---

## 1. Web editor flow (works now)

Home page, then the editor: open a screenshot (already auto-balanced), find sensitive data on-device, blur it, copy all
text, download a PNG. The finished video plays page loads, text recognition and export rendering faster, so it lands at
about 40 seconds whatever the machine's speed.

```powershell
pnpm install                                                # once
node tools/demo/web-flow-demo.mjs --start-server --prod     # builds the site, starts it, records, stops it
```

`--prod` builds the production site into `apps/web/.next-demo-prod` first (a few minutes) and records that. It is the
better choice for the final video: there is no development badge in the corner, and a build is a snapshot, so it does not
change under you while someone edits the code. Without `--prod`, `--start-server` runs `next dev` in `apps/web/.next-demo`.

If you already have the site running (`cd apps/web && npx next dev -p 3100`), just record it:

```powershell
node tools/demo/web-flow-demo.mjs                           # http://127.0.0.1:3100
node tools/demo/web-flow-demo.mjs --url http://127.0.0.1:3102
```

Output in `tools/demo/out/web/`: `polishot-web-flow.mp4` (needs ffmpeg on PATH; otherwise the `.webm` is kept),
`exported.png` (what the editor's Download button produced), `sample-billing.png`, and `run.json` (timeline and the checks
the run made: auto-balance applied, three items found, all blurred, text on the clipboard, PNG exported).
Exit code 2 means the video was recorded but a check failed, so watch it before using it.

Useful options: `--headed` (watch it), `--no-captions`, `--pace 1.3` (slower), `--ocr-timeout 400` (seconds, for a slow
machine), `--keep-webm`, `--verbose` (prints how long each step took), `--out <dir>`, `--help`.
`--sample-only` renders only `sample-billing.png` (2560x1600) and exits; the Android script uses that image.

Record this again once the website design is final: the video shows whatever the site looks like at that moment.

---

## 2. Windows app (owner runs it)

The installer cannot be built on the maintainer's laptop (no MSVC). CI builds it on `windows-latest`. Get it one of three ways:

```powershell
# a) From a CI run (workflow "desktop", artifact polishot-windows-x64). Needs the GitHub CLI.
gh run download <run-id> -n polishot-windows-x64 -D tools\demo\out\installer

# b) From a tagged release (workflow "Release", artifact release-windows, or the release assets). Needs the GitHub CLI.
gh release download vX.Y.Z -R OWNER/REPO -p Polishot-Setup-x64.exe -D tools\demo\out\installer

# c) Let the script fetch the latest public release and verify it against SHA256SUMS.txt
powershell -NoProfile -ExecutionPolicy Bypass -File tools\demo\windows-demo.ps1 -Download -Repo OWNER/REPO
```

Then, in a normal (non-elevated) PowerShell window on a Windows 10/11 desktop:

```powershell
# 1. Preflight: checks ffmpeg and the browser, shows the sample window, records 3 seconds.
#    Sends no mouse or keyboard input and installs nothing. Open the video it writes and look at it.
powershell -NoProfile -ExecutionPolicy Bypass -File tools\demo\windows-demo.ps1 -Check

# 2. The real run. Hands off the mouse and keyboard for about 40 seconds.
powershell -NoProfile -ExecutionPolicy Bypass -File tools\demo\windows-demo.ps1 -InstallerPath tools\demo\out\installer -UninstallAfter
```

What step 2 does: installs silently (`/S`, per user, no admin), launches the app into the tray, minimises your other
windows, shows `assets/sample.html` in a browser app window, starts `ffmpeg -f gdigrab` on the primary monitor, presses the
capture shortcut (default `Ctrl+Shift+2`, or whatever `%APPDATA%\Polishot\settings.json` says), drags a region over the
sample window, then presses `Ctrl+2` (Redact tab), `Ctrl+Shift+B` (blur everything found), `Ctrl+3` (Text tab),
`Ctrl+Shift+C` (copy all text), `Ctrl+4` (Export tab) and `Ctrl+S` (save). It then restores your windows, quits the app,
and writes `tools\demo\out\windows\polishot-windows-demo.mp4` and `run.json`.

`run.json` records a timeline and these checks: a capture was registered, the recognised text on the clipboard contains the
sample's email address, and a new image appeared in the save folder. Exit code 2 means one failed.

Useful options (see `Get-Help .\tools\demo\windows-demo.ps1 -Full`):

| Option | Meaning |
|---|---|
| `-SkipInstall` / `-AppExe <Polishot.exe>` | Use an app that is already installed. |
| `-StopExisting` | Quit a running Polishot first (it is single-instance, so the demo needs a fresh one). |
| `-Hotkey 'Ctrl+Alt+S'` | The capture shortcut, if you changed it. |
| `-Pace 1.3` | Slows every pause (1 is about 33 s of video; stay within 30 to 45 s). |
| `-InstallDir <dir>` | Install somewhere specific (NSIS `/D=`). |
| `-UninstallAfter` | Remove the app afterwards. Your settings and history are kept. |
| `-KeepWindows` | Do not minimise your other windows. |
| `-LeaveRunning` | Leave the app running afterwards. |
| `-DryRun` | Print the plan and run the preflight only. |
| `-FfmpegPath`, `-Browser` | Point to ffmpeg or a browser that is not found automatically. |

Things that can go wrong, and what the script tells you:

- **ffmpeg missing**: `winget install Gyan.FFmpeg`, then open a new terminal. A build without `gdigrab` is rejected.
- **Installer missing**: the error lists every place it looked and the three ways to get it.
- **Windows SmartScreen** may warn about the unsigned installer if you run it by hand. The script runs `Unblock-File` first, so a download in `tools\demo\out` does not prompt.
- **Execution policy**: that is why the commands above start with `powershell -ExecutionPolicy Bypass -File`.
- **Scaled display (125 %, 150 %)**: handled (the recorder runs in high-DPI mode and the sample page shrinks to fit the window). `-Check` warns if the video size does not match the screen.
- **The preview never opens**: another program may own the capture shortcut, or the app's shortcut is different. Pass `-Hotkey`.
- **Do not touch the mouse or keyboard** during the run. If a stray keystroke lands in another window, run it again.

---

## 3. Android app (owner runs it)

Needs the platform-tools (`adb`), Node, and an APK. Use a phone with USB debugging on, or an emulator. The profile
`android-profile.json` holds the package name, the AVD to boot, the timing, and the text the script looks for on screen.

```sh
# APK: build it (see apps/android/README.md) ...
pnpm install
pnpm --filter @polishot/android-editor-host build
(cd apps/android && ./gradlew assembleDebug)          # Windows: gradlew.bat assembleDebug
# ... or take the CI one (workflow "Android", artifact Polishot.apk; the "Release" workflow's artifact is release-android):
gh run download <run-id> -n Polishot.apk -D tools/demo/out/installer     # puts Polishot.apk there

# The sample screenshot the script puts on the device (needs only Node and the pnpm install above):
node tools/demo/web-flow-demo.mjs --sample-only

# Optional: boot an emulator the script creates for you (image: system-images;android-35;google_apis;x86_64)
bash tools/demo/android-demo.sh --check --boot-avd     # preflight + 5 s test recording, installs nothing

# The run (a phone or emulator is connected, or add --boot-avd)
bash tools/demo/android-demo.sh --apk apps/android/app/build/outputs/apk/debug/app-debug.apk
```

On Windows use Git Bash or WSL. If several devices are connected, pass `--serial emulator-5554` (see `adb devices`).
Without `--apk` the script takes the first file that exists from the list in `android-profile.json`
(`tools/demo/out/installer/Polishot.apk`, then the release build, then the debug build).

What it does: puts the status bar in demo mode (clean clock and battery) and turns on show-touches, installs the APK,
pushes `northwind-billing.png` to the gallery, starts `adb shell screenrecord`, opens Polishot, then shares the picture to
**Beautify with Polishot**. The editor opens already auto-balanced. It then taps the **N found** chip (auto-redact), the
**Copy text** chip (OCR) and **Save**, stops the recording, pulls `tools/demo/out/android/polishot-android-demo.mp4`, puts
the phone back as it was, and writes `run.json`. Checks: the editor came to the front, the three UI elements were found
in the accessibility tree, the clipboard text (when Android lets adb read it) contains the sample's email, and a new file
appeared in `Pictures/Polishot`.

It enters through the share sheet on purpose. A screen capture needs the system's consent dialog, whose wording and
buttons differ on every Android image, so a script cannot press it reliably. Everything after the editor opens is the real app.

If the share step does not work on your image (the script says so), do it yourself and let the script record the rest:

```sh
bash tools/demo/android-demo.sh --attach     # waits up to 90 s for you to open a picture in Polishot via its share sheet
```

Other options: `--reinstall` (remove an APK signed with a different key first), `--no-install`, `--uninstall-after`,
`--no-demo-mode`, `--pace 1.3`, `--image <png>`, `--keep-emulator`, `--dry-run`, `--help`.
If the editor's buttons are not in the accessibility tree on your image (it is a WebView), the script taps fixed
positions from `ui.fallback` in the profile and says so; adjust those fractions if they miss.

---

## What was and was not verified

Verified on the maintainer's machine (Windows 11, 1920x1080 at 125 % display scaling, ffmpeg 9.0.2, Playwright 1.65.0):

- `web-flow-demo.mjs`: ran end to end against the production build and the dev server; every check passed and it produced a
  41 s H.264 video (`tools/demo/out/web/`). Frames were reviewed.
- `windows-demo.ps1`: parses; `-DryRun`, the installer-not-found and ffmpeg-not-found errors, and `-Check` ran (the check
  recorded a 3 s, 1920x1080 video with the sample window fully visible). The keyboard and pointer code was run against a
  scratch window: every shortcut arrived with the right modifiers and a drag landed on the expected pixels. Helper
  functions (installer lookup, log polling, key parsing, download validation) were unit-tested by dot-sourcing the script.
- `android-demo.sh`: `bash -n` and `--dry-run`; the whole flow was run against a mock `adb` that plays back canned replies.

**Not** verified, because they need things only the owner has:

- The Windows script against the real installer and app: the silent install, the app's start-up, the shortcut, the overlay
  drag, the preview's keys, the clipboard and saved-file checks. It reads the app's `timings.log` to know when the overlay and
  preview are up and falls back to fixed pauses if those lines change.
- The Android script on any real device or emulator: the share intent with a MediaStore URI, `uiautomator` seeing the
  WebView, `screenrecord`, demo mode, the `cmd clipboard` read. Treat the first run as a trial.

## Known site bug found while recording

Clicking the **Web editor** link from another page (a client-side navigation) leaves the previous page's
Content-Security-Policy in force (`worker-src 'none'`), so text recognition fails there with "Text recognition could not
start". A full page load of `/editor` works. The web demo therefore opens `/editor` with a full page load. The fix belongs in
`apps/web` (make the links to `/editor` full navigations, or give every page the policy `/editor` needs).
