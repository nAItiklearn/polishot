# Polishot for Android

Capture the screen, beautify it, redact what should not be shared, and send it to a PC on the same Wi-Fi.
Everything runs on the device: there is no account and no upload.

This folder is a Gradle build (`apps/android/`) with two modules and a small web app:

| Path | What it is |
|---|---|
| `app/` | The Android app (Kotlin, Jetpack Compose, `applicationId` `app.polishot`, minSdk 29, target and compile SDK 37) |
| `quicksend/` | Quick send protocol: pure Kotlin/JVM, no Android classes, tested on the JVM |
| `editor-host/` | The editor page (Vite + React) that the app shows in a locked-down WebView. Built into `app/src/main/assets/editor/` |

## Requirements

- JDK 17 (Gradle uses a JDK 17 toolchain for the build and for the compiler target).
- Android SDK with platform 37 and build-tools. Easiest: install Android Studio and open this folder. Or install the
  command-line tools and point `ANDROID_HOME` at the SDK.
- Node 24 and pnpm 12.16.1 (the repo pins it in `packageManager`; `corepack enable` provides it).
- A device or emulator with Android 10 (API 29) or newer.

The Gradle wrapper is checked in and pinned by SHA-256, so you do not need a Gradle install.

## Build and install a debug build

Run these in order. The first command is the only one run from the repository root.

```sh
# 1. JavaScript dependencies for the whole monorepo (the editor host uses workspace packages)
pnpm install

# 2. Build the editor page into app/src/main/assets/editor
pnpm --filter @polishot/android-editor-host build

# 3. Build the debug APK
cd apps/android
./gradlew assembleDebug            # Windows: gradlew.bat assembleDebug

# 4. Install it on a connected device or a running emulator
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

Notes:

- Step 2 also runs by itself as part of any Gradle build that needs the assets (task `buildEditorHost`), so step 3 alone
  works after `pnpm install`. Running step 2 first just makes a failure in the page easy to see.
- Add `-PskipEditorBuild` to a Gradle command to skip that task when `app/src/main/assets/editor` is already up to date
  (the emulator job in CI does this).
- The licence public key is read from `packages/license/public-key.hex` at build time and generated into
  `LicensePublicKey.kt`, so the app, the website and the desktop app always verify against the same key.
- `BuildConfig.BUILD_DAYS` is the build date in days since 1970-01-01. A licence covers a build when the build date is
  not later than one year after the licence was issued (docs/CONTRACTS.md section 5b). `-PbuildDays=20500` pins it for
  reproducible builds and tests.

## Tests

```sh
# Editor page: type check and unit tests (from the repository root)
pnpm --filter @polishot/android-editor-host typecheck
pnpm --filter @polishot/android-editor-host test

# JVM unit tests for the app and for quicksend, plus Android lint (from apps/android)
./gradlew test :quicksend:test lint

