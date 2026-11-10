// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The real Tauri API needs the webview's IPC bridge; the client is tested against mocks of the two
// modules it imports.
const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listenMock(...args) }));

import {
  IpcError,
  blobToBytes,
  captureUrl,
  errorMessage,
  events,
  ipc,
  isCaptureMeta,
  isValidId,
  sanitizeWords,
  setTransport,
  setUrlResolver,
  thumbUrl,
  type CaptureMeta,
} from './ipc';

const META: CaptureMeta = { id: 'abc_123-XYZ', width: 1280, height: 800, createdAt: 1_760_000_000_000, source: 'region' };

beforeEach(() => {
  setTransport(null);
  setUrlResolver(null);
  invokeMock.mockReset();
  listenMock.mockReset();
});

afterEach(() => {
  setTransport(null);
});

describe('commands: names and argument shapes match CONTRACTS section 5', () => {
  it('passes plain arguments as objects', async () => {
    invokeMock.mockResolvedValue(undefined);
    await ipc.copyText('hello');
    await ipc.shareFile('C:\\x.png');
    await ipc.historySave('abc', '{"version":1}');
    await ipc.historyDelete('abc');
    await ipc.historyClear();
    await ipc.pinOpen('abc');
    await ipc.captureStart('window');
    expect(invokeMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['copy_text', { text: 'hello' }],
      ['share_file', { path: 'C:\\x.png' }],
      ['history_save', { id: 'abc', docJson: '{"version":1}' }],
      ['history_delete', { id: 'abc' }],
      ['history_clear', undefined],
      ['pin_open', { id: 'abc' }],
      ['capture_start', { mode: 'window' }],
    ]);
  });

  it('sends image bytes as the raw request body, with the file name in a header', async () => {
    invokeMock.mockResolvedValue('C:\\Shots\\polishot-1.png');
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const path = await ipc.exportSave(bytes, 'polishot-1.png');
    expect(path).toBe('C:\\Shots\\polishot-1.png');
    const [cmd, body, options] = invokeMock.mock.calls[0]!;
    expect(cmd).toBe('export_save');
    expect(body).toBe(bytes);
    expect(options).toEqual({ headers: { 'x-filename': 'polishot-1.png' } });

    await ipc.copyImage(bytes);
    expect(invokeMock.mock.calls[1]![0]).toBe('copy_image');
    expect(invokeMock.mock.calls[1]![1]).toBe(bytes);
  });

  it('keeps header values ASCII and percent-encodes a Save As destination', async () => {
    invokeMock.mockResolvedValue('x');
    await ipc.exportSave(new Uint8Array([1]), 'schön.png', { savePath: 'D:\\Bilder\\schön.png' });
    const options = invokeMock.mock.calls[0]![2] as { headers: Record<string, string> };
    expect(options.headers['x-filename']).toBe('sch_n.png');
    expect(options.headers['x-save-path']).toBe(encodeURIComponent('D:\\Bilder\\schön.png'));
  });

  it('settings_set sends a patch and returns the full settings', async () => {
    const settings = { shortcut: 'Ctrl+Shift+2' };
    invokeMock.mockResolvedValue(settings);
    await expect(ipc.settingsSet({ shortcut: 'Ctrl+Shift+2' })).resolves.toBe(settings);
    expect(invokeMock.mock.calls[0]![0]).toBe('settings_set');
    expect(invokeMock.mock.calls[0]![1]).toEqual({ patch: { shortcut: 'Ctrl+Shift+2' } });
  });

  it('history_list drops an empty query and keeps paging arguments', async () => {
    invokeMock.mockResolvedValue([]);
    await ipc.historyList({ query: '   ', limit: 48, offset: 0 });
    await ipc.historyList({ query: ' invoice ', limit: 48, offset: 48 });
    expect(invokeMock.mock.calls[0]![1]).toEqual({ query: undefined, limit: 48, offset: 0 });
    expect(invokeMock.mock.calls[1]![1]).toEqual({ query: 'invoice', limit: 48, offset: 48 });
  });

  it('history_get returns the meta and the saved document', async () => {
    invokeMock.mockResolvedValue({ meta: META, docJson: '{"v":1}' });
    await expect(ipc.historyGet(META.id)).resolves.toEqual({ meta: META, docJson: '{"v":1}' });
    invokeMock.mockResolvedValue({ meta: META, docJson: null });
    await expect(ipc.historyGet(META.id)).resolves.toEqual({ meta: META, docJson: null });
  });

  it('uses the opener plugin for links and Show in folder', async () => {
    invokeMock.mockResolvedValue(undefined);
    await ipc.openUrl('https://polishot.app/pricing');
    await ipc.revealInFolder('C:\\Shots\\a.png');
    expect(invokeMock.mock.calls[0]![0]).toBe('plugin:opener|open_url');
    expect(invokeMock.mock.calls[0]![1]).toEqual({ url: 'https://polishot.app/pricing' });
    expect(invokeMock.mock.calls[1]![0]).toBe('plugin:opener|reveal_item_in_dir');
    expect(invokeMock.mock.calls[1]![1]).toEqual({ paths: ['C:\\Shots\\a.png'] });
  });

  it('refuses to open anything but https links', async () => {
    for (const bad of ['http://polishot.app', 'javascript:alert(1)', 'file:///C:/x', 'polishot.app', 'https://']) {
      await expect(ipc.openUrl(bad)).rejects.toBeInstanceOf(IpcError);
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe('validation of what comes back from Rust', () => {
  it('open_file and paste return a checked CaptureMeta', async () => {
    invokeMock.mockResolvedValue(META);
    await expect(ipc.openFile('C:\\a.png')).resolves.toEqual(META);
    invokeMock.mockResolvedValue(null);
    await expect(ipc.pasteClipboardImage()).resolves.toBeNull();
    invokeMock.mockResolvedValue({ ...META, id: '../escape' });
    await expect(ipc.openFile('C:\\a.png')).rejects.toThrow(/does not understand/);
  });

  it('rejects ids that could escape the protocol path, before any request is made', async () => {
    for (const bad of ['', '../x', 'a/b', 'a b', 'x'.repeat(65), 'é']) {
      expect(isValidId(bad)).toBe(false);
      await expect(ipc.ocrRecognize(bad)).rejects.toBeInstanceOf(IpcError);
      expect(() => captureUrl(bad)).toThrow(IpcError);
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('keeps only well-formed OCR words', () => {
    const good = { text: 'hello', box: { x: 1, y: 2, w: 30, h: 10 }, line: 0 };
    const out = sanitizeWords([
      good,
      { text: '', box: good.box },
      { text: 'nan', box: { x: Number.NaN, y: 0, w: 1, h: 1 } },
      { text: 'flat', box: { x: 0, y: 0, w: 0, h: 5 } },
      { text: 'nobox' },
      null,
      42,
      { text: 'x'.repeat(500), box: good.box },
      { text: 'ok', box: { x: 0, y: 0, w: 5, h: 5 } },
    ]);
    expect(out).toEqual([good, { text: 'ok', box: { x: 0, y: 0, w: 5, h: 5 } }]);
    expect(sanitizeWords('nope')).toEqual([]);
  });

  it('recognises a valid CaptureMeta and nothing else', () => {
    expect(isCaptureMeta(META)).toBe(true);
    expect(isCaptureMeta({ ...META, source: 'camera' })).toBe(false);
    expect(isCaptureMeta({ ...META, width: 0 })).toBe(false);
    expect(isCaptureMeta({ ...META, createdAt: 'yesterday' })).toBe(false);
    expect(isCaptureMeta(null)).toBe(false);
  });

  it('history rows with a bad id are dropped', async () => {
    invokeMock.mockResolvedValue([
      { id: 'good1', createdAt: 1, width: 10, height: 10, excerpt: 'x', hasDoc: true },
      { id: '../bad', createdAt: 1, width: 10, height: 10, excerpt: 'x', hasDoc: false },
      { id: 'good2', createdAt: 2, width: 10, height: 10 },
    ]);
    const rows = await ipc.historyList({ limit: 10, offset: 0 });
    expect(rows.map((r) => r.id)).toEqual(['good1', 'good2']);
    expect(rows[1]).toMatchObject({ excerpt: '', hasDoc: false });
  });
});

describe('errors reach the UI as readable sentences', () => {
  it('uses the string Tauri rejects with', async () => {
    invokeMock.mockRejectedValue('Ctrl+Shift+2 is already in use by another application. Choose a different shortcut.');
    const err = await ipc.settingsSet({ shortcut: 'Ctrl+Shift+2' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IpcError);
    expect((err as IpcError).message).toBe('Ctrl+Shift+2 is already in use by another application. Choose a different shortcut.');
    expect((err as IpcError).command).toBe('settings_set');
  });

  it('copes with Error objects, plain objects and nothing at all', () => {
    expect(errorMessage(new Error('Disk full.'))).toBe('Disk full.');
    expect(errorMessage({ message: 'Could not write.' })).toBe('Could not write.');
    expect(errorMessage({ error: 'Nope.' })).toBe('Nope.');
    expect(errorMessage(undefined)).toBe('Something went wrong. Please try again.');
    expect(errorMessage('   ')).toBe('Something went wrong. Please try again.');
    expect(errorMessage({ code: 5 }, 'Fallback.')).toBe('Fallback.');
  });

  it('strips control characters and caps the length', () => {
    expect(errorMessage('line one\n\tline two\u0000')).toBe('line one line two');
    const long = errorMessage('word '.repeat(300));
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long.endsWith('…')).toBe(true);
  });

  it('turns Tauri plumbing failures into something a person can act on', () => {
    expect(errorMessage('export_save not allowed. Command not found')).toBe('That action is not available in this build.');
    expect(errorMessage('plugin opener not found')).toBe('That action is not available in this build.');
    expect(errorMessage(new TypeError("Cannot read properties of undefined (reading 'invoke') __TAURI_INTERNALS__"))).toBe(
      'The app backend is not running.',
    );
  });

  it('wraps a thrown (not rejected) failure the same way', async () => {
    invokeMock.mockImplementation(() => {
      throw new Error('boom');
    });
    await expect(ipc.licenseStatus()).rejects.toMatchObject({ name: 'IpcError', message: 'boom', command: 'license_status' });
  });
});

describe('events', () => {
  function capture() {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    const unlisten = vi.fn();
    listenMock.mockImplementation((name: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(name, cb);
      return Promise.resolve(unlisten);
    });
    return { handlers, unlisten };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('delivers a valid capture:ready and ignores a malformed one', async () => {
    const { handlers } = capture();
    const seen: CaptureMeta[] = [];
    events.onCaptureReady((m) => seen.push(m));
    await flush();
    handlers.get('capture:ready')!({ payload: META });
    handlers.get('capture:ready')!({ payload: { id: '../x', width: 1, height: 1, createdAt: 1, source: 'region' } });
    handlers.get('capture:ready')!({ payload: 'junk' });
    expect(seen).toEqual([META]);
  });

  it('sanitises the OCR words in ocr:ready', async () => {
    const { handlers } = capture();
    const seen: Array<{ id: string; words: unknown[] }> = [];
    events.onOcrReady((p) => seen.push(p));
    await flush();
    handlers.get('ocr:ready')!({ payload: { id: 'abc', words: [{ text: 'hi', box: { x: 0, y: 0, w: 4, h: 4 } }, { text: 'bad' }] } });
    handlers.get('ocr:ready')!({ payload: { id: 'bad id', words: [] } });
    expect(seen).toEqual([{ id: 'abc', words: [{ text: 'hi', box: { x: 0, y: 0, w: 4, h: 4 } }] }]);
  });

  it('accepts only known navigation targets', async () => {
    const { handlers } = capture();
    const seen: string[] = [];
    events.onNavigate((t) => seen.push(t));
    await flush();
    for (const p of ['history', 'settings', 'license', 'about', 42]) handlers.get('navigate')!({ payload: p });
    expect(seen).toEqual(['history', 'settings', 'license']);
  });

  it('reports file drops as paths and drops junk entries', async () => {
    const { handlers } = capture();
    const seen: string[][] = [];
    events.onFileDrop((d) => seen.push(d.paths));
    await flush();
    handlers.get('tauri://drag-drop')!({ payload: { paths: ['C:\\a.png', 7, ''], position: { x: 1, y: 2 } } });
    handlers.get('tauri://drag-drop')!({ payload: { paths: [] } });
    expect(seen).toEqual([['C:\\a.png']]);
  });

  it('turns capture:error payloads into messages', async () => {
    const { handlers } = capture();
    const seen: string[] = [];
    events.onCaptureError((m) => seen.push(m));
    await flush();
    handlers.get('capture:error')!({ payload: 'That window cannot be captured.' });
    expect(seen).toEqual(['That window cannot be captured.']);
  });

  it('unsubscribes even when called before the registration finished', async () => {
    const unlisten = vi.fn();
    let resolveListen: (fn: () => void) => void = () => undefined;
    listenMock.mockImplementation(() => new Promise<() => void>((r) => (resolveListen = r)));
    const off = events.onNavigate(() => undefined);
    off(); // React cleanup runs before the async listen() resolves
    resolveListen(unlisten);
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after unsubscribing', async () => {
    const { handlers, unlisten } = capture();
    const seen: string[] = [];
    const off = events.onNavigate((t) => seen.push(t));
    await flush();
    handlers.get('navigate')!({ payload: 'history' });
    off();
    handlers.get('navigate')!({ payload: 'settings' });
    expect(seen).toEqual(['history']);
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

describe('image URLs', () => {
  it('uses the custom protocol origin the webview sees on Windows', () => {
    expect(captureUrl('abc')).toBe('http://polishot.localhost/capture/abc');
    expect(thumbUrl('abc')).toBe('http://polishot.localhost/thumb/abc');
  });

  it('can be redirected (the dev mock serves blob: URLs)', () => {
    setUrlResolver({ capture: (id) => `blob:${id}`, history: (id) => `blob:h-${id}`, thumb: (id) => `blob:t-${id}` });
    expect(captureUrl('abc')).toBe('blob:abc');
    expect(thumbUrl('abc')).toBe('blob:t-abc');
    setUrlResolver(null);
    expect(captureUrl('abc')).toBe('http://polishot.localhost/capture/abc');
  });
});

describe('transport', () => {
  it('runs on a swapped-in transport (mock mode) without touching Tauri', async () => {
    setTransport({
      invoke: vi.fn().mockResolvedValue({ licensed: false, reason: 'no-key' }),
      listen: vi.fn().mockResolvedValue(() => undefined),
    });
    await expect(ipc.licenseStatus()).resolves.toEqual({ licensed: false, reason: 'no-key' });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('turns a Blob into bytes', async () => {
    const bytes = await blobToBytes(new Blob([new Uint8Array([1, 2, 3])]));
    expect([...bytes]).toEqual([1, 2, 3]);
  });
});
