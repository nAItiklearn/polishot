import Konva from 'konva';
import { analyzeImage } from './analysis';
import { sanitizeBrandMark, type BrandMark } from './brandMark';
import { createDoc, newId, nextStepNumber, validateDoc, LIMITS } from './doc';
import { exportDoc } from './export';
import { History } from './history';
import { computeLayout } from './layout';
import { redactionsFromDetections } from './redactions';
import { Scene } from './render/scene';
import { SelectionUI } from './render/selection';
import { TextEditor } from './render/textEditor';
import { mapSelectionShortcut, mapShortcut } from './shortcuts';
import {
  buildDragShape,
  capStroke,
  duplicateAnnotation,
  defaultStyleFor,
  isMeaningful,
  renumberSteps,
  thinStroke,
  translateAnnotation,
  type Point,
} from './tools';
import type {
  Annotation,
  Background,
  Box,
  Detection,
  EditorDoc,
  EditorEvent,
  ExportOptions,
  ImageSource,
  Style,
  Tool,
} from './types';

export interface ViewInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface EditorOptions {
  /** Pro: no watermark, and the brand mark (if any) is drawn instead. Only the boolean `true` counts. */
  licensed: boolean;
  /** Pro brand mark; ignored while `licensed` is false. Can be changed later with `setBrandMark`. */
  brandMark?: BrandMark | null;
  /** Extra origins allowed for background image URLs (the page origin is always allowed). */
  origins?: readonly string[];
  /** Space kept free around the canvas in the viewport, in CSS px (default 24 on every side). */
  insets?: Partial<ViewInsets>;
}

/** Controls that use the arrow keys themselves: sliders, selects, buttons (toolbar), menus. */
function isControl(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.closest('input, select, textarea, button, a[href], [role="slider"], [role="toolbar"], [role="listbox"], [role="menu"], [contenteditable="true"]') !== null;
}

const DRAW_TOOLS: ReadonlySet<Tool> = new Set(['arrow', 'rect', 'ellipse', 'line', 'text', 'blur', 'step', 'redact-brush']);

const CURSORS: Record<Tool, string> = {
  select: 'default',
  arrow: 'crosshair',
  rect: 'crosshair',
  ellipse: 'crosshair',
  line: 'crosshair',
  text: 'text',
  blur: 'crosshair',
  step: 'copy',
  'redact-brush': 'crosshair',
};

function isTextEntry(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) {
    return !['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file'].includes(t.type);
  }
  return false;
}

interface Session {
  tool: Tool;
  pointerId: number;
  start: Point;
  last: Point;
  startCss: Point;
  points: number[];
}

const sameBox = (a: { x: number; y: number; w: number; h: number }, b: Box) =>
  Math.abs(a.x - b.x) < 0.75 && Math.abs(a.y - b.y) < 0.75 && Math.abs(a.w - b.w) < 0.75 && Math.abs(a.h - b.h) < 0.75;

/**
 * The editor: owns a Konva scene for one screenshot document, the tools, selection, undo history and
 * export. Host-agnostic; React wrappers live in `@polishot/editor/react`.
 */
export class Editor {
  /** Root element. Append it to any container; it fills its parent and resizes with it. */
  readonly element: HTMLDivElement;
  private readonly stageHost: HTMLDivElement;
  private readonly overlay: HTMLDivElement;
  private readonly scene: Scene;
  private readonly selection: SelectionUI;
  private readonly textEditor: TextEditor;
  private readonly history: History<EditorDoc>;
  private readonly origins: readonly string[] | undefined;
  private insets: ViewInsets;
  private readonly ro: ResizeObserver;
  private readonly listeners: Record<EditorEvent, Set<() => void>> = {
    change: new Set(),
    select: new Set(),
    tool: new Set(),
    view: new Set(),
  };
  private readonly handled = new WeakSet<object>();
  private readonly dragStart = new Map<string, Point>();
  private image: ImageSource | null = null;
  private _tool: Tool = 'select';
  private _style: Style = defaultStyleFor(1000, 1000);
  private _selectedId: string | null = null;
  private _licensed: boolean;
  private _brandMark: BrandMark | null = null;
  /** Hover preview: rendered but never recorded in history; `doc` and exports stay on the committed state. */
  private _preview: EditorDoc | null = null;
  /** Auto-balance result for the loaded image, computed once (it takes 60-120 ms on a 4K capture). */
  private analysisCache: { image: ImageSource; result: ReturnType<typeof analyzeImage> } | null = null;
  /** The last arrow-key nudge, so a held key folds into one undo step. */
  private lastNudge: { id: string; json: string } | null = null;
  /** The canvas is hidden until its first frame is complete (sized, background image decoded). */
  private veil = false;
  private loadEpoch = 0;
  private _version = 0;
  private view = { scale: 1, x: 0, y: 0 };
  /** How long the last load() took, split into analysis, scene build and first draw (milliseconds). */
  private analysisTimings: Record<string, number> = {};
  timings: Record<string, number> = { analyzeMs: 0, buildMs: 0, drawMs: 0, totalMs: 0 };
  private session: Session | null = null;
  private editingId: string | null = null;
  private destroyed = false;

