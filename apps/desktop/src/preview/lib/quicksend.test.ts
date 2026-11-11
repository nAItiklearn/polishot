import { describe, expect, it } from 'vitest';
import type { DeviceEntry, PairCode } from '../../shared/ipc';
import {
  PAIR_IDLE,
  QS_HINT_KEY,
  SEND_LIMIT_BYTES,
  formatBytes,
  incomingSummary,
  loadPairedHint,
  nearbyDevices,
  oversizeMessage,
  pairReducer,
  pairedDevices,
  resolveSendTarget,
  savePairedHint,
  sendLabel,
  type PairState,
} from './quicksend';

const dev = (id: string, name: string, paired: boolean, online: boolean): DeviceEntry => ({ id, name, paired, online });
const PIXEL = dev('AAAAAAAAAAAAAAAA', 'Pixel 8', true, true);
const GALAXY = dev('BBBBBBBBBBBBBBBB', 'Galaxy S24', true, true);
const STRANGER = dev('CCCCCCCCCCCCCCCC', 'Maya phone', false, true);
const CODE: PairCode = { sas: '042 917', peerName: 'Maya phone', peerId: STRANGER.id, role: 'initiator' };

describe('device lists', () => {
  it('splits paired devices from phones that are nearby and unpaired', () => {
    const list = [PIXEL, STRANGER, dev('DDDDDDDDDDDDDDDD', 'Far away', false, false)];
    expect(pairedDevices(list)).toEqual([PIXEL]);
    expect(nearbyDevices(list)).toEqual([STRANGER]); // an unpaired device that is not visible is not offered
    expect(pairedDevices(null)).toEqual([]);
    expect(nearbyDevices(null)).toEqual([]);
  });
});

describe('what pressing Send does', () => {
  it('opens pairing when nothing is paired, or when the list is not known yet', () => {
    expect(resolveSendTarget(null)).toEqual({ kind: 'pair' });
    expect(resolveSendTarget([])).toEqual({ kind: 'pair' });
    expect(resolveSendTarget([STRANGER])).toEqual({ kind: 'pair' });
  });

  it('sends straight away when exactly one paired device is nearby', () => {
    expect(resolveSendTarget([PIXEL])).toEqual({ kind: 'direct', device: PIXEL });
    // A second phone that is switched off does not make the choice ambiguous.
    const off = { ...GALAXY, online: false };
    expect(resolveSendTarget([PIXEL, off])).toEqual({ kind: 'direct', device: PIXEL });
  });

  it('asks which phone when two are nearby, and lists offline ones when none is', () => {
    expect(resolveSendTarget([PIXEL, GALAXY])).toEqual({ kind: 'menu', devices: [PIXEL, GALAXY] });
    const off = { ...PIXEL, online: false };
    expect(resolveSendTarget([off])).toEqual({ kind: 'menu', devices: [off] });
  });

  it('names the phone in the label only when there is one obvious target', () => {
    expect(sendLabel([PIXEL])).toBe('Send to Pixel 8');
    expect(sendLabel([PIXEL, GALAXY])).toBe('Send to phone');
    expect(sendLabel(null)).toBe('Send to phone');
  });
});

describe('sizes', () => {
  it('formats bytes the way Windows does', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(842 * 1024)).toBe('842 KB');
    expect(formatBytes(1.24 * 1024 * 1024)).toBe('1.2 MB');
    expect(formatBytes(48 * 1024 * 1024)).toBe('48 MB');
    expect(formatBytes(Number.NaN)).toBe('');
    expect(formatBytes(-1)).toBe('');
  });

  it('refuses what the backend would refuse, with a sentence that says what to do', () => {
    expect(oversizeMessage(SEND_LIMIT_BYTES)).toBeNull();
    expect(oversizeMessage(SEND_LIMIT_BYTES + 1)).toMatch(/Export tab/);
  });

  it('summarises an incoming file', () => {
    expect(incomingSummary({ name: 'shot.png', size: 1_300_000 })).toBe('shot.png · 1.2 MB');
    expect(incomingSummary({ name: 'shot.png', size: Number.NaN })).toBe('shot.png');
  });
});

