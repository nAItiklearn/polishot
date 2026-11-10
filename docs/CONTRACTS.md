# Polishot — Shared Contracts

Every workstream must follow this file. If you need to change a contract, write the change in
`docs/CONTRACT-CHANGES.md` and explain why. Do not silently change an interface someone else consumes.

## 0. Repo conventions (all agents)

- Monorepo root: `D:\polishot`. Package manager: pnpm 12 workspace (`pnpm-workspace.yaml`).
- **Pin exact versions** (`.npmrc` has `save-exact=true`; Cargo uses `=x.y.z`). No `^` or `~`.
  Do not add a dependency if a few lines of code do the job.
- JS/TS packages are consumed **as TypeScript source**: `"exports": { ".": "./src/index.ts" }`.
  No build step for packages. Next.js uses `transpilePackages`; Vite consumes TS directly.
- TypeScript: extend `../../tsconfig.base.json` (strict, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`).
- Tests: Vitest 5.1.0 (from root devDependencies). Each package has `"test": "vitest run"` and
  `"typecheck": "tsc -p tsconfig.json"`. Never skip, `.only`, or weaken a test to make it pass.
- Installing deps: edit the package's `package.json` with an exact version, then run `pnpm install`
  from the repo root. Several agents work concurrently: if install fails with a lock/EBUSY/EPERM error,
  wait 20–30 s and retry. **Never delete `pnpm-lock.yaml` or `node_modules`.**
- Look up current versions with `pnpm view <pkg> version` before pinning.
- **GateGuard hook:** a hook blocks the first Write to each new file path until you state, in plain
  text, (1) who imports/calls the file, (2) that no existing file serves the same purpose, (3) any data
  schema it reads/writes, (4) the user's instruction. The user's instruction is:
  *"Build Polishot, a premium, clean, secure beautiful-screenshot app for Windows and Android plus a
  marketing website; keep the UI absolute premium and clean; everything must work smoothly."*
  Efficient pattern: state the facts once for a batch, send tiny placeholder writes (content `.`) for
  all new paths in the batch, then write the real content. Retries after the first block succeed.
- Brand: product name lives only in `packages/brand/src/index.ts` (`APP_NAME`). Import it; never
  hard-code "Polishot" in TS. Native files that must repeat it: `apps/desktop/src-tauri/tauri.conf.json`
  (`"productName": "Polishot"`), `apps/android/app/src/main/java/app/polishot/Brand.kt`.
- Design tokens: `@polishot/brand/tokens.css` (CSS variables `--ps-*`, light + dark +
  `prefers-reduced-motion`). Use these variables; do not invent new colours.
- Design rules: warm-neutral surfaces, one accent (Persimmon, `--ps-accent`), 8px grid, radii 6/10/14,
  two shadow levels, 150–200 ms ease `cubic-bezier(0.2,0,0,1)`. No purple/blue gradients, no emoji,
  no icon-card grids, no filler copy. Icons: `lucide-react` (pinned) only, 16px/1.5 stroke in UI.
  Fonts: headings *Instrument Serif*; UI *Geist Sans*; shortcuts/code *Geist Mono*.
- Security: no `eval`/`new Function`, no `dangerouslySetInnerHTML` with untrusted data, no remote
  scripts, strict CSP, validate all IPC input on the receiving side, never log OCR text or images.

## 1. `@polishot/brand` (done)
`APP_NAME, APP_SLUG, APP_ID, WATERMARK_TEXT, SITE_URL, palette, motion, radius, space(n)`; `tokens.css`.

## 2. `@polishot/redact` (done — `packages/redact`)
```ts
interface Box { x: number; y: number; w: number; h: number }            // image pixels
interface OcrWord { text: string; box: Box; line?: number }              // line = reading-order index
type DetectionKind = 'email' | 'card' | 'ipv4' | 'ipv6' | 'secret';
interface Match { kind; label: string; start; end; value: string; confidence: number }
interface Detection extends Match { id: string; boxes: Box[] }
findMatches(text: string): Match[]
detect(words: OcrWord[], opts?: { kinds?: DetectionKind[]; pad?: number }): Detection[]
groupLines(words: OcrWord[]): OcrWord[][]
```
All OCR producers (Windows.Media.Ocr, ML Kit, tesseract.js) must emit `OcrWord[]` in **source image
pixel coordinates** with `line` set.

## 3. `@polishot/license` + Rust crate `crates/polishot-license`
Key binary layout (30-byte payload, then 64-byte Ed25519 signature over the payload):
| bytes | field |
|---|---|
| 0 | version = 1 |
| 1 | edition: 1 = personal, 2 = team |
| 2–5 | issuedAt: days since Unix epoch, u32 big-endian |
| 6–13 | keyId: 8 random bytes |
| 14–29 | licenseeHash: first 16 bytes of SHA-256(lowercase(trim(email))) |

Text form: `PSHOT-` + Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, no padding) of
`payload‖signature`, grouped in 6-char groups joined by `-`. Decoding: case-insensitive, ignores
whitespace and `-`, maps `O→0`, `I/L→1`, rejects `U`.

TS API (`packages/license/src/index.ts`):
```ts
export const PUBLIC_KEY_HEX: string;   // equals contents of packages/license/public-key.hex
type Edition = 'personal' | 'team';
interface LicenseInfo { version: 1; edition: Edition; issuedAt: Date; keyId: string; licenseeHash: string }
type VerifyResult = { valid: true; info: LicenseInfo } | { valid: false; reason: 'format' | 'length' | 'version' | 'signature' };
verifyLicense(key: string, publicKeyHex?: string): Promise<VerifyResult>
licenseeHash(email: string): Promise<string>                 // 32 hex chars
encodeKey(payload: Uint8Array, signature: Uint8Array): string
decodeKey(key: string): { payload: Uint8Array; signature: Uint8Array } | null
```
Rust crate `crates/polishot-license` (`verify(key: &str, public_key: &[u8; 32]) -> Result<LicenseInfo, LicenseError>`),
embedding the prod key via `include_str!` of `packages/license/public-key.hex`.
Shared vectors: `packages/license/test-vectors.json` =
`{ "publicKeyHex": "...", "cases": [ { "name", "key", "valid", "reason"?, "edition"?, "issuedDays"?, "keyIdHex"?, "licenseeHash"? } ] }`
generated with a **test-only** keypair. TS, Rust and Kotlin tests must all pass these vectors.
Private keys live only in `tools/license-keygen/keys/` (gitignored).

## 4. `@polishot/editor` (`packages/editor`)
Konva-based editor, host-agnostic. Peer deps: `react`, `react-dom`, `konva`. Two entry points:
`@polishot/editor` (core, no React) and `@polishot/editor/react` (shared React UI). Styling for the
shared UI: plain CSS `@polishot/editor/editor.css`, class prefix `pe-`, only `--ps-*` tokens.
No Tailwind inside this package.

```ts
type PresetId = 'auto' | 'x' | 'linkedin' | 'ig-square' | 'ig-story' | 'youtube' | 'custom';
type FrameId = 'none' | 'browser-light' | 'browser-dark' | 'window' | 'phone' | 'laptop';
type Background =
  | { type: 'auto'; color?: string; stops?: [string, string] }   // resolved from edge colours
  | { type: 'solid'; color: string }
  | { type: 'gradient'; stops: [string, string]; angle: number }
  | { type: 'image'; src: string; blur: number }                 // data: or host URL
  | { type: 'none' };
type Tool = 'select' | 'arrow' | 'rect' | 'ellipse' | 'line' | 'text' | 'blur' | 'step' | 'redact-brush';
type Annotation =                                                  // all coords in SOURCE IMAGE pixels
  | { id; type: 'arrow' | 'line'; points: [number, number, number, number]; color; strokeWidth }
  | { id; type: 'rect' | 'ellipse'; x; y; w; h; color; strokeWidth; fill?: boolean }
  | { id; type: 'text'; x; y; text: string; fontSize; color }
  | { id; type: 'step'; x; y; n: number; color }
  | { id; type: 'blur'; x; y; w; h; mode: 'blur' | 'pixelate' | 'bar'; source: 'manual' | 'auto'; kind?: DetectionKind }
  | { id; type: 'redact-brush'; points: number[]; size: number; mode: 'blur' | 'bar' };
interface EditorDoc {
  version: 1;
  image: { id: string; width: number; height: number };
  crop: Box | null;           // auto-balance trim of uniform borders
  padding: number;            // 0..0.3, fraction of max(content w,h)
  background: Background;
  radius: number;             // px on content corners
  shadow: number;             // 0..1
  frame: FrameId;
  preset: PresetId;
  custom?: { width: number; height: number };
  annotations: Annotation[];
}
interface ImageSource { id: string; width: number; height: number; element: CanvasImageSource }
interface ExportOptions { format: 'png' | 'jpeg' | 'webp'; quality: number /*0..1*/; scale: 1 | 2 | 3; licensed: boolean }

createDoc(image: { id; width; height }): EditorDoc
autoBalance(pixels: ImageDataLike): { crop: Box | null; padding: number }
autoBackground(pixels: ImageDataLike): Background            // { type:'auto', color, stops }
computeLayout(doc: EditorDoc): { width; height; content: { x; y; w; h; scale } }
PRESETS: Record<PresetId, { label: string; width?: number; height?: number }>
exportDoc(doc, image: ImageSource, opts: ExportOptions): Promise<Blob>   // standalone (batch)
redactionsFromDetections(dets: Detection[], mode: 'blur' | 'bar'): Annotation[]

class Editor {
  constructor(container: HTMLElement, opts: { licensed: boolean });
  load(image: ImageSource, doc?: EditorDoc): void;    // runs autoBalance + autoBackground for new docs
  get doc(): EditorDoc;
  update(patch: Partial<EditorDoc> | ((d: EditorDoc) => EditorDoc)): void;  // one undo step
  setTool(t: Tool): void; get tool(): Tool;
  setStyle(s: { color?: string; strokeWidth?: number; fontSize?: number }): void;
  undo(): void; redo(): void; canUndo(): boolean; canRedo(): boolean;
  applyDetections(dets: Detection[], mode: 'blur' | 'bar'): void;
  deleteSelection(): void;
  imageRectToScreen(b: Box): Box;     // for OCR text overlay positioning (CSS px relative to container)
  export(opts: ExportOptions): Promise<Blob>;
  setLicensed(v: boolean): void;
  on(ev: 'change' | 'select' | 'tool', cb: () => void): () => void;   // returns unsubscribe
  destroy(): void;
}
```
Keyboard (when editor focused): V select, A arrow, R rect, E ellipse, L line, T text, B blur,
N step, P redact brush, Delete/Backspace delete, Esc deselect/select tool, Ctrl+Z undo,
Ctrl+Shift+Z / Ctrl+Y redo. Watermark: `WATERMARK_TEXT`, bottom-right, drawn only when `licensed === false`.

Shared React UI (`@polishot/editor/react`): `<EditorCanvas editor>`, `<Toolbar editor>`,
`<Inspector editor presets>` (background, padding, radius, shadow, frame, preset/aspect, user presets
via `onSavePreset/loadPresets` props), `<RedactPanel editor words onScan>`, `<TextLayer editor words>`
(transparent selectable DOM text over the canvas; Ctrl+C copies), `<ExportPanel editor onExport>`.
Hosts supply persistence via props/callbacks; the UI never touches storage or the network.

## 5. Desktop IPC (Tauri 2) — `apps/desktop`
Window labels: `preview` (main editor, 1040×680, hidden at start, reused), `overlay-<n>` (one per
monitor, fullscreen, transparent, always-on-top, pre-created hidden), `pin-<id>`.
Custom protocol `polishot://` (in webview use `http://polishot.localhost/...` on Windows):
`/capture/<id>` (full image), `/frame/<monitor>` (frozen monitor frame), `/history/<id>`,
`/thumb/<id>`. Content-Type correct; ids validated `^[A-Za-z0-9_-]{1,64}$`.

```ts
type CaptureMeta = { id: string; width: number; height: number; createdAt: number; source: 'region' | 'window' | 'file' | 'clipboard' | 'scroll' };
type WindowInfo = { hwnd: number; title: string; app: string; rect: Box; monitor: number };
// overlay
invoke('overlay_info') -> { monitor: number; scale: number; bounds: Box; windows: WindowInfo[] }
invoke('capture_commit', { req: { kind: 'region'; monitor: number; rect: Box } | { kind: 'window'; hwnd: number } }) -> CaptureMeta
invoke('capture_cancel') -> void
// preview
invoke('ocr_recognize', { id }) -> OcrWord[]
invoke('open_file', { path }) -> CaptureMeta           // png/jpg/webp/bmp, size-capped
invoke('paste_clipboard_image') -> CaptureMeta | null
invoke('export_save', bytes: Uint8Array, { headers: { 'x-filename': string } }) -> string  // returns saved path
invoke('copy_image', bytes: Uint8Array) -> void        // PNG bytes to clipboard
invoke('copy_text', { text }) -> void
invoke('share_file', { path }) -> void                  // Windows Share UI, best-effort
invoke('history_list', { query?: string; limit: number; offset: number }) -> HistoryItem[]
invoke('history_save', { id, docJson: string }) -> void
invoke('history_delete', { id }) -> void
invoke('history_clear') -> void
invoke('settings_get') -> Settings
invoke('settings_set', { patch: Partial<Settings> }) -> Settings   // re-registers shortcuts
invoke('license_status') -> { licensed: boolean; edition?: 'personal' | 'team'; keyId?: string; issuedAt?: number }
invoke('license_activate', { key }) -> LicenseStatus   // error string on failure
invoke('license_deactivate') -> LicenseStatus
invoke('pin_open', { id }) -> void
invoke('capture_start', { mode: 'region' | 'window' }) -> void     // same as the hotkey
type HistoryItem = { id: string; createdAt: number; width: number; height: number; excerpt: string; hasDoc: boolean };
type Settings = { shortcut: string; scrollShortcut: string; gifShortcut: string; autostart: boolean;
  saveFolder: string; format: 'png' | 'jpeg' | 'webp'; quality: number; afterCapture: 'preview' | 'copy';
  theme: 'system' | 'light' | 'dark'; defaultPreset: string; userPresets: string /* JSON */ };
// events emitted by Rust
'capture:ready' (CaptureMeta)  → preview window loads it
'ocr:ready' ({ id, words: OcrWord[] })
'navigate' ('history' | 'settings' | 'license')
```

## 5b. Pricing & entitlements (owner decision, 2026-11-10)
- **Free**: every capture/edit/redact/OCR/export feature, small watermark on exports, up to **3** saved
  user presets, batch beautify up to **5** images per run.
- **Pro — $11 one-time** (constant `LICENSE_PRICE` in `apps/web/lib/site.ts`):
  no watermark · custom brand mark (your own logo or text instead of ours) · unlimited saved presets ·
  unlimited batch beautify · **1 year of updates** included.
- **Update window**: a key covers every app version whose build date is ≤ `issuedDays + 365`.
  Versions built later keep working but behave as Free, showing: "Your license includes updates
  released until <date>. This version came out later." The last covered version stays Pro forever.
  - TS: `updatesUntilDays(info) = issuedDays + 365`, `coversBuild(info, buildDays): boolean`.
  - Rust: `LicenseInfo::updates_until_days()`, `covers_build(build_days: u32) -> bool`.
  - Each app embeds `BUILD_DAYS` (days since epoch) at build time.
- **Entitlement object** passed to the editor/UI:
  `{ pro: boolean; reason?: 'no-key' | 'invalid' | 'updates-expired'; updatesUntil?: string /*ISO date*/ }`.
  `Editor` option `licensed` = `pro`. Pro-only editor feature: `brandMark: { type: 'text'; text: string } | { type: 'image'; src: string } | null`
  drawn instead of the default watermark when `pro` is true.

## 6. Android ↔ WebView editor bridge
Editor host: `apps/android/editor-host` (Vite + React app using `@polishot/editor/react`), built into
`apps/android/app/src/main/assets/editor/`. Loaded via `WebViewAssetLoader` at
`https://appassets.androidplatform.net/assets/editor/index.html`; captures served at
`https://appassets.androidplatform.net/capture/<id>.png`. No `file://` access, JS bridge only on that origin.
- Android → JS: `window.polishot.load({ id, imageUrl, width, height, licensed, theme, words?: OcrWord[], docJson?: string })`,
  `window.polishot.setWords(words)`, `window.polishot.setLicensed(bool)`.
- JS → Android (`@JavascriptInterface` object `PolishotAndroid`): `ready()`, `requestOcr(id)`,
  `saveImage(base64, mime, filename)`, `shareImage(base64, mime)`, `copyImage(base64)`,
  `copyText(text)`, `saveDoc(id, docJson)`, `quickSend(base64)`, `close()`. All strings validated natively.
