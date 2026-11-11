import { describe, expect, it, vi } from 'vitest';
import { BATCH_HARD_CAP, batchSummary, isImagePath, planBatch, polishedName, runBatch, type BatchDeps } from './batch';

describe('planBatch', () => {
  const imgs = (n: number) => Array.from({ length: n }, (_, i) => `C:\\Shots\\img${i}.png`);

  it('takes images only, once each, in the order chosen', () => {
    const plan = planBatch(['C:\\a.png', 'C:\\notes.txt', 'C:\\A.PNG', 'C:\\b.JPG', 'C:\\c.webp', 'C:\\d.bmp'], 10);
    expect(plan.files).toEqual(['C:\\a.png', 'C:\\b.JPG', 'C:\\c.webp', 'C:\\d.bmp']);
    expect(plan.ignored).toBe(2); // the text file and the duplicate (paths compare case-insensitively)
    expect(plan.overLimit).toBe(0);
  });

  it('enforces the Free limit of 5 and says how many were left out', () => {
    const plan = planBatch(imgs(8), 5);
    expect(plan.files).toHaveLength(5);
    expect(plan.files[4]).toBe('C:\\Shots\\img4.png');
    expect(plan.overLimit).toBe(3);
  });

  it('lets Pro through, up to a sane cap', () => {
    expect(planBatch(imgs(30), Infinity).files).toHaveLength(30);
    const huge = planBatch(imgs(BATCH_HARD_CAP + 20), Infinity);
    expect(huge.files).toHaveLength(BATCH_HARD_CAP);
    expect(huge.overLimit).toBe(20);
  });

  it('handles an empty choice', () => {
    expect(planBatch([], 5)).toEqual({ files: [], overLimit: 0, ignored: 0 });
  });

  it('recognises image paths', () => {
    expect(isImagePath('x.PNG')).toBe(true);
    expect(isImagePath('x.jpeg')).toBe(true);
    expect(isImagePath('x.gif')).toBe(false);
    expect(isImagePath('png')).toBe(false);
  });
});

describe('polishedName', () => {
  it('appends -polished and the format extension', () => {
    const taken = new Set<string>();
    expect(polishedName('C:\\Users\\me\\Desktop\\Screenshot 12.png', 'png', taken)).toBe('Screenshot 12-polished.png');
    expect(polishedName('C:\\x\\photo.jpeg', 'jpeg', new Set())).toBe('photo-polished.jpg');
    expect(polishedName('/home/me/a.b.webp', 'webp', new Set())).toBe('a.b-polished.webp');
  });

  it('keeps names unique within a run, whatever the case', () => {
    const taken = new Set<string>();
    expect(polishedName('C:\\one\\shot.png', 'png', taken)).toBe('shot-polished.png');
    expect(polishedName('C:\\two\\SHOT.png', 'png', taken)).toBe('SHOT-polished-2.png');
    expect(polishedName('C:\\three\\shot.png', 'png', taken)).toBe('shot-polished-3.png');
  });

  it('cleans characters Windows rejects and never returns an empty stem', () => {
    expect(polishedName('C:\\x\\a:b?c.png', 'png', new Set())).toBe('a_b_c-polished.png');
    expect(polishedName('C:\\x\\.png', 'png', new Set())).toBe('png-polished.png');
    expect(polishedName('', 'png', new Set())).toBe('image-polished.png');
    expect(polishedName(`C:\\x\\${'n'.repeat(300)}.png`, 'png', new Set()).length).toBeLessThan(100);
  });
});

function deps(over: Partial<BatchDeps> = {}) {
  const calls = { open: [] as string[], saved: [] as string[], discarded: [] as string[] };
  const d: BatchDeps = {
    open: async (p) => {
      calls.open.push(p);
      return `id${calls.open.length}`;
    },
    render: async () => new Blob(['x']),
    save: async (_b, name) => {
      calls.saved.push(name);
      return `C:\\Out\\${name}`;
    },
    discard: async (id) => void calls.discarded.push(id),
    ...over,
  };
  return { d, calls };
}

