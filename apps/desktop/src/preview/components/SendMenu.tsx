import { Plus, Smartphone } from 'lucide-react';
import { useRef } from 'react';
import type { DeviceEntry } from '../../shared/ipc';
import { actionDef } from '../lib/commands';
import { cx } from '../lib/format';
import { pairedDevices, sendLabel } from '../lib/quicksend';
import { IconButton } from './IconButton';
import { Popover } from './Popover';

const ICON = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;

export interface SendMenuProps {
  /** Null until the list has been asked for. */
  devices: DeviceEntry[] | null;
  open: boolean;
  /** The icon was pressed: the app decides whether that sends, pairs or opens this menu. */
  onPress: () => void;
  onClose: () => void;
  onSend: (device: DeviceEntry) => void;
  onPair: () => void;
  disabled?: boolean;
}

/**
 * The Send button and, when more than one phone could be meant, the menu of phones. With one phone in
 * range the button just sends; with none paired it opens the pairing dialog.
 */
export function SendMenu({ devices, open, onPress, onClose, onSend, onPair, disabled }: SendMenuProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const paired = pairedDevices(devices);
  return (
    <>
      <IconButton ref={anchor} label={sendLabel(devices)} shortcut={actionDef('send-phone').shortcut} menu expanded={open} disabled={disabled} onClick={onPress}>
        <Smartphone {...ICON} />
      </IconButton>
      <Popover open={open} onClose={onClose} anchor={anchor} label="Send to a phone">
        {paired.map((d) => (
          <button
            key={d.id}
            type="button"
            role="menuitem"
            className={cx('pv-menuitem', !d.online && 'is-off')}
            aria-disabled={!d.online}
            title={d.online ? undefined : 'Open Polishot on that phone, on the same Wi-Fi as this PC.'}
            onClick={() => d.online && onSend(d)}
          >
            <Smartphone {...ICON} />
            <span className="pv-menuitem-name">{d.name}</span>
            <span className="pv-menuitem-note">{d.online ? 'Nearby' : 'Not nearby'}</span>
          </button>
        ))}
        {paired.length > 0 ? <div className="pv-menu-sep" role="separator" /> : null}
        <button type="button" role="menuitem" className="pv-menuitem" onClick={onPair}>
          <Plus {...ICON} />
          <span className="pv-menuitem-name">Pair another phone…</span>
        </button>
      </Popover>
    </>
  );
}
