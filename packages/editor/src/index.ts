/**
 * @polishot/editor core entry: types, the pure document/layout/colour logic, the Konva-based Editor and
 * the standalone exporter. No React in here; see `@polishot/editor/react` for the shared UI.
 */
export type {
  Annotation,
  AnnotationType,
  Background,
  BlurMode,
  Box,
  Detection,
  DetectionKind,
  EditorDoc,
  EditorEvent,
  ExportOptions,
  FrameId,
  ImageDataLike,
  ImageSource,
  Layout,
  PresetId,
  Rect,
  Style,
  Tool,
} from './types';

export { createDoc, validateDoc, isSafeImageSrc, newId, nextStepNumber, LIMITS, DEFAULT_STYLE } from './doc';
export type { ValidateOptions } from './doc';
export { PRESETS, PRESET_ORDER, CUSTOM_MIN, CUSTOM_MAX } from './presets';
export type { PresetInfo } from './presets';
export { FRAME_IDS, FRAME_LABELS, frameSpec } from './frames';
export { computeLayout, computeExportSize, contentBox, presetSize, sourceToOutput, outputToSource } from './layout';
export type { ExportSize } from './layout';
export { planExport } from './exportPlan';
export type { ExportPlan } from './exportPlan';
export { autoBalance, autoBackground, deriveGradient, dominantEdgeColor, paddingFor } from './balance';
export type { BalanceOptions, EdgeColor } from './balance';
export { resolveBackground, SWATCHES, gradientPoints } from './background';
export type { ResolvedBackground, Swatch } from './background';
export { contrastRatio, parseColor, isSafeColor, rgbToOklab, oklabToRgb, oklchToHex } from './color';
export { History } from './history';
export { redactionsFromDetections, effectParams } from './redactions';
export { shouldWatermark, watermarkLayout } from './watermark';
export { BRAND_MARK_MAX_TEXT, brandImageBox, brandTextMaxWidth, markPlan, sanitizeBrandMark } from './brandMark';
export type { BrandMark, MarkBox, MarkPlan } from './brandMark';
export { FREE_BATCH_LIMIT, FREE_PRESET_LIMIT, batchLimit, presetLimit } from './limits';
export { mapShortcut, TOOL_ORDER, TOOL_SHORTCUT, TOOL_LABEL } from './shortcuts';
export type { ShortcutAction, KeyInfo } from './shortcuts';
export { maskPreview } from './mask';
export { ANNOTATION_COLORS, defaultStyleFor } from './tools';

export { Editor } from './editor';
export type { EditorOptions, ViewInsets } from './editor';
export { exportDoc } from './export';
