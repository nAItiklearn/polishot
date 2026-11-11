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
  /** Increments whenever a step starts or restarts. Use it as a React key to restart CSS progress. */
  epoch: number;
  /** Length of the current step in ms. */
  stepDuration: number;
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
  // Bumped every time a step (re)starts. Lets CSS restart the progress animation without per-frame state.
  const [epoch, setEpoch] = useState(0);
  const [visible, setVisible] = useState(false);
  const [pageHidden, setPageHidden] = useState(false);
  const [held, setHeld] = useState(false);
  const [reduced, setReduced] = useState(true);
  const [started, setStarted] = useState(false);
  const elapsed = useRef(0);
  const stepRef = useRef(step);
  stepRef.current = step;
  const epochRef = useRef(epoch);
  epochRef.current = epoch;

  const lengthOf = useCallback(
    (i: number) => (Array.isArray(duration) ? (duration[i] ?? duration[0] ?? 2000) : duration),
    // Callers pass array literals; compare by value so a re-render does not restart the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [Array.isArray(duration) ? duration.join(',') : duration],
  );

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const update = () => setPageHidden(document.visibilityState === 'hidden');
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
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
      setEpoch((e) => e + 1);
    }
  }, [visible, reduced, started]);

  const playing = visible && !pageHidden && !reduced && !held && started;

  // One timer per step, not one render per frame. Pausing keeps the time already spent on the step.
  useEffect(() => {
    if (!playing) return;
    const mine = epochRef.current;
    const startedAt = performance.now();
    const remaining = Math.max(0, lengthOf(stepRef.current) - elapsed.current);
    const timer = window.setTimeout(() => {
      elapsed.current = 0;
      setStep((stepRef.current + 1) % steps);
      setEpoch((e) => e + 1);
    }, remaining);
    return () => {
      window.clearTimeout(timer);
      // Only a pause (same step) keeps the elapsed time; a step change already reset it.
      if (epochRef.current === mine) elapsed.current += performance.now() - startedAt;
    };
  }, [playing, epoch, steps, lengthOf]);

  const goTo = useCallback(
    (next: number) => {
      setStarted(true);
      elapsed.current = 0;
      setStep(((next % steps) + steps) % steps);
      setEpoch((e) => e + 1);
    },
    [steps],
  );

  return {
    ref,
    step,
    epoch,
    stepDuration: lengthOf(step),
    playing,
    reduced,
    goTo,
    hold: setHeld,
  };
}
