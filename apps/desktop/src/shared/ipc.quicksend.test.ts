// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Same approach as ipc.test.ts: the client is tested against mocks of the two Tauri modules it imports.
const invokeMock = vi.fn();
const listenMock = vi.fn();

vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));
vi.mock('@tauri-apps/api/event', () => ({ listen: (...args: unknown[]) => listenMock(...args) }));

import { IpcError, events, ipc, setTransport, type CaptureMeta } from './ipc';

const META: CaptureMeta = { id: 'abc_123-XYZ', width: 1280, height: 800, createdAt: 1_760_000_000_000, source: 'region' };
const ID = 'PIXELEIGHT0000AA';
const DEVICE = { id: ID, name: 'Pixel 8', paired: true, online: true };
const CODE = { sas: '042 917', peerName: 'Pixel 8', peerId: ID, role: 'initiator' };

beforeEach(() => {
  setTransport(null);
  invokeMock.mockReset();
  listenMock.mockReset();
});

afterEach(() => {
  setTransport(null);
});

describe('quick send commands', () => {
  it('uses the argument names the backend reads', async () => {
    invokeMock.mockResolvedValue(undefined);
    await ipc.qsPairingMode(true);
    await ipc.qsForget(ID);
    await ipc.qsIncomingRespond(7, true);
    await ipc.captureStart('scroll');
    await ipc.captureStart('gif');
    await ipc.revealSaved('C:\\Shots\\a.gif');
    expect(invokeMock.mock.calls.map((c) => [c[0], c[1]])).toEqual([
      ['qs_pairing_mode', { open: true }],
      ['qs_forget', { deviceId: ID }],
      ['qs_incoming_respond', { requestId: 7, accept: true }],
      ['capture_start', { mode: 'scroll' }],
      ['capture_start', { mode: 'gif' }],
      ['reveal_in_folder', { path: 'C:\\Shots\\a.gif' }],
    ]);
  });

  it('sends the PNG as the raw body with the device and file name in headers', async () => {
    invokeMock.mockResolvedValue(undefined);
    const bytes = new Uint8Array([1, 2, 3]);
    await ipc.qsSend(bytes, ID, 'shot \u00fc.png');
    const [cmd, body, options] = invokeMock.mock.calls[0]!;
    expect(cmd).toBe('qs_send');
    expect(body).toBe(bytes);
    expect(options).toEqual({ headers: { 'x-device-id': ID, 'x-filename': 'shot _.png' } });
  });

  it('refuses a device id that is not alphanumeric before anything is sent', () => {
    for (const bad of ['', 'short', '../etc/passwd', 'ABCDEFGH ABCDEFGH', 'A'.repeat(40)]) {
      expect(() => ipc.qsForget(bad)).toThrow(IpcError);
      expect(() => ipc.qsSend(new Uint8Array(1), bad, 'a.png')).toThrow(IpcError);
    }
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it('returns checked device rows, dropping malformed and repeated ones', async () => {
    invokeMock.mockResolvedValue([
      DEVICE,
      { ...DEVICE },
      { id: 'bad id', name: 'x', paired: true, online: true },
      { id: 'GALAXYSTWENTYFOU', name: 'Galaxy\u202E S24\n', paired: 'yes', online: 1 },
      'junk',
    ]);
    await expect(ipc.qsDevices()).resolves.toEqual([DEVICE, { id: 'GALAXYSTWENTYFOU', name: 'Galaxy S24', paired: false, online: false }]);
    invokeMock.mockResolvedValue({ not: 'a list' });
    await expect(ipc.qsDevices()).resolves.toEqual([]);
  });

  it('pair_start and pair_confirm return checked results', async () => {
    invokeMock.mockResolvedValue(CODE);
    await expect(ipc.qsPairStart(ID)).resolves.toEqual(CODE);
    expect(invokeMock).toHaveBeenLastCalledWith('qs_pair_start', { deviceId: ID }, undefined);
    invokeMock.mockResolvedValue({ ...CODE, sas: '42917' });
    await expect(ipc.qsPairStart(ID)).rejects.toBeInstanceOf(IpcError);
    invokeMock.mockResolvedValue(DEVICE);
    await expect(ipc.qsPairConfirm(true, CODE)).resolves.toEqual(DEVICE);
    // The answer names the device and digits of the code that was on screen.
    expect(invokeMock).toHaveBeenLastCalledWith('qs_pair_confirm', { accepted: true, peerId: ID, sas: '042 917' }, undefined);
    invokeMock.mockResolvedValue(null);
    await expect(ipc.qsPairConfirm(true, CODE)).rejects.toBeInstanceOf(IpcError);
    await expect(ipc.qsPairConfirm(false, { peerId: '../x', sas: '042 917' })).rejects.toBeInstanceOf(IpcError);
  });

  it('turns a refusal from the backend into a readable error', async () => {
    invokeMock.mockRejectedValue('Pixel 8 declined the image.');
    await expect(ipc.qsSend(new Uint8Array(1), ID, 'a.png')).rejects.toMatchObject({ command: 'qs_send', message: 'Pixel 8 declined the image.' });
  });
});

describe('quick send and recorder events', () => {
  function capture() {
    const handlers = new Map<string, (e: { payload: unknown }) => void>();
    listenMock.mockImplementation((name: string, cb: (e: { payload: unknown }) => void) => {
      handlers.set(name, cb);
      return Promise.resolve(() => undefined);
    });
    return handlers;
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('qs:pair-code needs a six digit code and a role', async () => {
    const handlers = capture();
    const seen: unknown[] = [];
    events.onQsPairCode((c) => seen.push(c));
    await flush();
    const good = { sas: '042 917', peerName: 'Pixel 8', peerId: ID, role: 'responder' };
    handlers.get('qs:pair-code')!({ payload: good });
    handlers.get('qs:pair-code')!({ payload: { ...good, sas: '042917' } });
    handlers.get('qs:pair-code')!({ payload: { ...good, role: 'observer' } });
    handlers.get('qs:pair-code')!({ payload: { ...good, peerId: '../x' } });
    expect(seen).toEqual([good]);
  });

  it('qs:incoming carries a request id, and names are cleaned', async () => {
    const handlers = capture();
    const seen: unknown[] = [];
    events.onQsIncoming((f) => seen.push(f));
    await flush();
    handlers.get('qs:incoming')!({ payload: { requestId: 7, peerName: 'Pixel\u202E 8', name: 'shot.png', mime: 'image/png', size: 1234 } });
    handlers.get('qs:incoming')!({ payload: { requestId: -1, peerName: 'x', name: 'x', mime: '', size: 1 } });
    handlers.get('qs:incoming')!({ payload: { requestId: 'seven', peerName: 'x', name: 'x', mime: '', size: 1 } });
    handlers.get('qs:incoming')!({ payload: { requestId: 8, peerName: 'x', name: 'x', mime: '', size: Number.NaN } });
    expect(seen).toEqual([{ requestId: 7, peerName: 'Pixel 8', name: 'shot.png', mime: 'image/png', size: 1234 }]);
  });

  it('qs:received needs a valid capture', async () => {
    const handlers = capture();
    const seen: unknown[] = [];
    events.onQsReceived((r) => seen.push(r));
    await flush();
    handlers.get('qs:received')!({ payload: { meta: META, peerName: 'Pixel 8' } });
    handlers.get('qs:received')!({ payload: { meta: { ...META, id: '../x' }, peerName: 'Pixel 8' } });
    expect(seen).toEqual([{ meta: META, peerName: 'Pixel 8' }]);
  });

  it('qs:devices is a bare signal', async () => {
    const handlers = capture();
    const cb = vi.fn();
    events.onQsDevices(cb);
    await flush();
    handlers.get('qs:devices')!({ payload: null });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('gif:saved reports the file, and is ignored without a path', async () => {
    const handlers = capture();
    const seen: unknown[] = [];
    events.onGifSaved((g) => seen.push(g));
    await flush();
    handlers.get('gif:saved')!({ payload: { path: 'C:\\Shots\\Recording 1.gif', name: 'Recording 1.gif', bytes: 2048 } });
    handlers.get('gif:saved')!({ payload: { name: 'x.gif', bytes: 1 } });
    handlers.get('gif:saved')!({ payload: { path: 'C:\\Shots\\a.gif', bytes: -5 } });
    expect(seen).toEqual([
      { path: 'C:\\Shots\\Recording 1.gif', name: 'Recording 1.gif', bytes: 2048 },
      { path: 'C:\\Shots\\a.gif', name: 'a.gif', bytes: 0 },
    ]);
  });

  it('no longer listens for the retired shortcut:extra event', () => {
    expect('onShortcutExtra' in events).toBe(false);
  });
});
