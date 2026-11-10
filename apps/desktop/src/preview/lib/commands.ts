/**
 * The action catalogue: one list drives the keyboard shortcuts, the command palette and the labels
 * in the UI, so a shortcut can never be shown in one place and missing in another. Every action has
 * a shortcut (UX-BAR: "every action has a shortcut listed in the command palette").
 */
import type { Tool } from '@polishot/editor';

export type StaticActionId =
  | 'capture-region'
  | 'capture-window'
  | 'open-file'
  | 'paste-image'
  | 'copy-image'
  | 'copy-text'
  | 'save'
  | 'save-as'
  | 'pin'
  | 'redact-blur'
  | 'redact-bars'
  | 'delete-selection'
  | 'duplicate'
  | 'undo'
  | 'redo'
  | 'tab-style'
  | 'tab-redact'
  | 'tab-text'
  | 'tab-export'
  | 'go-editor'
  | 'go-history'
  | 'go-settings'
  | 'go-license'
  | 'palette'
  | 'theme-cycle'
  | 'hide';

export type ActionId = StaticActionId | `tool-${Tool}`;

export type ActionGroup = 'Capture' | 'Export' | 'Edit' | 'Tools' | 'Go to' | 'Appearance' | 'Window';

export interface ActionDef {
  id: ActionId;
  label: string;
  group: ActionGroup;
  /** Accelerator in the app's format (`Ctrl+Shift+C`). */
  shortcut: string;
  keywords?: readonly string[];
  /**
   * The editor itself handles this key (tool letters, Delete, undo/redo). The action is listed in the
   * palette and can be run from it, but the app's key handler leaves the keypress alone.
   */
  external?: boolean;
}

export const ACTIONS: readonly ActionDef[] = [
  { id: 'capture-region', label: 'Capture a region', group: 'Capture', shortcut: 'Ctrl+N', keywords: ['screenshot', 'snip', 'new'] },
  { id: 'capture-window', label: 'Capture a window', group: 'Capture', shortcut: 'Ctrl+Shift+N', keywords: ['screenshot', 'app'] },
  { id: 'open-file', label: 'Open image', group: 'Capture', shortcut: 'Ctrl+O', keywords: ['file', 'browse', 'import'] },
  { id: 'paste-image', label: 'Paste image from clipboard', group: 'Capture', shortcut: 'Ctrl+V', keywords: ['clipboard'] },

  { id: 'copy-image', label: 'Copy image', group: 'Export', shortcut: 'Ctrl+C', keywords: ['clipboard', 'png'] },
  { id: 'copy-text', label: 'Copy all text', group: 'Export', shortcut: 'Ctrl+Shift+C', keywords: ['ocr', 'recognised', 'clipboard'] },
  { id: 'save', label: 'Save to folder', group: 'Export', shortcut: 'Ctrl+S', keywords: ['export', 'write', 'file'] },
  { id: 'save-as', label: 'Save as', group: 'Export', shortcut: 'Ctrl+Shift+S', keywords: ['export', 'choose', 'location'] },
  { id: 'pin', label: 'Pin to screen', group: 'Export', shortcut: 'Ctrl+P', keywords: ['float', 'always on top'] },

  { id: 'redact-blur', label: 'Blur sensitive data', group: 'Edit', shortcut: 'Ctrl+Shift+B', keywords: ['redact', 'privacy', 'email', 'card', 'token'] },
  { id: 'redact-bars', label: 'Cover sensitive data with bars', group: 'Edit', shortcut: 'Ctrl+Shift+X', keywords: ['redact', 'privacy', 'black'] },
  { id: 'delete-selection', label: 'Delete selection', group: 'Edit', shortcut: 'Del', keywords: ['remove', 'erase'], external: true },
  { id: 'duplicate', label: 'Duplicate selection', group: 'Edit', shortcut: 'Ctrl+D', keywords: ['copy', 'clone'], external: true },
  { id: 'undo', label: 'Undo', group: 'Edit', shortcut: 'Ctrl+Z', keywords: ['back'], external: true },
  { id: 'redo', label: 'Redo', group: 'Edit', shortcut: 'Ctrl+Shift+Z', keywords: ['forward'], external: true },
  { id: 'tab-style', label: 'Style panel', group: 'Edit', shortcut: 'Ctrl+1', keywords: ['background', 'padding', 'inspector'] },
  { id: 'tab-redact', label: 'Redact panel', group: 'Edit', shortcut: 'Ctrl+2', keywords: ['sensitive', 'privacy'] },
  { id: 'tab-text', label: 'Text panel', group: 'Edit', shortcut: 'Ctrl+3', keywords: ['ocr', 'recognised'] },
  { id: 'tab-export', label: 'Export panel', group: 'Edit', shortcut: 'Ctrl+4', keywords: ['format', 'scale', 'quality'] },

  { id: 'go-editor', label: 'Back to the editor', group: 'Go to', shortcut: 'Ctrl+E', keywords: ['preview', 'canvas'] },
  { id: 'go-history', label: 'History', group: 'Go to', shortcut: 'Ctrl+H', keywords: ['recent', 'captures', 'search'] },
  { id: 'go-settings', label: 'Settings', group: 'Go to', shortcut: 'Ctrl+,', keywords: ['preferences', 'options', 'shortcut', 'folder'] },
  { id: 'go-license', label: 'License', group: 'Go to', shortcut: 'Ctrl+L', keywords: ['pro', 'key', 'activate', 'buy', 'watermark'] },
  { id: 'palette', label: 'Command palette', group: 'Go to', shortcut: 'Ctrl+K', keywords: ['search', 'commands'] },

  { id: 'theme-cycle', label: 'Switch theme (system, light, dark)', group: 'Appearance', shortcut: 'Ctrl+Shift+T', keywords: ['dark', 'light', 'mode'] },

  { id: 'hide', label: 'Hide window', group: 'Window', shortcut: 'Esc', keywords: ['close', 'tray', 'minimise'] },
];

