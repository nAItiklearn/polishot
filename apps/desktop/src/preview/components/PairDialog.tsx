import { Check, Smartphone } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { DeviceEntry } from '../../shared/ipc';
import type { QuickSend } from '../hooks/useQuickSend';
import { actionDef } from '../lib/commands';
import { nearbyDevices } from '../lib/quicksend';
import { useModal } from './Dialog';
import { Keys } from './Keys';

/** The Windows Firewall prompt appears the first time the listener starts (CONTRACT-CHANGES, Quick send). */
const FIREWALL_NOTE = 'Windows may ask to allow network access. Choose Private networks.';

function NearbyList({ devices, onDial }: { devices: DeviceEntry[]; onDial: (d: DeviceEntry) => void }) {
  if (devices.length === 0) {
    return (
      <p className="pv-pair-looking" role="status">
        <span className="pv-pulse" aria-hidden="true" />
        Looking for phones on this Wi-Fi…
      </p>
    );
  }
  return (
    <ul className="pv-pair-list" aria-label="Phones nearby">
      {devices.map((d) => (
        <li key={d.id} className="pv-pair-row">
          <Smartphone size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="pv-pair-name">{d.name}</span>
          <button type="button" className="pe-btn" onClick={() => onDial(d)} aria-label={`Pair with ${d.name}`}>
            Pair
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Pair a phone, step by step: wait for a phone (or pick one that is listed), compare the code on both
 * screens, done. The code is never confirmed for the user; only the two buttons answer it.
 */
export function PairDialog({ qs }: { qs: QuickSend }) {
  const { pair, devices, dial, answer, retryPairing, closePairing } = qs;
  const open = pair.step !== 'idle';
  const titleId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const ref = useModal(open, closePairing, () => primaryRef.current ?? ref.current?.querySelector<HTMLElement>('button') ?? null);
  // Each step is a new set of buttons; the one that carries on gets the focus, so Enter does the obvious thing.
  useEffect(() => {
    if (!open) return;
    const raf = requestAnimationFrame(() => primaryRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open, pair.step]);
  if (!open) return null;

  let title = 'Pair a phone';
  let body: ReactNode = null;

  switch (pair.step) {
    case 'browse':
      body = (
        <>
          <p className="pv-dialog-body">
            Open Polishot on your phone, choose Pair a new device, then pick this PC. Or pick your phone below if it is listed.
          </p>
          <NearbyList devices={nearbyDevices(devices)} onDial={dial} />
          <p className="pv-pair-note">{FIREWALL_NOTE}</p>
          <div className="pv-dialog-actions">
            <button ref={primaryRef} type="button" className="pe-btn" onClick={closePairing}>
              Cancel
            </button>
          </div>
        </>
      );
      break;
    case 'dialing':
      body = (
        <>
          <p className="pv-dialog-body" role="status">
            <span className="pv-pulse" aria-hidden="true" />
            Contacting {pair.name}…
          </p>
          <div className="pv-dialog-actions">
            <button ref={primaryRef} type="button" className="pe-btn" onClick={closePairing}>
              Cancel
            </button>
          </div>
        </>
      );
      break;
    case 'compare':
      title = 'Compare the codes';
      body = (
        <>
          <p className="pv-pair-code" aria-label={`Code ${pair.code.sas.split(' ').join(', ')}`}>
            {pair.code.sas}
          </p>
          <p className="pv-dialog-body" role="status">
            {pair.answered ? `Waiting for ${pair.code.peerName}…` : `Does ${pair.code.peerName} show the same code?`}
          </p>
          {pair.another ? (
            <p className="pv-pair-note" role="alert">
              Another device is trying to pair. Finish or cancel this one first; if you did not expect it, someone else on this network may be trying.
            </p>
          ) : null}
          <div className="pv-dialog-actions">
            <button type="button" className="pe-btn" disabled={pair.answered} onClick={() => answer(false)}>
              They don’t match
            </button>
            <button ref={primaryRef} type="button" className="pe-btn pe-btn-primary" disabled={pair.answered} onClick={() => answer(true)}>
              They match
            </button>
          </div>
        </>
      );
      break;
    case 'success':
      title = 'Paired';
      body = (
        <>
          <p className="pv-pair-done" role="status">
            <Check size={16} strokeWidth={1.5} aria-hidden="true" />
            Paired with {pair.device.name}. Send any capture with <Keys accelerator={actionDef('send-phone').shortcut} />.
          </p>
          <div className="pv-dialog-actions">
            <button ref={primaryRef} type="button" className="pe-btn pe-btn-primary" onClick={closePairing}>
              Done
            </button>
          </div>
        </>
      );
      break;
    case 'failed':
      title = 'Pairing didn’t finish';
      body = (
        <>
          <p className="pv-dialog-body" role="alert">
            {pair.message}
          </p>
          <div className="pv-dialog-actions">
            <button type="button" className="pe-btn" onClick={closePairing}>
              Close
            </button>
            <button ref={primaryRef} type="button" className="pe-btn pe-btn-primary" onClick={retryPairing}>
              Try again
            </button>
          </div>
        </>
      );
      break;
  }

  return createPortal(
    <div className="pv-scrim" onMouseDown={(e) => e.target === e.currentTarget && closePairing()}>
      <div ref={ref} className="pv-dialog pv-pair" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 className="pv-dialog-title" id={titleId}>
          {title}
        </h2>
        {body}
      </div>
    </div>,
    document.body,
  );
}
