import { Editor } from '@polishot/editor';

/** Space kept free around the artboard: room for the top bar above and the floating toolbar below. */
export const CANVAS_INSETS = { top: 64, right: 12, bottom: 92, left: 12 } as const;

let instance: Editor | null = null;

/**
 * The page's single Editor. It is created lazily, outlives React re-renders and is reused for every image
 * (`editor.load`), including the hidden batch run.
 */
export function getEditor(): Editor {
  if (!instance) {
    instance = new Editor(document.createElement('div'), { licensed: false, insets: CANVAS_INSETS });
  }
  return instance;
}

/** Decodes an image from the app's own capture route. */
export async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  await img.decode();
  if (img.naturalWidth < 1 || img.naturalHeight < 1) throw new Error('The image is empty.');
  return img;
}
