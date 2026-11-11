import { sanitizeBrandMark, type BrandMark, type PresetId } from '@polishot/editor';
import type { OcrWord } from '@polishot/redact';

/*
 * Types and validators for everything Android sends into the page (`window.polishot.*`). The native side is our
 * own code, but the page still treats the payloads as untrusted input: a malformed value is dropped, never
 * half-applied. Nothing here touches the DOM, so this file runs under plain Node in the unit tests.
 */

export type ThemeName = 'light' | 'dark';
export type ExportFormat = 'png' | 'jpeg' | 'webp';

export interface ExportDefaults {
  format: ExportFormat;
  /** 0.4 to 1 */
  quality: number;
  scale: 1 | 2 | 3;
}

export interface LoadPayload {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
  /** True when the user is Pro (CONTRACTS 5b: no watermark, no free-tier limits). */
  licensed: boolean;
  theme: ThemeName;
  words?: OcrWord[];
  docJson?: string;
  exportDefaults: ExportDefaults;
  defaultPreset: PresetId;
  quickSendAvailable: boolean;
  /** Pro brand mark (your name or logo instead of the watermark); only ever drawn while the licence is Pro (licensed is true). */
  brandMark?: BrandMark;
}

export interface BatchItem {
  id: string;
  imageUrl: string;
  width: number;
  height: number;
}

export interface BatchPayload {
  items: BatchItem[];
  lookJson?: string;
  licensed: boolean;
  theme: ThemeName;
  export: ExportDefaults;
  brandMark?: BrandMark;
}

export type NotifyKind = 'saved' | 'copied' | 'shared' | 'sent' | 'error';

export interface NotifyPayload {
  kind: NotifyKind;
  message: string;
}

export const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const CAPTURE_PATH = /^\/capture\/[A-Za-z0-9_-]{1,64}\.png$/;
const PRESET_IDS: readonly PresetId[] = ['auto', 'x', 'linkedin', 'ig-square', 'ig-story', 'youtube', 'custom'];
const NOTIFY_KINDS: readonly NotifyKind[] = ['saved', 'copied', 'shared', 'sent', 'error'];

export const MAX_IMAGE_SIDE = 65_535;
export const MAX_WORDS = 20_000;
export const MAX_WORD_CHARS = 4000;
export const MAX_DOC_JSON_CHARS = 8_000_000;
export const MAX_BATCH_ITEMS = 100;
export const MAX_LOOK_JSON_CHARS = 400_000;
/** A logo arrives as a data URL; Android stores it at most 1 MB, which is about 1.4 million base64 characters. */
export const MAX_BRAND_SRC_CHARS = 3_000_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Only images served by the app's own `/capture/<id>.png` route may be loaded. */
export function isCaptureUrl(url: unknown, origin: string): url is string {
  if (typeof url !== 'string' || url.length > 300) return false;
  try {
    const u = new URL(url, origin);
    return u.origin === origin && CAPTURE_PATH.test(u.pathname) && u.search === '' && u.hash === '';
  } catch {
    return false;
  }
}

/**
 * The optional Pro brand mark. A bad value is dropped (the export is then clean for Pro, or watermarked for
 * Free), never a reason to refuse the whole payload. sanitizeBrandMark from the editor package does the real
 * check: text is cleaned and cut, an image must be a raster data: or blob: URL.
 */
export function parseBrandMark(raw: unknown): BrandMark | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.type === 'image' && typeof raw.src === 'string' && raw.src.length > MAX_BRAND_SRC_CHARS) return undefined;
  if (raw.type === 'text' && typeof raw.text === 'string' && raw.text.length > 400) return undefined;
  return sanitizeBrandMark(raw) ?? undefined;
}

export function parseTheme(v: unknown): ThemeName {
  return v === 'dark' ? 'dark' : 'light';
}

export function parseExportDefaults(raw: unknown): ExportDefaults {
  const fallback: ExportDefaults = { format: 'png', quality: 0.92, scale: 2 };
  if (!isRecord(raw)) return fallback;
  const format: ExportFormat = raw.format === 'jpeg' || raw.format === 'webp' ? raw.format : 'png';
  const quality = isFiniteNumber(raw.quality) ? Math.min(1, Math.max(0.4, raw.quality)) : fallback.quality;
  const scale = raw.scale === 1 || raw.scale === 3 ? raw.scale : 2;
  return { format, quality, scale };
}

