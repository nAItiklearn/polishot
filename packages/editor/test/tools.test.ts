import { describe, expect, it } from 'vitest';
import { LIMITS, validateDoc } from '../src/doc';
import { planExport } from '../src/exportPlan';
import { maskPreview } from '../src/mask';
import {
  ANNOTATION_COLORS,
  annotationBounds,
  buildDragShape,
  capStroke,
  defaultStyleFor,
  isMeaningful,
  snapAngle,
  stepRadius,
  thinStroke,
  translateAnnotation,
} from '../src/tools';
import type { Annotation, Style } from '../src/types';
import { docFor } from './helpers';

const style: Style = { ...defaultStyleFor(1600, 900), color: '#e4572e' };

describe('buildDragShape', () => {
  it('builds arrows and lines from the drag points', () => {
    expect(buildDragShape('arrow', { x: 10, y: 20 }, { x: 110, y: 70 }, style, false, 'a1')).toMatchObject({
      type: 'arrow',
      points: [10, 20, 110, 70],
      color: '#e4572e',
      strokeWidth: style.strokeWidth,
    });
    expect(buildDragShape('line', { x: 0, y: 0 }, { x: 5, y: 5 }, style, false, 'a2')?.type).toBe('line');
  });

  it('normalises rectangles dragged in any direction', () => {
    const r = buildDragShape('rect', { x: 100, y: 100 }, { x: 40, y: 30 }, style, false, 'r1');
    expect(r).toMatchObject({ type: 'rect', x: 40, y: 30, w: 60, h: 70 });
    const e = buildDragShape('ellipse', { x: 10, y: 10 }, { x: 50, y: 20 }, style, false, 'e1');
    expect(e).toMatchObject({ type: 'ellipse', x: 10, y: 10, w: 40, h: 10 });
  });

  it('Shift makes squares and snaps angles to 45 degrees', () => {
    const sq = buildDragShape('rect', { x: 0, y: 0 }, { x: 80, y: 30 }, style, true, 's')!;
    expect(sq).toMatchObject({ w: 80, h: 80 });
    const neg = buildDragShape('rect', { x: 100, y: 100 }, { x: 60, y: 90 }, style, true, 's')!;
    expect(neg).toMatchObject({ x: 60, y: 60, w: 40, h: 40 });
    const a = buildDragShape('arrow', { x: 0, y: 0 }, { x: 100, y: 12 }, style, true, 'a')!;
    expect(a.type === 'arrow' && a.points[3]).toBeCloseTo(0, 6);
    const d = snapAngle({ x: 0, y: 0 }, { x: 50, y: 60 });
    expect(d.x).toBeCloseTo(d.y, 6);
    expect(snapAngle({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });

  it('blur shapes carry the current effect mode and are manual', () => {
    const b = buildDragShape('blur', { x: 0, y: 0 }, { x: 40, y: 20 }, { ...style, blurMode: 'pixelate' }, false, 'b');
    expect(b).toMatchObject({ type: 'blur', mode: 'pixelate', source: 'manual', w: 40, h: 20 });
  });

  it('returns null for tools that are not drag shapes', () => {
    for (const t of ['select', 'text', 'step', 'redact-brush'] as const) {
      expect(buildDragShape(t, { x: 0, y: 0 }, { x: 1, y: 1 }, style, false, 'x')).toBeNull();
    }
  });

  it('everything it builds is a valid document annotation', () => {
    const anns = (['arrow', 'line', 'rect', 'ellipse', 'blur'] as const).map((t, i) =>
      buildDragShape(t, { x: 10, y: 10 }, { x: 200, y: 120 }, style, false, `id${i}`),
    ) as Annotation[];
    expect(validateDoc({ ...docFor(800, 600), annotations: anns })).not.toBeNull();
  });
});

describe('guards against accidental clicks', () => {
  it('drops tiny drags', () => {
    const tiny = buildDragShape('rect', { x: 0, y: 0 }, { x: 2, y: 2 }, style, false, 'x')!;
    expect(isMeaningful(tiny, 4)).toBe(false);
    const big = buildDragShape('rect', { x: 0, y: 0 }, { x: 20, y: 20 }, style, false, 'x')!;
    expect(isMeaningful(big, 4)).toBe(true);
    const arrow = buildDragShape('arrow', { x: 0, y: 0 }, { x: 1, y: 1 }, style, false, 'x')!;
    expect(isMeaningful(arrow, 4)).toBe(false);
  });
});

describe('freehand strokes', () => {
  const line = (n: number) => Array.from({ length: n }, (_, i) => [i, i % 7]).flat();

  it('thins by distance and always keeps the ends', () => {
    const pts = [0, 0, 0.2, 0, 0.4, 0, 5, 0, 5.1, 0, 10, 0];
    const out = thinStroke(pts, 1);
    expect(out.slice(0, 2)).toEqual([0, 0]);
    expect(out.slice(-2)).toEqual([10, 0]);
    expect(out.length).toBeLessThan(pts.length);
  });

  it('caps a huge stroke to the document limit and keeps it valid', () => {
    const big = line(LIMITS.maxBrushNumbers * 2);
    const capped = capStroke(big);
    expect(capped.length).toBeLessThanOrEqual(LIMITS.maxBrushNumbers);
    expect(capped.length % 2).toBe(0);
    const doc = { ...docFor(800, 600), annotations: [{ id: 'b', type: 'redact-brush', points: capped, size: 20, mode: 'blur' }] };
    expect(validateDoc(doc)).not.toBeNull();
  });

  it('leaves small strokes alone', () => {
    const s = line(50);
    expect(capStroke(s)).toEqual(s);
  });
});

describe('annotation helpers', () => {
  it('translates every annotation type', () => {
    const arrow: Annotation = { id: 'a', type: 'arrow', points: [1, 2, 3, 4], color: '#fff', strokeWidth: 2 };
    expect(translateAnnotation(arrow, 10, 20)).toMatchObject({ points: [11, 22, 13, 24] });
    const brush: Annotation = { id: 'b', type: 'redact-brush', points: [1, 2, 3, 4], size: 8, mode: 'bar' };
    expect(translateAnnotation(brush, 1, 1)).toMatchObject({ points: [2, 3, 4, 5] });
    const rect: Annotation = { id: 'r', type: 'rect', x: 5, y: 6, w: 7, h: 8, color: '#fff', strokeWidth: 1 };
    expect(translateAnnotation(rect, -5, -6)).toMatchObject({ x: 0, y: 0, w: 7, h: 8 });
    const step: Annotation = { id: 's', type: 'step', x: 1, y: 1, n: 2, color: '#fff' };
    expect(translateAnnotation(step, 2, 3)).toMatchObject({ x: 3, y: 4, n: 2 });
  });

  it('reports bounds', () => {
    expect(annotationBounds({ id: 'a', type: 'arrow', points: [10, 40, 30, 20], color: '#fff', strokeWidth: 2 }, 800, 600)).toEqual({
      x: 10,
      y: 20,
      w: 20,
      h: 20,
    });
    const s = annotationBounds({ id: 's', type: 'step', x: 100, y: 100, n: 1, color: '#fff' }, 1000, 800);
    expect(s.w).toBe(stepRadius(1000, 800) * 2);
    expect(annotationBounds({ id: 'b', type: 'redact-brush', points: [0, 0, 10, 20], size: 4, mode: 'bar' }, 1, 1)).toEqual({
      x: 0,
      y: 0,
      w: 10,
      h: 20,
    });
  });

  it('default styles scale with the image so strokes stay visible', () => {
    const small = defaultStyleFor(800, 600);
    const big = defaultStyleFor(3840, 2400);
    expect(big.strokeWidth).toBeGreaterThan(small.strokeWidth);
    expect(big.fontSize).toBeGreaterThan(small.fontSize);
    expect(stepRadius(3840, 2400)).toBeGreaterThan(stepRadius(800, 600));
    expect(ANNOTATION_COLORS.length).toBeGreaterThanOrEqual(5);
  });
});

describe('planExport', () => {
  const doc = docFor(1000, 500, { padding: 0.1 });

  it('derives mime, scale and size', () => {
    const p = planExport(doc, { format: 'png', quality: 0.5, scale: 2, licensed: true });
    expect(p.mime).toBe('image/png');
    expect(p.quality).toBeUndefined();
    expect(p.size).toMatchObject({ width: 2400, height: 1400, pixelRatio: 2 });
    expect(p.matte).toBeNull();
  });

  it('gives JPEG an opaque matte and clamps quality', () => {
    const p = planExport(doc, { format: 'jpeg', quality: 5, scale: 1, licensed: true });
    expect(p.mime).toBe('image/jpeg');
    expect(p.matte).toBe('#ffffff');
    expect(p.quality).toBe(1);
    expect(planExport(doc, { format: 'webp', quality: -1, scale: 1, licensed: true }).quality).toBe(0.05);
  });

  it('gates the watermark by licence and fails closed on junk', () => {
    expect(planExport(doc, { format: 'png', quality: 1, scale: 1, licensed: false }).watermark).toBe(true);
    expect(planExport(doc, { format: 'png', quality: 1, scale: 1, licensed: true }).watermark).toBe(false);
    const junk = { format: 'gif', quality: Number.NaN, scale: 7, licensed: 'yes' } as never;
    const p = planExport(doc, junk);
    expect(p.watermark).toBe(true);
    expect(p.mime).toBe('image/png');
    expect(p.size.pixelRatio).toBe(1);
  });
});

describe('maskPreview', () => {
  it('shows only the last four digits of a card', () => {
    expect(maskPreview('card', '4111 1111 1111 1111')).toBe('••••1111');
    expect(maskPreview('card', '4111-1111-1111-1234')).toBe('••••1234');
  });

  it('hides most of an email, an IP and a token', () => {
    const email = maskPreview('email', 'maya.chen@northwind-labs.com');
    expect(email).toBe('m•••@•••.com');
    expect(email).not.toContain('chen');
    expect(maskPreview('ipv4', '203.0.113.42')).toBe('•••.•••.•••.42');
    const token = maskPreview('secret', 'ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5');
    expect(token).toBe('ghp_••••••A5');
    expect(token).not.toContain('aB3d');
    expect(maskPreview('secret', 'short')).toBe('••••••••');
    expect(maskPreview('ipv6', '2001:db8::8a2e:370:7334')).toContain('7334');
  });

  it('never throws on odd input', () => {
    expect(() => maskPreview('email', 'no-at-sign')).not.toThrow();
    expect(() => maskPreview('ipv4', 'x')).not.toThrow();
    expect(() => maskPreview('ipv6', '')).not.toThrow();
  });
});
