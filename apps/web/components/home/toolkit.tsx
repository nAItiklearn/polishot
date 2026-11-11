'use client';

import type { CSSProperties, ReactNode } from 'react';
import {
  Check,
  Clapperboard,
  Copy,
  Laptop,
  Layers,
  Pin,
  ScrollText,
  ShieldCheck,
  Smartphone,
  SquareDashed,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Keys } from './keycap';
import { useDemoClock } from './use-demo-clock';

type Visual = (props: { step: number }) => ReactNode;

interface Tool {
  id: string;
  label: string;
  icon: typeof Check;
  keys?: string[];
  title: string;
  note: string;
  visual: Visual;
  /** Where the card floats on wide screens, and its tilt. */
  place: CSSProperties;
  tilt: number;
  durations?: number[];
}

/* ---- The little live visuals. Each is driven by a three-step clock: 0 before, 1 doing, 2 done. ---- */

function CaptureVisual({ step }: { step: number }) {
  return (
    <div className="tv-screen">
      <div className="tv-ui">
        <span className="w-[40%]" />
        <span className="w-[70%]" />
        <span className="w-[55%]" />
        <span className="w-[62%]" />
      </div>
      <div className={cn('tv-marquee', step >= 1 && 'is-on')} />
      <span className={cn('tv-chip right-2 top-2', step >= 2 && 'is-on')}>1280 × 800</span>
    </div>
  );
}

function RedactVisual({ step }: { step: number }) {
  return (
    <div className="tv-paper space-y-2 px-4 py-4 font-mono text-[12px] text-[#2a2722]">
      {['maya@northwind.example', 'sk_live_demo_7Hq2R9', '203.0.113.42'].map((v, i) => (
        <span key={v} className="flex items-center justify-between gap-3">
          <span className="font-sans text-[11px] text-[#6c665c]">{['Email', 'Key', 'IP'][i]}</span>
          <span className="relative">
            {v}
            <span
              className={cn('demo-redact', step >= 1 && 'is-on')}
              style={{ transitionDelay: step >= 1 ? `${i * 220}ms` : '0ms' }}
            />
          </span>
        </span>
      ))}
    </div>
  );
}

function TextVisual({ step }: { step: number }) {
  return (
    <div className="tv-paper relative px-4 py-4 text-left text-[12.5px] leading-[1.7] text-[#4a4841]">
      <span className={cn('demo-select', step >= 1 && 'is-on')}>
        Error 502: the upstream timed out after 30 seconds. Retry with a smaller batch.
      </span>
      <span className={cn('tv-chip bottom-2 right-2', step >= 2 && 'is-on')}>
        <Copy className="size-3" aria-hidden="true" /> Copied
      </span>
    </div>
  );
}

function ScrollVisual({ step }: { step: number }) {
  return (
    <div className="tv-screen">
      <div className={cn('tv-scroll', step >= 1 && 'is-on')}>
        {Array.from({ length: 9 }, (_, i) => (
          <span key={i} className="tv-scroll-row">
            <span
              className="size-5 shrink-0 rounded-[5px]"
              style={{ background: ['#f2c3a5', '#d9e2cf', '#d7dbe8'][i % 3] }}
            />
            <span className="h-2 flex-1 rounded-full bg-[#e6dfd3]" />
          </span>
        ))}
      </div>
      <span className={cn('tv-chip bottom-2 right-2', step >= 2 && 'is-on')}>
        Stitched, 4 frames
      </span>
    </div>
  );
}

function GifVisual({ step }: { step: number }) {
  return (
    <div className="tv-paper flex flex-col justify-between px-4 py-4">
      <span className="flex items-center gap-2 text-[12px] font-medium text-[#2a2722]">
        <span className={cn('tv-rec', step === 1 && 'is-on')} />
        {step === 0 ? 'Ready to record' : step === 1 ? 'Recording 0:03' : 'Saved GIF, 1.8 MB'}
      </span>
      <span className="flex gap-1.5 overflow-hidden">
        {Array.from({ length: 6 }, (_, i) => (
          <span
            key={i}
            className={cn('tv-frame', step >= 1 && 'is-on')}
            style={{ transitionDelay: step >= 1 ? `${i * 140}ms` : '0ms' }}
          />
        ))}
      </span>
    </div>
  );
}

function SendVisual({ step }: { step: number }) {
  return (
    <div className="tv-paper relative flex items-center justify-between px-6">
      <span className="tv-device">
        <Smartphone className="size-6" aria-hidden="true" />
      </span>
      <span className="relative mx-3 h-px flex-1 border-t border-dashed border-[#cfc6b8]">
        <span className={cn('tv-packet', step >= 1 && 'is-on')} />
      </span>
      <span className={cn('tv-device', step >= 2 && 'is-done')}>
        {step >= 2 ? (
          <Check className="size-6" aria-hidden="true" />
        ) : (
          <Laptop className="size-6" aria-hidden="true" />
        )}
      </span>
      <span className="absolute bottom-2 left-1/2 -translate-x-1/2 font-mono text-[11px] tracking-[0.2em] text-[#6c665c]">
        482 913
      </span>
    </div>
  );
}

