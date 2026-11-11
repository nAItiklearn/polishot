'use client';

import { useState } from 'react';
import { Eye, EyeOff, RotateCcw, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useDemoClock } from './use-demo-clock';

const FOUND = [
  { id: 'card', kind: 'Card number', value: '4242 4242 4242 4242' },
  { id: 'email', kind: 'Email address', value: 'maya@northwind.example' },
  { id: 'ip', kind: 'IP address', value: '203.0.113.42' },
  { id: 'key', kind: 'API key', value: 'sk_live_demo_7Hq2R9fXa' },
] as const;

type FoundId = (typeof FOUND)[number]['id'];

const ALL_COVERED: Record<FoundId, boolean> = { card: false, email: false, ip: false, key: false };

function Secret({ id, covered, bar }: { id: FoundId; covered: boolean; bar: boolean }) {
  const index = FOUND.findIndex((f) => f.id === id);
  return (
    <span className="relative whitespace-nowrap font-mono text-[0.92em]">
      {FOUND[index]!.value}
      <span
        className={cn('demo-redact', covered && 'is-on', bar && 'is-bar')}
        style={{ transitionDelay: covered ? `${index * 160}ms` : '0ms' }}
      />
    </span>
  );
}

/**
 * A support chat with secrets in it. On first view it is scanned, then every finding can be shown or
 * covered, with blur or a solid bar. All values are made up.
 */
export function RedactDemo() {
  const clock = useDemoClock<HTMLDivElement>({ steps: 2, duration: [1500, 3_600_000] });
  const scanned = clock.step >= 1;
  const [shown, setShown] = useState<Record<FoundId, boolean>>(ALL_COVERED);
  const [style, setStyle] = useState<'blur' | 'bar'>('blur');
  const secret = (id: FoundId) => (
    <Secret id={id} covered={scanned && !shown[id]} bar={style === 'bar'} />
  );

  return (
    <div ref={clock.ref} className="mock-window grid md:grid-cols-[1fr_260px]">
      <div className="relative overflow-hidden border-b border-[#ece6dc] md:border-b-0 md:border-r">
        <div className="mock-bar">
          <span className="demo-dot" />
          <span className="demo-dot" />
          <span className="demo-dot" />
          <span className="ml-3 text-[13px] text-[#6c665c]">Support · Ticket #4021</span>
        </div>
        <div
          className="relative space-y-4 p-5 text-[14.5px] leading-relaxed text-[#2a2722]"
          data-demo=""
          data-illustration=""
        >
          <div className="max-w-[90%] rounded-2xl rounded-tl-md bg-[#f1ebe1] px-4 py-3">
            <p className="mb-1 text-[12px] font-medium text-[#6c665c]">Maya, 9:41</p>
            Hi! Billing keeps failing. My card is {secret('card')} and the account email is{' '}
            {secret('email')}.
          </div>
          <div className="ml-auto max-w-[90%] rounded-2xl rounded-tr-md bg-[#1f1c19] px-4 py-3 text-[#f7f2ea]">
            <p className="mb-1 text-[12px] font-medium text-[#857d71]">You, 9:44</p>
            Thanks. The logs show calls from {secret('ip')} using {secret('key')}. I am rotating
            that key now.
          </div>
          <span aria-hidden="true" className={cn('demo-scan', clock.step === 0 && 'is-on')} />
        </div>
      </div>

      <div className="flex flex-col p-5">
        <p
          className="flex items-center gap-2 text-[13px] font-semibold text-ink"
          aria-live="polite"
        >
          <ShieldCheck className="size-4 text-accent-ink" aria-hidden="true" />
          {scanned ? `${FOUND.length} found on this image` : 'Scanning the image'}
        </p>
        <ul className="mt-4 space-y-1.5">
          {FOUND.map((f) => {
            const isShown = shown[f.id];
            return (
              <li key={f.id}>
                <button
                  type="button"
                  disabled={!scanned}
                  aria-pressed={!isShown}
                  onClick={() => setShown((s) => ({ ...s, [f.id]: !s[f.id] }))}
                  className={cn(
                    'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2.5 text-left text-[13.5px] transition-colors',
                    scanned
                      ? 'border-line bg-surface text-ink hover:border-ink-3'
                      : 'border-transparent bg-surface-2 text-ink-3',
                  )}
                >
                  <span>{f.kind}</span>
                  <span className="flex items-center gap-1.5 text-[12px] text-ink-3">
                    {isShown ? (
                      <Eye className="size-3.5" aria-hidden="true" />
                    ) : (
                      <EyeOff className="size-3.5" aria-hidden="true" />
                    )}
                    {isShown ? 'Shown' : 'Covered'}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-5">
          <p className="eyebrow text-[11px]">Cover with</p>
          <div
            className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-surface-2 p-1"
            role="group"
            aria-label="Cover style"
          >
            {(['blur', 'bar'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={style === s}
                onClick={() => setStyle(s)}
                className={cn(
                  'rounded-md py-1.5 text-[13px] font-medium transition-colors',
                  style === s ? 'bg-surface text-ink shadow-low' : 'text-ink-3 hover:text-ink',
                )}
              >
                {s === 'blur' ? 'Blur' : 'Solid bar'}
              </button>
            ))}
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            setShown(ALL_COVERED);
            // Under reduced motion the scan would never finish, so just recover everything.
            if (!clock.reduced) clock.goTo(0);
          }}
          className="mt-auto inline-flex items-center gap-1.5 self-start rounded-md pt-5 text-[13px] text-ink-2 hover:text-ink"
        >
          <RotateCcw className="size-3.5" aria-hidden="true" />
          Scan again
        </button>
      </div>
    </div>
  );
}
