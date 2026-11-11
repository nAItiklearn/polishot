/*
 * Wire format of the web-message transport between the page and the Android app (see EditorBridge.kt, BridgeMessages).
 * Pure functions, so they are unit tested under plain Node.
 *
 * Text message: a JSON object `{ "m": "<method>", ...fields }`.
 * Binary message (an image without base64 overhead): `u32 big-endian header length | header | image bytes`, where the
 * header is UTF-8 JSON `{ "m": "saveImage" | "shareImage" | "copyImage" | "quickSend", "mime": "...", "filename": "..." }`.
 */

export type ImageMethod = 'saveImage' | 'shareImage' | 'copyImage' | 'quickSend';

/** The JSON text for one call. Field order is not significant. */
export function textMessage(method: string, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({ m: method, ...fields });
}

/** The header of a binary message: which call it is, the image type and (for saves) the suggested file name. */
export function binaryHeader(method: ImageMethod, mime: string, filename?: string): Uint8Array<ArrayBuffer> {
  const header: Record<string, string> = { m: method, mime };
  if (filename) header.filename = filename;
  // Copied into a plain ArrayBuffer so the result is a valid Blob part.
  return new Uint8Array(new TextEncoder().encode(JSON.stringify(header)));
}

/** `length | header | image` as one ArrayBuffer, built by the browser without copying the image through JavaScript strings. */
export async function binaryMessage(method: ImageMethod, image: Blob, mime: string, filename?: string): Promise<ArrayBuffer> {
  const header = binaryHeader(method, mime, filename);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, header.length, false);
  return new Blob([length, header, image]).arrayBuffer();
}
