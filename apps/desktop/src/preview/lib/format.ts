/** Small formatting helpers for the preview UI. Pure; locale and time zone are injectable for tests. */

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

/** "1280 × 800" */
export function formatDimensions(width: number, height: number): string {
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** Last path segment of a Windows or POSIX path. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Directory part of a path, without the trailing separator. */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return i > 0 ? path.slice(0, i) : '';
}

/** Shortens a long path in the middle, keeping the drive and the file name: `C:\Users\…\shot.png`. */
export function middleEllipsis(path: string, max = 44): string {
  if (path.length <= max) return path;
  const sep = path.includes('\\') ? '\\' : '/';
  const file = basename(path);
  const head = path.slice(0, path.indexOf(sep) + 1 || 3);
  const room = max - head.length - file.length - 2;
  if (room < 4) return `…${sep}${file}`.slice(-max);
  const rest = path.slice(head.length, path.length - file.length - 1);
  return `${head}${rest.slice(0, Math.max(0, room))}…${sep}${file}`;
}

export interface TimeOpts {
  now?: number;
  locale?: string;
  timeZone?: string;
}

function startOfDay(ts: number, timeZone?: string): number {
  // Calendar day in the requested zone, compared as a number.
  const f = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone });
  const [y, m, d] = f.format(ts).split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

/** "Today, 2:41 PM", "Yesterday, 9:12 AM", "12 Nov, 4:05 PM" or "12 Nov 2025" for older years. */
export function formatCaptureTime(ts: number, opts: TimeOpts = {}): string {
  const now = opts.now ?? Date.now();
  const { locale, timeZone } = opts;
  const time = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone }).format(ts);
  const days = Math.round((startOfDay(now, timeZone) - startOfDay(ts, timeZone)) / 86_400_000);
  if (days === 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  const sameYear =
    new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(ts) ===
    new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone }).format(now);
  if (sameYear) {
    return `${new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone }).format(ts)}, ${time}`;
  }
  return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone }).format(ts);
}

/** Plural helper: `plural(3, 'capture')` is "3 captures". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** A short single-line excerpt for a card; collapses whitespace and cuts on a word boundary. */
export function excerpt(text: string, max = 80): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd()}…`;
}

export const EXTENSION = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;

/** `polishot-20261110-143005.png`, the same naming the export panel uses. */
export function exportFilename(slug: string, format: keyof typeof EXTENSION, date: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const stamp = `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
  return `${slug}-${stamp}.${EXTENSION[format]}`;
}

/** Image format named by a file name's extension, or null. */
export function formatFromFilename(name: string): keyof typeof EXTENSION | null {
  const m = /\.(png|jpe?g|webp)$/i.exec(name);
  if (!m) return null;
  const ext = m[1]!.toLowerCase();
  return ext === 'png' ? 'png' : ext === 'webp' ? 'webp' : 'jpeg';
}

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

/** Joins a folder and a file name with the folder's own separator. */
export function joinPath(folder: string, name: string): string {
  if (!folder) return name;
  const BACKSLASH = String.fromCharCode(92);
  const sep = folder.includes('/') && !folder.includes(BACKSLASH) ? '/' : BACKSLASH;
  return folder.endsWith(BACKSLASH) || folder.endsWith('/') ? `${folder}${name}` : `${folder}${sep}${name}`;
}
