'use client';

import { Check, Lock, Send, Wifi } from 'lucide-react';
import { LogoMark } from '@/components/logo';
import { cn } from '@/lib/utils';
import { useDemoClock } from './use-demo-clock';

const STATUS = ['Ready', 'Sending over Wi-Fi', 'Waiting for you to accept', 'Received'];

/** The photo being sent: a phone screenshot of a boarding pass, drawn in HTML. */
function Photo({ className }: { className?: string }) {
  return (
    <span className={cn('qs-photo', className)} aria-hidden="true">
      <span className="qs-photo-head">
        <span>LIS</span>
        <span className="text-[0.7em] opacity-70">→</span>
        <span>CPH</span>
      </span>
      <span className="qs-photo-row">
        <span>Seat</span>
        <span>14A</span>
      </span>
      <span className="qs-photo-row">
        <span>Gate</span>
        <span>B22</span>
      </span>
      <span className="qs-photo-code" />
    </span>
  );
}

/**
 * Phone on the left, PC on the right. Press Send (or let it play): the image travels across, the PC asks,
 * and it opens in the editor. Nothing goes through a server.
 */
export function QuickSendDemo() {
  const clock = useDemoClock<HTMLDivElement>({ steps: 4, duration: [1800, 1500, 1500, 2600] });
  const { step } = clock;

  return (
    <div ref={clock.ref} className="qs-scene" data-demo="" data-illustration="" data-step={step}>
      {/* Phone */}
      <div className="qs-phone">
        <div className="qs-phone-screen">
          <p className="flex items-center justify-between text-[11px] text-[#6c665c]">
            <span>9:41</span>
            <Wifi className="size-3" aria-hidden="true" />
          </p>
          <p className="mt-3 text-[13px] font-semibold text-[#1d1b18]">Send to PC</p>
          <Photo className={cn('mt-3', step === 1 && 'is-leaving')} />
          <p className="mt-3 flex items-center gap-1.5 text-[11px] text-[#7c766c]">
            <Lock className="size-3" aria-hidden="true" />
            Paired with Studio PC
          </p>
          <button type="button" onClick={() => clock.goTo(1)} className="qs-send">
            <Send className="size-3.5" aria-hidden="true" />
            {step === 1 ? 'Sending' : step >= 2 ? 'Sent' : 'Send'}
          </button>
        </div>
      </div>

      {/* The image in flight */}
      <div className="qs-wire" aria-hidden="true">
        <span className={cn('qs-flyer', step === 1 && 'is-on')}>
          <Photo />
        </span>
      </div>

      {/* PC */}
      <div className="qs-pc">
        <div className="mock-bar">
          <LogoMark className="size-4" />
          <span className="ml-2 text-[12.5px] text-[#6c665c]">Polishot</span>
          <span className="ml-auto font-mono text-[11px] tracking-[0.16em] text-[#857d71]">
            482 913
          </span>
        </div>
        <div className="relative grid flex-1 place-items-center bg-[#efe8dc] p-5">
          <div className={cn('qs-canvas', step >= 3 && 'is-on')}>
            <Photo />
          </div>
          <div className={cn('qs-prompt', step === 2 && 'is-on')}>
            <p className="text-[13px] font-semibold text-[#1d1b18]">Image from Pixel phone</p>
            <p className="mt-0.5 text-[12px] text-[#7c766c]">boarding-pass.png · 412 KB</p>
            <div className="mt-3 flex gap-2">
              <button type="button" onClick={() => clock.goTo(0)} className="qs-btn">
                Decline
              </button>
              <button type="button" onClick={() => clock.goTo(3)} className="qs-btn is-primary">
                Accept
              </button>
            </div>
          </div>
        </div>
        <p
          className="flex items-center gap-1.5 border-t border-[#ece6dc] px-4 py-2.5 text-[12px] text-[#7c766c]"
          aria-live="polite"
        >
          {step >= 3 ? <Check className="size-3.5 text-[#3f7a4e]" aria-hidden="true" /> : null}
          {STATUS[step]}
        </p>
      </div>
    </div>
  );
}
