/**
 * Dev-only mock of the desktop backend, so the preview UI runs in a plain browser: open
 * `http://127.0.0.1:1420/?mock=1`. It implements the same commands and events as the Rust side, with
 * in-memory state and generated sample images. Imported lazily behind `import.meta.env.DEV`, so it is
 * not part of a production build.
 *
 * URL options:
 *   lic=free|pro|team|expired|invalid   starting licence            (default free)
 *   theme=system|light|dark             starting theme setting      (default system)
 *   capture=0                           start with no capture       (default: one arrives after ~120 ms)
 *   size=4k                             make the capture 3840 x 2400
 *   history=0|N                         history items               (default 9)
 *   backdrop=mica                       pretend Mica is active (a soft wallpaper shows through)
 *   warn=1                              start with a shortcut-conflict warning
 *   clip=empty                          make the clipboard hold no image
 *   delay=ms                            delay before the capture arrives
 *   ocr=none|many                       no recognised text, or eight times as many words
 *   qs=none|one|two|offline             paired phones: none (default), one Pixel, two phones, one that is out of range
 *   qsdelay=ms                          how long a send takes (the phone has to accept)
 *   qsfail=1                            the phone declines every send
 *   batch=N                             how many files the multi-file chooser returns (default 3)
 *
 * Tests and Playwright can reach in through `window.__polishotMock` (emit events, read what was copied).
 */
import type { OcrWord } from '@polishot/redact';
import {
  setTransport,
  setUrlResolver,
  type AppInfo,
  type CaptureMeta,
  type DeviceEntry,
  type HistoryItem,
  type LicenseStatus,
  type Settings,
  type Transport,
} from '../ipc';
import { setNative, type NativeApi } from '../native';
import { makeSample } from './sample';

interface MockLast {
  copiedImageBytes?: number;
  copiedText?: string;
  saved?: { filename: string; bytes: number; savePath?: string; returned: string };
  pinned?: string;
  openedUrl?: string;
  revealed?: string;
  windowCalls: string[];
  captureStarts: string[];
  /** performance.now() of the last window hide and of the capture_start that followed it. */
  hideAt?: number;
  captureStartAt?: number;
  historySaves: Array<{ id: string; bytes: number }>;
  /** Every path export_save returned, in order (batch runs write several). */
  savedPaths: string[];
  sent: Array<{ deviceId: string; filename: string; bytes: number }>;
  forgotten: string[];
  incomingAnswers: Array<{ requestId: number; accept: boolean }>;
  pairingMode: boolean;
  pairAnswers: boolean[];
  /** The device and code each qs_pair_confirm named. */
  pairConfirmArgs: Array<{ peerId: string; sas: string }>;
  /** Each preview_ready call, with the image the editor held when it arrived. */
  previewReady: Array<{ id: string; editorHasImage: boolean; editorImageId: string }>;
}

interface MockApi {
  emit(event: string, payload?: unknown): void;
  last: MockLast;
  state: { settings: Settings; license: LicenseStatus };
  /** Emits a fresh capture:ready (and ocr:ready after a short delay), like a hotkey capture. */
  newCapture(): CaptureMeta;
  /** Quick send helpers: simulate what a phone does. */
  qs: {
    /** A phone starts pairing with this PC (the dialog must be open). */
    pairFromPhone(): void;
    /** A different device starts pairing while a code is already on screen. */
    secondPairCode(): void;
    /** A paired phone offers an image. */
    incoming(requestId?: number): void;
    /** An accepted image arrives. */
    receive(): CaptureMeta;
    devices(): DeviceEntry[];
  };
}

declare global {
  interface Window {
    __polishotMock?: MockApi;
  }
}

const params = () => new URLSearchParams(location.search);
const tick = (ms = 0) => new Promise<void>((r) => setTimeout(r, ms));

const MOCK_FOLDER = 'C:\\Users\\you\\Pictures\\Polishot';

/** Same wording as the Rust validation, so the UI shows realistic errors. */
function validateShortcut(value: string, what: string, allowEmpty: boolean, others: string[]): string | null {
  const t = value.trim();
  if (!t) return allowEmpty ? null : `${what} cannot be empty.`;
  if (!t.toLowerCase().split('+').some((part) => ['ctrl', 'control', 'commandorcontrol', 'cmdorctrl', 'alt', 'option'].includes(part))) return `${what} needs Ctrl or Alt, for example Ctrl+Shift+2.`;
  if (others.some((o) => o && o.toLowerCase() === t.toLowerCase())) return 'Each action needs its own shortcut.';
  if (t.toLowerCase() === 'ctrl+shift+4') return `${t} is already in use by another application. Choose a different shortcut.`;
  return null;
}

