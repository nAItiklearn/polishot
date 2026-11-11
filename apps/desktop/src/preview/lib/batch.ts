/**
 * Batch beautify without the UI: which files a run takes (the Free limit of CONTRACTS 5b is enforced
 * here, by the host), what each result is called, and the loop itself with its dependencies injected,
 * so cancelling, failing one image and keeping the rest can be tested without a window.
 */
import { IMAGE_EXTENSIONS } from '../../shared/native';
import { basename, plural } from './format';

/** Even Pro stops here: a run holds one decoded image at a time, but the list and the history clean-up should stay sane. */
export const BATCH_HARD_CAP = 200;

const IMAGE_FILE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join('|')})$`, 'i');

export const isImagePath = (path: string): boolean => IMAGE_FILE.test(path);

export interface BatchPlan {
  /** Paths this run will process, in the order they were chosen. */
  files: string[];
  /** Images left out because they exceed the limit (not counting duplicates or non-images). */
  overLimit: number;
  /** Chosen files that are not images, or were chosen twice. */
  ignored: number;
}

/**
 * Picks the files a run will process: images only, each path once (Windows paths compare
 * case-insensitively), at most `limit` of them (and never more than {@link BATCH_HARD_CAP}).
 */
export function planBatch(paths: readonly string[], limit: number): BatchPlan {
  const cap = Math.min(limit, BATCH_HARD_CAP);
  const seen = new Set<string>();
  const files: string[] = [];
  let ignored = 0;
  let overLimit = 0;
  for (const p of paths) {
    const key = p.toLowerCase();
    if (!isImagePath(p) || seen.has(key)) {
      ignored++;
      continue;
    }
    seen.add(key);
    if (files.length < cap) files.push(p);
    else overLimit++;
  }
  return { files, overLimit, ignored };
}

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;
export type BatchFormat = keyof typeof EXT;

/** Characters Windows does not allow in a file name, plus control characters. */
const ILLEGAL = new RegExp('[<>:"/\\\\|?*\\u0000-\\u001f]', 'g');

/**
 * `<name>-polished.<ext>`, cleaned for Windows and made unique within this run (`-2`, `-3`). The save
 * folder never overwrites either, so a name that already exists on disk becomes `name (2)`.
 */
export function polishedName(sourcePath: string, format: BatchFormat, taken: Set<string>): string {
  const file = basename(sourcePath);
  const dot = file.lastIndexOf('.');
  const stemRaw = dot > 0 ? file.slice(0, dot) : file;
  const stem = stemRaw.replace(ILLEGAL, '_').replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 80) || 'image';
  const ext = EXT[format];
  let name = `${stem}-polished.${ext}`;
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${stem}-polished-${n}.${ext}`;
  taken.add(name.toLowerCase());
  return name;
}

export interface BatchDeps {
  /** Registers the file with the app and returns its capture id. */
  open(path: string): Promise<string>;
  /** Renders the beautified image for a capture id. */
  render(id: string): Promise<Blob>;
  /** Writes the bytes to the save folder; resolves to the final path. */
  save(blob: Blob, name: string): Promise<string>;
  /** Removes the temporary capture the open step created (best effort). */
  discard(id: string): Promise<void>;
}

export interface BatchProgress {
  /** 0-based index of the image being processed. */
  index: number;
  total: number;
  name: string;
}

export interface BatchResult {
  saved: string[];
  failed: Array<{ path: string; message: string }>;
  cancelled: boolean;
}

/**
 * Runs the batch one image at a time (never two decoded images at once). A failing image is recorded
 * and skipped; cancelling stops before the next image, and whatever was saved stays saved.
 */
export async function runBatch(
  files: readonly string[],
  format: BatchFormat,
  deps: BatchDeps,
  opts: { onProgress?: (p: BatchProgress) => void; isCancelled?: () => boolean; message?: (e: unknown) => string } = {},
): Promise<BatchResult> {
  const result: BatchResult = { saved: [], failed: [], cancelled: false };
  const taken = new Set<string>();
  const describe = opts.message ?? ((e: unknown) => (e instanceof Error ? e.message : String(e)));
  for (let i = 0; i < files.length; i++) {
    if (opts.isCancelled?.()) {
      result.cancelled = true;
      break;
    }
    const path = files[i]!;
    opts.onProgress?.({ index: i, total: files.length, name: basename(path) });
    let id: string | null = null;
    try {
      id = await deps.open(path);
      const blob = await deps.render(id);
      result.saved.push(await deps.save(blob, polishedName(path, format, taken)));
    } catch (e) {
      result.failed.push({ path, message: describe(e) });
    } finally {
      if (id) await deps.discard(id).catch(() => undefined);
    }
  }
  return result;
}

/** One sentence for the end of a run. */
export function batchSummary(r: BatchResult, total: number): string {
  const saved = plural(r.saved.length, 'image');
  if (r.cancelled) return r.saved.length ? `Stopped. ${saved} saved before that.` : 'Stopped. Nothing was saved.';
  if (r.failed.length === 0) return `${saved} saved.`;
  if (r.saved.length === 0) return total === 1 ? 'That image could not be processed.' : 'None of the images could be processed.';
  return `${saved} saved, ${r.failed.length} could not be processed.`;
}
