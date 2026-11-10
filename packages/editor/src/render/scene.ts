import { WATERMARK_TEXT } from '@polishot/brand';
import Konva from 'konva';
import {
  backgroundCornerColor,
  gradientPoints,
  resolveBackground,
  type ResolvedBackground,
} from '../background';
import { brandImageBox, brandTextMaxWidth, markPlan, sanitizeBrandMark, type BrandMark } from '../brandMark';
import { parseColor, readableOn } from '../color';
import { frameSpec, type FrameSpec, type ShapeSpec } from '../frames';
import { computeLayout, contentBox } from '../layout';
import { brushBlurRadius, effectParams, strokeBounds } from '../redactions';
import { stepRadius } from '../tools';
import type { Annotation, Box, EditorDoc, ImageSource, Layout, Rect } from '../types';
import { watermarkLayout } from '../watermark';
import { applyKonvaFilter, buildBrushBitmap, buildEffectBitmap, intersect, snapOut } from './effects';
import { ImagePyramid } from './pyramid';

export const FONT_STACK =
  '"Geist Sans", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif';

/** Colour of solid redaction bars. Opaque, so nothing shows through. */
export const BAR_COLOR = '#0f0f0e';

export interface SceneOptions {
  /** Interactive scenes get a UI layer and hit detection; export scenes do not. */
  interactive: boolean;
  /** Extra origins allowed for background images. */
  origins?: readonly string[];
  /** Opaque colour painted behind everything (JPEG export). */
  matte?: string | null;
}

type PathCtx = {
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  arcTo(x1: number, y1: number, x2: number, y2: number, r: number): void;
  closePath(): void;
};

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Shadows on canvases longer than this (design px) are drawn from a cached bitmap while editing. */
const SHADOW_CACHE_MIN = 1800;
/** Longest side of that bitmap in device px. */
const SHADOW_CACHE_PX = 1400;

export function roundRectPath(
  ctx: PathCtx,
  x: number,
  y: number,
  w: number,
  h: number,
  radii: number | [number, number, number, number],
): void {
  const max = Math.min(w, h) / 2;
  const rr = typeof radii === 'number' ? [radii, radii, radii, radii] : radii;
  const [tl, tr, br, bl] = rr.map((v) => clamp(v, 0, max)) as [number, number, number, number];
  ctx.moveTo(x + tl, y);
  ctx.lineTo(x + w - tr, y);
  ctx.arcTo(x + w, y, x + w, y + tr, tr);
  ctx.lineTo(x + w, y + h - br);
  ctx.arcTo(x + w, y + h, x + w - br, y + h, br);
  ctx.lineTo(x + bl, y + h);
  ctx.arcTo(x, y + h, x, y + h - bl, bl);
  ctx.lineTo(x, y + tl);
  ctx.arcTo(x, y, x + tl, y, tl);
  ctx.closePath();
}

export function withAlpha(color: string, alpha: number): string {
  const p = parseColor(color);
  if (!p) return color;
  return `rgba(${p[0]}, ${p[1]}, ${p[2]}, ${(p[3] * alpha).toFixed(3)})`;
}

function shortKey(s: string): string {
  return s.length <= 96 ? s : `${s.length}:${s.slice(0, 48)}:${s.slice(-48)}`;
}

type Drawable = Konva.Group | Konva.Shape;

interface AnnEntry {
  node: Drawable;
  sig: string;
}

interface EffectEntry {
  key: string;
  canvas: HTMLCanvasElement;
  rect: Rect;
}

/**
 * The Konva scene graph for one document: background layer (background + soft shadow), main layer
 * (framed content with rounded clip, annotations, watermark) and, for interactive scenes, a UI layer
 * that the editor fills with selection handles. Everything is positioned in output pixels ("design
 * space"); the stage scale only fits that space into the container.
 */
export class Scene {
  readonly bgLayer: Konva.Layer;
  readonly mainLayer: Konva.Layer;
  readonly uiLayer: Konva.Layer | null;
  /** Annotation parent. Its transform maps source-image px to design px. */
  readonly annGroup: Konva.Group;
  private readonly draftGroup: Konva.Group;
  private readonly bgGroup: Konva.Group;
  private readonly shadowGroup: Konva.Group;
  private readonly shadowRects: Konva.Rect[];
  private readonly contentGroup: Konva.Group;
  private readonly chromeGroup: Konva.Group;
  private readonly imageClip: Konva.Group;
  private readonly imageNode: Konva.Image;
  private readonly hairline: Konva.Rect;
  private readonly watermark: Konva.Text;
  private readonly brandImage: Konva.Image;

