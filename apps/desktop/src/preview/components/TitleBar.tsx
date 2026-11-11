import { APP_NAME } from '@polishot/brand';
import { Clock, Command, Copy, Pin, Save, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { native } from '../../shared/native';
import type { View } from '../context';
import { actionDef, type ActionId } from '../lib/commands';
import { cx } from '../lib/format';
import { IconButton } from './IconButton';
import { Keys } from './Keys';
import { SendMenu, type SendMenuProps } from './SendMenu';

const ICON = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;

/**
 * The Print P (packages/brand/assets/logo-mark.svg), drawn with the theme's ink and accent so it reads on
 * light and dark. The shapes are the brand's own; do not redraw or recolour them (BRAND.md).
 */
function BrandMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 64 64" aria-hidden="true" focusable="false">
      <path
        fill="var(--ps-text)"
        d="M14.5 26.6L18.5 26.6A3 3 0 0 1 21.5 29.6L21.5 53.6A3 3 0 0 1 18.5 56.6L14.5 56.6A3 3 0 0 1 11.5 53.6L11.5 29.6A3 3 0 0 1 14.5 26.6Z"
      />
      <path
        fill="var(--ps-accent)"
        fillRule="evenodd"
        d="M17.448 10.992L42.311 8.378A7.5 7.5 0 0 1 50.554 15.053L52.227 30.966A7.5 7.5 0 0 1 45.552 39.208L20.689 41.822A7.5 7.5 0 0 1 12.446 35.147L10.773 19.234A7.5 7.5 0 0 1 17.448 10.992ZM24.252 18.321L40.164 16.648A2.5 2.5 0 0 1 42.912 18.873L43.957 28.818A2.5 2.5 0 0 1 41.732 31.566L25.82 33.238A2.5 2.5 0 0 1 23.072 31.013L22.027 21.068A2.5 2.5 0 0 1 24.252 18.321Z"
      />
    </svg>
  );
}

function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let alive = true;
    const sync = () => {
      native
        .isMaximized()
        .then((m) => alive && setMaximized(m))
        .catch(() => undefined);
    };
    sync();
    let off: (() => void) | undefined;
    native
      .onResized(sync)
      .then((fn) => {
        if (alive) off = fn;
        else fn();
      })
      .catch(() => undefined);
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  const run = (p: Promise<unknown>) => void p.catch(() => undefined);

  return (
    <div className="pv-winctl">
      <button type="button" className="pv-winbtn" aria-label="Minimize" title="Minimize" onClick={() => run(native.minimize())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1 5h8" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
      <button
        type="button"
        className="pv-winbtn"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => run(native.toggleMaximize())}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="3" width="5.5" height="5.5" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
            <path d="M3.5 3V2.5a1 1 0 0 1 1-1H8a1 1 0 0 1 1 1V6a1 1 0 0 1-1 1h-.5" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="1.5" y="1.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1" fill="none" />
          </svg>
        )}
      </button>
      <button type="button" className="pv-winbtn pv-winbtn-close" aria-label="Close to tray" title="Close to tray" onClick={() => run(native.hide())}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M1.5 1.5l7 7M8.5 1.5l-7 7" stroke="currentColor" strokeWidth="1" fill="none" />
        </svg>
      </button>
    </div>
  );
}

export interface TitleBarProps {
  view: View;
  hasImage: boolean;
  pro: boolean;
  /** An export started from the title bar is running. */
  busy: boolean;
  onAction: (id: ActionId) => void;
  /** The Send-to-phone button and its menu. */
  send: Omit<SendMenuProps, 'disabled'>;
}

/**
 * Slim custom title bar: brand, the command palette entry, the two primary actions, navigation and the
 * window controls. The bar itself and its empty stretches are the drag region.
 */
export function TitleBar({ view, hasImage, pro, busy, onAction, send }: TitleBarProps) {
  const showActions = view === 'editor' && hasImage;
  return (
    <header className="pv-titlebar" data-tauri-drag-region>
      <div className="pv-brand" data-tauri-drag-region>
        <BrandMark />
        <span className="pv-brand-name">{APP_NAME}</span>
      </div>

      <div className="pv-titlebar-center" data-tauri-drag-region>
        <button type="button" className="pv-cmdbtn" onClick={() => onAction('palette')} aria-keyshortcuts="Control+K" aria-label="Open command palette">
          <Command size={14} strokeWidth={1.5} aria-hidden="true" />
          <span className="pv-cmdbtn-text">Search commands</span>
          <Keys accelerator={actionDef('palette').shortcut} />
        </button>
      </div>

      <div className="pv-titlebar-right">
        {/* Always in the layout, hidden when there is nothing to act on: the search box never moves when a capture opens or a screen changes. */}
        <div className="pv-titlebar-actions" data-shown={showActions}>
            <button type="button" className="pe-btn pe-btn-primary pv-tbtn" disabled={busy} aria-keyshortcuts="Control+C" onClick={() => onAction('copy-image')}>
              <Copy {...ICON} />
              <span className="pv-tbtn-text">Copy</span>
            </button>
            <button type="button" className="pe-btn pv-tbtn" disabled={busy} aria-keyshortcuts="Control+S" onClick={() => onAction('save')}>
              <Save {...ICON} />
              <span className="pv-tbtn-text">Save</span>
            </button>
            <IconButton label="Pin to screen" shortcut={actionDef('pin').shortcut} onClick={() => onAction('pin')}>
              <Pin {...ICON} />
            </IconButton>
            <SendMenu {...send} disabled={busy} />
            <span className="pv-titlebar-sep" aria-hidden="true" />
        </div>
        <IconButton label="History" shortcut={actionDef('go-history').shortcut} pressed={view === 'history'} onClick={() => onAction('go-history')}>
          <Clock {...ICON} />
        </IconButton>
        <IconButton label="Settings" shortcut={actionDef('go-settings').shortcut} pressed={view === 'settings'} onClick={() => onAction('go-settings')}>
          <SettingsIcon {...ICON} />
        </IconButton>
        <button
          type="button"
          className={cx('pv-pill', pro && 'is-pro')}
          aria-label={pro ? 'License: Pro. Open license.' : 'License: Free. Open license.'}
          aria-pressed={view === 'license'}
          onClick={() => onAction('go-license')}
        >
          {pro ? 'Pro' : 'Free'}
        </button>
      </div>

      <WindowControls />
    </header>
  );
}
