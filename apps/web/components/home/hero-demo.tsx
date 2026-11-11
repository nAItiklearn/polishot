'use client';

import { Check, Copy, Download, ScanText, ShieldCheck, Sparkles, SquareDashed } from 'lucide-react';
import { LogoMark } from '@/components/logo';
import { cn } from '@/lib/utils';
import { Keys } from './keycap';
import { useDemoClock } from './use-demo-clock';

const STEPS = [
  { id: 'capture', label: 'Capture', status: 'Selecting a region', icon: SquareDashed },
  { id: 'balance', label: 'Balance', status: 'Framed and padded', icon: Sparkles },
  { id: 'redact', label: 'Redact', status: '3 found, all covered', icon: ShieldCheck },
  { id: 'text', label: 'Copy text', status: '6 lines copied', icon: ScanText },
  { id: 'export', label: 'Export', status: 'Saved, PNG at 2x', icon: Download },
] as const;

const DURATIONS = [2800, 2500, 3200, 2600, 2800];

/** The fake window that gets captured. Every value in it is made up and obviously so. */
function CapturedWindow({ step }: { step: number }) {
  const redacted = step >= 2;
  const selected = step >= 3;
  return (
    <div className="demo-window">
      <div className="demo-window-bar">
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="demo-dot" />
        <span className="ml-[2cqw] text-[1.15cqw] text-[#8a8378]">Northwind · Settings</span>
      </div>
      <div className="flex h-[calc(100%-4.2cqw)]">
        <div className="demo-window-side">
          {['Overview', 'Team', 'Billing', 'API', 'Security'].map((item) => (
            <span key={item} className={cn('demo-side-item', item === 'Billing' && 'is-active')}>
              {item}
            </span>
          ))}
        </div>
        <div className="flex-1 px-[2.6cqw] py-[2.2cqw]">
          <p className="text-[2.1cqw] font-semibold leading-none text-[#1d1b18]">Billing</p>
          <p className="mt-[0.8cqw] text-[1.15cqw] text-[#7c766c]">
            Plan, payment details and keys
          </p>
          <div className="mt-[2cqw] divide-y divide-[#ece6dc] border-y border-[#ece6dc]">
            {[
              ['Billing email', 'maya@northwind.example'],
              ['API key', 'sk_live_demo_7Hq2R9fXa'],
              ['Server IP', '203.0.113.42'],
            ].map(([k, v]) => (
              <div key={k} className="flex items-center justify-between py-[1.05cqw] text-[1.2cqw]">
                <span className="text-[#7c766c]">{k}</span>
                <span className="relative font-mono text-[#2a2722]">
                  {v}
                  <span className={cn('demo-redact', redacted && 'is-on')} />
                </span>
              </div>
            ))}
            <div className="flex items-center justify-between py-[1.05cqw] text-[1.2cqw]">
              <span className="text-[#7c766c]">Plan</span>
              <span className="rounded-full bg-[#f3e6dc] px-[0.9cqw] py-[0.2cqw] text-[1.05cqw] font-medium text-[#a2401c]">
                Team, yearly
              </span>
            </div>
          </div>
          <p className="relative mt-[1.8cqw] max-w-[38cqw] text-[1.15cqw] leading-[1.75] text-[#5f594f]">
            <span className={cn('demo-select', selected && 'is-on')}>
              Invoices are sent on the first of each month and are due within fourteen days. Change
              the billing email above to send them somewhere else.
            </span>
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The hero: a live, clickable run through one capture. Capture a window, watch it get framed, see the
 * secrets covered, copy its text and export it. Each step can be picked from the scrubber below.
 */
export function HeroDemo() {
  const clock = useDemoClock<HTMLDivElement>({ steps: STEPS.length, duration: DURATIONS });
  const { step } = clock;
  const current = STEPS[step] ?? STEPS[0];
  const StatusIcon = current.icon;

  return (
    <div ref={clock.ref} className="relative mx-auto w-full max-w-[1080px]">
      <div aria-hidden="true" className="demo-glow" />
      <div
        className="demo-device"
        onPointerEnter={() => clock.hold(true)}
        onPointerLeave={() => clock.hold(false)}
      >
        <div
          className="demo-stage"
          data-demo=""
          data-step={step}
          role="img"
          aria-label={`Polishot demo, step ${step + 1} of ${STEPS.length}: ${current.label}. ${current.status}.`}
        >
          {/* Desktop wallpaper, only seen during the capture. */}
          <div className={cn('demo-wallpaper', step >= 1 && 'is-hidden')} />

          {/* The editor that opens after the capture. */}
          <div className={cn('demo-editor', step >= 1 && 'is-on')}>
            <div className="demo-editor-bar">
              <span className="flex items-center gap-[0.8cqw]">
                <LogoMark className="size-[1.9cqw]" />
                <span className="text-[1.15cqw] font-medium text-[#1d1b18]">Capture, just now</span>
              </span>
              <span className="flex items-center gap-[0.6cqw]">
                {['A', 'R', 'B', 'T'].map((k) => (
                  <span key={k} className="demo-tool">
                    {k}
                  </span>
                ))}
              </span>
            </div>
            <div className="demo-canvas" />
            <div className="demo-panel">
              <p className="demo-panel-label">Style</p>
              <div className="demo-row">
                <span>Auto-balance</span>
                <span className="demo-check">
                  <Check className="size-[1.1cqw]" />
                </span>
              </div>
              <div className="demo-row">
                <span>Padding</span>
                <span className="demo-slider">
                  <span style={{ width: '62%' }} />
                </span>
              </div>
              <div className="demo-row">
                <span>Corners</span>
                <span className="demo-slider">
                  <span style={{ width: '40%' }} />
                </span>
              </div>
              <div className="mt-[1cqw] flex gap-[0.7cqw]">
                {['#f6c8a8', '#e9dccb', '#c9d6c3', '#cfd6e6', '#2a2722'].map((c, i) => (
                  <span
                    key={c}
                    className={cn('demo-swatch', i === 0 && 'is-active')}
                    style={{ background: c }}
                  />
                ))}
              </div>
              <p className="demo-panel-label mt-[2.2cqw]">Found on this image</p>
              {['Email address', 'API key', 'IP address'].map((label, i) => (
                <div
                  key={label}
                  className={cn('demo-found', step >= 2 && 'is-on')}
                  style={{ transitionDelay: step >= 2 ? `${i * 260 + 200}ms` : '0ms' }}
                >
                  <ShieldCheck className="size-[1.2cqw] text-[#b03c15]" />
                  <span>{label}</span>
                  <span className="ml-auto text-[#8a8378]">Covered</span>
                </div>
              ))}
            </div>
          </div>

          {/* The captured window: on the desktop first, then framed on the canvas. */}
          <div className={cn('demo-captured', step >= 1 && 'is-framed')}>
            <CapturedWindow step={step} />
          </div>

          {/* Capture: the screen dims and a selection is dragged around the window. */}
          <div className={cn('demo-marquee', step === 0 && 'is-on')}>
            <span className="demo-marquee-size">1280 × 800</span>
          </div>

          {/* Toasts for copy and export. */}
          <div className={cn('demo-toast', step === 3 && 'is-on')}>
            <Copy className="size-[1.3cqw]" />
            Copied 6 lines of text
          </div>
          <div className={cn('demo-toast', step === 4 && 'is-on')}>
            <Check className="size-[1.3cqw]" />
            Saved northwind-billing.png
            <span className="text-[#a59d90]">PNG · 2x · 1.2 MB</span>
          </div>

          {/* The status pill that hangs from the top edge, like a notch. */}
          <div className="demo-notch">
            <LogoMark className="size-[1.7cqw]" />
            <StatusIcon className="size-[1.3cqw] text-[#f2b48f]" aria-hidden="true" />
            <span key={step} className="demo-notch-text">
              {current.status}
            </span>
          </div>
        </div>
      </div>

      {/* Scrubber: one segment per step, each a button. */}
      <div className="mx-auto mt-6 max-w-[760px]">
        <ol className="grid grid-cols-5 gap-2" aria-label="Demo steps">
          {STEPS.map((s, i) => {
return (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => clock.goTo(i)}
                  aria-current={i === step ? 'step' : undefined}
                  className="group block w-full rounded-md pb-1 pt-2 text-left"
                >
                  <span className="demo-scrub" data-demo="">
                    {i < step ? (
                      <span style={{ transform: 'none' }} />
                    ) : i === step ? (
                      // Filled by a CSS animation of the step's length, paused with the demo.
                      <span
                        key={clock.epoch}
                        className={clock.reduced ? undefined : 'is-running'}
                        style={{
                          transform: clock.reduced ? 'none' : undefined,
                          animationDuration: `${clock.stepDuration}ms`,
                          animationPlayState: clock.playing ? 'running' : 'paused',
                        }}
                      />
                    ) : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="mt-5 min-h-[28px] text-center text-[15px] text-ink-2">
          {step === 0 ? (
            <>
              Press <Keys keys={['Ctrl', 'Shift', '2']} size="sm" /> and drag.
            </>
          ) : step === 1 ? (
            'Trimmed, padded and set on a matching background.'
          ) : step === 2 ? (
            'Emails, keys and IP addresses, found and covered.'
          ) : step === 3 ? (
            'The words in the image, ready to paste.'
          ) : (
            'Saved, or copied straight to the clipboard.'
          )}
        </p>
      </div>
    </div>
  );
}