function drawThumb(index: number, w: number, h: number): HTMLCanvasElement {
  const palettes: Array<[string, string, string]> = [
    ['#e6efe9', '#2f6f5e', '#ffffff'],
    ['#efe6dc', '#c8471d', '#fffaf5'],
    ['#e3e8f0', '#34425c', '#ffffff'],
    ['#f1ece4', '#4a463d', '#fbfaf7'],
    ['#e8e4f0', '#5a4a7a', '#ffffff'],
    ['#dfe9ee', '#2c5d73', '#ffffff'],
    ['#f0e4e4', '#8a3b3b', '#fffafa'],
    ['#e9ecdc', '#56612a', '#ffffff'],
    ['#ece9e2', '#26241f', '#ffffff'],
  ];
  const [bg, ink, paper] = palettes[index % palettes.length]!;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  const pad = Math.round(w * 0.07);
  ctx.fillStyle = paper;
  ctx.beginPath();
  ctx.roundRect(pad, pad, w - pad * 2, h - pad * 2, 8);
  ctx.fill();
  ctx.fillStyle = ink;
  ctx.fillRect(pad, pad, Math.round(w * 0.2), h - pad * 2);
  const x0 = pad + Math.round(w * 0.24);
  const lines = 4 + (index % 3);
  for (let i = 0; i < lines; i++) {
    ctx.fillStyle = i === 0 ? ink : 'rgba(22,22,21,0.16)';
    const lw = (i === 0 ? 0.32 : 0.5 - ((i * 7 + index * 3) % 5) * 0.05) * w;
    ctx.fillRect(x0, pad + 14 + i * Math.round(h * 0.11), lw, i === 0 ? 8 : 5);
  }
  return c;
}

const toBlobUrl = (canvas: HTMLCanvasElement, type = 'image/png'): Promise<string> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(URL.createObjectURL(b)) : reject(new Error('toBlob failed'))), type);
  });

const HISTORY_SEED: Array<{ excerpt: string; ageMin: number; doc: boolean; w: number; h: number }> = [
  { excerpt: 'Billing Manage your plan, payment method and invoices. Billing email maya.chen@northwind-labs.com', ageMin: 6, doc: true, w: 1280, h: 800 },
  { excerpt: 'Deploy succeeded production api-gateway 42 seconds ago', ageMin: 55, doc: false, w: 1600, h: 900 },
  { excerpt: 'Q4 roadmap review notes owners and dates', ageMin: 60 * 5, doc: true, w: 1024, h: 768 },
  { excerpt: 'Error 502 bad gateway upstream timed out after 30s', ageMin: 60 * 26, doc: false, w: 1280, h: 720 },
  { excerpt: 'Notifications email digest weekly summary toggle', ageMin: 60 * 30, doc: false, w: 800, h: 1000 },
  { excerpt: 'Pull request 218 add retry to the upload worker', ageMin: 60 * 24 * 3, doc: true, w: 1920, h: 1080 },
  { excerpt: 'Invoice 4021 Northwind Labs total 114.00 paid', ageMin: 60 * 24 * 5, doc: false, w: 1280, h: 800 },
  { excerpt: 'Team members invite by email owner admin viewer', ageMin: 60 * 24 * 9, doc: false, w: 1440, h: 900 },
  { excerpt: 'Usage this month requests 1.2M storage 48 GB', ageMin: 60 * 24 * 40, doc: false, w: 1280, h: 800 },
];

function licenseFor(kind: string): LicenseStatus {
  const now = Date.UTC(2026, 10, 9);
  switch (kind) {
    case 'pro':
      return { licensed: true, edition: 'personal', keyId: 'a3f9c20e71b4d5e8', issuedAt: now, updatesUntil: '2027-11-09' };
    case 'team':
      return { licensed: true, edition: 'team', keyId: '7be10c4a98d2f365', issuedAt: now, updatesUntil: '2027-11-09' };
    case 'expired':
      return { licensed: false, edition: 'personal', keyId: 'a3f9c20e71b4d5e8', issuedAt: Date.UTC(2025, 0, 14), reason: 'updates-expired', updatesUntil: '2026-01-14' };
    case 'invalid':
      return { licensed: false, reason: 'invalid' };
    default:
      return { licensed: false, reason: 'no-key' };
  }
}

