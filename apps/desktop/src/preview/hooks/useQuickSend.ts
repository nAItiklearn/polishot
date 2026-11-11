/**
 * Quick send state for the preview window: the device list, the pairing dialog, incoming-file
 * prompts and files that arrived. The network listener (and Windows' firewall prompt) only starts
 * once something asks for devices, so this hook does not ask at launch unless a device is already
 * known to be paired.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { errorMessage, events, ipc, type CaptureMeta, type DeviceEntry, type IncomingFile } from '../../shared/ipc';
import type { Notify } from '../context';
import {
  INCOMING_TIMEOUT_MS,
  PAIR_IDLE,
  loadPairedHint,
  pairReducer,
  pairedDevices,
  savePairedHint,
  type PairState,
} from '../lib/quicksend';

export interface QuickSend {
  /** Null until the list has been asked for. */
  devices: DeviceEntry[] | null;
  /** Fetches the device list now (this is what starts the listener the first time). */
  refresh: () => Promise<DeviceEntry[]>;
  pair: PairState;
  openPairing: () => void;
  closePairing: () => void;
  /** Dial a phone that is visible on the network. */
  dial: (device: DeviceEntry) => void;
  /** The user's answer to "do both screens show this code?". */
  answer: (accepted: boolean) => void;
  retryPairing: () => void;
  forget: (device: DeviceEntry) => Promise<void>;
  incoming: IncomingFile[];
  respond: (requestId: number, accept: boolean) => void;
}

const MAX_PROMPTS = 3;
const PAIR_MISMATCH = 'Pairing was cancelled because the codes did not match. If you did not start it, someone else on this network may have.';

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function useQuickSend(notify: Notify, onReceived: (meta: CaptureMeta, peerName: string) => void): QuickSend {
  const [devices, setDevices] = useState<DeviceEntry[] | null>(null);
  const [pair, dispatch] = useReducer(pairReducer, PAIR_IDLE);
  const [incoming, setIncoming] = useState<IncomingFile[]>([]);

  const pairRef = useRef(pair);
  pairRef.current = pair;
  const notifyRef = useRef(notify);
  notifyRef.current = notify;
  const receivedRef = useRef(onReceived);
  receivedRef.current = onReceived;
  const timers = useRef(new Map<number, number>());
  const pairingOpen = useRef(false);

  const refresh = useCallback(async (): Promise<DeviceEntry[]> => {
    const list = await ipc.qsDevices();
    setDevices(list);
    savePairedHint(storage(), pairedDevices(list).length > 0);
    return list;
  }, []);

  const refreshQuietly = useCallback(() => {
    refresh().catch(() => undefined);
  }, [refresh]);

  // A device already paired means the listener is already up, so asking for the list is free.
  useEffect(() => {
    if (loadPairedHint(storage())) refreshQuietly();
  }, [refreshQuietly]);

  const setPairingMode = useCallback((open: boolean) => {
    pairingOpen.current = open;
    return ipc.qsPairingMode(open);
  }, []);

  const closePairing = useCallback(() => {
    const s = pairRef.current;
    if (s.step === 'idle') return;
    // Leaving the comparison counts as "no": the backend must not keep a half-finished pairing around.
    if (s.step === 'compare' && !s.answered) ipc.qsPairConfirm(false, s.code).catch(() => undefined);
    dispatch({ type: 'close' });
    setPairingMode(false).catch(() => undefined);
  }, [setPairingMode]);

  const openPairing = useCallback(() => {
    if (pairRef.current.step !== 'idle') return;
    dispatch({ type: 'open' });
    setPairingMode(true)
      .then(() => refresh())
      .catch((e: unknown) => dispatch({ type: 'fail', message: errorMessage(e) }));
  }, [refresh, setPairingMode]);

  const dial = useCallback((device: DeviceEntry) => {
    dispatch({ type: 'dial', name: device.name, deviceId: device.id });
    ipc
      .qsPairStart(device.id)
      .then((code) => dispatch({ type: 'code', code }))
      .catch((e: unknown) => dispatch({ type: 'fail', message: errorMessage(e) }));
  }, []);

  const answer = useCallback(
    (accepted: boolean) => {
      const s = pairRef.current;
      if (s.step !== 'compare' || s.answered) return;
      dispatch({ type: 'answer' });
      // The answer is for the code the user is looking at, named by device and digits.
      ipc
        .qsPairConfirm(accepted, s.code)
        .then((device) => {
          if (!accepted) {
            dispatch({ type: 'fail', message: PAIR_MISMATCH });
            return;
          }
          dispatch({ type: 'paired', device });
          savePairedHint(storage(), true);
          refreshQuietly();
        })
        .catch((e: unknown) => dispatch({ type: 'fail', message: accepted ? errorMessage(e) : PAIR_MISMATCH }));
    },
    [refreshQuietly],
  );

  const retryPairing = useCallback(() => {
    dispatch({ type: 'retry' });
    // The window may have closed while the error was showing.
    setPairingMode(true).catch(() => undefined);
    refreshQuietly();
  }, [refreshQuietly, setPairingMode]);

  const forget = useCallback(
    async (device: DeviceEntry) => {
      try {
        await ipc.qsForget(device.id);
        notifyRef.current(`Forgot ${device.name}`);
        await refresh();
      } catch (e) {
        notifyRef.current({ message: errorMessage(e), tone: 'error' });
      }
    },
    [refresh],
  );

  const dropPrompt = useCallback((requestId: number) => {
    const t = timers.current.get(requestId);
    if (t !== undefined) window.clearTimeout(t);
    timers.current.delete(requestId);
    setIncoming((list) => list.filter((p) => p.requestId !== requestId));
  }, []);

  const respond = useCallback(
    (requestId: number, accept: boolean) => {
      dropPrompt(requestId);
      ipc.qsIncomingRespond(requestId, accept).catch((e: unknown) => notifyRef.current({ message: errorMessage(e), tone: 'error' }));
    },
    [dropPrompt],
  );

  useEffect(() => {
    const offs = [
      events.onQsDevices(refreshQuietly),
      events.onQsPairCode((code) => dispatch({ type: 'code', code })),
      events.onQsIncoming((file) => {
        setIncoming((list) => [...list.filter((p) => p.requestId !== file.requestId), file].slice(-MAX_PROMPTS));
        // The backend declines an unanswered prompt after 55 s; the card goes away with it.
        timers.current.set(
          file.requestId,
          window.setTimeout(() => dropPrompt(file.requestId), INCOMING_TIMEOUT_MS),
        );
      }),
      events.onQsReceived(({ meta, peerName }) => receivedRef.current(meta, peerName)),
    ];
    const live = timers.current;
    return () => {
      offs.forEach((off) => off());
      live.forEach((h) => window.clearTimeout(h));
      live.clear();
      if (pairingOpen.current) ipc.qsPairingMode(false).catch(() => undefined);
    };
  }, [refreshQuietly, dropPrompt]);

  return { devices, refresh, pair, openPairing, closePairing, dial, answer, retryPairing, forget, incoming, respond };
}
