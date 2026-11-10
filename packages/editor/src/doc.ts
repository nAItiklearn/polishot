import { isSafeColor } from './color';
import { FRAME_IDS } from './frames';
import { CUSTOM_MAX, CUSTOM_MIN, PRESETS } from './presets';
import type {
  Annotation,
  Background,
  Box,
  DetectionKind,
  EditorDoc,
  FrameId,
  PresetId,
} from './types';

/* ------------------------------------------------------------------ */
/* Limits (documents are untrusted: they come from disk and IPC)        */
/* ------------------------------------------------------------------ */

export const LIMITS = {
  maxJsonChars: 8_000_000,
  maxAnnotations: 2000,
  /** Largest number of coordinates in one freehand stroke. */
  maxBrushNumbers: 20_000,
  /** Largest total of freehand coordinates in a document. */
  maxTotalBrushNumbers: 200_000,
  maxText: 2000,
  maxCoord: 1_000_000,
  maxImageSide: 65_535,
  maxImagePixels: 400_000_000,
  maxSrcChars: 24_000_000,
  maxScanNodes: 400_000,
  maxDepth: 8,
} as const;

export const DEFAULT_STYLE = {
  color: '#e4572e',
  strokeWidth: 4,
  fontSize: 28,
} as const;

const DETECTION_KINDS: readonly DetectionKind[] = ['email', 'card', 'ipv4', 'ipv6', 'secret'];
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/* ------------------------------------------------------------------ */
/* Ids and small helpers                                                */
/* ------------------------------------------------------------------ */

let idSeq = 0;
/** A short unique id that satisfies the id pattern accepted by validateDoc. */
export function newId(prefix = 'a'): string {
  const rnd = Math.floor(Math.random() * 36 ** 5)
    .toString(36)
    .padStart(5, '0');
  return `${prefix}_${Date.now().toString(36)}${(idSeq++ % 1296).toString(36)}${rnd}`;
}

/** Smallest positive integer not yet used by a step annotation (steps auto-increment, gaps are reused). */
export function nextStepNumber(annotations: readonly Annotation[]): number {
  const used = new Set<number>();
  for (const a of annotations) if (a.type === 'step') used.add(a.n);
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/* ------------------------------------------------------------------ */
/* createDoc                                                            */
/* ------------------------------------------------------------------ */

export function createDoc(image: { id: string; width: number; height: number }): EditorDoc {
  return {
    version: 1,
    image: { id: image.id, width: image.width, height: image.height },
    crop: null,
    padding: 0.08,
    background: { type: 'auto' },
    radius: 12,
    shadow: 0.5,
    frame: 'none',
    preset: 'auto',
    annotations: [],
  };
}

/* ------------------------------------------------------------------ */
/* Image source policy                                                  */
/* ------------------------------------------------------------------ */

const DATA_IMAGE_RE = /^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i;

/**
 * Image backgrounds may only point at inline `data:` images (no SVG), `blob:` URLs, or a URL on an origin
 * the host listed (default: the page's own origin). Everything else, including `javascript:`, `file:` and
 * remote hosts, is refused.
 */
export function isSafeImageSrc(src: unknown, allowedOrigins?: readonly string[]): boolean {
  if (typeof src !== 'string' || src.length === 0 || src.length > LIMITS.maxSrcChars) return false;
  if (DATA_IMAGE_RE.test(src)) return true;
  if (/^blob:/i.test(src)) return true;
  const loc = (globalThis as { location?: { href: string; origin: string } }).location;
  const origins = allowedOrigins ?? (loc ? [loc.origin] : []);
  if (origins.length === 0) return false;
  let url: URL;
  try {
    url = loc ? new URL(src, loc.href) : new URL(src);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return origins.includes(url.origin);
}

/* ------------------------------------------------------------------ */
/* validateDoc                                                          */
/* ------------------------------------------------------------------ */

export interface ValidateOptions {
  /** Extra origins allowed for image backgrounds (the page origin is always allowed). */
  origins?: readonly string[];
}

class Reject extends Error {}
function fail(): never {
  throw new Reject();
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Walks the untrusted structure once: depth, size and prototype-pollution keys. */
function scan(root: unknown): void {
  const stack: { v: unknown; d: number }[] = [{ v: root, d: 0 }];
  let nodes = 0;
  while (stack.length) {
    const { v, d } = stack.pop()!;
    if (typeof v !== 'object' || v === null) continue;
    if (d > LIMITS.maxDepth) fail();
    if (Array.isArray(v)) {
      nodes += v.length;
      if (nodes > LIMITS.maxScanNodes) fail();
      for (let i = 0; i < v.length; i++) {
        const el = v[i];
        if (typeof el === 'object' && el !== null) stack.push({ v: el, d: d + 1 });
      }
      continue;
    }
    if (!isPlainObject(v)) fail();
    const keys = Object.keys(v);
    nodes += keys.length;
    if (nodes > LIMITS.maxScanNodes) fail();
    for (const k of keys) {
      if (FORBIDDEN_KEYS.has(k)) fail();
      const el = v[k];
      if (typeof el === 'object' && el !== null) stack.push({ v: el, d: d + 1 });
    }
  }
}

const finite = (v: unknown): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fail();
  return v;
};
const coord = (v: unknown): number => {
  const n = finite(v);
  if (Math.abs(n) > LIMITS.maxCoord) fail();
  return n;
};
const ranged = (v: unknown, lo: number, hi: number): number => clamp(finite(v), lo, hi);
const str = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || v.length > max) return fail();
  return v;
};
const color = (v: unknown): string => {
  if (!isSafeColor(v)) return fail();
  return v;
};
const oneOf = <T extends string>(v: unknown, list: readonly T[]): T => {
  if (typeof v !== 'string' || !(list as readonly string[]).includes(v)) return fail();
  return v as T;
};
const posInt = (v: unknown, lo: number, hi: number): number => {
  const n = finite(v);
  if (!Number.isInteger(n) || n < lo || n > hi) return fail();
  return n;
};
const record = (v: unknown): Record<string, unknown> => (isPlainObject(v) ? v : fail());

