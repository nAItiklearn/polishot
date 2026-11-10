import Konva from 'konva';
import type { BrandMark } from './brandMark';
import { computeLayout } from './layout';
import { planExport } from './exportPlan';
import { Scene } from './render/scene';
import type { EditorDoc, ExportOptions, ImageSource } from './types';

export interface ExportExtras {
  /** Extra origins allowed for background and brand mark images. */
  origins?: readonly string[];
  /**
   * Pro brand mark drawn instead of the watermark. Ignored (the default watermark is drawn) unless
   * `opts.licensed === true`, and ignored when it is not a valid mark (see `sanitizeBrandMark`).
   */
  brandMark?: BrandMark | null;
}

/**
 * Renders a document to an image file at full resolution x scale on an offscreen stage. Standalone: it
 * needs no Editor instance, so it can be used for batch exports. The watermark is drawn when
 * `opts.licensed` is not exactly `true`; a Pro brand mark replaces it only when licensed.
 */
export async function exportDoc(
  doc: EditorDoc,
  image: ImageSource,
  opts: ExportOptions,
  extras: ExportExtras = {},
): Promise<Blob> {
  const plan = planExport(doc, opts);
  const layout = computeLayout(doc);
  const host = document.createElement('div');

  // Layer canvases are allocated at construction using the global pixel ratio; the offscreen stage must not
  // allocate device-pixel-ratio sized buffers. Restore the global before anything asynchronous happens.
  const previousRatio = Konva.pixelRatio;
  Konva.pixelRatio = 1;
  let scene: Scene;
  try {
    const stage = new Konva.Stage({ container: host, width: layout.width, height: layout.height });
    scene = new Scene(stage, { interactive: false, origins: extras.origins, matte: plan.matte });
    scene.setImage(image);
    scene.setLicensed(!plan.watermark);
    scene.setBrandMark(extras.brandMark ?? null);
    scene.render(doc);
  } finally {
    Konva.pixelRatio = previousRatio;
  }

  try {
    await scene.ready();
    // Background images load asynchronously; render again so they are part of the first draw.
    scene.render(doc);
    const blob = await scene.stage.toBlob({
      pixelRatio: plan.size.pixelRatio,
      mimeType: plan.mime,
      quality: plan.quality,
    });
    if (!blob) throw new Error('The browser could not encode the image.');
    return blob;
  } finally {
    scene.destroy();
  }
}
