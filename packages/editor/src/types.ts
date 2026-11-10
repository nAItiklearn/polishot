import type { Box, Detection, DetectionKind } from '@polishot/redact';

export type { Box, Detection, DetectionKind };

/** Pixel buffer compatible with the DOM `ImageData` (RGBA, row-major, 8 bits per channel). */
export interface ImageDataLike {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export type PresetId = 'auto' | 'x' | 'linkedin' | 'ig-square' | 'ig-story' | 'youtube' | 'custom';
export type FrameId = 'none' | 'browser-light' | 'browser-dark' | 'window' | 'phone' | 'laptop';

export type Background =
  | { type: 'auto'; color?: string; stops?: [string, string] }
  | { type: 'solid'; color: string }
  | { type: 'gradient'; stops: [string, string]; angle: number }
  | { type: 'image'; src: string; blur: number }
  | { type: 'none' };

export type Tool =
  | 'select'
  | 'arrow'
  | 'rect'
  | 'ellipse'
  | 'line'
  | 'text'
  | 'blur'
  | 'step'
  | 'redact-brush';

export type BlurMode = 'blur' | 'pixelate' | 'bar';

export type Annotation =
  | {
      id: string;
      type: 'arrow' | 'line';
      points: [number, number, number, number];
      color: string;
      strokeWidth: number;
    }
  | {
      id: string;
      type: 'rect' | 'ellipse';
      x: number;
      y: number;
      w: number;
      h: number;
      color: string;
      strokeWidth: number;
      fill?: boolean;
    }
  | { id: string; type: 'text'; x: number; y: number; text: string; fontSize: number; color: string }
  | { id: string; type: 'step'; x: number; y: number; n: number; color: string }
  | {
      id: string;
      type: 'blur';
      x: number;
      y: number;
      w: number;
      h: number;
      mode: BlurMode;
      source: 'manual' | 'auto';
      kind?: DetectionKind;
    }
  | { id: string; type: 'redact-brush'; points: number[]; size: number; mode: 'blur' | 'bar' };

export type AnnotationType = Annotation['type'];

export interface EditorDoc {
  version: 1;
  image: { id: string; width: number; height: number };
  /** Auto-balance trim of uniform borders, in source image pixels. */
  crop: Box | null;
  /** 0..0.3, fraction of max(content w, h). */
  padding: number;
  background: Background;
  /** Corner radius in output pixels. */
  radius: number;
  /** 0..1 */
  shadow: number;
  frame: FrameId;
  preset: PresetId;
  custom?: { width: number; height: number };
  annotations: Annotation[];
}

export interface ImageSource {
  id: string;
  width: number;
  height: number;
  element: CanvasImageSource;
}

export interface ExportOptions {
  format: 'png' | 'jpeg' | 'webp';
  /** 0..1, ignored for PNG. */
  quality: number;
  scale: 1 | 2 | 3;
  licensed: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  /** Output canvas size in px (before the export scale factor). */
  width: number;
  height: number;
  /** Where the (cropped) source image lands in the output; `scale` maps source px to output px. */
  content: Rect & { scale: number };
  /** The whole framed object (content plus frame chrome) in output px. Equals `content` for frame "none". */
  frame: Rect;
  /** The padding between the canvas edge and the framed object, in output px. */
  pad: number;
}

/** Drawing style used by new annotations. */
export interface Style {
  color: string;
  strokeWidth: number;
  fontSize: number;
  blurMode: BlurMode;
  /** Brush diameter in screen pixels. */
  brushSize: number;
  brushMode: 'blur' | 'bar';
}

export type EditorEvent = 'change' | 'select' | 'tool' | 'view';
