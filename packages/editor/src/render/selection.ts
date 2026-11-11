import Konva from 'konva';
import type { Annotation } from '../types';
import type { Scene } from './scene';

export interface SelectionHooks {
  /** Called while an arrow/line endpoint handle is dragged, with the new point in source px. */
  onHandleMove(id: string, index: 0 | 1, p: { x: number; y: number }): void;
  onHandleStart(): void;
  onHandleEnd(): void;
}

const FALLBACK_ACCENT = '#c8471d';

/** Touch screens get bigger handles. */
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/**
 * Selection chrome on the UI layer: a Transformer for boxes and text, endpoint handles for arrows and
 * lines, and a thin solid outline for everything else (steps, brush strokes).
 */
export class SelectionUI {
  readonly transformer: Konva.Transformer;
  private readonly handles: [Konva.Circle, Konva.Circle];
  private readonly outline: Konva.Rect;
  private accent = FALLBACK_ACCENT;
  private current: { ann: Annotation; node: Konva.Node } | null = null;

  constructor(
    private readonly scene: Scene,
    private readonly hooks: SelectionHooks,
  ) {
    const layer = scene.uiLayer!;
    this.transformer = new Konva.Transformer({
      rotateEnabled: false,
      ignoreStroke: true,
      keepRatio: false,
      // Quiet selection: a hairline accent outline and small round handles, never a heavy box.
      anchorSize: coarsePointer() ? 18 : 8,
      anchorCornerRadius: coarsePointer() ? 9 : 4,
      anchorStrokeWidth: 1.5,
      borderStrokeWidth: 1,
      padding: 0,
      flipEnabled: false,
      visible: false,
      boundBoxFunc: (oldBox, newBox) => (Math.abs(newBox.width) < 8 || Math.abs(newBox.height) < 8 ? oldBox : newBox),
    });
    this.outline = new Konva.Rect({ listening: false, visible: false, strokeWidth: 1, fillEnabled: false });
    const makeHandle = (index: 0 | 1) => {
      const c = new Konva.Circle({ radius: 5, strokeWidth: 1.5, fill: '#ffffff', draggable: true, visible: false });
      c.on('dragstart', () => this.hooks.onHandleStart());
      c.on('dragmove', () => {
        if (!this.current) return;
        const p = this.scene.designToSource({ x: c.x(), y: c.y() });
        this.hooks.onHandleMove(this.current.ann.id, index, p);
      });
      c.on('dragend', () => this.hooks.onHandleEnd());
      c.on('mouseenter', () => (scene.stage.container().style.cursor = 'grab'));
      c.on('mouseleave', () => (scene.stage.container().style.cursor = ''));
      return c;
    };
    this.handles = [makeHandle(0), makeHandle(1)];
    layer.add(this.outline, this.transformer, ...this.handles);
    this.readAccent();
  }

  /** Picks up the live `--ps-accent` token so the chrome follows light/dark themes. */
  readAccent(): void {
    const el = this.scene.stage.container();
    const v = getComputedStyle(el).getPropertyValue('--ps-accent').trim();
    this.accent = /^#[0-9a-f]{3,8}$/i.test(v) ? v : FALLBACK_ACCENT;
    this.transformer.setAttrs({ borderStroke: this.accent, anchorStroke: this.accent, anchorFill: '#ffffff' });
    this.outline.stroke(this.accent);
    for (const h of this.handles) h.stroke(this.accent);
  }

  get accentColor(): string {
    return this.accent;
  }

  clear(): void {
    this.current = null;
    this.transformer.nodes([]);
    this.transformer.visible(false);
    this.outline.visible(false);
    for (const h of this.handles) h.visible(false);
    this.scene.uiLayer?.batchDraw();
  }

  /** Shows the right chrome for `ann`/`node`; pass null to clear. Only shown in the select tool. */
  show(ann: Annotation | null, node: Konva.Node | null, active: boolean): void {
    this.current = ann && node ? { ann, node } : null;
    this.transformer.nodes([]);
    this.transformer.visible(false);
    this.outline.visible(false);
    for (const h of this.handles) h.visible(false);
    if (!ann || !node || !active) {
      this.scene.uiLayer?.batchDraw();
      return;
    }
    switch (ann.type) {
      case 'rect':
      case 'ellipse':
      case 'blur':
        this.transformer.setAttrs({
          keepRatio: false,
          enabledAnchors: ['top-left', 'top-center', 'top-right', 'middle-left', 'middle-right', 'bottom-left', 'bottom-center', 'bottom-right'],
        });
        this.transformer.nodes([node]);
        this.transformer.visible(true);
        break;
      case 'text':
        this.transformer.setAttrs({ keepRatio: true, enabledAnchors: ['top-left', 'top-right', 'bottom-left', 'bottom-right'] });
        this.transformer.nodes([node]);
        this.transformer.visible(true);
        break;
      case 'arrow':
      case 'line':
        this.placeHandles(ann);
        break;
      default:
        this.placeOutline(node);
    }
    this.scene.uiLayer?.batchDraw();
  }

  /** Re-positions handles after the view or the document changed. */
  refresh(ann: Annotation | null, node: Konva.Node | null, active: boolean): void {
    this.show(ann, node, active);
  }

  private placeHandles(ann: Extract<Annotation, { type: 'arrow' | 'line' }>): void {
    const k = 1 / Math.max(0.01, this.scene.stage.scaleX());
    const pts = ann.points;
    const a = this.scene.sourceToDesign({ x: pts[0], y: pts[1] });
    const b = this.scene.sourceToDesign({ x: pts[2], y: pts[3] });
    const r = (coarsePointer() ? 10 : 5) * k;
    this.handles[0].setAttrs({ x: a.x, y: a.y, visible: true, radius: r, strokeWidth: 1.5 * k });
    this.handles[1].setAttrs({ x: b.x, y: b.y, visible: true, radius: r, strokeWidth: 1.5 * k });
  }

  private placeOutline(node: Konva.Node): void {
    // Relative to the main layer, which is the annotation node's own ancestor and shares the UI layer's design-pixel
    // coordinates. (Relative to the UI layer, a different branch, Konva falls back to screen coordinates and the
    // outline lands in the wrong place whenever the view is zoomed or offset.)
    const r = node.getClientRect({ relativeTo: this.scene.mainLayer as unknown as Konva.Container });
    const k = 1 / Math.max(0.01, this.scene.stage.scaleX());
    const pad = 4 * k;
    this.outline.setAttrs({
      visible: true,
      x: r.x - pad,
      y: r.y - pad,
      width: r.width + 2 * pad,
      height: r.height + 2 * pad,
      cornerRadius: 4 * k,
      strokeWidth: 1 * k,
    });
  }
}
