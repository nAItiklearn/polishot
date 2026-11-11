// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  acceleratorFromEvent,
  formatAccelerator,
  heldModifiers,
  matchesShortcut,
  normalizeAccelerator,
  parseAccelerator,
  tokenFromCode,
  validateAccelerator,
} from './shortcuts';

function key(init: KeyboardEventInit & { key: string; code: string }): KeyboardEvent {
  return new KeyboardEvent('keydown', init);
}

describe('acceleratorFromEvent (the shortcut recorder)', () => {
  it('records modifiers in a fixed order, then the key', () => {
    expect(acceleratorFromEvent(key({ key: '@', code: 'Digit2', ctrlKey: true, shiftKey: true }))).toBe('Ctrl+Shift+2');
    expect(acceleratorFromEvent(key({ key: 's', code: 'KeyS', shiftKey: true, altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+Shift+S');
    expect(acceleratorFromEvent(key({ key: 'F9', code: 'F9', altKey: true }))).toBe('Alt+F9');
    expect(acceleratorFromEvent(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toBeNull();
    expect(acceleratorFromEvent(key({ key: 'e', code: 'KeyE', metaKey: true }))).toBe('Super+E');
  });

  it('uses the physical key, so Shift+2 is "2" and not "@"', () => {
    expect(acceleratorFromEvent(key({ key: '@', code: 'Digit2', ctrlKey: true, shiftKey: true }))).toMatch(/\+2$/);
    // A non-Latin layout still records the key the Rust side expects.
    expect(acceleratorFromEvent(key({ key: 'ы', code: 'KeyS', ctrlKey: true }))).toBe('Ctrl+S');
  });

  it('returns null while only modifiers are held, and for keys with no accelerator name', () => {
    for (const k of ['Control', 'Shift', 'Alt', 'Meta']) {
      expect(acceleratorFromEvent(key({ key: k, code: `${k}Left`, ctrlKey: true }))).toBeNull();
    }
    expect(acceleratorFromEvent(key({ key: 'MediaPlayPause', code: 'MediaPlayPause', ctrlKey: true }))).toBeNull();
  });

  it('names punctuation, arrows and numpad keys the way global-hotkey parses them', () => {
    expect(tokenFromCode('Backquote')).toBe('`');
    expect(tokenFromCode('Slash')).toBe('/');
    expect(tokenFromCode('ArrowUp')).toBe('Up');
    expect(tokenFromCode('Numpad5')).toBe('Num5');
    expect(tokenFromCode('NumpadAdd')).toBe('NumAdd');
    expect(tokenFromCode('F24')).toBe('F24');
    expect(tokenFromCode('F25')).toBeNull();
    expect(tokenFromCode('Unidentified')).toBeNull();
  });

  it('shows the modifiers held so far', () => {
    expect(heldModifiers(key({ key: 'Shift', code: 'ShiftLeft', ctrlKey: true, shiftKey: true }))).toEqual(['Ctrl', 'Shift']);
    expect(heldModifiers(key({ key: 'Meta', code: 'MetaLeft', metaKey: true }))).toEqual(['Win']);
  });
});

describe('validateAccelerator (same rules as Settings::validate)', () => {
  it('accepts a modifier plus a key', () => {
    expect(validateAccelerator('Ctrl+Shift+2')).toBeNull();
    expect(validateAccelerator('alt+f9')).toBeNull();
    expect(validateAccelerator('CommandOrControl+Shift+S')).toBeNull();
    expect(validateAccelerator('Ctrl+Alt+Up')).toBeNull();
  });

  it('requires Ctrl or Alt, so a shortcut cannot hijack typing or the shell', () => {
    expect(validateAccelerator('A')).toMatch(/Ctrl or Alt/);
    expect(validateAccelerator('F9')).toMatch(/Ctrl or Alt/);
    // Shift alone only types capitals; the Windows key alone belongs to Windows. The backend refuses both.
    expect(validateAccelerator('Shift+F9')).toMatch(/Ctrl or Alt/);
    expect(validateAccelerator('Super+Up')).toMatch(/Ctrl or Alt/);
    expect(validateAccelerator('Shift+Super+S')).toMatch(/Ctrl or Alt/);
  });

  it('rejects unknown keys, two keys, a key before a modifier, and junk', () => {
    expect(validateAccelerator('Ctrl+Banana')).not.toBeNull();
    expect(validateAccelerator('Ctrl+A+B')).not.toBeNull();
    expect(validateAccelerator('A+Ctrl')).not.toBeNull();
    expect(validateAccelerator('Ctrl+')).not.toBeNull();
    expect(validateAccelerator('x'.repeat(80))).not.toBeNull();
  });

  it('allows empty only for optional shortcuts', () => {
    expect(validateAccelerator('')).toMatch(/Choose/);
    expect(validateAccelerator('  ', { allowEmpty: true })).toBeNull();
  });
});

describe('parse, normalise and format', () => {
  it('normalises spelling and order', () => {
    expect(normalizeAccelerator('shift+ctrl+2')).toBe('Ctrl+Shift+2'); // modifier order is normalised
    expect(normalizeAccelerator('shift+control+2')).toBe('Ctrl+Shift+2');
    expect(normalizeAccelerator('ctrl+shift+2')).toBe('Ctrl+Shift+2');
    expect(normalizeAccelerator('CTRL+ALT+delete')).toBe('Ctrl+Alt+Delete');
    expect(normalizeAccelerator('cmd+esc')).toBe('Super+Escape');
    expect(normalizeAccelerator('ctrl+arrowup')).toBe('Ctrl+Up');
  });

  it('parses into parts', () => {
    expect(parseAccelerator('Ctrl+Shift+2')).toEqual({ ctrl: true, alt: false, shift: true, super: false, key: '2' });
    expect(parseAccelerator('')).toBeNull();
  });

  it('formats for display', () => {
    expect(formatAccelerator('Ctrl+Shift+2')).toEqual(['Ctrl', 'Shift', '2']);
    expect(formatAccelerator('Super+Up')).toEqual(['Win', '↑']);
    expect(formatAccelerator('Ctrl+PageDown')).toEqual(['Ctrl', 'Page Down']);
    expect(formatAccelerator('Esc')).toEqual(['Esc']);
    expect(formatAccelerator('Del')).toEqual(['Del']);
    expect(formatAccelerator('')).toEqual([]);
    expect(formatAccelerator('not a shortcut')).toEqual(['not a shortcut']);
  });
});

describe('matchesShortcut (in-app shortcuts)', () => {
  it('matches modifiers exactly', () => {
    expect(matchesShortcut(key({ key: 'c', code: 'KeyC', ctrlKey: true }), 'Ctrl+C')).toBe(true);
    expect(matchesShortcut(key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+C')).toBe(true);
    // Ctrl+Shift+C must not fire the plain Ctrl+C action, and vice versa.
    expect(matchesShortcut(key({ key: 'C', code: 'KeyC', ctrlKey: true, shiftKey: true }), 'Ctrl+C')).toBe(false);
    expect(matchesShortcut(key({ key: 'c', code: 'KeyC', ctrlKey: true }), 'Ctrl+Shift+C')).toBe(false);
    expect(matchesShortcut(key({ key: 'c', code: 'KeyC' }), 'Ctrl+C')).toBe(false);
    expect(matchesShortcut(key({ key: 'c', code: 'KeyC', ctrlKey: true, altKey: true }), 'Ctrl+C')).toBe(false);
  });

  it('keeps Ctrl+C on the letter C for other layouts (Dvorak: the C key types "j")', () => {
    expect(matchesShortcut(key({ key: 'c', code: 'KeyJ', ctrlKey: true }), 'Ctrl+C')).toBe(true);
    expect(matchesShortcut(key({ key: 'j', code: 'KeyC', ctrlKey: true }), 'Ctrl+C')).toBe(false);
  });

  it('matches digits, punctuation and Esc on the physical key', () => {
    expect(matchesShortcut(key({ key: '1', code: 'Digit1', ctrlKey: true }), 'Ctrl+1')).toBe(true);
    expect(matchesShortcut(key({ key: ',', code: 'Comma', ctrlKey: true }), 'Ctrl+,')).toBe(true);
    expect(matchesShortcut(key({ key: 'Escape', code: 'Escape' }), 'Escape')).toBe(true);
    expect(matchesShortcut(key({ key: 'Delete', code: 'Delete' }), 'Delete')).toBe(true);
  });

  it('ignores a bare modifier press and bad accelerators', () => {
    expect(matchesShortcut(key({ key: 'Control', code: 'ControlLeft', ctrlKey: true }), 'Ctrl+C')).toBe(false);
    expect(matchesShortcut(key({ key: 'c', code: 'KeyC', ctrlKey: true }), 'Ctrl+')).toBe(false);
  });
});
