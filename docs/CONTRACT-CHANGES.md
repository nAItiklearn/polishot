# Contract changes

Append new sections at the bottom; never rewrite another workstream's entry.

## Desktop IPC (apps/desktop), clarifications and additions

Nothing in CONTRACTS section 5 was removed or renamed. Everything below is either a clarification of
something the contract left open or an additive extension. Reasons are given per item.

### Clarifications

1. **Units and coordinate spaces.** The overlay needs one unambiguous space to avoid off-by-one
   crops on mixed-DPI and negative-coordinate setups.
   - `overlay_info().bounds` is the monitor rectangle in **physical pixels, virtual-desktop
     coordinates** (x/y can be negative for monitors left of or above the primary).
   - `overlay_info().scale` is device pixels per CSS pixel (1.25 at 125 %).
   - `WindowInfo.rect` is the window's visible frame (DWM extended frame bounds) in the same
     physical virtual-desktop space. `overlay_info().windows` is ordered front-most first, so the
     first hit is the topmost window.
   - `capture_commit({kind:'region'}).rect` is in **physical pixels relative to that monitor's frame**
     (0,0 = the monitor's top-left). The Rust side rounds, clamps to the frame and rejects empty or
     non-finite rectangles.
   - Monitor indexes are assigned left-to-right, then top-to-bottom, and match the `overlay-<n>`
     label and `/frame/<n>`.
2. **Timestamps** (`CaptureMeta.createdAt`, `LicenseStatus.issuedAt`) are Unix epoch **milliseconds**.
3. **Default shortcuts.** `shortcut` defaults to `Ctrl+Shift+2`. `scrollShortcut` and `gifShortcut`
   default to `""` (disabled) because those features are not part of this workstream; an empty
   string is valid for them. When set they are registered and, on press, the Rust side emits
   `shortcut:extra` (`'scroll' | 'gif'`) to the `preview` window for the owning feature to handle.
4. **History is automatic.** Every capture, opened file and pasted image gets a history row with its
   OCR text indexed once recognition finishes. `history_save` only attaches the editor document
   (`docJson`) to an existing row (creating the row first if persistence has not caught up).
5. **`capture:ready`** is emitted to the `preview` window for region and window captures only
   (`open_file` and `paste_clipboard_image` return their `CaptureMeta` to the caller instead).
   With `afterCapture: 'copy'` the image goes to the clipboard, the preview stays hidden, and
   `capture:ready` is still emitted.
6. **Settings validation** (all failures are readable strings): shortcuts must parse, include a
   modifier and be distinct; `quality` in 0.1 to 1; `saveFolder` absolute with no `..`;
   `defaultPreset` matches `^[A-Za-z0-9_-]{1,64}$`; `userPresets` is a JSON array under 256 KB.
   `settings_set` rejects unknown keys. A shortcut another app already owns returns
   "`<shortcut>` is already in use by another application..." and leaves the old shortcuts active.
7. **Protocol.** `/frame/<n>` is served as an uncompressed 32-bit BMP (no encode step) and only to
   `overlay-<n>`; `/capture`, `/history`, `/thumb` only to `preview` and `pin-*`. `/capture/<id>` may be
   `image/bmp` while the PNG is still being written in the background and `image/png` afterwards
   (clients should rely on `Content-Type`, not on the URL). Responses carry CORS headers for the app's
   own origins so images can be drawn to a canvas without tainting it.

### Additive commands

| Command | Used by | Purpose |
|---|---|---|
| `overlay_ready({ nonce, decodeMs? })` | overlay | Frame decoded: Rust shows the window (this is what makes "overlay shown" measurable). |
| `overlay_focus()` | overlay | Take keyboard focus when the pointer moves onto a non-focused monitor. |
| `overlay_set_mode({ mode })` | overlay | Space toggled window mode; mirrored to every overlay via `overlay:mode`. |
| `history_get({ id }) -> { meta: CaptureMeta, docJson: string \| null }` | preview | Reopen a history item with its editor document. |
| `app_info() -> { version, backdrop: 'mica' \| 'solid', warnings: string[] }` | preview | Whether Mica is active (paint a solid background when `solid`) and non-fatal startup problems such as a shortcut conflict. |
| `pin_close()` | pin-* | A pin window closes itself. |

`OverlayInfo` additionally carries `nonce` and `mode` so an overlay that finishes loading after the
hotkey can catch up.

### Additive events

`settings:changed` (Settings) after a successful `settings_set`; `capture:error` (string) to `preview`
when a hotkey capture fails; `overlay:arm` ({ nonce, mode, cursor }) and `overlay:mode` (mode) to
overlay windows only; `shortcut:extra` as described above.

### Capabilities

The app declares every command in `build.rs`, so Tauri generates `allow-<command>` permissions and
`capabilities/{overlay,preview,pin}.json` grant each window label only its own set. Overlay windows
cannot read files, history or the clipboard; pin windows can only drag and close themselves.

### Dependencies not used

`tauri-plugin-clipboard-manager` was evaluated and dropped: the clipboard needs the registered
`PNG` format plus CF_DIBV5/CF_DIB written together so Slack, Word and browsers all paste correctly,
which the plugin does not do, so the Win32 clipboard is used directly (`src/clipboard.rs`).

## `@polishot/editor` (packages/editor), clarifications and additions

Nothing in CONTRACTS section 4 was removed or renamed; every signature there is implemented as written.
Below are the places where the contract left something open, and the strictly additive extensions.

### Clarifications

1. **`<EditorCanvas editor>` and construction.** `new Editor(container, opts)` needs a container at
   construction, while `<EditorCanvas editor>` receives an existing editor. Resolution: the editor owns a root
   element (`editor.element`, fills its parent, resizes with a `ResizeObserver`). A React host creates the
   editor with a detached element, `new Editor(document.createElement('div'), { licensed })`, and
   `EditorCanvas` moves `editor.element` into its own DOM. Non-React hosts pass a real container.
2. **Padding semantics.** `padding` is a fraction of `max(framed content w, h)` measured on the displayed
   content, for auto and fixed-size presets alike. Auto layouts keep scale 1 and snap the padding to whole
   pixels. Fixed presets scale the framed content to fit and centre it. `radius` is in output pixels.
3. **`Editor.export` and the licence.** The watermark is drawn unless the editor is licensed AND
   `opts.licensed !== false`; a caller cannot force it off on an unlicensed editor. The standalone
   `exportDoc(doc, image, opts)` uses `opts.licensed` directly, and anything other than boolean `true`
   draws the watermark (fails closed).
4. **`validateDoc(json)`** accepts an object or JSON text and returns a sanitised copy (unknown keys dropped,
   soft ranges clamped) or `null`. It rejects wrong types, NaN/Infinity, oversized arrays and nesting,
   duplicate ids, colours other than `#hex` / `rgb()` / `rgba()`, and `__proto__` / `constructor` /
   `prototype` keys anywhere. `Editor.load(image, doc)` and `Editor.update()` run it on everything they get;
   an invalid `doc` is ignored (a fresh balanced document is created) and an invalid `update` is a no-op.
5. **Image backgrounds** accept only `data:image/(png|jpeg|webp|gif|avif);base64,`, `blob:`, or a URL on an
   origin the host lists (`EditorOptions.origins`; the page origin is always allowed). SVG, `file:`,
   `javascript:` and remote hosts are refused in `validateDoc` and again at render time.
6. **Numbered steps** use the smallest unused positive integer, so deleting step 2 of 1-2-3 makes the next
   new step 2 again.
7. **Auto-balance** analyses a copy of the image of at most 1600 px (exact 2x halvings), so a 4K screenshot
   loads in about 60-120 ms of editor work. The crop is mapped back rounded outward, so content is never cut.
   A line is trimmed only if every pixel is within OKLab 0.03 of the colour at the outer edge, per-side trim is
   capped at 30 percent, and trims under 2 px are ignored.

### Additive API (core)

- `computeLayout(doc)` also returns `frame` (the framed object's rectangle) and `pad`.
- `autoBackground(pixels, region?)` takes an optional crop to sample the edge ring of the content.
- `Editor`: `element`, `version`, `hasImage`, `licensed`, `style`, `selectedId`, `selected`, `canvasSize`,
  `layout`, `zoom`, `timings`, `select(id)`, `beginBatch()` / `endBatch()` (one undo step for a slider drag),
  `removeDetections(dets)`, `isDetectionApplied(det)`, `rebalance()`, `computeAutoBackground()`,
  `contentRectOnScreen()`, `handleKey(e)`, `setInsets()`, `refreshTheme()`.
- `Editor.setStyle` also takes `blurMode`, `brushSize` (screen px) and `brushMode`.
- Event `'view'` (resize, zoom, layout change) next to `'change' | 'select' | 'tool'`.
- Exports: `validateDoc`, `isSafeImageSrc`, `History`, `planExport`, `computeExportSize`, `deriveGradient`,
  `dominantEdgeColor`, `mapShortcut`, `maskPreview`, `SWATCHES`, `FRAME_IDS`, `PRESET_ORDER`, and more.

### React UI props (contract left them open)

- `<Inspector editor presets? loadPresets? onSavePreset? onDeletePreset?>`: `loadPresets()` returns the
  host's saved looks (sync or async); `onSavePreset({ name, settings })` and `onDeletePreset(id)` persist.
  The UI never touches storage or the network.
- `<RedactPanel editor words onScan? scanning? kinds?>`: `words` is `null` until the host has run OCR.
- `<TextLayer editor words onCopyText?>`: the layer takes pointer events only while the select tool has
  nothing selected. `onCopyText` lets the host use a native clipboard command.
- `<ExportPanel editor onExport actions? defaults?>`: `onExport({ blob, options, action, filename, width,
  height })`; `action` is `'save'` or `'copy'` (copy always renders PNG).
- `<EditorCanvas editor insets?>`: default insets leave 80 px at the bottom for the floating toolbar.
- Hooks: `useEditorVersion(editor)` and `useEditorShortcuts(editor)` (document-level shortcuts that ignore
  text fields).

### Dependencies

Exactly as specified. `pnpm install` added `minimumReleaseAgeExclude: [lucide-react@1.71.0]` to
`pnpm-workspace.yaml` (pnpm did this itself because 1.71.0 is newer than the age gate).

## Desktop license status (apps/desktop), pricing and update window

Implements CONTRACTS section 5b on the desktop side. `LicenseStatus` (returned by `license_status`,
`license_activate`, `license_deactivate`) gains two optional fields; the existing ones keep their
meaning:

```ts
type LicenseStatus = {
  licensed: boolean;              // = Pro is active (valid key AND this build is inside its update window)
  edition?: 'personal' | 'team';  // present whenever a genuine key is stored, even if licensed is false
  keyId?: string;
  issuedAt?: number;              // Unix epoch milliseconds
  reason?: 'no-key' | 'invalid' | 'updates-expired';   // set whenever licensed is false
  updatesUntil?: string;          // ISO date (YYYY-MM-DD) = issuedDays + 365, present with a genuine key
};
```

- `BUILD_DAYS` is embedded by `apps/desktop/src-tauri/build.rs` from `SOURCE_DATE_EPOCH` (reproducible
  builds) or the current time, exposed to code as `POLISHOT_BUILD_DAYS` and parsed at compile time.
- A genuine key that does not cover this build is still stored (the user did pay): the status is
  `{ licensed: false, reason: 'updates-expired', updatesUntil, edition, keyId, issuedAt }` and the UI
  shows "Your license includes updates released until <date>. This version came out later."
  `license_activate` therefore only fails for keys that do not verify.
- `reason: 'invalid'` means a stored key no longer verifies (for example after a key rotation).
- The window maths (`updates_until_days = issuedDays + 365`, `covers_build = build_days <= that`) lives
  in `apps/desktop/src-tauri/core/src/license.rs` and mirrors the section 5b formulas; it is covered by
  tests at the window edge (last covered day, one day later, `u32::MAX`). When
  `polishot-license` exposes `LicenseInfo::updates_until_days()` / `covers_build()` the desktop code
  should switch to them (two one-line changes) so there is a single implementation.
- Batch beautify is not part of the desktop backend work (it runs in the editor host), so the Free
  limit of 5 images per run is not enforced in Rust.

## Android editor bridge (apps/android), additions to CONTRACTS section 6

Nothing in section 6 was removed or renamed; every call listed there works exactly as written. The items
below are additive. Each one has a reason, and all of them are optional for any other host.

### `window.polishot` (Android to page), additions

| Call | Reason |
|---|---|
| `notify({ kind: 'saved' \| 'copied' \| 'shared' \| 'sent' \| 'error', message })` | The bridge methods return nothing, so the page learns the outcome of a save, copy, share or send here and shows the "Copied" / "Saved" toast. `message` is empty for `shared`. |
| `onBack(): boolean` | Android's back button. Returns `true` when the page used it (it closed the bottom sheet); otherwise the activity finishes. |
| `batch({ items, lookJson?, licensed, theme, export })` | Batch beautify of several stored captures (share sheet with more than one image): the page renders each with the user's last look and hands every result to `saveImage`. `items` are `{ id, imageUrl, width, height }`; `lookJson` is `{ padding, background, radius, shadow, frame, preset, custom }` (a subset of `EditorDoc`); `export` is `{ format, quality, scale }`. Free runs are limited to 5 images (section 5b); Android trims the list before sending it, and the page enforces the same limit. |

### `window.polishot.load(...)` payload, optional fields

| Field | Reason |
|---|---|
| `exportDefaults: { format: 'png' \| 'jpeg' \| 'webp'; quality: number /* 0.4..1 */; scale: 1 \| 2 \| 3 }` | The Settings screen's defaults for the Save, Share and Copy buttons. Missing means PNG, 0.92, 2x. |
| `defaultPreset: PresetId` | Canvas preset from Settings, applied only to documents the user has not styled yet. Missing means `'auto'`. |
| `quickSendAvailable: boolean` | Whether the "Send to PC" button is shown. Missing means `false`. |
| `brandMark: { type: 'text'; text: string } \| { type: 'image'; src: string }` | The Pro brand mark (section 5b) from Settings, applied with `editor.setBrandMark`. Android sends it only while `licensed` is true; a logo is a `data:image/png;base64,...` URL (the page CSP allows `data:` images and nothing remote). The page re-validates it with `sanitizeBrandMark` and drops anything unsafe. The same optional field is accepted by `batch`. Missing means no mark: a Pro export is then clean. |

`licensed` in `load` / `setLicensed` is the **Pro** flag of CONTRACTS section 5b (`entitlement.pro`): a genuine key whose
update window covers this build.

### `PolishotAndroid` (page to Android), additions

| Method | Reason |
|---|---|
| `batchProgress(done: number, total: number, failed: number)` | Progress of `window.polishot.batch`. Android finishes the activity and reports the result when `done >= total`. |

### Behavioural clarifications

- `saveImage`, `shareImage`, `copyImage`, `quickSend` take base64 **without** a `data:` prefix. Size limit: 50 MiB of base64
  text. The MIME type must be `image/png`, `image/jpeg` or `image/webp` and must match the file signature, or the call is
  rejected (logged without content, answered with `notify({ kind: 'error' })` only for saves). `copyImage` and `quickSend`
  carry PNG. File names are reduced to a safe base name and the extension always follows the MIME type.
- `saveDoc(id, docJson)` is called by the page about 800 ms after the last change and when the page is hidden. Android keeps
  the JSON as the screenshot's history document; it must be a version 1 `EditorDoc` whose `image.id` equals `id`.
- Images are served at `https://appassets.androidplatform.net/capture/<id>.png` and are never cached (`Cache-Control: no-store`).
  The page's CSP has no remote origins; every request to another host is answered with 403 by the WebView client.

## Desktop scrolling capture, GIF recording and quick send (apps/desktop)

Additive only. Existing commands and events keep their shape, except that `capture_commit` may now
resolve to `null` (see below).

### Scrolling capture and GIF recording

- **Entry points.** Tray items "Capture scrolling" and "Record GIF", the `scrollShortcut` and
  `gifShortcut` settings (empty = disabled), and `capture_start({ mode })`, whose `mode` now also
  accepts `'scroll'` and `'gif'` (in addition to `'region'` and `'window'`). The old
  `shortcut:extra` event from the first desktop entry is gone: those shortcuts now start the flows
  directly.
- **Overlay reuse.** Both flows use the normal overlay. `overlay:arm`, `overlay_info()` and the
  `ipc` type `OverlayInfo` carry `purpose: 'capture' | 'scroll' | 'gif'`. For `scroll` the overlay is
  window-only (Space is ignored); for `gif` it is region-only (Enter records the whole monitor).
- **`capture_commit` returns `CaptureMeta | null`.** `null` means the selection started a scroll
  capture or GIF recording instead of producing a screenshot. Normal captures are unchanged.
- **Scrolling capture.** Pick a window; a small pill reads "Scrolling, Esc to stop". The window's
  client area is captured with wheel input (1-notch calibration, then about half a pane per step,
  retry at half the step once, stop on bottom/full/Esc/90 s/second failure). The result opens in the
  preview as `capture:ready` with `source: 'scroll'`; a partial result is still delivered, with a
  toast explaining an early stop. The pointer is moved into the pane for the wheel and restored after.
- **GIF recording.** Drag a region; a recording frame appears just outside it with a Stop button and
  timer; 15 fps, 800 px wide, 15 s maximum, streamed through a bounded channel to the encoder (no raw
  frames are kept). The file is written to the save folder as `Recording YYYY-MM-DD HH.MM.SS.gif`
  (UTC), a toast offers "Show in folder", and `gif:saved { path, name, bytes }` goes to the preview.
- **Status windows.** `status-pill`, `status-border`, `status-controls`, `status-toast` are created on
  demand, excluded from screen capture, and share one capability (`status-*`).
- **Additive commands.** `recording_stop()` (the Stop button; Esc does the same),
  `reveal_in_folder({ path })` (only files inside the save folder; used by the toast),
  `status_close()` (status windows close themselves).
- **Additive events.** `status:tick { elapsedMs, maxMs }` (to the controls window), `gif:saved`
  (to the preview), `capture:error` (string, when a hotkey capture cannot start).

### Quick send

Nothing starts until it is used: at launch the listener only comes up if a device is already paired;
otherwise the first `qs_devices` or `qs_pairing_mode` call starts it. Binding the listener is what
triggers the Windows Firewall prompt, so the pairing UI should say "Windows may ask to allow network
access; choose Private networks."

| Command | Arguments | Result |
|---|---|---|
| `qs_devices` | none | `DeviceEntry[]` = `{ id, name, paired, online }`. Paired devices first (names from the pair record), then unpaired devices visible on the network. `id` is 16 base32 characters. |
| `qs_pairing_mode` | `{ open: boolean }` | Opens or closes the window in which other devices may pair with this PC (`allow_pairing`). Call with `true` while the "Pair a phone" dialog is open and `false` when it closes. It also closes itself after 5 minutes. |
| `qs_pair_start` | `{ deviceId }` | Dial a visible device and start pairing as the initiator. Resolves to `PairCode`. |
| `qs_pair_confirm` | `{ accepted: boolean }` | The user's answer to "do both screens show this code?". Resolves to the new `DeviceEntry`; rejects with a readable message on mismatch or timeout. Used for both roles. |
| `qs_send` | raw PNG body, headers `x-device-id`, `x-filename` | Sends the image to a paired device that is currently visible. 50 MB limit, PNG only. |
| `qs_forget` | `{ deviceId }` | Removes the pair record. |
| `qs_incoming_respond` | `{ requestId, accept }` | Answer to a `qs:incoming` prompt. Unanswered prompts decline after 55 s. |

`PairCode` = `{ sas: "042 917", peerName, peerId, role: 'initiator' | 'responder' }`.

| Event (to the preview window) | Payload |
|---|---|
| `qs:devices` | none. The device list changed (peer appeared or left, pairing finished, device forgotten). Re-run `qs_devices`. |
| `qs:pair-code` | `PairCode`. Fired for both roles: when this PC started pairing, and when a phone started it while the pairing dialog was open. Show the code, the peer name, and "Do both screens show this code?". Never auto-confirm. |
| `qs:incoming` | `{ requestId, peerName, name, mime, size }`. A paired device wants to send a file. Show Accept / Decline and answer with `qs_incoming_respond`. |
| `qs:received` | `{ meta: CaptureMeta, peerName }`. The accepted image was decoded and registered (`source: 'file'`); the preview window is shown. Load `meta` as you would a `capture:ready`. |

Storage: the device identity secret and each pair record live in
`%APPDATA%\Polishot\quicksend\` (`identity.bin`, `<device id>.pair`), each protected with DPAPI
(`CryptProtectData`) and an app-specific entropy value. Files that cannot be unlocked are ignored; a
lost identity is regenerated and the pairs bound to it are dropped.

## Preview window UI (apps/desktop/src/preview, apps/desktop/src/shared), what it expects from the backend

Nothing in CONTRACTS section 5 was changed. The preview UI uses `apps/desktop/src/shared/ipc.ts` (typed client,
readable errors, swappable transport for the `?mock=1` dev mode). These are the places where it goes slightly
beyond the contract; each one degrades gracefully when the backend does not (yet) provide it.

1. **Save As.** The dialog plugin returns a path, but `export_save` writes only into the save folder. The client
   sends an optional header `x-save-path` (percent-encoded UTF-8 absolute path) next to `x-filename`. A backend
   that honours it should validate it like `saveFolder` (absolute, no `..`, extension and content must match) and
   return the path it wrote. A backend that ignores it still works: the UI always reports the path returned.
2. **Show in folder and the pricing link** use the opener plugin commands `plugin:opener|reveal_item_in_dir`
   (`{ paths: [path] }`) and `plugin:opener|open_url` (`{ url }`, https only). They need `tauri-plugin-opener` and
   `opener:allow-reveal-item-in-dir` + `opener:allow-open-url` in `capabilities/preview.json`. Without the plugin
   the UI copies the path or link to the clipboard and says so.
3. **Window chrome.** The preview draws its own title bar, so `create_preview` should build the window with
   `.decorations(false)`. Double-clicking the drag region also needs `core:window:allow-internal-toggle-maximize`
   in `capabilities/preview.json` (Tauri's drag script calls `internal_toggle_maximize`).
4. **Brand mark (Pro).** The editor exposes `brandMark` / `setBrandMark` (CONTRACTS 5b). `Settings` has no field
   for it, so the preview remembers it in the webview's `localStorage` under `polishot.brandMark.v1`; the editor
   validates it and ignores it unless the editor is licensed. It can move into `Settings` later without UI changes.
5. **First frame.** `show_preview` runs before `capture:ready` is emitted, so for a frame the window can show the
   previous capture. The UI hides the canvas the moment the event arrives, but the cleanest fix is on the Rust
   side: emit `capture:ready` first, or show the window only after the preview acknowledges it.
6. **`LicenseStatus`** in the client carries the optional `reason` and `updatesUntil` fields that the Rust side
   already returns (see "Desktop license status" above).

## Pro entitlements and the interaction bar (packages/license, crates/polishot-license, packages/editor)

Nothing in CONTRACTS sections 3, 4 or 5b was removed or renamed. Everything below is additive, except the three
behaviour changes called out under "Behaviour changes".

### `@polishot/license` (TypeScript)

- `LicenseInfo.issuedDays: number`, the exact unsigned 32-bit issue day. `issuedAt` is a JS `Date` and is clamped for
  absurd values (a vector uses 4294967295), so the window maths reads `issuedDays`.
- `UPDATE_WINDOW_DAYS = 365`.
- `updatesUntilDays(info) = min(issuedDays + 365, 4294967295)`: it saturates exactly like Rust `saturating_add`, so a
  key issued on day `u32::MAX` covers every build instead of wrapping to a tiny number.
- `updatesUntilDate(info): Date` (midnight UTC, clamped to the largest JS Date).
- `coversBuild(info, buildDays): boolean`: `buildDays <= updatesUntilDays(info)`, the last day is included. Fails
  closed: anything that is not an integer in `0..4294967295` is not covered.
- `entitlement(result: VerifyResult | null | undefined, buildDays): { pro, reason?, updatesUntil? }`. `null` or
  `undefined` is `no-key`; a failed or malformed result is `invalid`; a genuine key outside its window is `pro: false,
  reason: 'updates-expired'` and still reports `updatesUntil` (`YYYY-MM-DD`) so the UI can say when updates ended.
- `buildDaysFromDate(d: Date)`: days since the Unix epoch (UTC); throws `RangeError` for an invalid or pre-1970 date so
  a broken build script fails loudly. `daysToIso(days)`: `YYYY-MM-DD` for any u32 day count.
- Types `Entitlement`, `EntitlementReason`. How apps embed `BUILD_DAYS` (Vite, Next.js, Rust `build.rs`, Gradle) is
  documented in `packages/license/README.md` and `crates/polishot-license/README.md`. Never default `BUILD_DAYS` to 0:
  day 0 is covered by every key.

### `polishot-license` (Rust)

- `LicenseInfo::updates_until_days() -> u32` (saturating) and `covers_build(build_days: u32) -> bool`.
- `pub const UPDATE_WINDOW_DAYS: u32 = 365`.
- `Entitlement { pro: bool, reason: Option<&'static str>, updates_until_days: Option<u32> }` with consts
  `Entitlement::NO_KEY` / `INVALID`, `Entitlement::for_info(&info, build_days)` (for a key you already verified), and
  `REASON_NO_KEY` / `REASON_INVALID` / `REASON_UPDATES_EXPIRED`.
- `entitlement(key: Option<&str>, build_days: u32) -> Entitlement` checks against the production key;
  `entitlement_with_key(key, &public_key, build_days)` takes the key (tests use the test key). `None` or a blank
  string is `no-key`; a key that does not verify is `invalid`.

### Shared vectors (`packages/license/test-vectors.json`)

`cases` is byte-for-byte unchanged (Ed25519 signatures are deterministic, `vectors` regenerates the same output). New
array `entitlementCases`: `{ name, key, buildDays, pro, reason?, updatesUntilDays? }`. `key` is `""` or whitespace when
nothing is activated (not `null`, so every JSON parser reads it as a string). The cases cover a build inside the
window, on the issue day, before the issue day, the last covered day (inclusive), one day after, years after, both
editions, the u32 saturation key (a recent build and `buildDays = 4294967295`), invalid keys (flipped signature,
signed by another key, future version, garbage) and no key (empty, whitespace). Kotlin and Rust consumers read
`cases` as before and may read `entitlementCases` to test their own port.

### `@polishot/editor`: Pro

- `BrandMark = { type: 'text'; text } | { type: 'image'; src }`. `EditorOptions.brandMark?`, `editor.brandMark`
  (getter) and `editor.setBrandMark(mark | null): boolean` (false and cleared when the input is not valid). It is an
  app setting, not part of `EditorDoc`: it never enters undo history or saved documents; the host stores it.
- Drawing rule, one decision point (`markPlan(licensed, mark)`): unless `licensed === true` the default watermark is
  ALWAYS drawn and the brand mark is ignored, however it was set (fail closed); licensed with a valid mark draws the
  mark instead of the watermark; licensed with no mark draws nothing. Text uses the watermark's style, bottom-right at
  the watermark's margin, capped at half the canvas width; a logo is scaled to contain within about two lines of
  watermark text (so it has the same visual weight), bottom-right at the same margin, never wider than 40 percent of
  the canvas. The same `Scene` code renders the canvas and the export, so they match (a test compares the two).
- `sanitizeBrandMark(input, origins?)`: text is whitespace-normalised, control and bidi characters are stripped,
  and it is cut to 40 characters; an image must pass `isSafeImageSrc` (inline raster `data:`, `blob:` or a listed
  origin; no SVG, `file:`, `javascript:` or unlisted remote hosts). Prototype-pollution and inherited properties are
  ignored.
- `exportDoc(doc, image, opts, extras)`: `extras.brandMark` for batch exports. It only takes effect when
  `opts.licensed === true`. `Editor.export` passes the editor's own mark and keeps the earlier rule (`licensed &&
  opts.licensed !== false`).
- `presetLimit(pro) = 3 | Infinity` and `batchLimit(pro) = 5 | Infinity` (constants `FREE_PRESET_LIMIT`,
  `FREE_BATCH_LIMIT`); only the boolean `true` is Pro. The Inspector enforces the preset limit; hosts enforce the
  batch limit.
- `<Inspector>` new props: `pro?` (default `editor.licensed`), `onUpgrade?()` (hosts open pricing) and
  `onBrandMarkChange?(mark | null)` (hosts store the mark). New "Brand mark" section: for Free a locked row with a
  small "Pro" tag (a button when `onUpgrade` is given); for Pro Off / Text / Logo with a text field or a logo picker
  (PNG, JPEG, WebP or GIF under 2 MB). "Saved looks": for Free the Save field is disabled at 3 looks with a quiet
  "Free keeps 3 presets — Pro removes the limit" note, a "n of 3" count and, when `onUpgrade` is given, a
  "See Pro" link. Looks beyond the limit (a lapsed licence) stay usable and deletable.

### `@polishot/editor`: interaction bar (docs/UX-BAR.md)

- Hover preview: `editor.preview(patch)`, `editor.clearPreview()`, `editor.previewing`. A preview renders the patched
  document without recording history, firing `change`, or touching `doc` and exports; any committing action clears it.
  The Inspector previews on pointer hover (mouse and pen) and keyboard focus for the Auto and swatch backgrounds, frame
  chips and saved looks; click commits. Measured: median 0.5 ms per preview on a 4K capture.
- `editor.autoPadding` (what auto-balance suggested). The auto analysis is computed once per loaded image and shared
  by `load`, `rebalance` and `computeAutoBackground` (which used to re-analyse the image on every Inspector render).
- Sliders (`Slider` in the shared UI): a drag is live and one undo step; arrow keys change the value by `nudge`
  units (1 in the label's unit, e.g. 1 percent, 1 px), Shift by 10; a held key is one undo step; double-click resets to
  `reset` (Padding: the auto-balance value; Corners 12; Shadow 50 percent; Angle 160; Blur 30; stroke, text and brush
  sizes: the image-scaled defaults). `Slider` takes optional `nudge` and `reset` props.
- `editor.nudgeSelection(dx, dy, fold?)` and `editor.duplicateSelection()`. Keys (`mapSelectionShortcut`): arrows move
  the selection 1 source-image px, Shift+arrow 10 px (not while a slider, select, button or toolbar has focus, so those
  keep their arrow keys); Ctrl/Cmd+D duplicates (offset about 16 screen px, copy selected, one undo step, a copied
  automatic redaction becomes manual, a copied step takes the next number). A held arrow key folds into one undo step
  through the new `History.amend`.
- Shift while drawing (45 degree lines and arrows, squares and circles) was already implemented; it now also reacts to
  Shift being pressed or released mid-drag without a pointer move.
- Numbered steps renumber: deleting a step renumbers the rest 1..k in their current order, in the same undo step
  (`renumberSteps`). This supersedes clarification 6 of the earlier editor entry ("smallest unused number"): numbers are
  now always contiguous, so the next new step is k+1.
- No flash: after `load` the canvas is hidden until its first frame is complete: the element has a size, background
  images and logos are decoded, the view is fitted and both layers are drawn. A host that loads before it attaches the
  element, or a saved document with an image background, never shows an unstyled or mis-sized frame (600 ms cap so a
  broken URL cannot hide the editor).
- Selection chrome is a 1 px accent outline with small round handles (8 px, round; the dashed outline for steps and
  strokes is now a thin solid line). Tooltips open after 400 ms.
- Performance: on large canvases (longer than 1800 design px) the interactive scene keeps the soft shadow as a bitmap
  at reduced resolution instead of re-blurring a huge rectangle every frame. A 4K padding drag went from about 42 ms to
  about 21 ms of software raster per frame; exports still render the real shadow. The playground exposes
  `window.__polishot.image`, `exportDoc` and `EditorClass` for the end-to-end tests.

### Behaviour changes (existing behaviour that moved)

1. The Text tool stays active after a note is committed (it used to switch to Select and select the new note), as the
   UX bar asks for every drawing tool. Esc or V returns to Select. The matching assertion in `e2e/smoke.spec.ts` was
   updated. Clicking away from an open text field now only commits it (it no longer also starts a new note); empty
   text is discarded.
2. Numbered steps renumber on delete (see above).
3. The Inspector's Padding slider has a finer native step (0.1 percent) and the Angle slider a 1 degree step; arrow keys
   use the nudge unit instead of the native step.

## Desktop backend integration pass (apps/desktop/src-tauri), additive

Nothing in CONTRACTS section 5 was removed or renamed. Everything below is additive, or a stricter check on
input that was already validated. It closes the "what it expects from the backend" list of the preview window
section above.

### Commands the preview already calls, now implemented

- **`plugin:opener|reveal_item_in_dir({ paths })` and `plugin:opener|open_url({ url })`.** Same names and
  arguments as the general-purpose Tauri opener plugin, but implemented by a small in-app plugin
  (`src/opener_plugin.rs`, declared with `tauri_build::InlinedPlugin`), so no dependency was added and the rules
  are narrower: `open_url` accepts only `https://` links to a named host (at least two labels, TLD not numeric,
  no credentials, no whitespace, at most 2048 bytes); `reveal_item_in_dir` accepts 1 to 16 paths, all of which
  must be plain absolute Windows paths to existing png/jpg/jpeg/webp/gif files, and reveals the first. Rules and
  tests: `core/src/opener.rs`. The preview capability grants `opener:allow-reveal-item-in-dir` and
  `opener:allow-open-url` (and `core:window:allow-internal-toggle-maximize` for the title bar's double-click).
- **`export_save` honours the optional header `x-save-path`** (percent-encoded UTF-8, as the preview sends it).
  The file is written exactly there and the written path is returned. The path must be a plain absolute Windows
  path (no `..`, no `\?\` or `\.\`, no `:` streams, no wildcard characters), the file name must already be
  clean (a reserved name such as `con.png` is refused, not renamed) and end in png/jpg/jpeg/webp matching the
  content, and the folder must already exist. An existing file is replaced (the Save As dialog asked), an
  existing folder never. A present but unusable header is an error; the file never lands anywhere else.

### Window and event behaviour

- The `preview` window is created undecorated (`.decorations(false)`): the UI draws its own title bar.
- `capture:ready` is now emitted **before** the preview window is shown (region, window and scroll captures), so
  the window never shows the previous capture for a frame (item 5 of the preview section).
- `qs:incoming` and `qs:pair-code` (responder role) now bring the preview window forward (`qs:received` already did).
  The app lives in the tray with the window hidden, so before this a prompt was invisible and the sender timed out.
- Quick send advertises this PC over mDNS only while a device is paired or the pairing dialog is open
  (docs/QUICKSEND.md section 4); opening the device list alone no longer announces the PC. Browsing is unchanged.
- `shortcut:extra` is no longer emitted (the scroll and GIF shortcuts start their flows directly, see the
  scrolling-capture section). `events.onShortcutExtra` in the preview client is dead and can be removed.

### Limits and stricter validation

- **Scrolling capture height** is capped at `min(16384, 120 000 000 / width)` rows instead of the media crate's
  20 000, so the result can always be reopened from history and sent to the editor (the decoder refuses more
  than 16384 px per side or 120 megapixels). A capture that hits the cap ends normally ("full").
- `settings_set` `saveFolder` additionally refuses device namespaces (`\?\`, `\.\`), `:` in a folder name and
  wildcard characters. Normal drive paths and UNC shares are unaffected.
- `qs_*` device ids are 16 base32 characters; lower case is accepted and normalised to upper case (QUICKSEND.md
  section 3). `qs_send` checks the id and the 50 MB limit before the body is copied, and ignores `x-filename` values
  over 512 bytes (the protocol layer sanitises the rest).

### License and build date

`BUILD_DAYS` (CONTRACTS section 5b) is embedded by `build.rs` from `SOURCE_DATE_EPOCH` or the clock and parsed at
compile time. It never falls back to day 0: an empty, non-numeric, pre-2026-01-01 or post-2100-01-01 value is a
**compile error**, and a malformed `SOURCE_DATE_EPOCH` fails the build script. Without `SOURCE_DATE_EPOCH` the
build script re-runs on every build so a cached build cannot embed an old date. The window maths now comes from
`polishot-license` (`LicenseInfo::updates_until_days`, `covers_build`, `Entitlement`); the desktop copy was
removed. A stored blank key reads as `no-key` (it used to read as `invalid`). The desktop status is asserted
against the shared `entitlementCases` vectors.

### CI

`.github/workflows/desktop.yml` is now only the on-demand Windows installer build plus the capture-latency
measurement (`workflow_dispatch` and `workflow_call`); fmt, clippy, tests and the UI checks are in `ci.yml`.
The latency step runs `-p polishot-desktop-core`, where the ignored test lives.

## Preview window UI, completion pass (apps/desktop/src/preview, src/shared, src/pin), additive

No command, event or payload of CONTRACTS section 5 or of the entries above changed. This records what the preview
now calls, so the backend and the mock stay in step.

### Backend surface the UI now uses

- **Quick send** (all of "Quick send" above): `qs_devices`, `qs_pairing_mode`, `qs_pair_start`, `qs_pair_confirm`,
  `qs_send` (raw PNG body, headers `x-device-id`, `x-filename`), `qs_forget`, `qs_incoming_respond`, and the events
  `qs:devices`, `qs:pair-code`, `qs:incoming`, `qs:received`. Payloads are shape-checked on arrival (device ids are
  alphanumeric, the code must be `NNN NNN`, names lose control and bidirectional characters). The UI never
  auto-confirms a code. The device list is **not** requested at launch unless this PC is known to have paired before
  (webview `localStorage` key `polishot.qs.v1` = `"1"`), because the first `qs_devices` / `qs_pairing_mode` call is what
  starts the listener and shows the Windows Firewall prompt.
- **`capture_start` modes** `scroll` and `gif` (palette actions "Capture a scrolling window" Ctrl+Shift+L and "Record a
  GIF" Ctrl+Shift+G, plus the Settings shortcuts) and the **`gif:saved`** event (toast with "Show in folder").
  `shortcut:extra` is no longer subscribed to.
- **Show in folder** tries `plugin:opener|reveal_item_in_dir` first (any saved image, including a Save As outside the
  save folder), then `reveal_in_folder`, then copies the path.
- **Batch beautify** (Free: 5 images per run, Pro: unlimited, enforced by the host per CONTRACTS 5b) uses only existing
  commands: `open_file` for each chosen image (so its pixels come through `polishot://`), a private `Editor` to apply
  the look and export, `export_save` to write `<name>-polished.<ext>` into the save folder, and `history_delete` to
  remove the temporary capture that `open_file` registered, so a batch leaves the history as it was.

### Behaviour

- **Brand mark** now lives in the shared Inspector's "Brand mark" section (Style tab: `pro`, `onUpgrade`,
  `onBrandMarkChange`); Settings keeps a mirror of it for Pro only. Both write the same remembered value
  (`polishot.brandMark.v1`).
- **Warm paper look** (owner direction): the preview overrides the neutrals of `@polishot/brand/tokens.css` for its
  own window only (cream `#f7f2ea` / `#fffdf9` in light, a warmer near-black in dark), uses dark rounded keycaps and the
  display serif for headings. The brand accent and the Print P mark are unchanged. If the brand package adopts the
  same neutrals, the block at the top of `preview.css` can be deleted.
- **Text layer vs shapes.** The editor's `TextLayer` takes every click while Select has nothing selected, so a shape or
  note drawn over text could not be clicked. The preview hit-tests the document (`lib/annotationHit.ts`) and lets the
  words step aside while the pointer is over an annotation. A real `editor.annotationAt(x, y)` would replace that
  approximation.
- **Pin window**: a small pill shows the opacity and a close button while the pointer is over the pin and for a moment
  when it opens; Up/Down (and `+`/`-`) change the opacity like the wheel.
- **Mock backend** (`?mock=1`, dev only) gained `qs=none|one|two|offline`, `qsdelay`, `qsfail`, `batch=N`, and
  `window.__polishotMock.qs` helpers to play the phone's side. It is not part of a production build.

## Web editor (apps/web/app/editor), host behaviour and the route-scoped CSP

Nothing in CONTRACTS sections 4 or 5b changed. This records what the website host does with the shared editor, so the
other hosts can match it and the website agent knows what the `/editor` route depends on.

- **Free tier, always.** The site has no licence activation, so `new Editor(el, { licensed: false })`: every export carries
  `WATERMARK_TEXT`, the Inspector shows the Brand mark row locked, and `onUpgrade` opens `/pricing` in a **new tab**
  (leaving the page would throw away the work). The web editor opens one image at a time, so `batchLimit` does not apply
  here; a future multi-image mode must use `batchLimit(false)` = 5.
- **Saved looks** (`looks.ts`): `localStorage['polishot.looks.v1']` = JSON array of `{ id, name, settings }`, where
  `settings` is `LookSettings`. Everything read back is rebuilt from known fields and run through `validateDoc` (bad
  frame, colour, SVG background, duplicate or odd ids, prototype keys are dropped); at most 24 entries and 2,000,000
  characters are read. The Free limit (`presetLimit(false)` = 3) is enforced on save as well as in the Inspector. Blocked
  or full storage shows a plain message and the editor keeps working. Looks are style settings only, never images.
- **Keys** (all ignored while typing in a text field; sliders, buttons and checkboxes do not count as text fields):
  Ctrl/Cmd+K command palette (every action with its shortcut), Ctrl+S download, Ctrl+Shift+S share (where the browser
  can), Ctrl+O open another image, Ctrl+C copy the finished image (unless text is selected), 1 to 4 switch the Style,
  Redact, Text and Export panels. The editor package's own keys (tools, nudge, Ctrl+D, undo/redo) are unchanged.
- **CSP.** `/editor` alone gets `worker-src 'self' blob:` and `'wasm-unsafe-eval'` (tesseract.js runs in a blob worker
  built from files in `/ocr`); every other route keeps `worker-src 'none'`. A policy belongs to the *document*, so reaching
  `/editor` through a client-side `<Link>` keeps the previous page's policy and blocks the engine. `csp.ts` handles it: if
  the browser's navigation entry says the document was not `/editor`, the editor reloads itself once (guard:
  `sessionStorage['polishot.editor.reloaded']`, 30 s) before any image is open; if the engine is still blocked later it
  reloads only when nothing has been edited, otherwise it shows "The browser blocked text recognition on this page" with a
  Reload button. Links to `/editor` should still be full page loads (`<a>`), which avoids the reload altogether. The same
  rule works in the other direction: leaving `/editor` through a client-side link keeps its looser policy on the next page
  until a full load; one uniform policy for all routes would remove the whole class of problem.
- **Test hooks.** `[data-testid="editor-studio"]` mirrors `data-padding`, `data-annotations`, `data-steps` (for example
  `1,2`), `data-selected`, `data-tool` and `data-last` (newest annotation in source pixels, for example `arrow:10,20,110,120`).
- **Known gap (packages/editor, not the host).** Exporting a 4K capture rasterises on the main thread inside `toBlob`:
  measured on a fully loaded machine, copy of a 3786 x 2566 export blocks the page for 9 to 12 s (about 4 to 6 s with the
  shadow at 0), against 0.4 to 0.6 s for a plain canvas of the same size. The soft shadow is about half of it; the rest is the
  full-size draw and the PNG encode, none of which is cheap on the main thread. The host paints "Copying" before the work starts; the <300 ms bar of docs/UX-BAR.md needs the export to reuse
  the reduced-resolution shadow it already uses on screen and/or render in a worker with `OffscreenCanvas`.
