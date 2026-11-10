'use client';

import { useEffect, useRef } from 'react';
import { createRunner, type Runner } from './gl-runner';
import { SHADERS, type ShaderVariant } from './shaders';

interface ShaderCanvasProps {
  variant: ShaderVariant;
  /** 0..1 brightness of the whole effect. */
  intensity?: number;
  /** Moves the composition, in screen-height units (x right, y up). */
  offset?: [number, number];
  /** Frame cap while animating. */
  fps?: number;
}

/** Render scale: half of CSS pixels, with device pixel ratio capped at 1.5. */
const SCALE = 0.5;
const DPR_CAP = 1.5;

type State = 'pending' | 'running' | 'paused' | 'static' | 'unsupported';

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 2000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 300);
  return () => window.clearTimeout(id);
}

/**
 * A live background. It renders nothing visible by itself: the host (`.shader-surface`) already shows a CSS
 * gradient that matches the first frame. After the page is idle and the host is near the viewport, a canvas is
 * created and faded in over it. It pauses off-screen and in hidden tabs, draws one still frame under
 * prefers-reduced-motion, and stays out of the way if WebGL2 is unavailable.
 */
export function ShaderCanvas({ variant, intensity = 1, offset = [0, 0], fps = 30 }: ShaderCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const [offsetX, offsetY] = offset;

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const spec = SHADERS[variant];
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let runner: Runner | null = null;
    let canvas: HTMLCanvasElement | null = null;
    let nearViewport = false;
    let inView = false;
    let started = false;
    let cancelIdle: (() => void) | null = null;
    let disposed = false;

    const setState = (state: State) => {
      el.dataset.shaderState = state;
    };
    setState('pending');

    const size = () => {
      if (!runner || !canvas) return;
      const scale = Math.min(window.devicePixelRatio || 1, DPR_CAP) * SCALE;
      runner.resize(el.clientWidth * scale, el.clientHeight * scale);
    };

    // Decide between playing, a single still frame, or paused, from the current conditions.
    const sync = () => {
      if (!runner) return;
      if (reduceMotion.matches) {
        runner.stop();
        runner.renderAt(spec.staticPhase);
        setState('static');
      } else if (inView && !document.hidden) {
        runner.start();
        setState('running');
      } else {
        runner.stop();
        setState('paused');
      }
    };

    const init = async () => {
      if (disposed || started) return;
      started = true;
      const created = document.createElement('canvas');
      created.setAttribute('aria-hidden', 'true');
      const made = await createRunner(created, {
        fragment: spec.fragment,
        loopSeconds: spec.loopSeconds,
        fps,
        intensity,
        offset: [offsetX, offsetY],
        onLost: () => {
          created.removeAttribute('data-ready');
          setState('unsupported');
        },
      });
      if (disposed) {
        made?.destroy();
        return;
      }
      if (!made) {
        setState('unsupported');
        return;
      }
      runner = made;
      canvas = created;
      el.appendChild(created);
      size();
      runner.renderAt(spec.staticPhase);
      // Fade in on the next frame so the CSS transition runs.
      requestAnimationFrame(() => canvas?.setAttribute('data-ready', ''));
      sync();
    };

    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) inView = entry.isIntersecting;
        if (inView) nearViewport = true;
        if (nearViewport && !started && !cancelIdle) cancelIdle = whenIdle(() => void init());
        sync();
      },
      { rootMargin: '200px' },
    );
    io.observe(el);

    const ro = new ResizeObserver(size);
    ro.observe(el);

    const onVisibility = () => sync();
    document.addEventListener('visibilitychange', onVisibility);
    reduceMotion.addEventListener('change', sync);

    return () => {
      disposed = true;
      cancelIdle?.();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      reduceMotion.removeEventListener('change', sync);
      runner?.destroy();
      canvas?.remove();
    };
  }, [variant, intensity, offsetX, offsetY, fps]);

  return <div ref={host} aria-hidden="true" className="shader-surface" data-variant={variant} />;
}
