/** Getting a finished image out of the tab: download, clipboard and the system share sheet. */

/** Saves a blob through a temporary `blob:` link. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // The download has started by the next task; give slow browsers a little longer before freeing it.
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Image clipboard writes need the async Clipboard API and ClipboardItem; both must exist. */
export function canCopyImage(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.isSecureContext &&
    typeof ClipboardItem !== 'undefined' &&
    typeof navigator.clipboard?.write === 'function'
  );
}

/**
 * Writes a PNG to the clipboard. The blob may be a promise: Safari only allows the write while the click's
 * user activation is still live, so the item must be created before the (slow) render finishes.
 */
export async function copyImage(png: Blob | Promise<Blob>): Promise<void> {
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
}

/** True when the browser can share this file through the system share sheet (mostly phones and tablets). */
export function canShareFile(file: File): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.share === 'function' && !!navigator.canShare?.({ files: [file] });
}

export function canShareFiles(): boolean {
  if (typeof File === 'undefined') return false;
  return canShareFile(new File([new Uint8Array(1)], 'probe.png', { type: 'image/png' }));
}

/** Opens the share sheet. Resolves false when the person dismissed it. */
export async function shareImage(blob: Blob, filename: string): Promise<boolean> {
  const file = new File([blob], filename, { type: blob.type });
  if (!canShareFile(file)) throw new Error('Sharing images is not supported here.');
  try {
    await navigator.share({ files: [file] });
    return true;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    throw err;
  }
}

export const EXTENSION = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;

/** 20261110-142530 */
export function timestamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
