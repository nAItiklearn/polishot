'use client';

import { useEffect, useState } from 'react';

const FLAG = 'ps-visit';

function whenIdle(callback: () => void): () => void {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout: 4000 });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 1500);
  return () => window.clearTimeout(id);
}

/**
 * The small "dot + 12,483 visitors" pill. It is only rendered when the server has the counter configured
 * (see SiteHeader). After the page is idle it counts this browser session once (POST, flagged in
 * sessionStorage) and later page views just read the number (GET). Nothing is shown until a real number
 * arrives, and nothing is faked if the request fails.
 */
export function VisitorCounter() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const counted = window.sessionStorage.getItem(FLAG) === '1';
        const res = await fetch('/api/visits', { method: counted ? 'GET' : 'POST' });
        if (!res.ok) return;
        const data = (await res.json()) as { count?: unknown };
        if (typeof data.count !== 'number' || cancelled) return;
        if (!counted) window.sessionStorage.setItem(FLAG, '1');
        setCount(data.count);
      } catch {
        // Offline, blocked, or storage disabled: stay blank.
      }
    };
    const cancelIdle = whenIdle(() => void run());
    return () => {
      cancelled = true;
      cancelIdle();
    };
  }, []);

  return (
    // The box is always reserved, so the number appearing never shifts the header.
    <span
      data-testid="visitor-pill"
      className="hidden h-7 w-[8.5rem] items-center justify-center md:inline-flex"
    >
      {count === null ? null : (
        <span className="inline-flex items-center gap-2 rounded-full border border-line px-3 py-1 font-mono text-xs text-ink-3">
          <span aria-hidden="true" className="size-1.5 rounded-full bg-accent" />
          <span>
            {new Intl.NumberFormat('en-US').format(count)} visitor{count === 1 ? '' : 's'}
          </span>
        </span>
      )}
    </span>
  );
}
