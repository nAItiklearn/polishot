// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The Tauri window and dialog modules need the webview's bridge; the helpers are tested without them.
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({}) }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(), save: vi.fn() }));

import { HIDE_SETTLE_MS, hideAndSettle, setNative, whenHidden, type NativeApi } from './native';

let visibility: 'visible' | 'hidden' = 'visible';
const setVisibility = (v: 'visible' | 'hidden') => {
  visibility = v;
  document.dispatchEvent(new Event('visibilitychange'));
};

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
});

afterEach(() => {
  vi.useRealTimers();
  setNative(null);
});

function fakeNative(hide: () => Promise<void>): NativeApi {
  return {
    minimize: async () => undefined,
    toggleMaximize: async () => undefined,
    hide,
    isMaximized: async () => false,
    onResized: async () => () => undefined,
    pickImage: async () => null,
    pickImages: async () => [],
    pickFolder: async () => null,
    pickSavePath: async () => null,
  };
}

describe('whenHidden', () => {
  it('resolves at once when the page is already hidden', async () => {
    visibility = 'hidden';
    await expect(whenHidden()).resolves.toBeUndefined();
  });

  it('resolves when the page becomes hidden, not before', async () => {
    let done = false;
    void whenHidden(400).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(true);
  });

  it('ignores a change that leaves the page visible, and gives up after the timeout', async () => {
    let done = false;
    void whenHidden(400).then(() => (done = true));
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(399);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toBe(true);
  });
});

describe('hideAndSettle', () => {
  it('waits for the hidden event plus a short settle, far less than the old fixed 220 ms', async () => {
    let finished = false;
    setNative(
      fakeNative(async () => {
        // The webview reports "hidden" a frame after the hide call.
        window.setTimeout(() => setVisibility('hidden'), 16);
      }),
    );
    void hideAndSettle().then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(15);
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(2); // 17 ms: the hidden event came at 16
    await vi.advanceTimersByTimeAsync(HIDE_SETTLE_MS - 20); // still inside the settle
    expect(finished).toBe(false);
    await vi.advanceTimersByTimeAsync(25); // past 16 + the settle
    expect(finished).toBe(true);
    expect(16 + HIDE_SETTLE_MS).toBeLessThan(120);
  });

  it('still returns if the hide call fails, and if the event never comes', async () => {
    let finished = false;
    setNative(fakeNative(async () => Promise.reject(new Error('no window'))));
    void hideAndSettle().then(() => (finished = true));
    await vi.advanceTimersByTimeAsync(400 + HIDE_SETTLE_MS + 5);
    expect(finished).toBe(true);
  });
});