/** One action per editor tool, from the editor's own labels and letters (so they cannot drift). */
export function buildToolActions(
  order: readonly Tool[],
  labels: Readonly<Record<Tool, string>>,
  shortcuts: Readonly<Record<Tool, string>>,
): ActionDef[] {
  return order.map((tool) => ({
    id: `tool-${tool}` as const,
    label: `Tool: ${labels[tool]}`,
    group: 'Tools' as const,
    shortcut: shortcuts[tool],
    keywords: ['draw', 'annotate'],
    external: true,
  }));
}

/** Insert the tool actions after the "Edit" group, keeping the palette order meaningful. */
export function withToolActions(base: readonly ActionDef[], tools: readonly ActionDef[]): ActionDef[] {
  const at = base.findIndex((a) => a.group === 'Go to');
  if (at < 0) return [...base, ...tools];
  return [...base.slice(0, at), ...tools, ...base.slice(at)];
}

export function actionDef(id: StaticActionId): ActionDef {
  const def = ACTIONS.find((a) => a.id === id);
  if (!def) throw new Error(`Unknown action: ${id}`);
  return def;
}

/** What the palette shows: a catalogue entry plus the live state around it. */
export interface PaletteItem extends ActionDef {
  enabled: boolean;
  /** A short live note such as "3 found". */
  hint?: string;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

function startsWord(hay: string, needle: string): boolean {
  let from = 0;
  while (from <= hay.length - needle.length) {
    const i = hay.indexOf(needle, from);
    if (i < 0) return false;
    if (i === 0 || /[^a-z0-9]/.test(hay[i - 1]!)) return true;
    from = i + 1;
  }
  return false;
}

/** Score for one query token against an item, or null when it does not match at all. */
function scoreToken(item: PaletteItem, token: string): number | null {
  const label = item.label.toLowerCase();
  if (label.startsWith(token)) return 100;
  if (startsWord(label, token)) return 80;
  if (label.includes(token)) return 60;
  const keywords = (item.keywords ?? []).join(' ').toLowerCase();
  if (startsWord(keywords, token)) return 45;
  if (keywords.includes(token)) return 40;
  if (item.group.toLowerCase().includes(token)) return 30;
  if (token.length >= 2 && isSubsequence(token, label)) return 15;
  return null;
}

/**
 * Filters and ranks palette items. Every whitespace-separated token must match (label first, then
 * keywords, group, and as a loose subsequence). Runnable actions come before disabled ones; ties keep
 * the catalogue order. An empty query returns everything in catalogue order.
 */
export function filterActions<T extends PaletteItem>(items: readonly T[], query: string): T[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...items];
  const scored: Array<{ item: T; score: number; index: number }> = [];
  items.forEach((item, index) => {
    let total = 0;
    for (const t of tokens) {
      const s = scoreToken(item, t);
      if (s === null) return;
      total += s;
    }
    scored.push({ item, score: total, index });
  });
  scored.sort((a, b) => {
    if (a.item.enabled !== b.item.enabled) return a.item.enabled ? -1 : 1;
    return b.score - a.score || a.index - b.index;
  });
  return scored.map((s) => s.item);
}
