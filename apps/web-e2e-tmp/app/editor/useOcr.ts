'use client';

import type { OcrWord } from '@polishot/redact';
import { useCallback, useEffect, useRef, useState } from 'react';
import { disposeOcr, recognize, type OcrProgress, type OcrStage } from './ocr';

export interface OcrState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** Null until recognition has finished for the current image. */
  words: OcrWord[] | null;
  stage: OcrStage;
  /** 0..1 across the whole job (engine, model, reading). */
  progress: number;
  error: string | null;
}

const IDLE: OcrState = { status: 'idle', words: null, stage: 'engine', progress: 0, error: null };

/** Share of the progress bar each stage owns. Reading dominates on a large screenshot. */
const STAGE_RANGE: Record<OcrStage, [number, number]> = {
  engine: [0, 0.25],
  model: [0.25, 0.35],
  read: [0.35, 1],
};

export const STAGE_LABEL: Record<OcrStage, string> = {
  engine: 'Loading the text engine',
  model: 'Loading the language model',
  read: 'Reading text',
};

/**
 * Runs on-device OCR for one decoded image, only when `start` is called. Results belong to the image they
 * were computed for: switching images discards them and stops any recognition still in flight.
 */
export function useOcr(bitmap: ImageBitmap | null, imageId: string | null) {
  const [state, setState] = useState<OcrState>(IDLE);
  const statusRef = useRef<OcrState['status']>('idle');
  const token = useRef(0);

  const set = useCallback((next: OcrState) => {
    statusRef.current = next.status;
    setState(next);
  }, []);

  // A new image invalidates everything about the old one.
  useEffect(() => {
    const wasRunning = statusRef.current === 'running';
    token.current++;
    if (wasRunning) disposeOcr();
    set(IDLE);
  }, [imageId, set]);

  // Free the engine when the editor goes away.
  useEffect(() => () => disposeOcr(), []);

  const start = useCallback(async () => {
    if (!bitmap || statusRef.current === 'running' || statusRef.current === 'done') return;
    const mine = ++token.current;
    const alive = () => token.current === mine;
    set({ ...IDLE, status: 'running' });
    const onProgress = ({ stage, fraction }: OcrProgress) => {
      if (!alive()) return;
      const [from, to] = STAGE_RANGE[stage];
      setState((s) => (s.status === 'running' ? { ...s, stage, progress: Math.max(s.progress, from + (to - from) * fraction) } : s));
    };
    try {
      const words = await recognize(bitmap, onProgress);
      if (alive()) set({ status: 'done', words, stage: 'read', progress: 1, error: null });
    } catch (err) {
      if (alive()) {
        set({ ...IDLE, status: 'error', error: err instanceof Error ? err.message : 'Text recognition failed.' });
      }
    }
  }, [bitmap, set]);

  return { ...state, start };
}
