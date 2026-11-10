/**
 * Keyboard shortcut helpers: turning key events into the accelerator strings the Rust side accepts
 * (`Ctrl+Shift+2`, the format of `tauri-plugin-global-shortcut` / `global-hotkey`), validating them
 * with the same rules as `Settings::validate`, formatting them for display, and matching in-app
 * shortcuts such as Ctrl+C.
 *
 * Everything here is pure so it can be tested without a DOM.
 */

/** The subset of KeyboardEvent the helpers read. */
export interface KeyLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface ParsedAccelerator {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  super: boolean;
  key: string;
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS']);

/** True for the modifier keys themselves (pressing Ctrl on its own is not a shortcut yet). */
export function isModifierKey(e: Pick<KeyLike, 'key'>): boolean {
  return MODIFIER_KEYS.has(e.key);
}

const PUNCTUATION: Record<string, string> = {
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
};

const NAMED: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  Enter: 'Enter',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  PrintScreen: 'PrintScreen',
  Pause: 'Pause',
  ScrollLock: 'ScrollLock',
  NumpadAdd: 'NumAdd',
  NumpadSubtract: 'NumSubtract',
  NumpadMultiply: 'NumMultiply',
  NumpadDivide: 'NumDivide',
  NumpadDecimal: 'NumDecimal',
  NumpadEnter: 'NumEnter',
};

/** Canonical spelling of every key token the recorder can produce, keyed by its upper-cased form. */
const CANONICAL: ReadonlyMap<string, string> = new Map(
  [
    ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
    ...Array.from({ length: 24 }, (_, i) => `F${i + 1}`),
    ...Array.from({ length: 10 }, (_, i) => `Num${i}`),
    ...Object.values(PUNCTUATION),
    ...Object.values(NAMED),
    'Escape',
  ].map((t) => [t.toUpperCase(), t] as const),
);

/** Spellings global-hotkey accepts besides the canonical ones. */
const KEY_ALIASES: Record<string, string> = {
  ESC: 'Escape',
  ARROWUP: 'Up',
  ARROWDOWN: 'Down',
  ARROWLEFT: 'Left',
  ARROWRIGHT: 'Right',
  DEL: 'Delete',
  NUMPAD0: 'Num0',
  NUMPAD1: 'Num1',
  NUMPAD2: 'Num2',
  NUMPAD3: 'Num3',
  NUMPAD4: 'Num4',
  NUMPAD5: 'Num5',
  NUMPAD6: 'Num6',
  NUMPAD7: 'Num7',
  NUMPAD8: 'Num8',
  NUMPAD9: 'Num9',
};

/** The accelerator key token for a physical key (`KeyboardEvent.code`), or null if unsupported. */
export function tokenFromCode(code: string): string | null {
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!;
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1]!;
  m = /^F([1-9]|1[0-9]|2[0-4])$/.exec(code);
  if (m) return `F${m[1]}`;
  m = /^Numpad([0-9])$/.exec(code);
  if (m) return `Num${m[1]}`;
  return PUNCTUATION[code] ?? NAMED[code] ?? null;
}

/**
 * Accelerator string for a key event, e.g. `Ctrl+Shift+2`. Null while only modifiers are held or when
 * the key has no accelerator name. Modifier order is fixed (Ctrl, Alt, Shift, Super) so equal
 * shortcuts compare equal as strings.
 */
export function acceleratorFromEvent(e: KeyLike): string | null {
  if (isModifierKey(e)) return null;
  const token = tokenFromCode(e.code);
  if (!token) return null;
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Super');
  parts.push(token);
  return parts.join('+');
}

