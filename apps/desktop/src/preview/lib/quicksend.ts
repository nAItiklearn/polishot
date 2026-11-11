/**
 * Quick send, the parts that need no DOM: which device a "Send" press should go to, the pairing
 * dialog's state machine, and the little formatting the prompts need. Everything here is pure so the
 * rules (never auto-confirm a code, one online device is the target, 50 MB limit) can be tested.
 */
import type { DeviceEntry, IncomingFile, PairCode } from '../../shared/ipc';
import type { KeyValueStore } from './brand';

/** The backend refuses anything larger (CONTRACT-CHANGES, `qs_send`). */
export const SEND_LIMIT_BYTES = 50 * 1024 * 1024;

/** The backend declines an unanswered prompt after 55 s; the card goes away at the same moment. */
export const INCOMING_TIMEOUT_MS = 55_000;

export function pairedDevices(list: readonly DeviceEntry[] | null): DeviceEntry[] {
  return (list ?? []).filter((d) => d.paired);
}

/** Phones that are visible on the network and not paired yet: the ones the pairing dialog offers. */
export function nearbyDevices(list: readonly DeviceEntry[] | null): DeviceEntry[] {
  return (list ?? []).filter((d) => !d.paired && d.online);
}

/**
 * What pressing Send does:
 * - `pair`   nothing is paired (or the list is not known): open the pairing dialog;
 * - `direct` exactly one paired device is nearby: send to it, no questions asked;
 * - `menu`   otherwise: let the user choose (offline devices are listed, dimmed).
 */
export type SendTarget = { kind: 'pair' } | { kind: 'direct'; device: DeviceEntry } | { kind: 'menu'; devices: DeviceEntry[] };

export function resolveSendTarget(list: readonly DeviceEntry[] | null): SendTarget {
  const paired = pairedDevices(list);
  if (paired.length === 0) return { kind: 'pair' };
  const online = paired.filter((d) => d.online);
  if (online.length === 1) return { kind: 'direct', device: online[0]! };
  return { kind: 'menu', devices: paired };
}

/** Tooltip / palette wording for the Send action, which names the phone when there is one obvious target. */
export function sendLabel(list: readonly DeviceEntry[] | null): string {
  const target = resolveSendTarget(list);
  return target.kind === 'direct' ? `Send to ${target.device.name}` : 'Send to phone';
}

/** "842 KB", "1.2 MB". Binary units, as Windows shows them. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** A readable reason the export cannot be sent, or null. */
export function oversizeMessage(bytes: number): string | null {
  if (bytes <= SEND_LIMIT_BYTES) return null;
  return `That image is ${formatBytes(bytes)}, and quick send takes up to ${formatBytes(SEND_LIMIT_BYTES)}. Export a smaller size from the Export tab.`;
}

/** "screenshot.png · 1.2 MB" for the prompt under "Pixel 8 wants to send you an image". */
export function incomingSummary(file: Pick<IncomingFile, 'name' | 'size'>): string {
  const size = formatBytes(file.size);
  return size ? `${file.name} · ${size}` : file.name;
}

/* ------------------------------------------------------------------ */
/* Pairing dialog state                                                 */
/* ------------------------------------------------------------------ */

export type PairState =
  | { step: 'idle' }
  /** Waiting for a phone to be picked (or to start pairing itself). */
  | { step: 'browse' }
  /** This PC dialled `name` (device `deviceId`); waiting for the code. */
  | { step: 'dialing'; name: string; deviceId: string }
  /**
   * Both screens show `code`. `answered` once the user pressed a button and the backend is finishing. `another`
   * when a different device tried to pair meanwhile: its code is not shown, so the user cannot be steered into
   * confirming it, but they are told it happened.
   */
  | { step: 'compare'; code: PairCode; answered: boolean; another: boolean }
  | { step: 'success'; device: DeviceEntry }
  | { step: 'failed'; message: string };

export type PairAction =
  | { type: 'open' }
  | { type: 'close' }
  | { type: 'dial'; name: string; deviceId: string }
  | { type: 'code'; code: PairCode }
  | { type: 'answer' }
  | { type: 'paired'; device: DeviceEntry }
  | { type: 'fail'; message: string }
  | { type: 'retry' };

export const PAIR_IDLE: PairState = { step: 'idle' };

const sameCode = (a: PairCode, b: PairCode): boolean => a.sas === b.sas && a.peerId.toUpperCase() === b.peerId.toUpperCase();

/**
 * Transitions of the pairing dialog. A code that arrives while the dialog is closed is ignored (the
 * backend only offers pairing while the dialog is open), and a code is never confirmed by any
 * transition here: only the `answer` the user triggers moves past the comparison.
 *
 * The code on screen is the one the user is comparing and the one the answer is sent for, so it is never
 * replaced underneath them: a second, different code while one is shown only sets `another`, and while this PC is
 * dialling, only the device it dialled can produce the code.
 */
export function pairReducer(state: PairState, action: PairAction): PairState {
  switch (action.type) {
    case 'open':
      return state.step === 'idle' ? { step: 'browse' } : state;
    case 'close':
      return PAIR_IDLE;
    case 'dial':
      return state.step === 'browse' || state.step === 'failed' ? { step: 'dialing', name: action.name, deviceId: action.deviceId } : state;
    case 'code': {
      if (state.step === 'idle' || state.step === 'success') return state;
      if (state.step === 'compare') {
        // The same code reported twice (the command result and the event) changes nothing, and neither does a
        // different one: the visible prompt stays, with a note.
        if (sameCode(state.code, action.code) || state.another) return state;
        return { ...state, another: true };
      }
      if (state.step === 'dialing' && state.deviceId.toUpperCase() !== action.code.peerId.toUpperCase()) return state;
      return { step: 'compare', code: action.code, answered: false, another: false };
    }
    case 'answer':
      return state.step === 'compare' ? { ...state, answered: true } : state;
    case 'paired':
      return state.step === 'compare' || state.step === 'dialing' ? { step: 'success', device: action.device } : state;
    case 'fail':
      return state.step === 'idle' || state.step === 'success' ? state : { step: 'failed', message: action.message };
    case 'retry':
      return state.step === 'failed' ? { step: 'browse' } : state;
  }
}

/* ------------------------------------------------------------------ */
/* "This PC has paired a device" hint                                   */
/* ------------------------------------------------------------------ */

export const QS_HINT_KEY = 'polishot.qs.v1';

/**
 * Looking at the device list is what starts the network listener (and shows Windows' firewall prompt),
 * so the app only does it on launch when a device is known to be paired. This remembers that.
 */
export function loadPairedHint(store: KeyValueStore | null | undefined): boolean {
  try {
    return store?.getItem(QS_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

export function savePairedHint(store: KeyValueStore | null | undefined, hasPaired: boolean): void {
  try {
    if (!store) return;
    if (hasPaired) store.setItem(QS_HINT_KEY, '1');
    else store.removeItem(QS_HINT_KEY);
  } catch {
    // storage may be unavailable; the app then simply waits for the first use
  }
}