  private image: ImageSource | null = null;
  private pyramid: ImagePyramid | null = null;
  private cropBox: Box = { x: 0, y: 0, w: 1, h: 1 };
  private imageEpoch = 0;
  private doc: EditorDoc | null = null;
  private spec: FrameSpec = frameSpec('none', 1, 1);
  private licensed = false;
  private brandMark: BrandMark | null = null;
  private readonly markImages = new Map<string, HTMLImageElement>();
  private readonly markLoading = new Set<string>();
  private markBitmap: { key: string; canvas: HTMLCanvasElement } | null = null;
  private selectMode = true;
  private resolvedBg: ResolvedBackground = { kind: 'none' };
  private readonly keys = { bg: '', frame: '', shadow: '' };
  private readonly annNodes = new Map<string, AnnEntry>();
  private readonly effects = new Map<string, EffectEntry>();
  private readonly bgImages = new Map<string, HTMLImageElement>();
  private readonly pending = new Set<Promise<unknown>>();
  private destroyed = false;
  private clip = { outer: false, radiusSrc: 0, imageRadius: null as number | null };
  layout: Layout;

  constructor(
    readonly stage: Konva.Stage,
    private readonly opts: SceneOptions,
  ) {
    this.bgLayer = new Konva.Layer({ listening: false });
    this.mainLayer = new Konva.Layer({ listening: opts.interactive });
    this.uiLayer = opts.interactive ? new Konva.Layer() : null;
    stage.add(this.bgLayer, this.mainLayer);
    if (this.uiLayer) stage.add(this.uiLayer);

    this.bgGroup = new Konva.Group({ listening: false });
    this.shadowGroup = new Konva.Group({ listening: false });
    this.bgLayer.add(this.bgGroup, this.shadowGroup);
    this.shadowRects = [0, 1, 2].map(() => new Konva.Rect({ listening: false, visible: false, fill: '#000' }));
    this.shadowGroup.add(...this.shadowRects);

    this.chromeGroup = new Konva.Group({ listening: false });
    this.imageNode = new Konva.Image({ image: undefined, listening: false });
    this.imageClip = new Konva.Group({ listening: false });
    this.imageClip.add(this.imageNode);
    this.hairline = new Konva.Rect({
      listening: false,
      stroke: 'rgba(0,0,0,0.12)',
      fillEnabled: false,
    });
    this.contentGroup = new Konva.Group({ listening: false });
    this.contentGroup.add(this.chromeGroup, this.imageClip, this.hairline);

    this.annGroup = new Konva.Group({ listening: opts.interactive });
    this.draftGroup = new Konva.Group({ listening: false });
    this.watermark = new Konva.Text({
      text: WATERMARK_TEXT,
      fontFamily: FONT_STACK,
      fontStyle: '600',
      listening: false,
      visible: false,
      opacity: 0.78,
    });
    this.brandImage = new Konva.Image({ image: undefined, listening: false, visible: false, opacity: 0.9 });
    this.mainLayer.add(this.contentGroup, this.annGroup, this.draftGroup, this.watermark, this.brandImage);

    if (!opts.interactive) {
      this.bgLayer.hitGraphEnabled(false);
      this.mainLayer.hitGraphEnabled(false);
      // Export scenes are drawn exactly once, by toBlob; never schedule animation-frame redraws.
      const noop = () => this.bgLayer;
      this.bgLayer.batchDraw = noop as typeof this.bgLayer.batchDraw;
      this.mainLayer.batchDraw = (() => this.mainLayer) as typeof this.mainLayer.batchDraw;
    }
    this.layout = {
      width: stage.width(),
      height: stage.height(),
      content: { x: 0, y: 0, w: 0, h: 0, scale: 1 },
      frame: { x: 0, y: 0, w: 0, h: 0 },
      pad: 0,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Inputs                                                             */
  /* ---------------------------------------------------------------- */

  setImage(image: ImageSource | null): void {
    this.image = image;
    this.imageEpoch++;
    this.effects.clear();
    this.pyramid = image && this.opts.interactive ? new ImagePyramid(image.element, image.width, image.height) : null;
    this.imageNode.image(image?.element as CanvasImageSource | undefined);
    for (const [id, e] of this.annNodes) {
      e.node.destroy();
      this.annNodes.delete(id);
    }
  }

  setLicensed(v: boolean): void {
    this.licensed = v === true;
    if (this.doc) this.renderWatermark();
  }

  /**
   * The Pro brand mark. Stored sanitised; it is only ever drawn while licensed (see `markPlan`), so setting
   * it on a Free editor has no visible effect.
   */
  setBrandMark(mark: unknown): void {
    this.brandMark = sanitizeBrandMark(mark, this.opts.origins);
    if (this.doc) this.renderWatermark();
  }

  /** In select mode annotations can be picked and dragged; with a drawing tool they are inert. */
  setSelectMode(on: boolean): void {
    this.selectMode = on;
    this.annGroup.listening(on && this.opts.interactive);
    for (const e of this.annNodes.values()) e.node.draggable(on && this.opts.interactive && this.canDrag(e.node));
  }

  private canDrag(node: Konva.Node): boolean {
    return node.getAttr('movable') !== false;
  }

  /** Fits the design canvas into a container; returns the view transform used. */
  setViewport(
    cssW: number,
    cssH: number,
    insets: { top: number; right: number; bottom: number; left: number },
  ): { scale: number; x: number; y: number } {
    const resized = this.stage.width() !== Math.max(1, cssW) || this.stage.height() !== Math.max(1, cssH);
    if (resized) this.stage.size({ width: Math.max(1, cssW), height: Math.max(1, cssH) });
    const availW = Math.max(1, cssW - insets.left - insets.right);
    const availH = Math.max(1, cssH - insets.top - insets.bottom);
    const fit = Math.min(availW / this.layout.width, availH / this.layout.height, 1);
    const scale = Number.isFinite(fit) && fit > 0 ? fit : 1;
    const x = insets.left + (availW - this.layout.width * scale) / 2;
    const y = insets.top + (availH - this.layout.height * scale) / 2;
    this.stage.scale({ x: scale, y: scale });
    this.stage.position({ x, y });
    if (resized) this.applyQuality();
    return { scale, x, y };
  }

  private applyQuality(): void {
    for (const layer of [this.bgLayer, this.mainLayer]) {
      const ctx = layer.getContext()._context as CanvasRenderingContext2D | undefined;
      if (ctx) ctx.imageSmoothingQuality = 'low';
    }
  }

  /** Scale from source px to CSS px on screen. */
  totalScale(): number {
    return this.layout.content.scale * this.stage.scaleX();
  }

  /* ---------------------------------------------------------------- */
  /* Coordinates                                                        */
  /* ---------------------------------------------------------------- */

  /** Design px (output canvas space) -> source image px. */
  designToSource(p: { x: number; y: number }): { x: number; y: number } {
    const box = this.doc ? contentBox(this.doc) : { x: 0, y: 0 };
    const c = this.layout.content;
    return { x: box.x + (p.x - c.x) / c.scale, y: box.y + (p.y - c.y) / c.scale };
  }

  sourceToDesign(p: { x: number; y: number }): { x: number; y: number } {
    const box = this.doc ? contentBox(this.doc) : { x: 0, y: 0 };
    const c = this.layout.content;
    return { x: c.x + (p.x - box.x) * c.scale, y: c.y + (p.y - box.y) * c.scale };
  }

  /** Container-relative CSS px -> design px. */
  cssToDesign(p: { x: number; y: number }): { x: number; y: number } {
    return { x: (p.x - this.stage.x()) / this.stage.scaleX(), y: (p.y - this.stage.y()) / this.stage.scaleY() };
  }

  /* ---------------------------------------------------------------- */
  /* Render                                                             */
  /* ---------------------------------------------------------------- */

  render(doc: EditorDoc, opts: { sync?: boolean } = {}): void {
    if (this.destroyed) return;
    this.doc = doc;
    const layout = computeLayout(doc);
    this.layout = layout;
    const box = contentBox(doc);

    for (const layer of [this.bgLayer, this.mainLayer]) {
      layer.clip({ x: 0, y: 0, width: layout.width, height: layout.height });
    }
    this.renderBackground();
    this.renderFrame(box);
    this.renderShadow();
    this.renderAnnotations(box);
    this.renderWatermark();
    this.draw(opts.sync === true);
  }

  draw(sync: boolean): void {
    if (this.destroyed) return;
    if (sync) {
      this.bgLayer.draw();
      this.mainLayer.draw();
      this.uiLayer?.draw();
    } else {
      this.bgLayer.batchDraw();
      this.mainLayer.batchDraw();
      this.uiLayer?.batchDraw();
    }
  }

  /** True while a background image or brand logo is still loading. */
  isLoading(): boolean {
    return this.pending.size > 0;
  }

  /** Resolves when background images that are still loading have been drawn. */
  async ready(): Promise<void> {
    for (let i = 0; i < 4 && this.pending.size > 0; i++) await Promise.allSettled([...this.pending]);
  }

  /**
   * Picks the image copy to draw: the original, or a half/quarter-size copy when the picture is shown much
   * smaller than its pixel size. Call after the view or the crop changes.
   */
  refreshImageLevel(): void {
    const image = this.image;
    if (!image) return;
    const box = this.cropBox;
    let element: CanvasImageSource = image.element;
    let kx = 1;
    let ky = 1;
    if (this.pyramid) {
      const dpr = Konva.pixelRatio || window.devicePixelRatio || 1;
      const needed = Math.max(image.width, image.height) * this.totalScale() * dpr;
      const level = this.pyramid.pick(needed);
      element = level.element;
      kx = level.width / image.width;
      ky = level.height / image.height;
    }
    if (this.imageNode.image() !== element) this.imageNode.image(element);
    this.imageNode.crop({ x: box.x * kx, y: box.y * ky, width: box.w * kx, height: box.h * ky });
  }

  /* ---- background ---- */

  private renderBackground(): void {
    const doc = this.doc!;
    const { width: W, height: H } = this.layout;
    const resolved = resolveBackground(doc.background, this.opts.origins);
    this.resolvedBg = resolved;
    const key = JSON.stringify([
      resolved.kind,
      resolved.kind === 'solid' ? resolved.color : '',
      resolved.kind === 'gradient' ? [resolved.stops, resolved.angle] : '',
      resolved.kind === 'image' ? [shortKey(resolved.src), resolved.blur] : '',
      W,
      H,
      this.opts.matte ?? '',
    ]);
    if (key === this.keys.bg) return;
    this.keys.bg = key;
    this.bgGroup.destroyChildren();
    if (this.opts.matte) {
      this.bgGroup.add(new Konva.Rect({ x: 0, y: 0, width: W, height: H, fill: this.opts.matte, listening: false }));
    }
    switch (resolved.kind) {
      case 'solid':
        this.bgGroup.add(new Konva.Rect({ x: 0, y: 0, width: W, height: H, fill: resolved.color, listening: false }));
        break;
      case 'gradient': {
        const g = gradientPoints(W, H, resolved.angle);
        this.bgGroup.add(
          new Konva.Rect({
            x: 0,
            y: 0,
            width: W,
            height: H,
            fillLinearGradientStartPoint: g.start,
            fillLinearGradientEndPoint: g.end,
            fillLinearGradientColorStops: [0, resolved.stops[0], 1, resolved.stops[1]],
            listening: false,
          }),
        );
        break;
      }
      case 'image':
        this.loadBackgroundImage(resolved, key);
        break;
      case 'none':
        break;
    }
  }

  private loadBackgroundImage(resolved: Extract<ResolvedBackground, { kind: 'image' }>, key: string): void {
    const done = (img: HTMLImageElement) => {
      if (this.destroyed || this.keys.bg !== key) return;
      this.buildImageBackground(img, resolved.blur);
      this.draw(false);
    };
    const cached = this.bgImages.get(resolved.src);
    if (cached) {
      done(cached);
      return;
    }
    const img = new Image();
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    if (/^https?:/i.test(resolved.src)) img.crossOrigin = 'anonymous';
    const p = new Promise<void>((resolve) => {
      img.onload = () => {
        this.bgImages.set(resolved.src, img);
        done(img);
        resolve();
      };
      img.onerror = () => resolve();
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    img.src = resolved.src;
  }

  private buildImageBackground(img: HTMLImageElement, blur: number): void {
    const { width: W, height: H } = this.layout;
    const iw = img.naturalWidth || img.width;
    const ih = img.naturalHeight || img.height;
    if (!iw || !ih) return;
    this.bgGroup.getChildren((n) => n.getAttr('role') === 'bgimage').forEach((n) => n.destroy());
    if (blur <= 0) {
      const s = Math.max(W / iw, H / ih);
      const cw = W / s;
      const ch = H / s;
      this.bgGroup.add(
        new Konva.Image({
          role: 'bgimage',
          image: img,
          x: 0,
          y: 0,
          width: W,
          height: H,
          crop: { x: (iw - cw) / 2, y: (ih - ch) / 2, width: cw, height: ch },
          listening: false,
        }),
      );
      return;
    }
    // Blur on a small canvas (cheap), drawn with an extra margin so the edges do not fade out.
    const long = 640;
    const k = long / Math.max(W, H);
    const sw = Math.max(8, Math.round(W * k));
    const sh = Math.max(8, Math.round(H * k));
    const radius = Math.max(1, Math.round((blur / 100) * 0.06 * long));
    const m = Math.ceil(radius * 2);
    const canvas = document.createElement('canvas');
    canvas.width = sw + 2 * m;
    canvas.height = sh + 2 * m;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const s = Math.max(canvas.width / iw, canvas.height / ih);
    const dw = iw * s;
    const dh = ih * s;
    ctx.drawImage(img, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
    applyKonvaFilter(canvas, 'blur', radius);
    this.bgGroup.add(
      new Konva.Image({
        role: 'bgimage',
        image: canvas,
        x: 0,
        y: 0,
        width: W,
        height: H,
        crop: { x: m, y: m, width: sw, height: sh },
        listening: false,
      }),
    );
  }

  /* ---- frame, image, shadow ---- */

  private renderFrame(box: Box): void {
    const doc = this.doc!;
    const { layout } = this;
    const s = layout.content.scale;
    const spec = frameSpec(doc.frame, box.w, box.h);
    this.spec = spec;

    const frameKey = `${doc.frame}|${box.w}|${box.h}`;
    if (frameKey !== this.keys.frame) {
      this.keys.frame = frameKey;
      this.chromeGroup.destroyChildren();
      for (const shape of spec.under) this.chromeGroup.add(shapeFromSpec(shape));
    }
    this.contentGroup.setAttrs({ x: layout.frame.x, y: layout.frame.y, scaleX: s, scaleY: s });
    this.imageNode.x(spec.insets.l);
    this.imageNode.y(spec.insets.t);
    this.imageNode.width(box.w);
    this.imageNode.height(box.h);
    this.cropBox = box;
    this.refreshImageLevel();

    const fw = box.w + spec.insets.l + spec.insets.r;
    const fh = box.h + spec.insets.t + spec.insets.b;
    const radiusSrc = doc.radius / s;
    this.clip = { outer: spec.outerClip, radiusSrc, imageRadius: spec.imageRadius };

    this.contentGroup.clipFunc(
      spec.outerClip
        ? (ctx) => {
            roundRectPath(ctx, 0, 0, fw, fh, this.clip.radiusSrc);
          }
        : (undefined as never),
    );
    this.imageClip.clipFunc(
      spec.imageRadius !== null
        ? (ctx) => {
            roundRectPath(ctx, spec.insets.l, spec.insets.t, box.w, box.h, this.clip.imageRadius ?? 0);
          }
        : (undefined as never),
    );

    // A one-device-pixel hairline keeps pale screenshots crisp against pale backdrops.
    const edge = spec.outerClip ? radiusSrc : 0;
    this.hairline.setAttrs({
      visible: spec.outerClip,
      x: 0,
      y: 0,
      width: fw,
      height: fh,
      cornerRadius: Math.min(edge, Math.min(fw, fh) / 2),
      strokeWidth: 2 / s,
    });
  }

  private renderShadow(): void {
    const doc = this.doc!;
    const { layout, spec } = this;
    const s = layout.content.scale;
    const amount = clamp(doc.shadow, 0, 1);
    const o = spec.outline;
    const r = o.r !== null ? o.r * s : doc.radius;
    // Inset by one px so the (hidden) caster never peeks out around the rounded corners.
    const x = layout.frame.x + o.x * s + 1;
    const y = layout.frame.y + o.y * s + 1;
    const w = Math.max(1, o.w * s - 2);
    const h = Math.max(1, o.h * s - 2);
    const u = clamp(Math.max(layout.frame.w, layout.frame.h) / 900, 0.55, 2.4);
    const layers = [
      { blur: 4 * u, dy: 1.5 * u, a: 0.2 },
      { blur: 16 * u, dy: 8 * u, a: 0.17 },
      { blur: 48 * u, dy: 26 * u, a: 0.26 },
    ];
    const alpha = Math.min(1, amount * 1.6);
    const visible = amount > 0.001;
    // The rects live at the group origin and the group is moved, so changing the padding (which only moves the
    // picture inside a bigger canvas) never invalidates the cached shadow bitmap below.
    this.shadowGroup.setAttrs({ x, y, visible });
    const key = JSON.stringify([visible, w, h, r, amount, u]);
    if (key === this.keys.shadow) return;
    this.keys.shadow = key;
    this.shadowGroup.clearCache();
    this.shadowRects.forEach((rect, i) => {
      const l = layers[i]!;
      rect.setAttrs({
        visible,
        x: 0,
        y: 0,
        width: w,
        height: h,
        cornerRadius: Math.max(0, r - 1),
        shadowColor: '#1c140d',
        shadowBlur: l.blur * (0.7 + 0.6 * amount),
        shadowOffsetY: l.dy,
        shadowOpacity: l.a * alpha,
        shadowEnabled: true,
      });
    });
    if (visible && this.opts.interactive) this.cacheShadow(w, h, layers);
  }

  /**
   * Blurring a big rectangle three times is the most expensive thing on the canvas (about 30 ms per frame for
   * a 4K capture when rasterised in software), and it would repeat on every frame of a padding drag. The
   * shadow is soft by nature, so on large canvases the interactive scene keeps it as a bitmap at reduced
   * resolution and just draws that. Exports always render the real thing.
   */
  private cacheShadow(w: number, h: number, layers: { blur: number; dy: number }[]): void {
    const margin = Math.ceil(Math.max(...layers.map((l) => l.blur * 1.3 + l.dy)) + 4);
    const bw = w + 2 * margin;
    const bh = h + 2 * margin;
    const longest = Math.max(bw, bh);
    if (longest <= SHADOW_CACHE_MIN) return;
    this.shadowGroup.cache({
      x: -margin,
      y: -margin,
      width: bw,
      height: bh,
      pixelRatio: Math.min(1, SHADOW_CACHE_PX / longest),
    });
  }

  /* ---- annotations ---- */

  private annSig(ann: Annotation, box: Box): string {
    const dep = ann.type === 'blur' || ann.type === 'redact-brush' ? `|${this.imageEpoch}|${box.x},${box.y},${box.w},${box.h}` : '';
    const img = ann.type === 'step' && this.image ? `|${this.image.width}x${this.image.height}` : '';
    return JSON.stringify(ann) + dep + img;
  }

  private renderAnnotations(box: Box): void {
    const doc = this.doc!;
    const { content } = this.layout;
    this.annGroup.setAttrs({
      x: content.x - box.x * content.scale,
      y: content.y - box.y * content.scale,
      scaleX: content.scale,
      scaleY: content.scale,
    });

    const seen = new Set<string>();
    let index = 0;
    for (const ann of doc.annotations) {
      seen.add(ann.id);
      const sig = this.annSig(ann, box);
      let entry = this.annNodes.get(ann.id);
      if (!entry || entry.sig !== sig) {
        entry?.node.destroy();
        this.annNodes.delete(ann.id);
        const node = this.createAnnotationNode(ann, box);
        if (node) {
          node.setAttrs({ annId: ann.id });
          node.draggable(this.selectMode && this.opts.interactive && this.canDrag(node));
          this.annGroup.add(node);
          entry = { node, sig };
          this.annNodes.set(ann.id, entry);
        } else entry = undefined;
      }
      if (entry) {
        if (entry.node.zIndex() !== index) entry.node.zIndex(index);
        index++;
      }
    }
    for (const [id, e] of this.annNodes) {
      if (!seen.has(id)) {
        e.node.destroy();
        this.annNodes.delete(id);
      }
    }
    for (const id of this.effects.keys()) if (!seen.has(id)) this.effects.delete(id);
    this.updateHitAreas();
  }

  /** Keeps thin strokes easy to click, independent of the zoom level. */
  updateHitAreas(): void {
    const minHit = 14 / Math.max(0.01, this.totalScale());
    for (const e of this.annNodes.values()) {
      const node: Konva.Node = e.node;
      const sw = node.getAttr('strokeWidth') as number | undefined;
      if (typeof sw === 'number' && node.getAttr('hitStrokeWidth') !== undefined) {
        node.setAttr('hitStrokeWidth', Math.max(sw, minHit));
      }
    }
  }

  getNode(id: string): Konva.Node | null {
    return this.annNodes.get(id)?.node ?? null;
  }

  /** The annotation id for a Konva target (walks up to the direct child of the annotation group). */
  annotationIdOf(target: Konva.Node | null): string | null {
    let n: Konva.Node | null = target;
    while (n && n.getParent() !== this.annGroup) n = n.getParent();
    const id = n?.getAttr('annId') as string | undefined;
    return id ?? null;
  }

  /** Visible part of a source-space rectangle: clipped to the content box. */
  private visibleRect(r: Rect, box: Box): Rect | null {
    return intersect(r, { x: box.x, y: box.y, w: box.w, h: box.h });
  }

  private createAnnotationNode(ann: Annotation, box: Box): Drawable | null {
    const hit = { hitStrokeWidth: 0 };
    switch (ann.type) {
      case 'arrow': {
        const head = clamp(ann.strokeWidth * 3.4, 10, 90);
        return new Konva.Arrow({
          points: [...ann.points],
          stroke: ann.color,
          fill: ann.color,
          strokeWidth: ann.strokeWidth,
          pointerLength: head,
          pointerWidth: head * 0.9,
          lineCap: 'round',
          lineJoin: 'round',
          ...hit,
          movable: true,
        });
      }
      case 'line':
        return new Konva.Line({
          points: [...ann.points],
          stroke: ann.color,
          strokeWidth: ann.strokeWidth,
          lineCap: 'round',
          lineJoin: 'round',
          ...hit,
        });
      case 'rect':
        return new Konva.Rect({
          x: ann.x,
          y: ann.y,
          width: ann.w,
          height: ann.h,
          stroke: ann.strokeWidth > 0 ? ann.color : undefined,
          strokeWidth: ann.strokeWidth,
          fill: ann.fill ? withAlpha(ann.color, 0.22) : undefined,
          cornerRadius: Math.min(10, Math.min(ann.w, ann.h) / 8),
          ...hit,
        });
      case 'ellipse':
        return new Konva.Ellipse({
          x: ann.x + ann.w / 2,
          y: ann.y + ann.h / 2,
          radiusX: Math.max(0.5, ann.w / 2),
          radiusY: Math.max(0.5, ann.h / 2),
          stroke: ann.strokeWidth > 0 ? ann.color : undefined,
          strokeWidth: ann.strokeWidth,
          fill: ann.fill ? withAlpha(ann.color, 0.22) : undefined,
          ...hit,
        });
      case 'text': {
        const t = new Konva.Text({
          x: ann.x,
          y: ann.y,
          text: ann.text,
          fontSize: ann.fontSize,
          fontFamily: FONT_STACK,
          fontStyle: '600',
          lineHeight: 1.25,
          fill: ann.color,
          wrap: 'none',
        });
        t.hitFunc((ctx, shape) => {
          ctx.beginPath();
          ctx.rect(0, 0, shape.width(), shape.height());
          ctx.closePath();
          ctx.fillShape(shape);
        });
        return t;
      }
      case 'step': {
        const w = this.image?.width ?? 1000;
        const h = this.image?.height ?? 1000;
        const r = stepRadius(w, h);
        const g = new Konva.Group({ x: ann.x, y: ann.y, movable: true });
        g.add(
          new Konva.Circle({ radius: r, fill: ann.color, stroke: 'rgba(255,255,255,0.9)', strokeWidth: Math.max(1.5, r * 0.12) }),
          new Konva.Text({
            text: String(ann.n),
            x: -r,
            y: -r,
            width: r * 2,
            height: r * 2,
            align: 'center',
            verticalAlign: 'middle',
            fontFamily: FONT_STACK,
            fontStyle: '700',
            fontSize: ann.n > 99 ? r * 0.8 : ann.n > 9 ? r * 0.95 : r * 1.1,
            fill: readableOn(ann.color),
            listening: false,
          }),
        );
        return g;
      }
      case 'blur':
        return this.createBlurNode(ann, box);
      case 'redact-brush':
        return this.createBrushNode(ann, box);
    }
  }

  private bar(x: number, y: number, w: number, h: number): Konva.Rect {
    return new Konva.Rect({ x, y, width: w, height: h, fill: BAR_COLOR, cornerRadius: Math.min(4, h / 5) });
  }

  private createBlurNode(ann: Extract<Annotation, { type: 'blur' }>, box: Box): Drawable | null {
    if (ann.mode === 'bar') return this.bar(ann.x, ann.y, ann.w, ann.h);
    const vis = this.visibleRect({ x: ann.x, y: ann.y, w: ann.w, h: ann.h }, box);
    if (!vis) return null;
    const v = snapOut(vis);
    const p = effectParams(ann.w, ann.h);
    const amount = ann.mode === 'blur' ? p.blurRadius : p.pixelSize;
    const key = `${this.imageEpoch}|${v.x},${v.y},${v.w},${v.h}|${ann.mode}|${amount}`;
    const bitmap = this.cachedEffect(ann.id, key, () =>
      this.image
        ? buildEffectBitmap(this.image.element, this.image.width, this.image.height, vis, ann.mode as 'blur' | 'pixelate', amount)
        : null,
    );
    // Fail closed: if the effect cannot be computed, cover the region with an opaque bar.
    if (!bitmap) return this.bar(v.x, v.y, v.w, v.h);
    return new Konva.Image({ image: bitmap.canvas, x: bitmap.rect.x, y: bitmap.rect.y, width: bitmap.rect.w, height: bitmap.rect.h });
  }

  private createBrushNode(ann: Extract<Annotation, { type: 'redact-brush' }>, box: Box): Drawable | null {
    if (ann.mode === 'bar') {
      return new Konva.Line({
        points: [...ann.points],
        stroke: BAR_COLOR,
        strokeWidth: ann.size,
        lineCap: 'round',
        lineJoin: 'round',
        tension: 0,
        hitStrokeWidth: Math.max(ann.size, 14),
      });
    }
    const vis = this.visibleRect(strokeBounds(ann.points, ann.size), box);
    if (!vis) return null;
    const v = snapOut(vis);
    const radius = brushBlurRadius(ann.size);
    const key = `${this.imageEpoch}|${v.x},${v.y},${v.w},${v.h}|brush|${radius}|${ann.size}|${ann.points.length}|${ann.points.slice(0, 6).join(',')}|${ann.points.slice(-4).join(',')}`;
    const bitmap = this.cachedEffect(ann.id, key, () =>
      this.image
        ? buildBrushBitmap(this.image.element, this.image.width, this.image.height, vis, ann.points, ann.size, radius)
        : null,
    );
    if (!bitmap) {
      return new Konva.Line({
        points: [...ann.points],
        stroke: BAR_COLOR,
        strokeWidth: ann.size,
        lineCap: 'round',
        lineJoin: 'round',
      });
    }
    return new Konva.Image({ image: bitmap.canvas, x: bitmap.rect.x, y: bitmap.rect.y, width: bitmap.rect.w, height: bitmap.rect.h });
  }

  /** Effect bitmaps are cached per annotation, so unrelated edits never recompute a blur. */
  private cachedEffect(
    id: string,
    key: string,
    build: () => { canvas: HTMLCanvasElement; rect: Rect } | null,
  ): { canvas: HTMLCanvasElement; rect: Rect } | null {
    const hit = this.effects.get(id);
    if (hit && hit.key === key) return hit;
    const built = build();
    if (built) this.effects.set(id, { key, canvas: built.canvas, rect: built.rect });
    else this.effects.delete(id);
    return built;
  }

  /* ---- draft (annotation being drawn) ---- */

  setDraft(ann: Annotation | null, accent: string): void {
    this.draftGroup.destroyChildren();
    this.draftGroup.setAttrs({
      x: this.annGroup.x(),
      y: this.annGroup.y(),
      scaleX: this.annGroup.scaleX(),
      scaleY: this.annGroup.scaleY(),
    });
    if (ann && this.doc) {
      const node = this.createDraftNode(ann, accent);
      if (node) {
        node.listening(false);
        this.draftGroup.add(node);
      }
    }
    this.mainLayer.batchDraw();
  }

  private createDraftNode(ann: Annotation, accent: string): Drawable | null {
    const sw = 1.5 / Math.max(0.01, this.totalScale());
    switch (ann.type) {
      case 'blur':
        return new Konva.Rect({
          x: ann.x,
          y: ann.y,
          width: ann.w,
          height: ann.h,
          stroke: accent,
          strokeWidth: sw,
          dash: [6 * sw, 4 * sw],
          fill: withAlpha(accent, 0.12),
        });
      case 'redact-brush':
        return new Konva.Line({
          points: [...ann.points],
          stroke: withAlpha(ann.mode === 'bar' ? BAR_COLOR : accent, ann.mode === 'bar' ? 0.8 : 0.45),
          strokeWidth: ann.size,
          lineCap: 'round',
          lineJoin: 'round',
        });
      default:
        return this.doc ? this.createAnnotationNode(ann, contentBox(this.doc)) : null;
    }
  }

  /* ---- watermark and brand mark ---- */

  /**
   * Draws the corner mark for the current plan: our watermark while Free, the Pro user's text or logo, or
   * nothing. The decision lives in `markPlan`, which fails closed. The same code runs on screen and in exports.
   */
  private renderWatermark(): void {
    const plan = markPlan(this.licensed, this.brandMark, this.opts.origins);
    const { width, height } = this.layout;
    this.watermark.visible(plan.kind === 'default' || plan.kind === 'text');
    this.brandImage.visible(false);
    if (plan.kind === 'none') return;
    if (plan.kind === 'image') {
      this.renderBrandImage(plan.src);
      return;
    }
    const wl = watermarkLayout(width, height);
    const corner = backgroundCornerColor(this.resolvedBg);
    const fill = corner ? readableOn(corner) : '#000000';
    this.watermark.setAttrs({
      text: plan.kind === 'text' ? plan.text : WATERMARK_TEXT,
      fontSize: wl.fontSize,
      fill,
      wrap: 'none',
      ellipsis: true,
    });
    this.watermark.width('auto');
    if (plan.kind === 'text') {
      const cap = brandTextMaxWidth(width);
      if (this.watermark.width() > cap) this.watermark.width(cap);
    }
    const w = this.watermark.width();
    this.watermark.setAttrs({ x: width - wl.margin - w, y: height - wl.margin - wl.fontSize });
  }

  private renderBrandImage(src: string): void {
    const img = this.markImages.get(src);
    if (img) {
      this.placeBrandImage(img);
      return;
    }
    if (this.markLoading.has(src)) return;
    this.markLoading.add(src);
    const el = new Image();
    el.decoding = 'async';
    el.referrerPolicy = 'no-referrer';
    if (/^https?:/i.test(src)) el.crossOrigin = 'anonymous';
    const p = new Promise<void>((resolve) => {
      el.onload = () => {
        this.markLoading.delete(src);
        this.markImages.set(src, el);
        if (!this.destroyed) {
          this.renderWatermark();
          this.draw(false);
        }
        resolve();
      };
      el.onerror = () => {
        this.markLoading.delete(src);
        resolve();
      };
    });
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    el.src = src;
  }

  private placeBrandImage(img: HTMLImageElement): void {
    const { width, height } = this.layout;
    const nw = img.naturalWidth || img.width;
    const nh = img.naturalHeight || img.height;
    const box = brandImageBox(width, height, nw, nh);
    if (!box) return;
    // A big logo is shrunk once with a high quality filter (up to 3x the box, enough for a 3x export), so
    // the final draw does not alias.
    let source: CanvasImageSource = img;
    if (nw > box.w * 3) {
      const tw = Math.max(1, Math.round(box.w * 3));
      const th = Math.max(1, Math.round(box.h * 3));
      const key = `${img.src.length}:${img.src.slice(-32)}:${tw}x${th}`;
      if (this.markBitmap?.key !== key) {
        const canvas = document.createElement('canvas');
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, tw, th);
          this.markBitmap = { key, canvas };
        }
      }
      if (this.markBitmap?.key === key) source = this.markBitmap.canvas;
    }
    this.brandImage.setAttrs({ image: source, x: box.x, y: box.y, width: box.w, height: box.h, visible: true });
  }

  /* ---------------------------------------------------------------- */

  destroy(): void {
    this.destroyed = true;
    this.annNodes.clear();
    this.effects.clear();
    this.bgImages.clear();
    this.markImages.clear();
    this.markLoading.clear();
    this.markBitmap = null;
    this.stage.destroy();
  }
}

function shapeFromSpec(s: ShapeSpec): Konva.Shape {
  switch (s.t) {
    case 'rect': {
      const cfg: Konva.RectConfig = {
        x: s.x,
        y: s.y,
        width: s.w,
        height: s.h,
        cornerRadius: s.r ?? 0,
        fill: s.fill,
        stroke: s.stroke,
        strokeWidth: s.sw ?? 0,
        listening: false,
      };
      if (s.grad) {
        cfg.fillLinearGradientStartPoint = { x: 0, y: 0 };
        cfg.fillLinearGradientEndPoint = { x: 0, y: s.h };
        cfg.fillLinearGradientColorStops = [0, s.grad[0], 1, s.grad[1]];
      }
      return new Konva.Rect(cfg);
    }
    case 'circle':
      return new Konva.Circle({ x: s.x, y: s.y, radius: s.r, fill: s.fill, listening: false });
    case 'line':
      return new Konva.Line({ points: s.points, stroke: s.stroke, strokeWidth: s.sw, lineCap: 'round', listening: false });
  }
}