export function parseWords(raw: unknown): OcrWord[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_WORDS) return null;
  const out: OcrWord[] = [];
  for (const w of raw) {
    if (!isRecord(w) || typeof w.text !== 'string' || w.text.length === 0 || w.text.length > MAX_WORD_CHARS) return null;
    const b = w.box;
    if (!isRecord(b) || !isFiniteNumber(b.x) || !isFiniteNumber(b.y) || !isFiniteNumber(b.w) || !isFiniteNumber(b.h)) return null;
    if (b.w <= 0 || b.h <= 0) return null;
    if (!isInt(w.line, 0, 1_000_000)) return null;
    out.push({ text: w.text, box: { x: b.x, y: b.y, w: b.w, h: b.h }, line: w.line });
  }
  return out;
}

export function parseLoad(raw: unknown, origin: string): LoadPayload | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return null;
  if (!isCaptureUrl(raw.imageUrl, origin)) return null;
  if (!isInt(raw.width, 1, MAX_IMAGE_SIDE) || !isInt(raw.height, 1, MAX_IMAGE_SIDE)) return null;
  if (typeof raw.licensed !== 'boolean') return null;

  let words: OcrWord[] | undefined;
  if (raw.words !== undefined) {
    const parsed = parseWords(raw.words);
    if (parsed === null) return null;
    words = parsed;
  }
  let docJson: string | undefined;
  if (raw.docJson !== undefined) {
    if (typeof raw.docJson !== 'string' || raw.docJson.length > MAX_DOC_JSON_CHARS) return null;
    docJson = raw.docJson;
  }
  const preset = PRESET_IDS.find((p) => p === raw.defaultPreset) ?? 'auto';
  const brandMark = parseBrandMark(raw.brandMark);

  return {
    id: raw.id,
    imageUrl: raw.imageUrl,
    width: raw.width,
    height: raw.height,
    licensed: raw.licensed,
    theme: parseTheme(raw.theme),
    ...(words ? { words } : {}),
    ...(docJson ? { docJson } : {}),
    exportDefaults: parseExportDefaults(raw.exportDefaults),
    defaultPreset: preset,
    quickSendAvailable: raw.quickSendAvailable === true,
    ...(brandMark ? { brandMark } : {}),
  };
}

export function parseBatch(raw: unknown, origin: string): BatchPayload | null {
  if (!isRecord(raw) || !Array.isArray(raw.items) || raw.items.length === 0 || raw.items.length > MAX_BATCH_ITEMS) return null;
  if (typeof raw.licensed !== 'boolean') return null;
  const items: BatchItem[] = [];
  for (const it of raw.items) {
    if (!isRecord(it) || typeof it.id !== 'string' || !ID_PATTERN.test(it.id)) return null;
    if (!isCaptureUrl(it.imageUrl, origin)) return null;
    if (!isInt(it.width, 1, MAX_IMAGE_SIDE) || !isInt(it.height, 1, MAX_IMAGE_SIDE)) return null;
    items.push({ id: it.id, imageUrl: it.imageUrl, width: it.width, height: it.height });
  }
  let lookJson: string | undefined;
  if (raw.lookJson !== undefined) {
    if (typeof raw.lookJson !== 'string' || raw.lookJson.length > MAX_LOOK_JSON_CHARS) return null;
    lookJson = raw.lookJson;
  }
  const batchMark = parseBrandMark(raw.brandMark);
  return {
    items,
    ...(lookJson ? { lookJson } : {}),
    licensed: raw.licensed,
    theme: parseTheme(raw.theme),
    export: parseExportDefaults(raw.export),
    ...(batchMark ? { brandMark: batchMark } : {}),
  };
}

export function parseNotify(raw: unknown): NotifyPayload | null {
  if (!isRecord(raw) || typeof raw.message !== 'string') return null;
  const kind = NOTIFY_KINDS.find((k) => k === raw.kind);
  if (!kind) return null;
  return { kind, message: raw.message.slice(0, 200) };
}

export const MIME: Record<ExportFormat, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

export const EXTENSION: Record<ExportFormat, string> = {
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
};
