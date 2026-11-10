import type { Editor } from '@polishot/editor';
import { blobToBase64 } from './base64';
import { loadImage } from './editorInstance';
import { batchLimit } from './limits';
import { lookToPatch } from './look';
import { exportFileName } from './naming';
import { native } from './native';
import { MIME, type BatchPayload } from './payload';

export interface BatchHooks {
  /** Called after every image, successful or not. */
  onProgress(processed: number, failed: number, total: number): void;
  /** Resolves when Android has answered the save that was just sent (saved or error). */
  waitForSaveResult(): Promise<'saved' | 'error'>;
}

export interface BatchOutcome {
  processed: number;
  failed: number;
  total: number;
}

/**
 * Beautify every image with the user's last-used look and hand each result to Android for saving, one at a time
 * (a batch of full-resolution screenshots would not fit in memory otherwise).
 *
 * Each image gets its own auto-balance and auto background from `editor.load`; the stored look (padding, radius,
 * shadow, frame, preset, and any non-auto background) is applied on top. Free runs are limited to
 * FREE_BATCH_IMAGES; Android already trims the list, this is the second line of defence.
 */
export async function runBatch(editor: Editor, payload: BatchPayload, hooks: BatchHooks): Promise<BatchOutcome> {
  const items = payload.items.slice(0, batchLimit(payload.licensed));
  const total = items.length;
  const patch = lookToPatch(payload.lookJson);
  const { format, quality, scale } = payload.export;
  let failed = 0;

  for (let index = 0; index < total; index++) {
    const item = items[index];
    if (!item) continue;
    try {
      const img = await loadImage(item.imageUrl);
      editor.load({ id: item.id, width: img.naturalWidth, height: img.naturalHeight, element: img });
      if (patch) editor.update(patch);
      const blob = await editor.export({ format, quality, scale, licensed: payload.licensed });
      const base64 = await blobToBase64(blob);
      const result = hooks.waitForSaveResult();
      native.saveImage(base64, MIME[format], exportFileName(format, `-${String(index + 1).padStart(2, '0')}`));
      if ((await result) === 'error') failed++;
    } catch {
      failed++;
    }
    hooks.onProgress(index + 1, failed, total);
  }

  native.batchProgress(total, total, failed);
  return { processed: total, failed, total };
}
