'use client';

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDemoClock } from './use-demo-clock';

const LINES = [
  '$ pnpm deploy --prod',
  'Building 14 routes…',
  'Error 502: upstream timed out after 30s',
  'at uploadWorker (worker.ts:218)',
  'Retry with --batch 8 or raise the timeout.',
];

/**
 * A terminal screenshot. The text in it is "recognised" on first view, and Copy text really puts it on
 * your clipboard, the way the apps do with any image.
 */
export function TextDemo() {
  const clock = useDemoClock<HTMLDivElement>({ steps: 2, duration: [1200, 3_600_000] });
  const recognised = clock.step >= 1;
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(LINES.join('\n'));
    } catch {
      // The clipboard can be blocked (for example inside an iframe). The demo still shows the result.
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  }

  return (
    <div ref={clock.ref} className="mock-window overflow-hidden">
      <div className="mock-bar">
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="ml-3 text-[13px] text-[#6c665c]">deploy-log.png</span>
        <span className="ml-auto hidden text-[12px] text-[#6c665c] sm:inline">1600 × 900</span>
      </div>
      <div
        className="relative bg-[#171513] px-6 py-6 font-mono text-[13.5px] leading-[1.9]"
        data-demo=""
        data-illustration=""
      >
        {LINES.map((line, i) => (
          <p
            key={line}
            className={i === 2 ? 'text-[#f2a07b]' : i === 0 ? 'text-[#f7f2ea]' : 'text-[#bdb5a7]'}
          >
            <span
              className={cn('demo-select is-dark', recognised && 'is-on')}
              style={{ transitionDelay: recognised ? `${i * 120}ms` : '0ms' }}
            >
              {line}
            </span>
          </p>
        ))}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <p className="text-[13px] text-ink-3" aria-live="polite">
          {copied
            ? '5 lines on your clipboard. Paste them anywhere.'
            : recognised
              ? '5 lines recognised on this device.'
              : 'Reading the text'}
        </p>
        <button
          type="button"
          onClick={copy}
          disabled={!recognised}
          className={cn(
            'inline-flex h-10 items-center gap-2 rounded-md border px-4 text-[14px] font-medium transition-colors',
            copied
              ? 'border-transparent bg-[#e6efe3] text-[#2f5e3b]'
              : 'border-line bg-surface text-ink hover:border-ink-3',
          )}
        >
          {copied ? (
            <Check className="size-4" aria-hidden="true" />
          ) : (
            <Copy className="size-4" aria-hidden="true" />
          )}
          {copied ? 'Copied' : 'Copy text'}
        </button>
      </div>
    </div>
  );
}