/** The modifiers currently held, for the live "Ctrl + Shift + ..." preview while recording. */
export function heldModifiers(e: Pick<KeyLike, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string[] {
  const parts: string[] = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  if (e.metaKey) parts.push('Win');
  return parts;
}

/** Parses `Ctrl+Shift+2` (case-insensitive, the same modifier aliases as global-hotkey). */
export function parseAccelerator(accelerator: string): ParsedAccelerator | null {
  const text = accelerator.trim();
  if (!text || text.length > 64) return null;
  const out: ParsedAccelerator = { ctrl: false, alt: false, shift: false, super: false, key: '' };
  for (const raw of text.split('+')) {
    const t = raw.trim();
    if (!t) return null;
    if (out.key) return null; // modifiers must come before the key, and there is only one key
    switch (t.toUpperCase()) {
      case 'CTRL':
      case 'CONTROL':
      case 'COMMANDORCONTROL':
      case 'COMMANDORCTRL':
      case 'CMDORCTRL':
      case 'CMDORCONTROL':
        out.ctrl = true;
        break;
      case 'ALT':
      case 'OPTION':
        out.alt = true;
        break;
      case 'SHIFT':
        out.shift = true;
        break;
      case 'SUPER':
      case 'WIN':
      case 'CMD':
      case 'COMMAND':
        out.super = true;
        break;
      default:
{
        const canonical = CANONICAL.get(t.toUpperCase()) ?? CANONICAL.get(KEY_ALIASES[t.toUpperCase()]?.toUpperCase() ?? '');
        if (!canonical) return null;
        out.key = canonical;
      }
    }
  }
  return out.key ? out : null;
}

/** Normalised accelerator string, or null if it does not parse. */
export function normalizeAccelerator(accelerator: string): string | null {
  const p = parseAccelerator(accelerator);
  if (!p) return null;
  const parts: string[] = [];
  if (p.ctrl) parts.push('Ctrl');
  if (p.alt) parts.push('Alt');
  if (p.shift) parts.push('Shift');
  if (p.super) parts.push('Super');
  parts.push(p.key);
  return parts.join('+');
}

/**
 * Same rules as the Rust settings validation, so the recorder can reject a bad combination before
 * the round trip: a known key, exactly one key, and at least one modifier. Empty is allowed only when
 * `allowEmpty` (scroll and GIF shortcuts are optional). Returns a readable error or null.
 */
export function validateAccelerator(accelerator: string, opts: { allowEmpty?: boolean } = {}): string | null {
  const text = accelerator.trim();
  if (!text) return opts.allowEmpty ? null : 'Choose a shortcut.';
  const p = parseAccelerator(text);
  if (!p) return 'That is not a shortcut this app can register. Try a letter, number or function key with Ctrl, Alt or Shift.';
  if (!(p.ctrl || p.alt || p.shift || p.super)) {
    return 'Include Ctrl, Alt or Shift so the shortcut does not get in the way of typing.';
  }
  return null;
}

const DISPLAY: Record<string, string> = {
  Escape: 'Esc',
  Delete: 'Del',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Super: 'Win',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  PrintScreen: 'Print Screen',
  ScrollLock: 'Scroll Lock',
  NumAdd: 'Num +',
  NumSubtract: 'Num −',
  NumMultiply: 'Num ×',
  NumDivide: 'Num ÷',
  NumDecimal: 'Num .',
  NumEnter: 'Num Enter',
};

/** Display tokens for an accelerator: `Ctrl+Shift+2` becomes `['Ctrl', 'Shift', '2']`. */
export function formatAccelerator(accelerator: string): string[] {
  const text = accelerator.trim();
  if (!text) return [];
  const p = parseAccelerator(text);
  // Unparseable strings are shown as typed rather than dropped.
  if (!p) return text.split('+').map((t) => t.trim()).filter(Boolean);
  const out: string[] = [];
  if (p.ctrl) out.push('Ctrl');
  if (p.alt) out.push('Alt');
  if (p.shift) out.push('Shift');
  if (p.super) out.push('Win');
  out.push(DISPLAY[p.key] ?? (/^NUM[0-9]$/i.test(p.key) ? `Num ${p.key.slice(3)}` : p.key));
  return out;
}

/**
 * Does a key event match an in-app accelerator such as `Ctrl+Shift+C`? Modifiers must match exactly.
 * Printable keys match on the character first (so Ctrl+C is still C on a Dvorak layout) and on the
 * physical key as a fallback (Shift+2 reports "@" but is still Digit2).
 */
export function matchesShortcut(e: KeyLike, accelerator: string): boolean {
  const p = parseAccelerator(accelerator);
  if (!p) return false;
  if (e.ctrlKey !== p.ctrl || e.altKey !== p.alt || e.shiftKey !== p.shift || e.metaKey !== p.super) return false;
  if (isModifierKey(e)) return false;
  const want = p.key.toUpperCase();
  // Latin letters match on the character, so Ctrl+C stays "C" on Dvorak; everything else (digits,
  // punctuation, shifted symbols, other scripts) matches on the physical key.
  if (/^[a-z]$/i.test(e.key)) return e.key.toUpperCase() === want;
  const byCode = tokenFromCode(e.code);
  if (byCode) return byCode.toUpperCase() === want;
  return e.key.toUpperCase() === want;
}
