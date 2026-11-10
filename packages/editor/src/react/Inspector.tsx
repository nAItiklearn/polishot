import { Lock, X } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type FocusEvent,
  type PointerEvent,
} from 'react';
import { SWATCHES } from '../background';
import { NEUTRAL_STOPS, deriveGradient } from '../balance';
import type { BrandMark } from '../brandMark';
import { BRAND_MARK_MAX_TEXT } from '../brandMark';
import { readableOn } from '../color';
import { CUSTOM_MAX, CUSTOM_MIN, PRESETS, PRESET_ORDER } from '../presets';
import { FRAME_IDS, FRAME_LABELS } from '../frames';
import { createDoc, isSafeImageSrc } from '../doc';
import type { Editor } from '../editor';
import { FREE_PRESET_LIMIT, presetLimit } from '../limits';
import { TOOL_LABEL } from '../shortcuts';
import { ANNOTATION_COLORS, defaultStyleFor } from '../tools';
import type { Annotation, Background, BlurMode, EditorDoc, PresetId } from '../types';
import { useEditorVersion } from './hooks';
import { Field, Section, Segmented, Slider } from './ui';

/** The shareable parts of a document: everything except the image and the annotations. */
export type LookSettings = Pick<EditorDoc, 'padding' | 'background' | 'radius' | 'shadow' | 'frame' | 'preset' | 'custom'>;

export interface UserPreset {
  id: string;
  name: string;
  settings: LookSettings;
}

export interface InspectorProps {
  editor: Editor;
  /** Which canvas size presets to offer. Default: all. */
  presets?: PresetId[];
  /** Host-provided persistence for user presets. The UI never touches storage itself. */
  loadPresets?: () => UserPreset[] | Promise<UserPreset[]>;
  onSavePreset?: (preset: Omit<UserPreset, 'id'>) => void | Promise<void>;
  onDeletePreset?: (id: string) => void | Promise<void>;
  /**
   * Whether Pro is active. Decides the saved-preset limit (3 for Free, none for Pro) and whether the Brand mark
   * controls are unlocked. Defaults to `editor.licensed`.
   */
  pro?: boolean;
  /** Called when a Free user clicks a locked Pro row or the limit note; hosts link to pricing. */
  onUpgrade?: () => void;
  /** Called with the new brand mark after the user changes it, so the host can store it. */
  onBrandMarkChange?: (mark: BrandMark | null) => void;
  className?: string;
}

const MAX_BG_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

const pct = (v: number) => `${Math.round(v * 100)}%`;
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((v, i) => v.toLowerCase() === b[i]!.toLowerCase());

/**
 * Hover (mouse and pen) and keyboard-focus preview: shows `patch` on the canvas without committing it, and the
 * committed look returns when the pointer or focus leaves. Click commits through `editor.update`. Touch has no
 * hover, so it never previews.
 */
function previewProps(editor: Editor, patch: () => Partial<EditorDoc>) {
  return {
    onPointerEnter: (e: PointerEvent<HTMLElement>) => {
      if (e.pointerType === 'mouse' || e.pointerType === 'pen') editor.preview(patch());
    },
    onPointerLeave: () => editor.clearPreview(),
    onFocus: (e: FocusEvent<HTMLElement>) => {
      if (e.currentTarget.matches(':focus-visible')) editor.preview(patch());
    },
    onBlur: () => editor.clearPreview(),
  };
}

/** Keeps a burst of edits (colour picker drag) to a single undo step. */
function useBatch(editor: Editor) {
  const open = useRef(false);
  const begin = useCallback(() => {
    if (!open.current) {
      open.current = true;
      editor.beginBatch();
    }
  }, [editor]);
  const end = useCallback(() => {
    if (open.current) {
      open.current = false;
      editor.endBatch();
    }
  }, [editor]);
  return { begin, end };
}

