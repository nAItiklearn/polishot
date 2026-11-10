import type { Tool } from './types';

export type ShortcutAction =
  | { type: 'tool'; tool: Tool }
  | { type: 'delete' }
  | { type: 'escape' }
  | { type: 'undo' }
  | { type: 'redo' };

export interface KeyInfo {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
}

const TOOL_KEYS: Record<string, Tool> = {
  v: 'select',
  a: 'arrow',
  r: 'rect',
  e: 'ellipse',
  l: 'line',
  t: 'text',
  b: 'blur',
  n: 'step',
  p: 'redact-brush',
};

/** Keyboard letter for each tool; used for tooltips. */
export const TOOL_SHORTCUT: Record<Tool, string> = {
  select: 'V',
  arrow: 'A',
  rect: 'R',
  ellipse: 'E',
  line: 'L',
  text: 'T',
  blur: 'B',
  step: 'N',
  'redact-brush': 'P',
};

export const TOOL_LABEL: Record<Tool, string> = {
  select: 'Select',
  arrow: 'Arrow',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  line: 'Line',
  text: 'Text',
  blur: 'Blur',
  step: 'Step',
  'redact-brush': 'Redact brush',
};

export const TOOL_ORDER: Tool[] = ['select', 'arrow', 'rect', 'ellipse', 'line', 'text', 'blur', 'step', 'redact-brush'];

/**
 * Pure keyboard shortcut mapping. Returns null for keys the editor does not handle. Tool letters are
 * ignored while Ctrl/Cmd/Alt is held so browser and OS shortcuts keep working.
 */
export function mapShortcut(e: KeyInfo): ShortcutAction | null {
  const mod = !!(e.ctrlKey || e.metaKey);
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey) {
    if (key === 'z') return e.shiftKey ? { type: 'redo' } : { type: 'undo' };
    if (key === 'y' && !e.shiftKey) return { type: 'redo' };
    return null;
  }
  if (mod || e.altKey) return null;
  if (key === 'Delete' || key === 'Backspace') return { type: 'delete' };
  if (key === 'Escape') return { type: 'escape' };
  if (e.shiftKey && key.length === 1 && !/[a-z]/.test(key)) return null;
  const tool = TOOL_KEYS[key];
  return tool ? { type: 'tool', tool } : null;
}

export type SelectionShortcut = { type: 'nudge'; dx: number; dy: number } | { type: 'duplicate' };

const ARROWS: Record<string, readonly [number, number]> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};

/** Pixels an arrow key moves the selection (source image px); Shift moves ten times as far. */
export const NUDGE_STEP = 1;
export const NUDGE_STEP_SHIFT = 10;

/**
 * Shortcuts that act on the selected annotation: arrow keys nudge by 1 px (Shift: 10 px) and Ctrl/Cmd+D
 * duplicates. Kept apart from `mapShortcut` because they only apply when something is selected and the
 * focus is not in a control that wants the arrow keys (sliders, menus, the toolbar).
 */
export function mapSelectionShortcut(e: KeyInfo): SelectionShortcut | null {
  const mod = !!(e.ctrlKey || e.metaKey);
  if (e.altKey) return null;
  if (mod) {
    return !e.shiftKey && e.key.length === 1 && e.key.toLowerCase() === 'd' ? { type: 'duplicate' } : null;
  }
  const dir = ARROWS[e.key];
  if (!dir) return null;
  const step = e.shiftKey ? NUDGE_STEP_SHIFT : NUDGE_STEP;
  return { type: 'nudge', dx: dir[0] * step, dy: dir[1] * step };
}