/** Emulates the window being hidden or shown: the page's visibility state and its event. */
function setPageVisible(visible: boolean): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (visible ? 'visible' : 'hidden') });
  document.dispatchEvent(new Event('visibilitychange'));
}

export async function installMock(): Promise<void> {
  const q = params();
  const last: MockLast = { windowCalls: [], captureStarts: [], historySaves: [], savedPaths: [], sent: [], forgotten: [], incomingAnswers: [], pairingMode: false, pairAnswers: [], pairConfirmArgs: [], previewReady: [] };
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  const emit = (event: string, payload?: unknown) => listeners.get(event)?.forEach((cb) => cb(payload));

  const settings: Settings = {
    shortcut: 'Ctrl+Shift+2',
    scrollShortcut: '',
    gifShortcut: '',
    autostart: false,
    saveFolder: MOCK_FOLDER,
    format: 'png',
    quality: 0.92,
    afterCapture: 'preview',
    theme: (['system', 'light', 'dark'] as const).find((t) => t === q.get('theme')) ?? 'system',
    defaultPreset: 'auto',
    userPresets: '[]',
  };
  let license = licenseFor(q.get('lic') ?? 'free');
  const backdrop: AppInfo['backdrop'] = q.get('backdrop') === 'mica' ? 'mica' : 'solid';
  const warnings = q.get('warn') === '1' ? ['Ctrl+Shift+2 is already in use by another application. Choose a different capture shortcut in Settings.'] : [];

  /* ---- images ---- */
  const scale = q.get('size') === '4k' ? 3 : 1;
  const sample = makeSample(scale);
  const sampleUrl = await toBlobUrl(sample.canvas);
  const captureUrls = new Map<string, string>();
  const thumbUrls = new Map<string, string>();
  const wordsById = new Map<string, OcrWord[]>();
  // ocr=none: recognition finds no text (the empty state of the Text and Redact tabs); ocr=many multiplies the words, like a text-heavy screenshot.
  const ocrMode = q.get('ocr');
  const mockWords: OcrWord[] =
    ocrMode === 'none'
      ? []
      : ocrMode === 'many'
        ? Array.from({ length: 8 }, (_, k) => sample.words.map((w) => ({ ...w, box: { ...w.box, y: w.box.y + (k % 2) * 2 } }))).flat()
        : sample.words;

  const newMeta = (source: CaptureMeta['source']): CaptureMeta => {
    const id = `mock${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
    captureUrls.set(id, sampleUrl);
    wordsById.set(id, mockWords);
    return { id, width: sample.width, height: sample.height, createdAt: Date.now(), source };
  };

  /* ---- history ---- */
  const wantHistory = Math.max(0, Math.min(HISTORY_SEED.length, Number(q.get('history') ?? HISTORY_SEED.length)));
  const history: Array<HistoryItem & { docJson: string | null }> = [];
  for (let i = 0; i < wantHistory; i++) {
    const seed = HISTORY_SEED[i]!;
    const id = `hist${i}x${(i * 7919).toString(36)}`;
    history.push({
      id,
      createdAt: Date.now() - seed.ageMin * 60_000,
      width: seed.w,
      height: seed.h,
      excerpt: seed.excerpt,
      hasDoc: seed.doc,
      docJson: null,
    });
    captureUrls.set(id, sampleUrl);
    wordsById.set(id, mockWords);
    const tw = 360;
    thumbUrls.set(id, await toBlobUrl(drawThumb(i, tw, Math.round((tw * seed.h) / seed.w))));
  }

  setUrlResolver({
    capture: (id) => captureUrls.get(id) ?? sampleUrl,
    history: (id) => captureUrls.get(id) ?? sampleUrl,
    thumb: (id) => thumbUrls.get(id) ?? captureUrls.get(id) ?? sampleUrl,
  });

  const emitCapture = (source: CaptureMeta['source']): CaptureMeta => {
    const meta = newMeta(source);
    history.unshift({ id: meta.id, createdAt: meta.createdAt, width: meta.width, height: meta.height, excerpt: '', hasDoc: false, docJson: null });
    thumbUrls.set(meta.id, sampleUrl);
    setPageVisible(true); // a capture brings the window back
    emit('capture:ready', meta);
    // Recognition finishes a little after the image, as on the real backend.
    setTimeout(() => emit('ocr:ready', { id: meta.id, words: mockWords }), 380);
    return meta;
  };

  /* ---- quick send ---- */
  const PIXEL: DeviceEntry = { id: 'PIXELEIGHT0000AA', name: 'Pixel 8', paired: true, online: true };
  const GALAXY: DeviceEntry = { id: 'GALAXYSTWENTYFOU', name: 'Galaxy S24', paired: true, online: true };
  const NEARBY: DeviceEntry = { id: 'MAYASPHONE00000B', name: 'Maya’s Pixel', paired: false, online: true };
  const qsMode = q.get('qs') ?? 'none';
  let pairedDevices: DeviceEntry[] = qsMode === 'one' ? [PIXEL] : qsMode === 'two' ? [PIXEL, GALAXY] : qsMode === 'offline' ? [{ ...PIXEL, online: false }] : [];
  let pendingPair: DeviceEntry | null = null;
  const pendingSas = '042 917';
  const OTHER: DeviceEntry = { id: 'OTHERPHONE00000C', name: 'Unknown phone', paired: false, online: true };
  const qsList = (): DeviceEntry[] => [...pairedDevices, ...(pairedDevices.some((d) => d.id === NEARBY.id) ? [] : [NEARBY])];
  const pairCodeFor = (dev: DeviceEntry, role: 'initiator' | 'responder') => ({ sas: '042 917', peerName: dev.name, peerId: dev.id, role });

  /* ---- commands ---- */
  const handle = async (cmd: string, args: unknown, options?: { headers?: Record<string, string> }): Promise<unknown> => {
    const a = (args ?? {}) as Record<string, unknown>;
    switch (cmd) {
      case 'app_info':
        return { version: '0.1.0-mock', backdrop, warnings } satisfies AppInfo;
      case 'settings_get':
        return { ...settings };
      case 'settings_set': {
        const patch = (a.patch ?? {}) as Partial<Settings>;
        const next = { ...settings, ...patch };
        const err =
          validateShortcut(next.shortcut, 'Capture shortcut', false, [next.scrollShortcut, next.gifShortcut]) ??
          validateShortcut(next.scrollShortcut, 'Scrolling capture shortcut', true, [next.shortcut, next.gifShortcut]) ??
          validateShortcut(next.gifShortcut, 'GIF shortcut', true, [next.shortcut, next.scrollShortcut]);
        if (err) throw err;
        if (typeof next.quality === 'number' && !(next.quality >= 0.1 && next.quality <= 1)) throw 'Quality must be between 0.1 and 1.';
        Object.assign(settings, next);
        emit('settings:changed', { ...settings });
        return { ...settings };
      }
      case 'license_status':
        return license;
      case 'license_activate': {
        const key = String(a.key ?? '').trim();
        if (!/^PSHOT-/i.test(key)) throw 'That does not look like a license key. Check for typos and paste the whole key.';
        if (/BAD/i.test(key)) throw 'That license key could not be verified. Check it for typos.';
        license = licenseFor(/EXPIRED/i.test(key) ? 'expired' : /TEAM/i.test(key) ? 'team' : 'pro');
        return license;
      }
      case 'license_deactivate':
        license = licenseFor('free');
        return license;
      case 'ocr_recognize': {
        await tick(220);
        return wordsById.get(String(a.id)) ?? [];
      }
      case 'open_file':
        return emitless(newMeta('file'));
      case 'paste_clipboard_image':
        return q.get('clip') === 'empty' ? null : emitless(newMeta('clipboard'));
      case 'export_save': {
        const bytes = args as Uint8Array;
        const filename = options?.headers?.['x-filename'] ?? 'export.png';
        const encoded = options?.headers?.['x-save-path'];
        const savePath = encoded ? decodeURIComponent(encoded) : undefined;
        const returned = savePath ?? `${settings.saveFolder}\\${filename}`;
        last.saved = { filename, bytes: bytes?.byteLength ?? 0, savePath, returned };
        last.savedPaths.push(returned);
        return returned;
      }
      case 'copy_image':
        last.copiedImageBytes = (args as Uint8Array)?.byteLength ?? 0;
        return null;
      case 'copy_text':
        last.copiedText = String(a.text ?? '');
        return null;
      case 'share_file':
        return null;
      case 'history_list': {
        const query = typeof a.query === 'string' ? a.query.toLowerCase() : '';
        const limit = Number(a.limit ?? 50);
        const offset = Number(a.offset ?? 0);
        const rows = history.filter((h) => !query || h.excerpt.toLowerCase().includes(query));
        return rows.slice(offset, offset + limit).map(({ docJson: _doc, ...item }) => item);
      }
      case 'history_get': {
        const row = history.find((h) => h.id === a.id);
        if (!row) throw 'That history item no longer exists.';
        const meta: CaptureMeta = { id: row.id, width: row.width, height: row.height, createdAt: row.createdAt, source: 'region' };
        return { meta, docJson: row.docJson };
      }
      case 'history_save': {
        const row = history.find((h) => h.id === a.id);
        const json = String(a.docJson ?? '');
        last.historySaves.push({ id: String(a.id), bytes: json.length });
        if (row) {
          row.docJson = json;
          row.hasDoc = true;
        }
        return null;
      }
      case 'history_delete': {
        const i = history.findIndex((h) => h.id === a.id);
        if (i >= 0) history.splice(i, 1);
        return null;
      }
      case 'history_clear':
        history.length = 0;
        return null;
      case 'pin_open':
        last.pinned = String(a.id);
        return null;
      case 'capture_start':
        last.captureStarts.push(String(a.mode));
        last.captureStartAt = performance.now();
        if (a.mode === 'gif') {
          const name = 'Recording 2026-11-11 09.30.12.gif';
          setTimeout(() => emit('gif:saved', { path: `${settings.saveFolder}\\${name}`, name, bytes: 2_400_000 }), 450);
        } else {
          setTimeout(() => emitCapture(a.mode === 'scroll' ? 'scroll' : 'region'), 450);
        }
        return null;
      case 'plugin:opener|open_url':
        last.openedUrl = String(a.url);
        return null;
      case 'plugin:opener|reveal_item_in_dir':
        last.revealed = String((a.paths as string[])?.[0] ?? '');
        return null;
      case 'preview_ready': {
        const ed = (window as unknown as { __polishotApp?: { editor?: { hasImage: boolean; doc: { image: { id: string } } } } }).__polishotApp?.editor;
        last.previewReady.push({ id: String(a.id), editorHasImage: ed?.hasImage === true, editorImageId: ed?.doc.image.id ?? '' });
        return null;
      }
      case 'reveal_in_folder':
        last.revealed = String(a.path ?? '');
        return null;
      case 'qs_devices':
        return qsList();
      case 'qs_pairing_mode':
        last.pairingMode = a.open === true;
        return null;
      case 'qs_pair_start': {
        const dev = qsList().find((d) => d.id === a.deviceId && !d.paired);
        if (!dev) throw 'That device is not nearby any more. Open Polishot on it and try again.';
        pendingPair = dev;
        const code = pairCodeFor(dev, 'initiator');
        setTimeout(() => emit('qs:pair-code', code), 0);
        return code;
      }
      case 'qs_pair_confirm': {
        last.pairAnswers.push(a.accepted === true);
        last.pairConfirmArgs.push({ peerId: String(a.peerId ?? ''), sas: String(a.sas ?? '') });
        const dev = pendingPair;
        // Like the backend: an answer only counts for the pairing it is waiting on, named by device and code.
        if (dev && (a.peerId !== dev.id || a.sas !== pendingSas)) throw 'That answer is for a different pairing. Start again.';
        pendingPair = null;
        if (!dev) throw 'There is no pairing to confirm. Start again.';
        if (a.accepted !== true) throw 'The codes did not match.';
        await tick(Number(q.get('confirmdelay') ?? 0));
        const paired: DeviceEntry = { ...dev, paired: true, online: true };
        pairedDevices = [...pairedDevices, paired];
        setTimeout(() => emit('qs:devices'), 0);
        return paired;
      }
      case 'qs_send': {
        const deviceId = options?.headers?.['x-device-id'] ?? '';
        const filename = options?.headers?.['x-filename'] ?? 'screenshot.png';
        const dev = pairedDevices.find((d) => d.id === deviceId);
        if (!dev) throw 'That device is not paired. Pair it first.';
        if (!dev.online) throw `${dev.name} is not nearby. Open Polishot on it, on the same Wi-Fi as this PC.`;
        await tick(Number(q.get('qsdelay') ?? 0));
        if (q.get('qsfail') === '1') throw `${dev.name} declined the image.`;
        last.sent.push({ deviceId, filename, bytes: (args as Uint8Array)?.byteLength ?? 0 });
        return null;
      }
      case 'qs_forget':
        last.forgotten.push(String(a.deviceId));
        pairedDevices = pairedDevices.filter((d) => d.id !== a.deviceId);
        setTimeout(() => emit('qs:devices'), 0);
        return null;
      case 'qs_incoming_respond':
        last.incomingAnswers.push({ requestId: Number(a.requestId), accept: a.accept === true });
        return null;
      default:
        throw `command ${cmd} not found`;
    }
  };
  const emitless = (m: CaptureMeta): CaptureMeta => {
    history.unshift({ id: m.id, createdAt: m.createdAt, width: m.width, height: m.height, excerpt: '', hasDoc: false, docJson: null });
    thumbUrls.set(m.id, sampleUrl);
    setTimeout(() => emit('ocr:ready', { id: m.id, words: mockWords }), 380);
    return m;
  };

  let autoCaptured = false;
  const transport: Transport = {
    async invoke(cmd, args, options) {
      await tick(8); // a real IPC round trip is never instantaneous
      return handle(cmd, args, options);
    },
    async listen(event, handler) {
      // The first capture arrives once the app is actually listening for it (module loading in a
      // dev server can take longer than any fixed timeout).
      if (event === 'capture:ready' && !autoCaptured && q.get('capture') !== '0') {
        autoCaptured = true;
        setTimeout(() => emitCapture('region'), Number(q.get('delay') ?? 120));
      }
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(handler);
      return () => set.delete(handler);
    },
  };
  setTransport(transport);

  const native: NativeApi = {
    minimize: async () => void last.windowCalls.push('minimize'),
    toggleMaximize: async () => void last.windowCalls.push('toggleMaximize'),
    hide: async () => {
      last.windowCalls.push('hide');
      last.hideAt = performance.now();
      // Like the webview: the page reports hidden a frame later, and visible again when the window is shown.
      setTimeout(() => setPageVisible(false), 16);
    },
    isMaximized: async () => false,
    onResized: async () => () => undefined,
    pickImage: async () => 'C:\\Users\\you\\Pictures\\screenshot.png',
    pickImages: async () =>
      Array.from({ length: Math.max(0, Math.min(40, Number(q.get('batch') ?? 3))) }, (_, i) => `C:\\Users\\you\\Pictures\\Screenshots\\shot-${i + 1}.png`),
    pickFolder: async () => 'D:\\Screenshots',
    pickSavePath: async ({ defaultPath }) => defaultPath,
  };
  setNative(native);

  if (backdrop === 'mica') {
    // A soft wallpaper behind a transparent page, to judge the translucent surfaces.
    const style = document.createElement('style');
    style.textContent = `
      html[data-mock-mica] { background: linear-gradient(135deg, #d8d2c6 0%, #bfcad3 55%, #d4c4b4 100%); }
      html[data-mock-mica][data-theme='dark'] { background: linear-gradient(135deg, #1b1d22 0%, #232a33 55%, #2a2420 100%); }
      @media (prefers-color-scheme: dark) { html[data-mock-mica]:not([data-theme='light']) { background: linear-gradient(135deg, #1b1d22 0%, #232a33 55%, #2a2420 100%); } }`;
    document.head.appendChild(style);
    document.documentElement.dataset.mockMica = '';
  }

  window.__polishotMock = {
    emit,
    last,
    state: {
      get settings() {
        return settings;
      },
      get license() {
        return license;
      },
    },
    newCapture: () => emitCapture('region'),
    qs: {
      pairFromPhone: () => {
        pendingPair = NEARBY;
        emit('qs:pair-code', pairCodeFor(NEARBY, 'responder'));
      },
      secondPairCode: () => emit('qs:pair-code', { sas: '731 204', peerName: OTHER.name, peerId: OTHER.id, role: 'responder' }),
      incoming: (requestId = 7) =>
        emit('qs:incoming', { requestId, peerName: 'Pixel 8', name: 'screenshot.png', mime: 'image/png', size: 1_300_000 }),
      receive: () => {
        const meta = emitless(newMeta('file'));
        setPageVisible(true);
        emit('qs:received', { meta, peerName: 'Pixel 8' });
        return meta;
      },
      devices: () => qsList(),
    },
  };
}
