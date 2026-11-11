'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface DemoClockOptions {
  /** Number of steps in the loop. */
  steps: number;
  /** How long each step is shown, in ms. One value for all steps or one per step. */
  duration: number | number[];
  /** Step shown when motion is reduced (and before hydration). Defaults to the last step. */
  restingStep?: number;
}

export interface DemoClock<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  step: number;
  /** 0..1 progress through the current step (0 when paused or under reduced motion). */
  progress: number;
  playing: boolean;
  reduced: boolean;
  /** Jump to a step. Playback continues from there. */
  goTo: (step: number) => void;
  /** Hold the current frame, e.g. while the pointer is over the demo. */
  hold: (held: boolean) => void;
}

/**
 * Drives a looping product demo. It only ticks while the demo is near the viewport and the tab is visible,
 * so offscreen demos cost nothing. Under prefers-reduced-motion it never advances on its own and rests on
 * the finished frame, but every step can still be chosen by hand.
 */
export function useDemoClock<T extends HTMLElement>({
  steps,
  duration,
  restingStep = steps - 1,
}: DemoClockOptions): DemoClock<T> {
  const ref = useRef<T | null>(null);
  const [step, setStep] = useState(restingStep);
  const [progress, setProgress] = useState(0);
  const [visible, setVisible] = useState(false);
  const [held, setHeld] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [started, setStarted] = useState(false);
  const elapsed = useRef(0);
  const stepRef = useRef(step);
  stepRef.current = step;

  const lengthOf = useCallback(
    (i: number) => (Array.isArray(duration) ? (duration[i] ?? duration[0] ?? 2000) : duration),
    [duration],
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setVisible(Boolean(entry?.isIntersecting)), {
      rootMargin: '120px 0px',
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // The first time the demo is seen with motion allowed, play it from the beginning.
  useEffect(() => {
    if (visible && !reduced && !started) {
      setStarted(true);
      elapsed.current = 0;
      setStep(0);
    }
  }, [visible, reduced, started]);

  const playing = visible && !reduced && !held && started;

  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = document.visibilityState === 'visible' ? Math.min(now - last, 100) : 0;
      last = now;
      elapsed.current += dt;
      const length = lengthOf(stepRef.current);
      if (elapsed.current >= length) {
        elapsed.current = 0;
        setProgress(0);
        setStep((stepRef.current + 1) % steps);
      } else {
        setProgress(elapsed.current / length);
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing, steps, lengthOf]);

  const goTo = useCallback(
    (next: number) => {
      setStarted(true);
      elapsed.current = 0;
      setProgress(0);
      setStep(((next % steps) + steps) % steps);
    },
    [steps],
  );

  return { ref, step, progress: reduced ? 0 : progress, playing, reduced, goTo, hold: setHeld };
}