  constructor(container: HTMLElement, opts: EditorOptions) {
    this._licensed = opts.licensed === true;
    this.origins = opts.origins;
    this._brandMark = sanitizeBrandMark(opts.brandMark ?? null, this.origins);
    this.insets = { top: 24, right: 24, bottom: 24, left: 24, ...opts.insets };
    this.history = new History<EditorDoc>(createDoc({ id: '', width: 1, height: 1 }), 200);

    const root = document.createElement('div');
    root.className = 'pe-root';
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Screenshot canvas');
    Object.assign(root.style, { position: 'relative', width: '100%', height: '100%', overflow: 'hidden' });
    this.element = root;

    this.stageHost = document.createElement('div');
    this.stageHost.className = 'pe-stage';
    Object.assign(this.stageHost.style, { position: 'absolute', inset: '0', touchAction: 'none' });
    this.overlay = document.createElement('div');
    this.overlay.className = 'pe-overlay';
    Object.assign(this.overlay.style, { position: 'absolute', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    root.append(this.stageHost, this.overlay);
    container.appendChild(root);

    const stage = new Konva.Stage({ container: this.stageHost, width: 1, height: 1 });
    this.scene = new Scene(stage, { interactive: true, origins: this.origins });
    this.scene.setLicensed(this._licensed);
    this.scene.setBrandMark(this._brandMark);
    this.textEditor = new TextEditor(this.overlay);
    this.selection = new SelectionUI(this.scene, {
      onHandleStart: () => this.history.begin(),
      onHandleMove: (id, index, p) => this.moveHandle(id, index, p),
      onHandleEnd: () => {
        this.history.commit();
        this.afterChange();
      },
    });

    this.bindKonvaEvents();
    this.bindDomEvents();
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(root);
    this.scene.render(this.history.present, { sync: true });
    this.resize();
  }

  /* ---------------------------------------------------------------- */
  /* Public API                                                         */
  /* ---------------------------------------------------------------- */

  get doc(): EditorDoc {
    return this.history.present;
  }

  /** Increases on every change, selection, tool or view update; handy as a snapshot for UI frameworks. */
  get version(): number {
    return this._version;
  }

  get hasImage(): boolean {
    return this.image !== null;
  }

  get licensed(): boolean {
    return this._licensed;
  }

  /** The Pro brand mark that is set (drawn only while licensed), or null. */
  get brandMark(): BrandMark | null {
    return this._brandMark;
  }

  get tool(): Tool {
    return this._tool;
  }

  get style(): Readonly<Style> {
    return this._style;
  }

  get selectedId(): string | null {
    return this._selectedId;
  }

  get selected(): Annotation | null {
    return this._selectedId ? (this.doc.annotations.find((a) => a.id === this._selectedId) ?? null) : null;
  }

  /** Output canvas size in px (before the export scale). */
  get canvasSize(): { width: number; height: number } {
    const { width, height } = this.scene.layout;
    return { width, height };
  }

  /** CSS px per output px at the current fit-to-window zoom. */
  get zoom(): number {
    return this.view.scale;
  }

  /**
   * Loads a screenshot. New documents run auto-balance and the auto background; a saved `doc` is
   * validated first (and ignored if it is malformed or does not match the image).
   */
  load(image: ImageSource, doc?: EditorDoc): void {
    const t0 = performance.now();
    this.textEditor.close();
    this.session = null;
    this.image = image;
    this.analysisCache = null;
    this._preview = null;
    this.lastNudge = null;
    let next: EditorDoc | null = null;
    if (doc !== undefined) {
      const v = validateDoc(doc, { origins: this.origins });
      if (v && v.image.width === image.width && v.image.height === image.height) {
        v.image = { id: image.id, width: image.width, height: image.height };
        next = v;
      }
    }
    const tAnalyze0 = performance.now();
    if (!next) {
      const analysis = this.autoAnalysis()!;
      this.analysisTimings = analysis.timings ?? {};
      next = {
        ...createDoc(image),
        crop: analysis.crop,
        padding: analysis.padding,
        background: analysis.background,
      };
    } else if (next.background.type === 'auto' && !next.background.stops && !next.background.color) {
      next = { ...next, background: this.autoAnalysis()!.background };
    }
    const tAnalyze1 = performance.now();
    this._style = defaultStyleFor(image.width, image.height);
    this._selectedId = null;
    this.history.reset(next);
    this.scene.setImage(image);
    this.scene.render(next, { sync: false });
    this.fit();
    this.refreshSelection();
    const tDraw0 = performance.now();
    this.scene.draw(true);
    const t1 = performance.now();
    this.timings = { ...this.timings, ...this.analysisTimings, analyzeMs: tAnalyze1 - tAnalyze0, buildMs: tDraw0 - tAnalyze1, drawMs: t1 - tDraw0, totalMs: t1 - t0 };
    this.holdUntilReady();
    this.bump('change', 'select', 'view');
  }

  /** Applies a patch (or an updater) to the document as one undo step. Invalid results are ignored. */
  update(patch: Partial<EditorDoc> | ((d: EditorDoc) => EditorDoc)): void {
    const cur = this.history.present;
    const draft = typeof patch === 'function' ? patch(structuredClone(cur)) : { ...cur, ...patch };
    const valid = validateDoc(draft, { origins: this.origins });
    if (!valid) return;
    valid.image = cur.image; // the image never changes under a document
    this.commitDoc(valid);
  }

  /**
   * Shows what `patch` would look like without committing it: nothing is recorded in history, `doc` and
   * exports stay on the committed state, and no `change` event fires. Built for hovering a swatch, frame or
   * saved look; call `clearPreview()` when the pointer leaves, or `update(patch)` to commit. Renders in
   * the same frame (a few milliseconds even for a 4K capture). Invalid patches are ignored.
   */
  preview(patch: Partial<EditorDoc>): void {
    if (this.destroyed || !this.image || this.history.inTransaction) return;
    const cur = this.history.present;
    const valid = validateDoc({ ...cur, ...patch }, { origins: this.origins });
    if (!valid) return;
    valid.image = cur.image;
    this._preview = valid;
    this.showDoc(valid);
  }

  /** Drops a hover preview and shows the committed document again. */
  clearPreview(): void {
    if (!this._preview) return;
    this._preview = null;
    this.showDoc(this.history.present);
  }

  /** True while a hover preview is on screen. */
  get previewing(): boolean {
    return this._preview !== null;
  }

  /** Starts a burst of updates (slider drag) that will be undone as one step. */
  beginBatch(): void {
    this.history.begin();
  }

  endBatch(): void {
    if (this.history.commit()) this.bump('change');
  }

  setTool(t: Tool): void {
    if (t === this._tool) return;
    this.textEditor.commit();
    this.session = null;
    this.scene.setDraft(null, this.selection.accentColor);
    this._tool = t;
    this.scene.setSelectMode(t === 'select');
    if (t !== 'select') this._selectedId = null;
    this.stageHost.style.cursor = CURSORS[t];
    this.refreshSelection();
    this.bump('tool', 'select');
  }

  setStyle(s: Partial<Style>): void {
    const next: Style = { ...this._style };
    if (s.color !== undefined) next.color = s.color;
    if (s.strokeWidth !== undefined) next.strokeWidth = Math.min(200, Math.max(0.5, s.strokeWidth));
    if (s.fontSize !== undefined) next.fontSize = Math.min(512, Math.max(6, s.fontSize));
    if (s.blurMode !== undefined) next.blurMode = s.blurMode;
    if (s.brushSize !== undefined) next.brushSize = Math.min(200, Math.max(4, s.brushSize));
    if (s.brushMode !== undefined) next.brushMode = s.brushMode;
    this._style = next;

    const sel = this.selected;
    if (sel) {
      const patched = this.styleAnnotation(sel, s);
      if (patched) {
        this.commitDoc({
          ...this.doc,
          annotations: this.doc.annotations.map((a) => (a.id === sel.id ? patched : a)),
        });
        return;
      }
    }
    this.bump('change');
  }

  undo(): void {
    this.textEditor.commit();
    if (this.history.undo()) this.afterHistoryJump();
  }

  redo(): void {
    this.textEditor.commit();
    if (this.history.redo()) this.afterHistoryJump();
  }

  canUndo(): boolean {
    return this.history.canUndo();
  }

  canRedo(): boolean {
    return this.history.canRedo();
  }

  /**
   * Adds blur/bar annotations for OCR detections as one undo step. Detections that are already applied
   * are not duplicated; applying again with a different mode switches the existing redaction.
   */
  applyDetections(dets: readonly Detection[], mode: 'blur' | 'bar'): void {
    const fresh = redactionsFromDetections(dets, mode);
    if (fresh.length === 0) return;
    const existing = this.doc.annotations;
    const add: Annotation[] = [];
    const switched = new Map<string, Annotation>();
    for (const a of fresh) {
      if (a.type !== 'blur') continue;
      const dup = existing.find((e) => e.type === 'blur' && e.source === 'auto' && sameBox(e, a));
      if (dup && dup.type === 'blur') {
        if (dup.mode !== a.mode) switched.set(dup.id, { ...dup, mode: a.mode });
      } else add.push(a);
    }
    if (add.length === 0 && switched.size === 0) return;
    if (existing.length + add.length > LIMITS.maxAnnotations) return;
    this.commitDoc({
      ...this.doc,
      annotations: [...existing.map((e) => switched.get(e.id) ?? e), ...add],
    });
  }

  /** Removes the automatic redactions that belong to the given detections. */
  removeDetections(dets: readonly Detection[]): void {
    const boxes = dets.flatMap((d) => d.boxes);
    const keep = this.doc.annotations.filter(
      (a) => !(a.type === 'blur' && a.source === 'auto' && boxes.some((b) => sameBox(a, b))),
    );
    if (keep.length === this.doc.annotations.length) return;
    this.commitDoc({ ...this.doc, annotations: keep });
  }

  /** Whether every box of the detection is currently covered by an automatic redaction. */
  isDetectionApplied(det: Detection): boolean {
    return (
      det.boxes.length > 0 &&
      det.boxes.every((b) => this.doc.annotations.some((a) => a.type === 'blur' && a.source === 'auto' && sameBox(a, b)))
    );
  }

  select(id: string | null): void {
    const exists = id !== null && this.doc.annotations.some((a) => a.id === id);
    const next = exists ? id : null;
    if (next === this._selectedId) return;
    this._selectedId = next;
    this.refreshSelection();
    this.bump('select');
  }

  deleteSelection(): void {
    const id = this._selectedId;
    if (!id) return;
    const target = this.doc.annotations.find((a) => a.id === id);
    this._selectedId = null;
    let annotations = this.doc.annotations.filter((a) => a.id !== id);
    // Deleting a numbered step renumbers the rest (1, 3 becomes 1, 2), as part of the same undo step.
    if (target?.type === 'step') annotations = renumberSteps(annotations);
    this.commitDoc({ ...this.doc, annotations });
    this.bump('select');
  }

  /**
   * Moves the selected annotation by (dx, dy) source pixels as one undo step. `fold` amends the previous
   * nudge instead of adding a step (a held arrow key). Returns false when nothing is selected.
   */
  nudgeSelection(dx: number, dy: number, fold = false): boolean {
    const sel = this.selected;
    if (!sel || this._tool !== 'select' || this.editingId) return false;
    const moved = translateAnnotation(sel, dx, dy);
    const next = { ...this.doc, annotations: this.doc.annotations.map((a) => (a.id === sel.id ? moved : a)) };
    const folding = fold && this.lastNudge?.id === sel.id && this.lastNudge.json === JSON.stringify(this.history.present);
    if (folding) {
      if (this.history.amend(next)) this.afterChange();
    } else this.commitDoc(next);
    this.lastNudge = { id: sel.id, json: JSON.stringify(this.history.present) };
    return true;
  }

  /** Duplicates the selected annotation a little down and to the right and selects the copy (Ctrl+D). */
  duplicateSelection(): boolean {
    const sel = this.selected;
    if (!sel || this.doc.annotations.length >= LIMITS.maxAnnotations) return false;
    const offset = Math.max(8, Math.round(16 / Math.max(0.01, this.scene.totalScale())));
    const copy = duplicateAnnotation(sel, this.doc.annotations, offset, offset);
    this.commitDoc({ ...this.doc, annotations: [...this.doc.annotations, copy] });
    this.select(copy.id);
    return true;
  }

  /** Changes the free space kept around the canvas (e.g. room for a floating toolbar). */
  setInsets(insets: Partial<ViewInsets>): void {
    const next = { ...this.insets, ...insets };
    if (JSON.stringify(next) === JSON.stringify(this.insets)) return;
    this.insets = next;
    this.fit();
    this.refreshSelection();
    this.scene.draw(false);
    this.bump('view');
  }

  /** Call after switching between light and dark themes so canvas chrome picks up the new accent colour. */
  refreshTheme(): void {
    this.selection.readAccent();
    this.refreshSelection();
    this.scene.draw(false);
  }

  /** The auto background derived from the current image (what the "Auto" swatch applies). */
  computeAutoBackground(): Background {
    const a = this.autoAnalysis();
    return a ? structuredClone(a.background) : { type: 'auto' };
  }

  /** The padding auto-balance suggests for this image (what double-clicking the Padding slider resets to). */
  get autoPadding(): number {
    return this.autoAnalysis()?.padding ?? createDoc({ id: '', width: 1, height: 1 }).padding;
  }

  private autoAnalysis(): ReturnType<typeof analyzeImage> | null {
    if (!this.image) return null;
    if (this.analysisCache?.image !== this.image) {
      this.analysisCache = { image: this.image, result: analyzeImage(this.image) };
    }
    return this.analysisCache.result;
  }

  /** Re-runs auto-balance and the auto background, as one undo step. */
  rebalance(): void {
    if (!this.image) return;
    const a = this.autoAnalysis()!;
    this.commitDoc({ ...this.doc, crop: a.crop, padding: a.padding, background: structuredClone(a.background) });
  }

  /** Maps a source-image rectangle to CSS px relative to the editor element (for OCR text overlays). */
  imageRectToScreen(b: Box): Box {
    const a = this.scene.sourceToDesign({ x: b.x, y: b.y });
    const c = this.scene.sourceToDesign({ x: b.x + b.w, y: b.y + b.h });
    const s = this.view.scale;
    return {
      x: this.view.x + a.x * s,
      y: this.view.y + a.y * s,
      w: (c.x - a.x) * s,
      h: (c.y - a.y) * s,
    };
  }

  /** Where the (cropped) image sits on screen, in CSS px relative to the editor element. */
  contentRectOnScreen(): Box {
    const c = this.scene.layout.content;
    const s = this.view.scale;
    return { x: this.view.x + c.x * s, y: this.view.y + c.y * s, w: c.w * s, h: c.h * s };
  }

  async export(opts: ExportOptions): Promise<Blob> {
    if (!this.image) throw new Error('No image loaded.');
    this.textEditor.commit();
    await this.scene.ready();
    return exportDoc(
      this.doc,
      this.image,
      { ...opts, licensed: this._licensed && opts.licensed !== false },
      { origins: this.origins, brandMark: this._brandMark },
    );
  }

  setLicensed(v: boolean): void {
    this._licensed = v === true;
    this.scene.setLicensed(this._licensed);
    this.scene.draw(false);
    this.bump('change');
  }

  /**
   * Sets (or with `null` clears) the Pro brand mark: text or a logo drawn bottom-right instead of the
   * watermark, on screen and in exports. It is only drawn while licensed; while Free the default watermark is
   * always drawn and the mark is ignored. Returns false (and clears the mark) when the input is not a valid
   * mark: empty text, or an image source that fails `isSafeImageSrc`. Not part of the document or undo history.
   */
  setBrandMark(mark: BrandMark | null): boolean {
    const clean = sanitizeBrandMark(mark, this.origins);
    this._brandMark = clean;
    this.scene.setBrandMark(clean);
    this.scene.draw(false);
    this.bump('change');
    return mark === null || clean !== null;
  }

  /** Handles a keyboard event for the editor shortcuts. Returns true if it was consumed. */
  handleKey(e: KeyboardEvent): boolean {
    if (this.destroyed || this.handled.has(e)) return false;
    this.handled.add(e);
    if (isTextEntry(e.target)) return false;
    const edit = mapSelectionShortcut(e);
    if (edit) {
      // Arrow keys belong to sliders, menus and the toolbar when one of them has the focus.
      if (edit.type === 'nudge' && isControl(e.target)) return false;
      const done = edit.type === 'nudge' ? this.nudgeSelection(edit.dx, edit.dy, e.repeat) : this.duplicateSelection();
      if (!done) return false;
      e.preventDefault();
      return true;
    }
    const action = mapShortcut(e);
    if (!action) return false;
    switch (action.type) {
      case 'tool':
        this.setTool(action.tool);
        break;
      case 'delete':
        if (!this._selectedId) return false;
        this.deleteSelection();
        break;
      case 'escape':
        if (this._selectedId) this.select(null);
        else this.setTool('select');
        break;
      case 'undo':
        this.undo();
        break;
      case 'redo':
        this.redo();
        break;
    }
    e.preventDefault();
    return true;
  }

  on(ev: EditorEvent, cb: () => void): () => void {
    this.listeners[ev].add(cb);
    return () => {
      this.listeners[ev].delete(cb);
    };
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ro.disconnect();
    window.removeEventListener('keydown', this.onShiftChange);
    window.removeEventListener('keyup', this.onShiftChange);
    this.textEditor.destroy();
    this.scene.destroy();
    this.element.remove();
    for (const set of Object.values(this.listeners)) set.clear();
  }

  /* ---------------------------------------------------------------- */
  /* State plumbing                                                     */
  /* ---------------------------------------------------------------- */

  private bump(...events: EditorEvent[]): void {
    this._version++;
    for (const ev of new Set(events)) for (const cb of [...this.listeners[ev]]) cb();
  }

  private commitDoc(next: EditorDoc): void {
    if (!this.history.push(next)) return;
    this.afterChange();
  }

  private afterChange(): void {
    this._preview = null;
    const doc = this.history.present;
    this.scene.render(doc);
    const stale = this._selectedId !== null && !doc.annotations.some((a) => a.id === this._selectedId);
    if (stale) this._selectedId = null;
    this.fit();
    this.refreshSelection();
    this.bump('change', ...(stale ? (['select'] as const) : []), 'view');
  }

  private afterHistoryJump(): void {
    this.afterChange();
  }

  /** Fits the canvas into the element; returns true when the view (zoom or offset) changed. */
  private fit(): boolean {
    const w = this.element.clientWidth;
    const h = this.element.clientHeight;
    if (w < 2 || h < 2) return false;
    const before = this.view;
    this.view = this.scene.setViewport(w, h, this.insets);
    this.scene.refreshImageLevel();
    this.scene.updateHitAreas();
    return before.scale !== this.view.scale || before.x !== this.view.x || before.y !== this.view.y;
  }

  /** Renders `doc` (committed or a hover preview) and keeps selection chrome and overlays in step. */
  private showDoc(doc: EditorDoc): void {
    this.scene.render(doc);
    const moved = this.fit();
    this.refreshSelection();
    if (moved) this.bump('view');
  }

  private resize(): void {
    if (this.destroyed) return;
    this.fit();
    this.refreshSelection();
    this.scene.draw(false);
    if (this.veil) this.unveilIfReady();
    this.bump('view');
  }

  private sized(): boolean {
    return this.element.clientWidth >= 2 && this.element.clientHeight >= 2;
  }

  private setVeil(on: boolean): void {
    this.veil = on;
    this.stageHost.style.visibility = on ? 'hidden' : '';
  }

  private unveilIfReady(): void {
    if (!this.sized() || this.scene.isLoading()) return;
    // Fit and paint everything now, so the canvas is complete (and laid out for its current size) in the very
    // frame it becomes visible, even if the ResizeObserver has not reported the size yet.
    this.fit();
    this.refreshSelection();
    this.scene.draw(true);
    this.setVeil(false);
  }

  /**
   * No flash: the first frame the user sees is the finished one. The canvas stays hidden while the element has
   * no size yet or a background image / logo is still decoding, and is revealed as soon as both are done
   * (with a 600 ms cap so a broken image URL cannot hide the editor).
   */
  private holdUntilReady(): void {
    const epoch = ++this.loadEpoch;
    if (this.sized() && !this.scene.isLoading()) {
      this.setVeil(false);
      return;
    }
    this.setVeil(true);
    void this.scene.ready().then(() => {
      if (epoch === this.loadEpoch && !this.destroyed) this.unveilIfReady();
    });
    setTimeout(() => {
      if (epoch === this.loadEpoch && !this.destroyed && this.sized()) this.setVeil(false);
    }, 600);
  }

  private refreshSelection(): void {
    const ann = this.selected;
    const node = ann ? this.scene.getNode(ann.id) : null;
    this.selection.show(ann, node, this._tool === 'select' && !this.editingId);
  }

  private styleAnnotation(a: Annotation, s: Partial<Style>): Annotation | null {
    switch (a.type) {
      case 'arrow':
      case 'line':
      case 'rect':
      case 'ellipse': {
        const out = { ...a };
        if (s.color !== undefined) out.color = s.color;
        if (s.strokeWidth !== undefined) out.strokeWidth = this._style.strokeWidth;
        return JSON.stringify(out) === JSON.stringify(a) ? null : out;
      }
      case 'text': {
        const out = { ...a };
        if (s.color !== undefined) out.color = s.color;
        if (s.fontSize !== undefined) out.fontSize = this._style.fontSize;
        return JSON.stringify(out) === JSON.stringify(a) ? null : out;
      }
      case 'step':
        return s.color !== undefined && s.color !== a.color ? { ...a, color: s.color } : null;
      case 'blur':
        return s.blurMode !== undefined && s.blurMode !== a.mode ? { ...a, mode: s.blurMode } : null;
      case 'redact-brush':
        return s.brushMode !== undefined && s.brushMode !== a.mode ? { ...a, mode: s.brushMode } : null;
    }
  }

  private moveHandle(id: string, index: 0 | 1, p: Point): void {
    const doc = this.history.present;
    const ann = doc.annotations.find((a) => a.id === id);
    if (!ann || (ann.type !== 'arrow' && ann.type !== 'line')) return;
    const pts: [number, number, number, number] = [...ann.points];
    pts[index * 2] = p.x;
    pts[index * 2 + 1] = p.y;
    if (this.history.push({ ...doc, annotations: doc.annotations.map((a) => (a.id === id ? { ...ann, points: pts } : a)) })) {
      this.scene.render(this.history.present);
      this.bump('change');
    }
  }

  /* ---------------------------------------------------------------- */
  /* Pointer and keyboard                                               */
  /* ---------------------------------------------------------------- */

  private bindKonvaEvents(): void {
    const { annGroup, stage } = this.scene;

    annGroup.on('pointerdown', (ev) => {
      if (this._tool !== 'select') return;
      const id = this.scene.annotationIdOf(ev.target);
      if (id) this.select(id);
    });
    stage.on('pointerdown', (ev) => {
      if (this._tool === 'select' && ev.target === stage) this.select(null);
    });
    annGroup.on('dragstart', (ev) => {
      const id = this.scene.annotationIdOf(ev.target);
      if (id) {
        this.select(id);
        this.dragStart.set(id, { x: ev.target.x(), y: ev.target.y() });
      }
    });
    annGroup.on('dragend', (ev) => {
      const id = this.scene.annotationIdOf(ev.target);
      if (!id) return;
      const start = this.dragStart.get(id);
      this.dragStart.delete(id);
      if (!start) return;
      const dx = ev.target.x() - start.x;
      const dy = ev.target.y() - start.y;
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return;
      this.commitDoc({
        ...this.doc,
        annotations: this.doc.annotations.map((a) => (a.id === id ? translateAnnotation(a, dx, dy) : a)),
      });
    });
    // Konva fires transformend on the transformer (and non-bubbling on the node), so listen on the former.
    this.selection.transformer.on('transformend', () => {
      const node = this.selection.transformer.nodes()[0];
      const id = node ? this.scene.annotationIdOf(node) : null;
      if (node && id) this.applyTransform(id, node);
    });
    annGroup.on('dblclick dbltap', (ev) => {
      const id = this.scene.annotationIdOf(ev.target);
      const ann = id ? this.doc.annotations.find((a) => a.id === id) : null;
      if (ann && ann.type === 'text') this.editText(ann);
    });
    annGroup.on('mouseenter', () => {
      if (this._tool === 'select') this.stageHost.style.cursor = 'move';
    });
    annGroup.on('mouseleave', () => {
      this.stageHost.style.cursor = CURSORS[this._tool];
    });
  }

  private applyTransform(id: string, node: Konva.Node): void {
    const ann = this.doc.annotations.find((a) => a.id === id);
    if (!ann) return;
    const sx = node.scaleX();
    const sy = node.scaleY();
    node.scale({ x: 1, y: 1 });
    let next: Annotation | null = null;
    switch (ann.type) {
      case 'rect':
        next = { ...ann, x: node.x(), y: node.y(), w: Math.max(2, node.width() * sx), h: Math.max(2, node.height() * sy) };
        break;
      case 'ellipse': {
        const e = node as Konva.Ellipse;
        const rx = Math.max(1, e.radiusX() * sx);
        const ry = Math.max(1, e.radiusY() * sy);
        next = { ...ann, x: node.x() - rx, y: node.y() - ry, w: rx * 2, h: ry * 2 };
        break;
      }
      case 'blur':
        next = { ...ann, x: node.x(), y: node.y(), w: Math.max(2, node.width() * sx), h: Math.max(2, node.height() * sy) };
        break;
      case 'text':
        next = { ...ann, x: node.x(), y: node.y(), fontSize: Math.min(512, Math.max(6, ann.fontSize * Math.abs(sx))) };
        break;
      default:
        break;
    }
    if (next) {
      const replacement = next;
      this.commitDoc({ ...this.doc, annotations: this.doc.annotations.map((a) => (a.id === id ? replacement : a)) });
    }
  }

  private bindDomEvents(): void {
    const host = this.stageHost;
    host.addEventListener('pointerdown', this.onPointerDown);
    host.addEventListener('pointermove', this.onPointerMove);
    host.addEventListener('pointerup', this.onPointerUp);
    host.addEventListener('pointercancel', this.onPointerCancel);
    this.element.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keydown', this.onShiftChange);
    window.addEventListener('keyup', this.onShiftChange);
  }

  /** Pressing or releasing Shift mid-drag re-applies the constraint at once, without waiting for a pointer move. */
  private onShiftChange = (e: KeyboardEvent) => {
    if (e.key === 'Shift' && !e.repeat && this.session) this.updateDraft(e.type === 'keydown');
  };

  private onKeyDown = (e: KeyboardEvent) => {
    this.handleKey(e);
  };

  private cssPoint(e: PointerEvent): Point {
    const r = this.stageHost.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private sourcePoint(css: Point): Point {
    return this.scene.designToSource(this.scene.cssToDesign(css));
  }

  private onPointerDown = (e: PointerEvent) => {
    if (this.destroyed) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (!this.image) return;
    const wasEditing = this.textEditor.isOpen;
    if (wasEditing) this.textEditor.commit();
    this.element.focus({ preventScroll: true });
    // Clicking away from a text field only commits it; the next click starts new text.
    if (wasEditing && this._tool === 'text') return;
    const tool = this._tool;
    if (!DRAW_TOOLS.has(tool)) return;
    e.preventDefault();
    const css = this.cssPoint(e);
    const p = this.sourcePoint(css);
    this.session = { tool, pointerId: e.pointerId, start: p, last: p, startCss: css, points: [p.x, p.y] };
    try {
      this.stageHost.setPointerCapture(e.pointerId);
    } catch {
      // Capture is a nicety; drawing still works without it.
    }
    this.updateDraft(false);
  };

  private onPointerMove = (e: PointerEvent) => {
    const s = this.session;
    if (!s || e.pointerId !== s.pointerId) return;
    const p = this.sourcePoint(this.cssPoint(e));
    s.last = p;
    if (s.tool === 'redact-brush') {
      const min = 1.5 / Math.max(0.01, this.scene.totalScale());
      const lx = s.points[s.points.length - 2]!;
      const ly = s.points[s.points.length - 1]!;
      if (Math.hypot(p.x - lx, p.y - ly) >= min) s.points.push(p.x, p.y);
      if (s.points.length > LIMITS.maxBrushNumbers * 2) s.points = thinStroke(s.points, min * 2);
    }
    this.updateDraft(e.shiftKey);
  };

  private onPointerUp = (e: PointerEvent) => {
    const s = this.session;
    if (!s || e.pointerId !== s.pointerId) return;
    this.session = null;
    try {
      this.stageHost.releasePointerCapture(e.pointerId);
    } catch {
      // Already released.
    }
    const p = this.sourcePoint(this.cssPoint(e));
    s.last = p;
    this.scene.setDraft(null, this.selection.accentColor);
    this.finishSession(s, e.shiftKey);
  };

  private onPointerCancel = (e: PointerEvent) => {
    if (this.session && e.pointerId === this.session.pointerId) {
      this.session = null;
      this.scene.setDraft(null, this.selection.accentColor);
    }
  };

  private draftFor(s: Session, shift: boolean): Annotation | null {
    const style = this._style;
    switch (s.tool) {
      case 'arrow':
      case 'line':
      case 'rect':
      case 'ellipse':
      case 'blur':
        return buildDragShape(s.tool, s.start, s.last, style, shift, '__draft');
      case 'redact-brush':
        return {
          id: '__draft',
          type: 'redact-brush',
          points: s.points.length >= 2 ? s.points : [s.start.x, s.start.y],
          size: style.brushSize / Math.max(0.01, this.scene.totalScale()),
          mode: style.brushMode,
        };
      case 'step':
        return { id: '__draft', type: 'step', x: s.last.x, y: s.last.y, n: nextStepNumber(this.doc.annotations), color: style.color };
      default:
        return null;
    }
  }

  private updateDraft(shift: boolean): void {
    const s = this.session;
    if (!s) return;
    this.scene.setDraft(this.draftFor(s, shift), this.selection.accentColor);
  }

  private finishSession(s: Session, shift: boolean): void {
    const style = this._style;
    const minSize = 4 / Math.max(0.01, this.scene.totalScale());
    let ann: Annotation | null = null;
    switch (s.tool) {
      case 'text':
        this.editNewText(s.start);
        return;
      case 'step':
        ann = { id: newId('s'), type: 'step', x: s.last.x, y: s.last.y, n: nextStepNumber(this.doc.annotations), color: style.color };
        break;
      case 'redact-brush': {
        const size = style.brushSize / Math.max(0.01, this.scene.totalScale());
        const points = capStroke(s.points.length >= 2 ? s.points : [s.start.x, s.start.y]);
        ann = { id: newId('b'), type: 'redact-brush', points, size, mode: style.brushMode };
        break;
      }
      default: {
        const shape = buildDragShape(s.tool, s.start, s.last, style, shift, newId('a'));
        if (shape && isMeaningful(shape, minSize)) ann = shape;
      }
    }
    if (ann) this.addAnnotation(ann);
  }

  private addAnnotation(ann: Annotation): void {
    if (this.doc.annotations.length >= LIMITS.maxAnnotations) return;
    this.commitDoc({ ...this.doc, annotations: [...this.doc.annotations, ann] });
  }

  /* ---------------------------------------------------------------- */
  /* Text                                                               */
  /* ---------------------------------------------------------------- */

  private editNewText(at: Point): void {
    const fontSize = this._style.fontSize;
    const color = this._style.color;
    const screen = this.imageRectToScreen({ x: at.x, y: at.y, w: 0, h: 0 });
    // Open after the click has finished, so its default focus handling cannot steal focus from the field.
    setTimeout(() => {
      if (this.destroyed) return;
      this.openNewTextEditor(at, screen, fontSize, color);
    }, 0);
  }

  private openNewTextEditor(at: Point, screen: Box, fontSize: number, color: string): void {
    this.textEditor.open({
      x: screen.x,
      y: screen.y,
      fontSize: fontSize * this.scene.totalScale(),
      color,
      text: '',
      label: 'Text annotation',
      onCommit: (text) => {
        const t = text.trim();
        // Empty text is discarded. The Text tool stays active for the next note (Esc or V selects).
        if (t) this.addAnnotation({ id: newId('t'), type: 'text', x: at.x, y: at.y, text, fontSize, color });
        this.element.focus({ preventScroll: true });
      },
      onCancel: () => this.element.focus({ preventScroll: true }),
    });
  }

  private editText(ann: Extract<Annotation, { type: 'text' }>): void {
    const node = this.scene.getNode(ann.id);
    const screen = this.imageRectToScreen({ x: ann.x, y: ann.y, w: 0, h: 0 });
    this.editingId = ann.id;
    this.selection.clear();
    node?.visible(false);
    this.scene.draw(false);
    const restore = () => {
      this.editingId = null;
      node?.visible(true);
      this.refreshSelection();
      this.scene.draw(false);
      this.element.focus({ preventScroll: true });
    };
    this.textEditor.open({
      x: screen.x,
      y: screen.y,
      fontSize: ann.fontSize * this.scene.totalScale(),
      color: ann.color,
      text: ann.text,
      label: 'Edit text annotation',
      onCommit: (text) => {
        restore();
        if (text.trim() === '') {
          this._selectedId = ann.id;
          this.deleteSelection();
        } else if (text !== ann.text) {
          this.commitDoc({
            ...this.doc,
            annotations: this.doc.annotations.map((a) => (a.id === ann.id ? { ...ann, text } : a)),
          });
        }
      },
      onCancel: restore,
    });
  }

  /** Layout of the current document (output size, content rect). Handy for hosts and tests. */
  get layout() {
    return computeLayout(this.doc);
  }
}
