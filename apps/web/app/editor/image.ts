/**
 * Getting a picture into the editor: validation and local decoding. Nothing here touches the network.
 * Files are checked by size, declared type and magic bytes, and the pixel count is read from the header
 * before decoding so an oversized image is refused instead of exhausting the tab's memory.
 */

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export const ACCEPT_ATTR = [...ACCEPTED_TYPES, '.png', '.jpg', '.jpeg', '.webp'].join(',');
export const MAX_BYTES = 25 * 1024 * 1024;
/** 64 megapixels: an 8K screenshot fits with room to spare. */
export const MAX_PIXELS = 64_000_000;

export interface LoadedImage {
  /** Unique per load; the editor and OCR key their state on it. */
  id: string;
  name: string;
  width: number;
  height: number;
  bitmap: ImageBitmap;
  origin: 'file' | 'sample' | 'paste';
}

/** An error whose message is safe and useful to show to the user as is. */
export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageError';
  }
}

export const MSG_TYPE = 'That file is not a PNG, JPEG or WebP image. Choose a screenshot in one of those formats.';
export const MSG_SIZE = 'That image is larger than 25 MB. Choose a smaller one or crop it first.';
const MSG_PIXELS = 'That image has more than 64 megapixels, which is too many for a browser tab. Resize it and try again.';
const MSG_READ = 'That image could not be read. It may be damaged; try another file.';

type Kind = 'png' | 'jpeg' | 'webp';

const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

export function sniffKind(b: Uint8Array): Kind | null {
  if (b.length >= 8 && b[0] === 0x89 && ascii(b, 1, 'PNG') && b[4] === 0x0d && b[5] === 0x0a) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return 'webp';
  return null;
}

/** Pixel size from the file header, or null if it cannot be found in the bytes given. */
export function headerSize(b: Uint8Array, kind: Kind): { width: number; height: number } | null {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (kind === 'png') {
    return b.length >= 24 && ascii(b, 12, 'IHDR') ? { width: v.getUint32(16), height: v.getUint32(20) } : null;
  }
  if (kind === 'webp') {
    if (b.length < 30) return null;
    if (ascii(b, 12, 'VP8 ')) return { width: v.getUint16(26, true) & 0x3fff, height: v.getUint16(28, true) & 0x3fff };
    if (ascii(b, 12, 'VP8L') && b[20] === 0x2f) {
      const bits = v.getUint32(21, true);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (ascii(b, 12, 'VP8X')) {
      return {
        width: (b[24]! | (b[25]! << 8) | (b[26]! << 16)) + 1,
        height: (b[27]! | (b[28]! << 8) | (b[29]! << 16)) + 1,
      };
    }
    return null;
  }
  // JPEG: walk the marker segments to the first start-of-frame.
  let pos = 2;
  while (pos + 9 < b.length) {
    if (b[pos] !== 0xff) return null;
    const marker = b[pos + 1]!;
    if (marker === 0xff) {
      pos++;
      continue;
    }
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) return { height: v.getUint16(pos + 5), width: v.getUint16(pos + 7) };
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      pos += 2;
      continue;
    }
    pos += 2 + v.getUint16(pos + 2);
  }
  return null;
}

let counter = 0;
export const nextImageId = () => `img-${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Decodes a canvas or blob into a LoadedImage, enforcing the pixel limit. */
export async function toLoadedImage(
  source: Blob | HTMLCanvasElement,
  name: string,
  origin: LoadedImage['origin'],
): Promise<LoadedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageError(MSG_READ);
  }
  if (bitmap.width < 1 || bitmap.height < 1) {
    bitmap.close();
    throw new ImageError(MSG_READ);
  }
  if (bitmap.width * bitmap.height > MAX_PIXELS) {
    bitmap.close();
    throw new ImageError(MSG_PIXELS);
  }
  return { id: nextImageId(), name, width: bitmap.width, height: bitmap.height, bitmap, origin };
}

/** Validates and decodes a user-supplied file. Throws ImageError with a readable message. */
export async function loadImageFile(file: File, origin: LoadedImage['origin'] = 'file'): Promise<LoadedImage> {
  if (file.type && !(ACCEPTED_TYPES as readonly string[]).includes(file.type)) throw new ImageError(MSG_TYPE);
  if (file.size > MAX_BYTES) throw new ImageError(MSG_SIZE);
  if (file.size === 0) throw new ImageError(MSG_READ);

  let head: Uint8Array;
  try {
    head = new Uint8Array(await file.slice(0, 1024 * 1024).arrayBuffer());
  } catch {
    throw new ImageError(MSG_READ);
  }
  const kind = sniffKind(head);
  if (!kind) throw new ImageError(MSG_TYPE);
  const size = headerSize(head, kind);
  if (size && size.width * size.height > MAX_PIXELS) throw new ImageError(MSG_PIXELS);

  // Pasted screenshots are usually called "image.png"; keep whatever name the browser gives.
  return toLoadedImage(file, file.name || 'Pasted image', origin);
}
