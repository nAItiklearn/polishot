import type { Annotation } from '@polishot/editor';
import { describe, expect, it } from 'vitest';
import { annotationNear, stepRadius, type HitView } from './annotationHit';

/** The canvas shows the image at half size, 20 px in from the left and 10 px down. */
const view: HitView = { toScreen: (p) => ({ x: 20 + p.x * 0.5, y: 10 + p.y * 0.5 }), scale: 0.5 };
const IMAGE = { width: 1000, height: 800 };
const near = (list: Annotation[], x: number, y: number, tol?: number) => annotationNear(list, IMAGE, view, { x, y }, tol);

describe('annotationNear', () => {
  it('is false for an empty canvas', () => {
    expect(near([], 100, 100)).toBe(false);
  });

  it('hits a line or arrow along its length and within the stroke, not away from it', () => {
    const arrow: Annotation = { id: 'a', type: 'arrow', points: [100, 100, 500, 100], color: '#000', strokeWidth: 8 };
    // Image (300, 100) is screen (170, 60).
    expect(near([arrow], 170, 60)).toBe(true);
    expect(near([arrow], 170, 66)).toBe(true); // inside the stroke and the tolerance
    expect(near([arrow], 170, 90)).toBe(false);
    expect(near([arrow], 400, 60)).toBe(false); // past the end
  });

  it('hits only the outline of an empty rectangle, and all of a filled one', () => {
    const frame: Annotation = { id: 'r', type: 'rect', x: 100, y: 100, w: 400, h: 200, color: '#000', strokeWidth: 6 };
    // Screen rectangle: left 70, right 270, top 60, bottom 160.
    expect(near([frame], 70, 100)).toBe(true); // on the left edge
    expect(near([frame], 170, 60)).toBe(true); // on the top edge
    expect(near([frame], 170, 110)).toBe(false); // in the middle: text underneath stays selectable
    expect(near([frame], 400, 400)).toBe(false);
    const filled: Annotation = { ...frame, fill: true };
    expect(near([filled], 170, 110)).toBe(true);
  });

  it('treats an ellipse the same way', () => {
    const ring: Annotation = { id: 'e', type: 'ellipse', x: 100, y: 100, w: 400, h: 200, color: '#000', strokeWidth: 6 };
    // Centre (170, 110); radii 100 x 50.
    expect(near([ring], 270, 110)).toBe(true); // right-most point of the outline
    expect(near([ring], 170, 110)).toBe(false); // centre
    expect(near([ring], 500, 110)).toBe(false);
    expect(near([{ ...ring, fill: true }], 170, 110)).toBe(true);
  });

  it('hits a rectangle drawn backwards (negative width and height)', () => {
    const back: Annotation = { id: 'r', type: 'rect', x: 500, y: 300, w: -400, h: -200, color: '#000', strokeWidth: 6 };
    expect(near([back], 70, 100)).toBe(true);
  });

  it('hits a blur or redaction anywhere inside it', () => {
    const blur: Annotation = { id: 'b', type: 'blur', x: 200, y: 200, w: 300, h: 60, mode: 'blur', source: 'auto' };
    expect(near([blur], 170, 140)).toBe(true);
    expect(near([blur], 20, 20)).toBe(false);
  });

  it('hits a numbered step on its disc, using the same radius rule as the canvas', () => {
    expect(stepRadius(1000, 800)).toBe(11);
    expect(stepRadius(4000, 3000)).toBe(40);
    const step: Annotation = { id: 's', type: 'step', x: 400, y: 400, n: 1, color: '#c00' };
    // Centre at screen (220, 210); the disc is 11 * 0.5 = 5.5 px wide plus the tolerance.
    expect(near([step], 220, 210)).toBe(true);
    expect(near([step], 226, 210)).toBe(true);
    expect(near([step], 260, 210)).toBe(false);
  });

  it('hits a note over its text box', () => {
    const note: Annotation = { id: 't', type: 'text', x: 100, y: 100, text: 'Check this', fontSize: 40, color: '#000' };
    expect(near([note], 100, 70)).toBe(true);
    expect(near([note], 100, 300)).toBe(false);
  });

  it('follows a brush stroke along its path', () => {
    const stroke: Annotation = { id: 'p', type: 'redact-brush', points: [100, 100, 300, 100, 300, 300], size: 20, mode: 'bar' };
    expect(near([stroke], 120, 60)).toBe(true); // on the first leg
    expect(near([stroke], 170, 110)).toBe(true); // on the second leg
    expect(near([stroke], 60, 160)).toBe(false);
    const dot: Annotation = { id: 'q', type: 'redact-brush', points: [100, 100], size: 20, mode: 'bar' };
    expect(near([dot], 70, 60)).toBe(true);
  });

  it('widens with the tolerance', () => {
    const arrow: Annotation = { id: 'a', type: 'arrow', points: [100, 100, 500, 100], color: '#000', strokeWidth: 2 };
    expect(near([arrow], 170, 75, 6)).toBe(false);
    expect(near([arrow], 170, 75, 16)).toBe(true);
  });
});
