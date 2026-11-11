import { TOOL_LABEL, TOOL_ORDER, TOOL_SHORTCUT } from '@polishot/editor';
import { describe, expect, it } from 'vitest';
import { ACTIONS, actionDef, buildToolActions, filterActions, withToolActions, type PaletteItem } from './commands';
import { parseAccelerator } from './shortcuts';

const items = (overrides: Partial<Record<string, boolean>> = {}): PaletteItem[] =>
  ACTIONS.map((a) => ({ ...a, enabled: overrides[a.id] ?? true }));

const ids = (list: PaletteItem[]) => list.map((i) => i.id);

describe('the action catalogue', () => {
  it('gives every action a shortcut that parses (UX-BAR: every action has one)', () => {
    for (const a of ACTIONS) {
      expect(a.shortcut, a.id).not.toBe('');
      expect(parseAccelerator(a.shortcut), `${a.id}: ${a.shortcut}`).not.toBeNull();
    }
  });

  it('has unique ids and no two actions on the same shortcut', () => {
    const seen = new Map<string, string>();
    for (const a of ACTIONS) {
      if (a.id === 'hide') continue; // Esc also leaves other views; same key, same intent
      const norm = a.shortcut.toLowerCase();
      expect(seen.get(norm), `${a.id} shares ${a.shortcut} with ${seen.get(norm)}`).toBeUndefined();
      seen.set(norm, a.id);
    }
    expect(new Set(ACTIONS.map((a) => a.id)).size).toBe(ACTIONS.length);
  });

  it('lists the actions the brief names, with their shortcuts', () => {
    expect(actionDef('copy-image').shortcut).toBe('Ctrl+C');
    expect(actionDef('copy-text').shortcut).toBe('Ctrl+Shift+C');
    expect(actionDef('save').shortcut).toBe('Ctrl+S');
    expect(actionDef('save-as').shortcut).toBe('Ctrl+Shift+S');
    expect(actionDef('pin').shortcut).toBe('Ctrl+P');
    expect(actionDef('open-file').shortcut).toBe('Ctrl+O');
    expect(actionDef('paste-image').shortcut).toBe('Ctrl+V');
    expect(actionDef('palette').shortcut).toBe('Ctrl+K');
    expect(actionDef('go-history').shortcut).toBe('Ctrl+H');
    expect(actionDef('hide').shortcut).toBe('Esc');
  });

  it('adds one action per editor tool, with the editor own letter', () => {
    const tools = buildToolActions(TOOL_ORDER, TOOL_LABEL, TOOL_SHORTCUT);
    expect(tools).toHaveLength(TOOL_ORDER.length);
    const arrow = tools.find((t) => t.id === 'tool-arrow');
    expect(arrow).toMatchObject({ label: 'Tool: Arrow', shortcut: 'A', group: 'Tools', external: true });
    const all = withToolActions(ACTIONS, tools);
    expect(all).toHaveLength(ACTIONS.length + tools.length);
    // Tool letters never collide with a modified app shortcut.
    for (const t of tools) expect(parseAccelerator(t.shortcut)).not.toBeNull();
  });
});

describe('filterActions (the command palette search)', () => {
  it('returns everything, in catalogue order, for an empty query', () => {
    expect(ids(filterActions(items(), ''))).toEqual(ids(items()));
    expect(ids(filterActions(items(), '   '))).toEqual(ids(items()));
  });

  it('ranks a label prefix above a word match above a keyword match', () => {
    const r = ids(filterActions(items(), 'copy'));
    expect(r.slice(0, 2)).toEqual(['copy-image', 'copy-text']);
    // "clipboard" is only a keyword on copy actions and the label on paste.
    const clip = ids(filterActions(items(), 'clipboard'));
    expect(clip[0]).toBe('paste-image');
    expect(clip).toContain('copy-image');
  });

  it('matches words in any order and requires every word', () => {
    expect(ids(filterActions(items(), 'text copy'))).toContain('copy-text');
    expect(ids(filterActions(items(), 'copy zebra'))).toEqual([]);
  });

  it('finds actions by keyword, and by loose subsequence for typos', () => {
    expect(ids(filterActions(items(), 'watermark'))).toEqual(['go-license']);
    expect(ids(filterActions(items(), 'privacy'))[0]).toBe('redact-blur');
    expect(ids(filterActions(items(), 'cpyim'))).toEqual(['copy-image']);
  });

  it('is case-insensitive', () => {
    expect(ids(filterActions(items(), 'HISTORY'))).toEqual(['go-history']);
  });

  it('keeps disabled actions listed, after the ones that can run', () => {
    const list = items({ 'copy-image': false });
    const r = ids(filterActions(list, 'copy'));
    expect(r[0]).toBe('copy-text');
    expect(r).toContain('copy-image');
    expect(r.at(-1)).toBe('copy-image'); // the disabled one comes last, still listed
  });

  it('says nothing matches with an empty list, not an error', () => {
    expect(filterActions(items(), 'qqqqqq')).toEqual([]);
  });
});