function PinVisual({ step }: { step: number }) {
  return (
    <div className="tv-screen">
      <div className="tv-ui">
        <span className="w-[50%]" />
        <span className="w-[80%]" />
        <span className="w-[66%]" />
      </div>
      <span className={cn('tv-pinned', step >= 1 && 'is-on')}>
        <span className={cn('tv-pin', step >= 2 && 'is-on')}>
          <Pin className="size-3" aria-hidden="true" />
        </span>
      </span>
    </div>
  );
}

const LOOKS = [
  { name: 'Launch', bg: 'linear-gradient(135deg,#f7c6a3,#ee8f63)' },
  { name: 'Docs', bg: 'linear-gradient(135deg,#ece4d6,#d8cdbb)' },
  { name: 'Social', bg: 'linear-gradient(135deg,#cfd8ea,#9fb2d6)' },
];

function PresetVisual({ step }: { step: number }) {
  const active = step % LOOKS.length;
  return (
    <div className="tv-paper flex items-center gap-4 px-4">
      <span className="tv-look" style={{ background: LOOKS[active]!.bg }}>
        <span />
      </span>
      <span className="flex flex-col gap-1.5">
        {LOOKS.map((l, i) => (
          <span key={l.name} className={cn('tv-look-chip', i === active && 'is-active')}>
            {l.name}
          </span>
        ))}
      </span>
    </div>
  );
}

const TOOLS: Tool[] = [
  {
    id: 'capture',
    label: 'Capture',
    icon: SquareDashed,
    keys: ['Ctrl', 'Shift', '2'],
    title: 'Any region, any app.',
    note: 'Press Space for a whole window.',
    visual: CaptureVisual,
    place: { left: 'calc(50% - 160px)', top: '0' },
    tilt: -1.5,
  },
  {
    id: 'redact',
    label: 'Auto-redact',
    icon: ShieldCheck,
    title: 'Secrets, covered.',
    note: 'Emails, keys, cards and IPs.',
    visual: RedactVisual,
    place: { left: '0', top: '8%' },
    tilt: -3,
  },
  {
    id: 'gif',
    label: 'GIF',
    icon: Clapperboard,
    title: 'Record a GIF.',
    note: 'Any region, straight to a file.',
    visual: GifVisual,
    place: { right: '0', top: '11%' },
    tilt: 3,
  },
  {
    id: 'scroll',
    label: 'Scrolling capture',
    icon: ScrollText,
    title: 'The whole page.',
    note: 'Scrolled and stitched for you.',
    visual: ScrollVisual,
    place: { left: '2%', top: '42%' },
    tilt: 2.5,
  },
  {
    id: 'send',
    label: 'Quick send',
    icon: Smartphone,
    title: 'Phone to PC.',
    note: 'Over your own Wi-Fi, encrypted.',
    visual: SendVisual,
    place: { right: '2%', top: '45%' },
    tilt: -2,
  },
  {
    id: 'pin',
    label: 'Pin',
    icon: Pin,
    title: 'Keep it on top.',
    note: 'Float a capture over any app.',
    visual: PinVisual,
    place: { left: '5%', bottom: '0' },
    tilt: -2,
  },
  {
    id: 'text',
    label: 'Copy text',
    icon: Copy,
    keys: ['Ctrl', 'C'],
    title: 'Text, out of pixels.',
    note: 'Recognised on your device.',
    visual: TextVisual,
    place: { left: 'calc(50% - 160px)', bottom: '3%' },
    tilt: 1.5,
  },
  {
    id: 'presets',
    label: 'Presets',
    icon: Layers,
    title: 'Your looks, saved.',
    note: 'Three free, unlimited with Pro.',
    visual: PresetVisual,
    place: { right: '5%', bottom: '1%' },
    tilt: 2,
    durations: [1600, 1600, 1600],
  },
];

function ToolCard({ tool, index }: { tool: Tool; index: number }) {
  const clock = useDemoClock<HTMLButtonElement>({
    steps: 3,
    duration: tool.durations ?? [900 + index * 70, 1800, 1700],
  });
  const Icon = tool.icon;
  const Visual = tool.visual;
  return (
    <button
      ref={clock.ref}
      type="button"
      onClick={() => (clock.reduced ? undefined : clock.goTo(0))}
      onPointerEnter={() => (clock.reduced ? undefined : clock.goTo(0))}
      className="tool-card"
      style={{ ...tool.place, '--tilt': `${tool.tilt}deg` } as CSSProperties}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <span className="grid size-7 place-items-center rounded-md bg-[#efe8dc] text-ink-2">
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <span className="tool-label">{tool.label}</span>
        </span>
        {tool.keys ? <Keys keys={tool.keys} size="sm" /> : null}
      </span>
      <span className="mt-3 block h-[132px]" data-demo="" data-illustration="" aria-hidden="true">
        <Visual step={clock.step} />
      </span>
      <span className="mt-3.5 block text-[17px] font-semibold leading-tight text-ink">
        {tool.title}
      </span>
      <span className="mt-1 block text-[13.5px] text-ink-3">{tool.note}</span>
      <span className="sr-only"> Replay the demo.</span>
    </button>
  );
}

/** Eight small live cards floating around the section title. Hover or click a card to replay it. */
export function Toolkit({ children }: { children: ReactNode }) {
  return (
    <div className="toolkit">
      <div className="toolkit-title">{children}</div>
      {TOOLS.map((tool, i) => (
        <ToolCard key={tool.id} tool={tool} index={i} />
      ))}
    </div>
  );
}