function ColorInput({ editor, label, value, onChange }: { editor: Editor; label: string; value: string; onChange: (v: string) => void }) {
  const { begin, end } = useBatch(editor);
  const id = useId();
  return (
    <div className="pe-colorfield">
      <label className="pe-label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="pe-color"
        type="color"
        value={/^#[0-9a-f]{6}$/i.test(value) ? value : '#888888'}
        onInput={(e) => {
          begin();
          onChange((e.currentTarget as HTMLInputElement).value);
        }}
        onChange={end}
        onBlur={end}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Annotation style (contextual)                                        */
/* ------------------------------------------------------------------ */

function annotationLabel(editor: Editor, sel: Annotation | null): string | null {
  if (sel) {
    const names: Record<Annotation['type'], string> = {
      arrow: 'Arrow',
      line: 'Line',
      rect: 'Rectangle',
      ellipse: 'Ellipse',
      text: 'Text',
      step: 'Step',
      blur: 'Redaction',
      'redact-brush': 'Redact brush',
    };
    return names[sel.type];
  }
  return editor.tool === 'select' ? null : TOOL_LABEL[editor.tool];
}

function AnnotationSection({ editor }: { editor: Editor }) {
  const sel = editor.selected;
  const title = annotationLabel(editor, sel);
  if (!title) return null;
  const style = editor.style;
  const kind = sel ? sel.type : editor.tool;
  const hasColor = !['blur', 'redact-brush'].includes(kind);
  const hasStroke = ['arrow', 'line', 'rect', 'ellipse'].includes(kind);
  const isText = kind === 'text';
  const isBlur = kind === 'blur';
  const isBrush = kind === 'redact-brush';
  const color = sel && 'color' in sel ? sel.color : style.color;
  const strokeWidth = sel && 'strokeWidth' in sel ? sel.strokeWidth : style.strokeWidth;
  const fontSize = sel && sel.type === 'text' ? sel.fontSize : style.fontSize;
  const blurMode: BlurMode = sel && sel.type === 'blur' ? sel.mode : style.blurMode;
  const brushMode = sel && sel.type === 'redact-brush' ? sel.mode : style.brushMode;
  const maxStroke = Math.max(24, Math.round(Math.max(editor.doc.image.width, editor.doc.image.height) / 60));
  const maxFont = Math.max(72, Math.round(Math.max(editor.doc.image.width, editor.doc.image.height) / 14));
  const defaults = defaultStyleFor(editor.doc.image.width, editor.doc.image.height);

  return (
    <Section title={title}>
      {hasColor && (
        <div className="pe-field">
          <div className="pe-field-head">
            <span className="pe-label" id="pe-color-label">
              Colour
            </span>
          </div>
          <div className="pe-colors" role="group" aria-labelledby="pe-color-label">
            {ANNOTATION_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                className="pe-colorchip"
                style={{ '--pe-chip': c } as CSSProperties}
                aria-label={`Colour ${c}`}
                aria-pressed={c.toLowerCase() === color.toLowerCase()}
                onClick={() => editor.setStyle({ color: c })}
              />
            ))}
          </div>
        </div>
      )}
      {hasStroke && (
        <Slider
          editor={editor}
          label="Stroke"
          min={1}
          max={maxStroke}
          step={1}
          value={Math.min(maxStroke, Math.round(strokeWidth))}
          reset={defaults.strokeWidth}
          format={(v) => `${v} px`}
          onChange={(v) => editor.setStyle({ strokeWidth: v })}
        />
      )}
      {isText && (
        <Slider
          editor={editor}
          label="Text size"
          min={8}
          max={maxFont}
          step={1}
          value={Math.min(maxFont, Math.round(fontSize))}
          reset={defaults.fontSize}
          format={(v) => `${v} px`}
          onChange={(v) => editor.setStyle({ fontSize: v })}
        />
      )}
      {isBlur && (
        <Field label="Effect">
          <Segmented<BlurMode>
            label="Redaction effect"
            value={blurMode}
            onChange={(v) => editor.setStyle({ blurMode: v })}
            options={[
              { value: 'blur', label: 'Blur' },
              { value: 'pixelate', label: 'Pixelate' },
              { value: 'bar', label: 'Bar' },
            ]}
          />
        </Field>
      )}
      {isBrush && (
        <>
          <Field label="Effect">
            <Segmented<'blur' | 'bar'>
              label="Brush effect"
              value={brushMode}
              onChange={(v) => editor.setStyle({ brushMode: v })}
              options={[
                { value: 'blur', label: 'Blur' },
                { value: 'bar', label: 'Bar' },
              ]}
            />
          </Field>
          <Slider
            editor={editor}
            label="Brush size"
            min={8}
            max={96}
            step={2}
            value={Math.round(style.brushSize)}
            reset={defaults.brushSize}
            format={(v) => `${v} px`}
            onChange={(v) => editor.setStyle({ brushSize: v })}
          />
        </>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Background                                                           */
/* ------------------------------------------------------------------ */

function BackgroundSection({ editor }: { editor: Editor }) {
  const doc = editor.doc;
  const bg = doc.background;
  const fileId = useId();
  const [customOpen, setCustomOpen] = useState(false);

  // The gradient the Auto tile previews and a custom background starts from. While the background is Auto the
  // stops are remembered; only a document opened with another background has to analyse the image (once).
  const lastAuto = useRef<{ image: string; stops: [string, string] } | null>(null);
  if (bg.type === 'auto') {
    const stops = bg.stops ?? (bg.color ? deriveGradient(bg.color) : null);
    if (stops) lastAuto.current = { image: doc.image.id, stops };
  }
  if (lastAuto.current && lastAuto.current.image !== doc.image.id) lastAuto.current = null;
  if (!lastAuto.current) {
    const a = editor.computeAutoBackground();
    lastAuto.current = { image: doc.image.id, stops: a.type === 'auto' && a.stops ? a.stops : NEUTRAL_STOPS };
  }
  const previewStops: [string, string] = lastAuto.current.stops;

  const matchedSwatch = bg.type === 'gradient' ? SWATCHES.find((s) => same(s.background.stops, bg.stops)) : undefined;
  const isCustom = (bg.type === 'solid' || bg.type === 'gradient' || bg.type === 'image') && !matchedSwatch;
  const showCustom = customOpen && bg.type !== 'auto';

  const setBg = (b: Background) => editor.update({ background: b });
  const customType: 'solid' | 'gradient' | 'image' = bg.type === 'solid' || bg.type === 'image' ? bg.type : 'gradient';

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file || !IMAGE_TYPES.includes(file.type) || file.size > MAX_BG_IMAGE_BYTES) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result;
      if (typeof src === 'string' && isSafeImageSrc(src)) setBg({ type: 'image', src, blur: bg.type === 'image' ? bg.blur : 30 });
    };
    reader.readAsDataURL(file);
  };

  return (
    <Section title="Background">
      <div className="pe-tiles" role="group" aria-label="Background">
        <button
          type="button"
          className="pe-tile pe-tile-auto"
          style={{ background: `linear-gradient(155deg, ${previewStops[0]}, ${previewStops[1]})`, color: readableOn(previewStops[0]) } as CSSProperties}
          aria-pressed={bg.type === 'auto'}
          aria-label="Auto background, derived from the screenshot edges"
          onClick={() => setBg(editor.computeAutoBackground())}
          {...previewProps(editor, () => ({ background: editor.computeAutoBackground() }))}
        >
          Auto
        </button>
        {SWATCHES.map((s) => (
          <button
            key={s.id}
            type="button"
            className="pe-tile"
            style={{ background: `linear-gradient(160deg, ${s.background.stops[0]}, ${s.background.stops[1]})` }}
            aria-label={s.label}
            aria-pressed={matchedSwatch?.id === s.id}
            onClick={() => {
              setBg(s.background);
              setCustomOpen(false);
            }}
            {...previewProps(editor, () => ({ background: s.background }))}
          />
        ))}
        <button
          type="button"
          className="pe-tile pe-tile-custom"
          aria-pressed={isCustom}
          aria-expanded={showCustom}
          aria-label="Custom background"
          onClick={() => {
            if (bg.type === 'auto') {
              // Start from what Auto looks like now, so switching to Custom does not change the picture.
              setBg({ type: 'gradient', stops: previewStops, angle: 155 });
              setCustomOpen(true);
            } else setCustomOpen(!customOpen);
          }}
        >
          Custom
        </button>
      </div>

      {showCustom && (
        <div className="pe-custom">
          <Segmented<'solid' | 'gradient' | 'image'>
            label="Custom background type"
            value={customType}
            onChange={(t) => {
              if (t === 'solid') setBg({ type: 'solid', color: bg.type === 'solid' ? bg.color : previewStops[0] });
              else if (t === 'gradient') setBg({ type: 'gradient', stops: bg.type === 'gradient' ? bg.stops : previewStops, angle: bg.type === 'gradient' ? bg.angle : 160 });
              else document.getElementById(fileId)?.click();
            }}
            options={[
              { value: 'solid', label: 'Solid' },
              { value: 'gradient', label: 'Gradient' },
              { value: 'image', label: 'Image' },
            ]}
          />
          {bg.type === 'solid' && (
            <ColorInput editor={editor} label="Colour" value={bg.color} onChange={(c) => setBg({ type: 'solid', color: c })} />
          )}
          {bg.type === 'gradient' && (
            <>
              <div className="pe-colorrow">
                <ColorInput editor={editor} label="From" value={bg.stops[0]} onChange={(c) => setBg({ ...bg, stops: [c, bg.stops[1]] })} />
                <ColorInput editor={editor} label="To" value={bg.stops[1]} onChange={(c) => setBg({ ...bg, stops: [bg.stops[0], c] })} />
              </div>
              <Slider
                editor={editor}
                label="Angle"
                min={0}
                max={360}
                step={1}
                reset={160}
                value={Math.round(((bg.angle % 360) + 360) % 360)}
                format={(v) => `${v}°`}
                onChange={(v) => setBg({ ...bg, angle: v })}
              />
            </>
          )}
          {bg.type === 'image' && (
            <Slider
              editor={editor}
              label="Blur"
              min={0}
              max={100}
              step={1}
              reset={30}
              value={Math.round(bg.blur)}
              format={(v) => `${v}`}
              onChange={(v) => setBg({ ...bg, blur: v })}
            />
          )}
          <input id={fileId} className="pe-visually-hidden" type="file" accept={IMAGE_TYPES.join(',')} onChange={onFile} tabIndex={-1} aria-label="Choose a background image" />
          {bg.type === 'image' && (
            <button type="button" className="pe-btn pe-btn-quiet" onClick={() => document.getElementById(fileId)?.click()}>
              Replace image
            </button>
          )}
        </div>
      )}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Layout, frame, canvas                                                */
/* ------------------------------------------------------------------ */

function CustomSize({ editor }: { editor: Editor }) {
  const custom = editor.doc.custom ?? { width: 1200, height: 800 };
  const [w, setW] = useState(String(custom.width));
  const [h, setH] = useState(String(custom.height));
  useEffect(() => {
    setW(String(custom.width));
    setH(String(custom.height));
  }, [custom.width, custom.height]);
  const apply = () => {
    const nw = Math.round(Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Number(w) || custom.width)));
    const nh = Math.round(Math.min(CUSTOM_MAX, Math.max(CUSTOM_MIN, Number(h) || custom.height)));
    setW(String(nw));
    setH(String(nh));
    if (nw !== custom.width || nh !== custom.height) editor.update({ custom: { width: nw, height: nh } });
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') apply();
  };
  return (
    <div className="pe-sizeinputs">
      <label className="pe-numfield">
        <span className="pe-label">Width</span>
        <input className="pe-input" inputMode="numeric" value={w} onChange={(e) => setW(e.target.value)} onBlur={apply} onKeyDown={onKey} />
      </label>
      <label className="pe-numfield">
        <span className="pe-label">Height</span>
        <input className="pe-input" inputMode="numeric" value={h} onChange={(e) => setH(e.target.value)} onBlur={apply} onKeyDown={onKey} />
      </label>
    </div>
  );
}

function LayoutSections({ editor, presets }: { editor: Editor; presets: PresetId[] }) {
  const doc = editor.doc;
  const selectId = useId();
  const size = editor.canvasSize;
  return (
    <>
      <Section title="Layout">
        <Slider
          editor={editor}
          label="Padding"
          min={0}
          max={0.3}
          step={0.001}
          nudge={0.01}
          reset={editor.autoPadding}
          value={doc.padding}
          format={pct}
          onChange={(v) => editor.update({ padding: v })}
        />
        <Slider
          editor={editor}
          label="Corners"
          min={0}
          max={48}
          step={1}
          reset={createDoc(doc.image).radius}
          value={Math.round(doc.radius)}
          format={(v) => `${v} px`}
          onChange={(v) => editor.update({ radius: v })}
        />
        <Slider
          editor={editor}
          label="Shadow"
          min={0}
          max={1}
          step={0.01}
          reset={createDoc(doc.image).shadow}
          value={doc.shadow}
          format={pct}
          onChange={(v) => editor.update({ shadow: v })}
        />
      </Section>

      <Section title="Frame">
        <div className="pe-chips" role="group" aria-label="Frame">
          {FRAME_IDS.map((f) => (
            <button
              key={f}
              type="button"
              className="pe-chip"
              aria-pressed={doc.frame === f}
              onClick={() => editor.update({ frame: f })}
              {...previewProps(editor, () => ({ frame: f }))}
            >
              {FRAME_LABELS[f]}
            </button>
          ))}
        </div>
      </Section>

      <Section title="Canvas">
        <Field label="Size" htmlFor={selectId} value={`${size.width} × ${size.height}`}>
          <select
            id={selectId}
            className="pe-select"
            value={doc.preset}
            onChange={(e) => {
              const preset = e.target.value as PresetId;
              editor.update(preset === 'custom' ? { preset, custom: doc.custom ?? { width: 1200, height: 800 } } : { preset });
            }}
          >
            {PRESET_ORDER.filter((p) => presets.includes(p)).map((p) => {
              const info = PRESETS[p];
              return (
                <option key={p} value={p}>
                  {info.width && info.height ? `${info.label} · ${info.width}×${info.height}` : info.label}
                </option>
              );
            })}
          </select>
        </Field>
        {doc.preset === 'custom' && <CustomSize editor={editor} />}
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Saved looks                                                          */
/* ------------------------------------------------------------------ */

function Looks({
  editor,
  loadPresets,
  onSavePreset,
  onDeletePreset,
  pro,
  onUpgrade,
}: Pick<InspectorProps, 'loadPresets' | 'onSavePreset' | 'onDeletePreset' | 'onUpgrade'> & { editor: Editor; pro: boolean }) {
  const [items, setItems] = useState<UserPreset[]>([]);
  const [name, setName] = useState('');
  const nameId = useId();

  const reload = useCallback(async () => {
    if (!loadPresets) return;
    try {
      const list = await loadPresets();
      setItems(Array.isArray(list) ? list.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string') : []);
    } catch {
      setItems([]);
    }
  }, [loadPresets]);
  useEffect(() => {
    void reload();
  }, [reload]);

  if (!loadPresets && !onSavePreset) return null;

  // A stored look is untrusted input: the editor re-validates it for both the preview and the commit.
  const patchOf = (p: UserPreset): Partial<EditorDoc> => {
    const s = p.settings;
    return {
      padding: s.padding,
      background: s.background,
      radius: s.radius,
      shadow: s.shadow,
      frame: s.frame,
      preset: s.preset,
      ...(s.custom ? { custom: s.custom } : {}),
    };
  };
  const apply = (p: UserPreset) => editor.update(patchOf(p));

  // Free keeps 3 saved looks; Pro has no limit. Existing looks beyond the limit stay usable and deletable.
  const limit = presetLimit(pro);
  const full = items.length >= limit;

  const save = async () => {
    const n = name.trim().slice(0, 40);
    if (!n || !onSavePreset || full) return;
    const d = editor.doc;
    await onSavePreset({
      name: n,
      settings: { padding: d.padding, background: d.background, radius: d.radius, shadow: d.shadow, frame: d.frame, preset: d.preset, ...(d.custom ? { custom: d.custom } : {}) },
    });
    setName('');
    await reload();
  };

  return (
    <Section
      title="Saved looks"
      aside={
        !pro && onSavePreset ? (
          <span className="pe-count" aria-label={`${items.length} of ${FREE_PRESET_LIMIT} saved looks used`}>
            {items.length} of {FREE_PRESET_LIMIT}
          </span>
        ) : undefined
      }
    >
      {items.length > 0 && (
        <ul className="pe-looks">
          {items.map((p) => (
            <li key={p.id} className="pe-look">
              <button type="button" className="pe-look-apply" onClick={() => apply(p)} {...previewProps(editor, () => patchOf(p))}>
                {p.name}
              </button>
              {onDeletePreset && (
                <button
                  type="button"
                  className="pe-look-del"
                  aria-label={`Delete look ${p.name}`}
                  onClick={async () => {
                    await onDeletePreset(p.id);
                    await reload();
                  }}
                >
                  <X size={14} strokeWidth={1.5} aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {onSavePreset && (
        <div className="pe-savelook">
          <label className="pe-visually-hidden" htmlFor={nameId}>
            Name for this look
          </label>
          <input
            id={nameId}
            className="pe-input"
            placeholder={full ? 'Limit reached' : 'Name this look'}
            value={name}
            maxLength={40}
            disabled={full}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
          />
          <button type="button" className="pe-btn" disabled={full || !name.trim()} onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
      {!pro && onSavePreset && (
        <p className="pe-hint pe-limit" data-reached={full ? 'true' : undefined}>
          Free keeps {FREE_PRESET_LIMIT} presets {'\u2014'} Pro removes the limit
          {onUpgrade && (
            <>
              {' '}
              <button type="button" className="pe-linkbtn" onClick={onUpgrade}>
                See Pro
              </button>
            </>
          )}
        </p>
      )}
      {items.length === 0 && !onSavePreset && <p className="pe-hint">No saved looks yet.</p>}
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Brand mark (Pro)                                                     */
/* ------------------------------------------------------------------ */

const MAX_MARK_IMAGE_BYTES = 2 * 1024 * 1024;

type MarkMode = 'off' | 'text' | 'image';

function BrandMarkSection({
  editor,
  pro,
  onUpgrade,
  onChange,
}: {
  editor: Editor;
  pro: boolean;
  onUpgrade?: () => void;
  onChange?: (mark: BrandMark | null) => void;
}) {
  const mark = editor.brandMark;
  const [mode, setMode] = useState<MarkMode>(mark?.type ?? 'off');
  const [text, setText] = useState(mark?.type === 'text' ? mark.text : '');
  const [error, setError] = useState<string | null>(null);
  const fileId = useId();
  const textId = useId();
  // The mark this component last set, so typing a trailing space is not "corrected" by the effect below.
  const ours = useRef<BrandMark | null>(mark);

  useEffect(() => {
    if (mark === ours.current) return;
    ours.current = mark;
    setMode(mark?.type ?? 'off');
    if (mark?.type === 'text') setText(mark.text);
  }, [mark]);

  if (!pro) {
    const hint = 'Your logo or name instead of the watermark';
    return (
      <Section title="Brand mark" aside={<span className="pe-protag">Pro</span>}>
        {onUpgrade ? (
          <button type="button" className="pe-lockrow" onClick={onUpgrade} aria-label={`Brand mark is a Pro feature. ${hint}. See Pro.`}>
            <Lock size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>{hint}</span>
          </button>
        ) : (
          <div className="pe-lockrow" role="note" aria-label={`Brand mark is a Pro feature. ${hint}.`}>
            <Lock size={14} strokeWidth={1.5} aria-hidden="true" />
            <span>{hint}</span>
          </div>
        )}
      </Section>
    );
  }

  const apply = (next: BrandMark | null) => {
    editor.setBrandMark(next);
    ours.current = editor.brandMark;
    onChange?.(editor.brandMark);
  };
  const textMark = (value: string): BrandMark | null => (value.trim() ? { type: 'text', text: value } : null);

  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    if (!IMAGE_TYPES.includes(file.type) || file.size > MAX_MARK_IMAGE_BYTES) {
      setError('Choose a PNG, JPEG, WebP or GIF under 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result;
      if (typeof src === 'string' && isSafeImageSrc(src)) {
        setError(null);
        setMode('image');
        apply({ type: 'image', src });
      } else setError('That file could not be used as a logo.');
    };
    reader.onerror = () => setError('That file could not be read.');
    reader.readAsDataURL(file);
  };

  return (
    <Section title="Brand mark">
      <Segmented<MarkMode>
        label="Brand mark"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
          if (m === 'off') apply(null);
          else if (m === 'text') apply(textMark(text));
          else if (mark?.type !== 'image') apply(null);
        }}
        options={[
          { value: 'off', label: 'Off', name: 'No brand mark' },
          { value: 'text', label: 'Text', name: 'Text brand mark' },
          { value: 'image', label: 'Logo', name: 'Logo brand mark' },
        ]}
      />
      {mode === 'text' && (
        <div className="pe-field">
          <label className="pe-visually-hidden" htmlFor={textId}>
            Brand mark text
          </label>
          <input
            id={textId}
            className="pe-input pe-markinput"
            placeholder="Your name or handle"
            value={text}
            maxLength={BRAND_MARK_MAX_TEXT}
            onChange={(e) => {
              setText(e.target.value);
              apply(textMark(e.target.value));
            }}
          />
        </div>
      )}
      {mode === 'image' && (
        <div className="pe-markrow">
          {mark?.type === 'image' ? (
            <img className="pe-marklogo" src={mark.src} alt="Your logo" />
          ) : (
            <span className="pe-hint">No logo chosen.</span>
          )}
          <button type="button" className="pe-btn" onClick={() => document.getElementById(fileId)?.click()}>
            {mark?.type === 'image' ? 'Replace' : 'Choose logo'}
          </button>
        </div>
      )}
      <input id={fileId} className="pe-visually-hidden" type="file" accept={IMAGE_TYPES.join(',')} onChange={onFile} tabIndex={-1} aria-label="Choose a logo image" />
      {error && (
        <p className="pe-error" role="alert">
          {error}
        </p>
      )}
    </Section>
  );
}

/** The 280px inspector: annotation style (when relevant), background, layout, frame, canvas size, saved looks, brand mark. */
export function Inspector({
  editor,
  presets = PRESET_ORDER,
  loadPresets,
  onSavePreset,
  onDeletePreset,
  pro,
  onUpgrade,
  onBrandMarkChange,
  className,
}: InspectorProps) {
  useEditorVersion(editor);
  // Never leave a hover preview behind if the inspector goes away while the pointer is over a swatch.
  useEffect(() => () => editor.clearPreview(), [editor]);
  const isPro = (pro ?? editor.licensed) === true;
  return (
    <aside className={`pe-inspector ${className ?? ''}`} aria-label="Inspector">
      <AnnotationSection editor={editor} />
      <BackgroundSection editor={editor} />
      <LayoutSections editor={editor} presets={presets} />
      <Looks
        editor={editor}
        loadPresets={loadPresets}
        onSavePreset={onSavePreset}
        onDeletePreset={onDeletePreset}
        pro={isPro}
        onUpgrade={onUpgrade}
      />
      <BrandMarkSection editor={editor} pro={isPro} onUpgrade={onUpgrade} onChange={onBrandMarkChange} />
    </aside>
  );
}