function cleanText(s: string): string {
  // Keep newlines and tabs; drop other control characters. Text is only ever drawn, never parsed.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

function validateBackground(v: unknown, opts: ValidateOptions): Background {
  const o = record(v);
  const type = oneOf(o.type, ['auto', 'solid', 'gradient', 'image', 'none'] as const);
  const stops = (raw: unknown): [string, string] => {
    if (!Array.isArray(raw) || raw.length !== 2) return fail();
    return [color(raw[0]), color(raw[1])];
  };
  switch (type) {
    case 'auto': {
      const bg: Background = { type: 'auto' };
      if (o.color !== undefined) bg.color = color(o.color);
      if (o.stops !== undefined) bg.stops = stops(o.stops);
      return bg;
    }
    case 'solid':
      return { type: 'solid', color: color(o.color) };
    case 'gradient':
      return { type: 'gradient', stops: stops(o.stops), angle: ranged(o.angle, -720, 720) };
    case 'image': {
      const src = o.src;
      if (!isSafeImageSrc(src, opts.origins)) return fail();
      return { type: 'image', src: src as string, blur: ranged(o.blur, 0, 100) };
    }
    case 'none':
      return { type: 'none' };
  }
}

function validateAnnotation(v: unknown, ids: Set<string>, brushBudget: { n: number }): Annotation {
  const o = record(v);
  const id = o.id;
  if (typeof id !== 'string' || !ID_RE.test(id) || ids.has(id)) return fail();
  ids.add(id);
  const type = oneOf(o.type, ['arrow', 'line', 'rect', 'ellipse', 'text', 'step', 'blur', 'redact-brush'] as const);
  switch (type) {
    case 'arrow':
    case 'line': {
      const p = o.points;
      if (!Array.isArray(p) || p.length !== 4) return fail();
      return {
        id,
        type,
        points: [coord(p[0]), coord(p[1]), coord(p[2]), coord(p[3])],
        color: color(o.color),
        strokeWidth: ranged(o.strokeWidth, 0.5, 200),
      };
    }
    case 'rect':
    case 'ellipse': {
      const a: Annotation = {
        id,
        type,
        x: coord(o.x),
        y: coord(o.y),
        w: coord(o.w),
        h: coord(o.h),
        color: color(o.color),
        strokeWidth: ranged(o.strokeWidth, 0, 200),
      };
      if (o.fill !== undefined) {
        if (typeof o.fill !== 'boolean') return fail();
        a.fill = o.fill;
      }
      return a;
    }
    case 'text':
      return {
        id,
        type,
        x: coord(o.x),
        y: coord(o.y),
        text: cleanText(str(o.text, LIMITS.maxText)),
        fontSize: ranged(o.fontSize, 6, 512),
        color: color(o.color),
      };
    case 'step':
      return { id, type, x: coord(o.x), y: coord(o.y), n: posInt(o.n, 1, 9999), color: color(o.color) };
    case 'blur': {
      const w = coord(o.w);
      const h = coord(o.h);
      if (w <= 0 || h <= 0) return fail();
      const a: Annotation = {
        id,
        type,
        x: coord(o.x),
        y: coord(o.y),
        w,
        h,
        mode: oneOf(o.mode, ['blur', 'pixelate', 'bar'] as const),
        source: oneOf(o.source, ['manual', 'auto'] as const),
      };
      if (o.kind !== undefined) a.kind = oneOf(o.kind, DETECTION_KINDS);
      return a;
    }
    case 'redact-brush': {
      const p = o.points;
      if (!Array.isArray(p) || p.length < 2 || p.length % 2 !== 0 || p.length > LIMITS.maxBrushNumbers) return fail();
      brushBudget.n += p.length;
      if (brushBudget.n > LIMITS.maxTotalBrushNumbers) return fail();
      const points = new Array<number>(p.length);
      for (let i = 0; i < p.length; i++) points[i] = coord(p[i]);
      return {
        id,
        type,
        points,
        size: ranged(o.size, 1, 2000),
        mode: oneOf(o.mode, ['blur', 'bar'] as const),
      };
    }
  }
}

function validateCrop(v: unknown, imgW: number, imgH: number): Box | null {
  if (v === null) return null;
  const o = record(v);
  const x0 = clamp(coord(o.x), 0, imgW);
  const y0 = clamp(coord(o.y), 0, imgH);
  const x1 = clamp(coord(o.x) + coord(o.w), 0, imgW);
  const y1 = clamp(coord(o.y) + coord(o.h), 0, imgH);
  if (x1 - x0 < 1 || y1 - y0 < 1) return fail();
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Validates and normalises an untrusted document (object or JSON string). Returns a fresh, sanitised
 * EditorDoc (unknown keys dropped, ranges clamped) or `null` when the input is malformed or hostile:
 * wrong types, NaN/Infinity, oversized arrays, excessive nesting, duplicate ids, unsafe colours or image
 * sources, and prototype-pollution keys anywhere in the structure.
 */
export function validateDoc(json: unknown, opts: ValidateOptions = {}): EditorDoc | null {
  try {
    let input = json;
    if (typeof input === 'string') {
      if (input.length > LIMITS.maxJsonChars) return null;
      input = JSON.parse(input);
    }
    scan(input);
    const o = record(input);
    if (o.version !== 1) return null;

    const img = record(o.image);
    const id = img.id;
    if (typeof id !== 'string' || id.length === 0 || id.length > 128) return null;
    const width = posInt(img.width, 1, LIMITS.maxImageSide);
    const height = posInt(img.height, 1, LIMITS.maxImageSide);
    if (width * height > LIMITS.maxImagePixels) return null;

    const preset = oneOf(o.preset, Object.keys(PRESETS) as PresetId[]);
    const frame = oneOf(o.frame, FRAME_IDS as FrameId[]);

    let custom: EditorDoc['custom'];
    if (o.custom !== undefined) {
      const c = record(o.custom);
      custom = { width: posInt(c.width, CUSTOM_MIN, CUSTOM_MAX), height: posInt(c.height, CUSTOM_MIN, CUSTOM_MAX) };
    }

    const rawAnn = o.annotations;
    if (!Array.isArray(rawAnn) || rawAnn.length > LIMITS.maxAnnotations) return null;
    const ids = new Set<string>();
    const budget = { n: 0 };
    const annotations = rawAnn.map((a) => validateAnnotation(a, ids, budget));

    const doc: EditorDoc = {
      version: 1,
      image: { id, width, height },
      crop: validateCrop(o.crop === undefined ? null : o.crop, width, height),
      padding: ranged(o.padding, 0, 0.3),
      background: validateBackground(o.background, opts),
      radius: ranged(o.radius, 0, 512),
      shadow: ranged(o.shadow, 0, 1),
      frame,
      preset,
      annotations,
    };
    if (custom) doc.custom = custom;
    if (preset === 'custom' && !doc.custom) doc.custom = { width: 1200, height: 800 };
    return doc;
  } catch {
    // Reject (our own) and anything unexpected (JSON.parse, hostile getters/proxies) all mean "not a valid doc".
    return null;
  }
}
