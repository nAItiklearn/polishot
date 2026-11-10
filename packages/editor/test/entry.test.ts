import { describe, expect, it } from 'vitest';

describe('package entry points', () => {
  it('the core entry loads without a DOM (SSR-safe at import time) and exposes the contract', async () => {
    expect(typeof document).toBe('undefined');
    const core = await import('../src/index');
    for (const name of [
      'createDoc',
      'validateDoc',
      'autoBalance',
      'autoBackground',
      'computeLayout',
      'PRESETS',
      'exportDoc',
      'redactionsFromDetections',
      'shouldWatermark',
      'computeExportSize',
      'mapShortcut',
      'History',
      'Editor',
    ]) {
      expect(core, name).toHaveProperty(name);
    }
    const doc = core.createDoc({ id: 'x', width: 100, height: 80 });
    expect(core.computeLayout(doc).width).toBeGreaterThan(100);
    expect(Object.keys(core.PRESETS).sort()).toEqual(['auto', 'custom', 'ig-square', 'ig-story', 'linkedin', 'x', 'youtube']);
  });

  it('constructing an Editor without a DOM fails loudly instead of half-working', async () => {
    const { Editor } = await import('../src/index');
    expect(() => new Editor({} as HTMLElement, { licensed: false })).toThrow();
  });
});