describe('the pairing dialog', () => {
  const run = (actions: Parameters<typeof pairReducer>[1][], from: PairState = PAIR_IDLE) => actions.reduce(pairReducer, from);

  it('goes browse, dialing, compare, success', () => {
    expect(run([{ type: 'open' }]).step).toBe('browse');
    expect(run([{ type: 'open' }, { type: 'dial', name: 'Maya phone', deviceId: STRANGER.id }])).toEqual({ step: 'dialing', name: 'Maya phone', deviceId: STRANGER.id });
    const compare = run([{ type: 'open' }, { type: 'dial', name: 'Maya phone', deviceId: STRANGER.id }, { type: 'code', code: CODE }]);
    expect(compare).toEqual({ step: 'compare', code: CODE, answered: false, another: false });
    const answered = pairReducer(compare, { type: 'answer' });
    expect(answered).toEqual({ step: 'compare', code: CODE, answered: true, another: false });
    expect(pairReducer(answered, { type: 'paired', device: { ...STRANGER, paired: true } })).toEqual({
      step: 'success',
      device: { ...STRANGER, paired: true },
    });
  });

  it('shows a code that a phone started, without this PC dialling', () => {
    const s = run([{ type: 'open' }, { type: 'code', code: { ...CODE, role: 'responder' } }]);
    expect(s.step).toBe('compare');
  });

  it('never moves past the comparison on its own', () => {
    // Only `answer` followed by the backend result can finish; a repeated code does not skip ahead or reset.
    const s = run([{ type: 'open' }, { type: 'code', code: CODE }, { type: 'answer' }, { type: 'code', code: CODE }]);
    expect(s).toEqual({ step: 'compare', code: CODE, answered: true, another: false });
    expect(pairReducer({ step: 'browse' }, { type: 'paired', device: PIXEL }).step).toBe('browse');
  });

  it('keeps the visible code when a different one arrives, and only notes it', () => {
    const other: PairCode = { ...CODE, sas: '555 100', peerId: 'OTHERPHONE00000C', peerName: 'Unknown phone' };
    const shown = run([{ type: 'open' }, { type: 'code', code: CODE }, { type: 'answer' }]);
    const after = pairReducer(shown, { type: 'code', code: other });
    // Not replaced, not reset to unanswered: the answer in flight is still for the code the user compared.
    expect(after).toEqual({ step: 'compare', code: CODE, answered: true, another: true });
    // A third attempt changes nothing further.
    expect(pairReducer(after, { type: 'code', code: { ...other, sas: '111 222' } })).toBe(after);
    // The same code again (command result plus event) is not "another device".
    expect(pairReducer(shown, { type: 'code', code: { ...CODE, peerId: CODE.peerId.toLowerCase() } })).toBe(shown);
  });

  it('while dialling, only the device that was dialled can produce the code', () => {
    const dialling = run([{ type: 'open' }, { type: 'dial', name: 'Maya phone', deviceId: STRANGER.id }]);
    const stranger: PairCode = { ...CODE, sas: '555 100', peerId: 'OTHERPHONE00000C', role: 'responder' };
    expect(pairReducer(dialling, { type: 'code', code: stranger })).toBe(dialling);
    expect(pairReducer(dialling, { type: 'code', code: CODE }).step).toBe('compare');
  });

  it('ignores a code that arrives while the dialog is closed', () => {
    expect(pairReducer(PAIR_IDLE, { type: 'code', code: CODE })).toEqual(PAIR_IDLE);
  });

  it('keeps a finished pairing finished', () => {
    const done: PairState = { step: 'success', device: PIXEL };
    expect(pairReducer(done, { type: 'fail', message: 'late error' })).toBe(done);
    expect(pairReducer(done, { type: 'code', code: CODE })).toBe(done);
  });

  it('fails with a message and can try again', () => {
    const failed = run([{ type: 'open' }, { type: 'dial', name: 'Maya phone', deviceId: STRANGER.id }, { type: 'fail', message: 'Pairing is off on that device.' }]);
    expect(failed).toEqual({ step: 'failed', message: 'Pairing is off on that device.' });
    expect(pairReducer(failed, { type: 'retry' })).toEqual({ step: 'browse' });
    expect(pairReducer(PAIR_IDLE, { type: 'fail', message: 'x' })).toEqual(PAIR_IDLE);
  });

  it('closing always returns to idle', () => {
    expect(run([{ type: 'open' }, { type: 'code', code: CODE }, { type: 'close' }])).toEqual(PAIR_IDLE);
  });
});

describe('the "has paired" hint', () => {
  const memory = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
      m,
    };
  };

  it('round-trips and clears', () => {
    const s = memory();
    expect(loadPairedHint(s)).toBe(false);
    savePairedHint(s, true);
    expect(s.m.get(QS_HINT_KEY)).toBe('1');
    expect(loadPairedHint(s)).toBe(true);
    savePairedHint(s, false);
    expect(loadPairedHint(s)).toBe(false);
  });

  it('survives storage that throws or is missing', () => {
    const broken = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(loadPairedHint(broken)).toBe(false);
    expect(() => savePairedHint(broken, true)).not.toThrow();
    expect(loadPairedHint(null)).toBe(false);
    expect(() => savePairedHint(null, true)).not.toThrow();
  });
});