# Instrumented tests on a connected device or emulator (from apps/android)
./gradlew connectedCheck
```

What the tests cover:

- **License and pricing**: the shared vectors in `packages/license/test-vectors.json` (the same file the TypeScript and
  Rust tests use), including non-canonical signatures and the u32 edge, and the shared `entitlementCases` for the
  update window.
- **Bridge**: base64 and MIME validation with signature checks, file-name sanitising, the JavaScript call builders,
  and a check that the page's Content-Security-Policy meta tag equals the policy the app sends.
- **OCR mapping, history search** (the FTS query builder), look extraction, settings, capture ids, free batch limit.
- **Quick send**: real loopback sockets for pairing, sending, declining, bad files, unreachable peers and the stall
  watchdog (`:quicksend:test` covers the protocol library itself).
- **UI on the JVM (Robolectric)**: home screen, licence screen (a bad key is rejected), share-intent filtering.
- **UI on a device** (`app/src/androidTest`): home renders, licence screen rejects a bad key, the share sheet lists
  "Beautify with Polishot", sharing a real image opens the editor.

`testReleaseUnitTest` is switched off on purpose: the Compose test activity is declared only in the debug variant,
and the same sources run in `testDebugUnitTest`.

## Release builds

```sh
./gradlew assembleRelease bundleRelease
# app/build/outputs/apk/release/app-release.apk
# app/build/outputs/bundle/release/app-release.aab
```

Release builds are minified with R8 (the bridge methods are kept by `app/proguard-rules.pro`). They are signed with
your keystore when these environment variables are set, and with the debug key otherwise (fine for testing, rejected
by Google Play):

```sh
export POLISHOT_KEYSTORE=/path/to/polishot.keystore
export POLISHOT_KEYSTORE_PASSWORD=...
export POLISHOT_KEY_ALIAS=...
export POLISHOT_KEY_PASSWORD=...
```

The `Android` GitHub Actions workflow (`.github/workflows/android.yml`) runs the unit tests, quicksend tests, lint,
`assembleRelease` and `bundleRelease`, uploads `Polishot.apk` and `Polishot.aab`, and runs `connectedCheck` on an
API 34 emulator. It signs with the repository secrets `POLISHOT_KEYSTORE_BASE64`, `POLISHOT_KEYSTORE_PASSWORD`,
`POLISHOT_KEY_ALIAS` and `POLISHOT_KEY_PASSWORD` when they exist.

## How the pieces fit

- **Capture.** `MainActivity` asks for screen-capture consent and starts `CaptureService` (a `mediaProjection`
  foreground service). A draggable bubble (needs "Display over other apps") or the notification takes the shot, which
  is saved to private storage and opened in `EditorActivity`, already styled, with no flash of the raw screenshot.
- **Share sheet.** "Beautify with Polishot" (`ShareReceiverActivity` behind an activity alias) accepts one image or
  several. Several run as a batch with your last look. Free runs up to 5 images at a time; Pro has no such limit.
- **Editor.** A WebView loads the page from the app's assets through `WebViewAssetLoader` on
  `https://appassets.androidplatform.net`. File access and content access are off, every other host gets a 403, and
  the page's CSP allows no remote origin. The page talks to Kotlin through one `@JavascriptInterface` object
  (`PolishotAndroid`, CONTRACTS section 6) whose inputs are validated: size caps, an allow-list of image types that
  must match the file's signature, and sanitised file names.
- **Text and redaction.** ML Kit text recognition (bundled model, works offline) feeds the editor's one-tap
  "found N" redaction chip and the searchable history.
- **History.** Room with an FTS4 index over the recognised text, stored only on the device. Backups are disabled.
- **License.** Ed25519 verification with BouncyCastle (canonical-S check, unsigned 32-bit day count). The key text is
  kept encrypted with an Android Keystore key. Free has every feature with a small watermark, 3 saved looks and
  batches of 5; Pro removes those limits and adds your own brand mark (Settings, Brand mark).
- **Quick send.** Discovery with `NsdManager` (`_polishot._tcp`), pairing with a 6-digit code that both screens
  compare, and an encrypted send. The listener only runs while a Quick send screen is open, and pairing is only
  accepted while the pairing screen is open. Incoming offers arrive as a notification and open in the editor.

## Things to know

- **Permissions** are the minimum that each feature needs: `INTERNET` (sockets for quick send; there is no web
  traffic), `CHANGE_WIFI_MULTICAST_STATE` (a multicast lock while browsing for devices), `SYSTEM_ALERT_WINDOW` (the
  bubble, optional), `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE` and `FOREGROUND_SERVICE_MEDIA_PROJECTION`, and on
  Android 17 and later the runtime permission `ACCESS_LOCAL_NETWORK` for reaching a PC on the local network.
  `NEARBY_WIFI_DEVICES` is not needed for `NsdManager` and is not requested.
- **No logging of content.** OCR text, images and licence keys are never written to the log.
- **`quicksend` stays free of newer Java APIs.** It compiles on a plain JDK 17, but the app runs it on Android 10 and
  newer (minSdk 29). Avoid library calls added after Java 8 in `quicksend/` (for example `HexFormat`,
  `InputStream.readAllBytes`, `Stream.toList`, `String.formatted`): the JVM build would accept them and an older phone
  would crash. Android lint checks the `app` module only.
- **Robolectric** runs the JVM UI tests on a simulated Android 15 (`src/test/resources/robolectric.properties`).
  The first run downloads the Android jars it needs.
- **Room schemas** are exported to `app/schemas/` on every build. Commit them with any change to the database.