describe('runBatch', () => {
  it('processes every file, one at a time, and removes each temporary capture', async () => {
    const { d, calls } = deps();
    const progress: string[] = [];
    const r = await runBatch(['C:\\a.png', 'C:\\b.png'], 'png', d, { onProgress: (p) => progress.push(`${p.index + 1}/${p.total} ${p.name}`) });
    expect(r).toEqual({ saved: ['C:\\Out\\a-polished.png', 'C:\\Out\\b-polished.png'], failed: [], cancelled: false });
    expect(progress).toEqual(['1/2 a.png', '2/2 b.png']);
    expect(calls.discarded).toEqual(['id1', 'id2']);
  });

  it('records a failing image and carries on with the rest', async () => {
    const { d, calls } = deps({
      render: async (id) => {
        if (id === 'id2') throw new Error('The image could not be decoded.');
        return new Blob(['x']);
      },
    });
    const r = await runBatch(['C:\\a.png', 'C:\\bad.png', 'C:\\c.png'], 'png', d);
    expect(r.saved).toHaveLength(2);
    expect(r.failed).toEqual([{ path: 'C:\\bad.png', message: 'The image could not be decoded.' }]);
    expect(calls.discarded).toEqual(['id1', 'id2', 'id3']); // even the failed one is cleaned up
  });

  it('does not fail the run when cleaning up fails', async () => {
    const { d } = deps({ discard: async () => Promise.reject(new Error('gone')) });
    const r = await runBatch(['C:\\a.png'], 'png', d);
    expect(r.saved).toHaveLength(1);
    expect(r.failed).toEqual([]);
  });

  it('stops before the next image when cancelled and keeps what was saved', async () => {
    const { d, calls } = deps();
    let cancel = false;
    const r = await runBatch(['C:\\a.png', 'C:\\b.png', 'C:\\c.png'], 'png', d, {
      isCancelled: () => cancel,
      onProgress: (p) => {
        if (p.index === 0) cancel = true; // pressed Cancel while the first image was being processed
      },
    });
    expect(r.cancelled).toBe(true);
    expect(r.saved).toHaveLength(1);
    expect(calls.open).toEqual(['C:\\a.png']);
  });

  it('never has two images open at once', async () => {
    let open = 0;
    let peak = 0;
    const { d } = deps({
      open: async () => {
        open++;
        peak = Math.max(peak, open);
        return `id${open}`;
      },
      discard: async () => void open--,
    });
    await runBatch(['C:\\a.png', 'C:\\b.png', 'C:\\c.png'], 'png', d);
    expect(peak).toBe(1);
  });

  it('turns an open failure into a failed entry using the supplied wording', async () => {
    const message = vi.fn(() => 'readable');
    const { d } = deps({ open: async () => Promise.reject('boom') });
    const r = await runBatch(['C:\\a.png'], 'png', d, { message });
    expect(r.failed).toEqual([{ path: 'C:\\a.png', message: 'readable' }]);
    expect(message).toHaveBeenCalledWith('boom');
  });
});

describe('batchSummary', () => {
  it('says what happened in one sentence', () => {
    expect(batchSummary({ saved: ['a'], failed: [], cancelled: false }, 1)).toBe('1 image saved.');
    expect(batchSummary({ saved: ['a', 'b'], failed: [], cancelled: false }, 2)).toBe('2 images saved.');
    expect(batchSummary({ saved: ['a', 'b'], failed: [{ path: 'c', message: '' }], cancelled: false }, 3)).toBe('2 images saved, 1 could not be processed.');
    expect(batchSummary({ saved: [], failed: [{ path: 'c', message: '' }], cancelled: false }, 1)).toBe('That image could not be processed.');
    expect(batchSummary({ saved: [], failed: [{ path: 'c', message: '' }], cancelled: false }, 3)).toBe('None of the images could be processed.');
    expect(batchSummary({ saved: ['a'], failed: [], cancelled: true }, 4)).toBe('Stopped. 1 image saved before that.');
    expect(batchSummary({ saved: [], failed: [], cancelled: true }, 4)).toBe('Stopped. Nothing was saved.');
  });
});
