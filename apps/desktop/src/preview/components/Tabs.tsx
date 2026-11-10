import { useRef, type KeyboardEvent, type ReactNode } from 'react';
import { cx } from '../lib/format';

export interface TabDef<T extends string> {
  id: T;
  label: string;
  /** A small count shown next to the label, e.g. detections found. */
  badge?: number;
  /** Accessible description of the badge ("3 found"). */
  badgeLabel?: string;
}

/** Tabs with roving focus: Left/Right/Home/End move and select, as in the ARIA tabs pattern. */
export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  idPrefix,
}: {
  tabs: readonly TabDef<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  idPrefix: string;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    let next = -1;
    if (e.key === 'ArrowRight') next = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    if (next < 0) return;
    e.preventDefault();
    const target = tabs[next];
    if (!target) return;
    onChange(target.id);
    refs.current[next]?.focus();
  };
  return (
    <div className="pv-tablist" role="tablist" aria-label={label} onKeyDown={onKeyDown}>
      {tabs.map((t, idx) => {
        const selected = t.id === value;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={selected}
            aria-controls={`${idPrefix}-panel`}
            tabIndex={selected ? 0 : -1}
            className="pv-tab"
            onClick={() => onChange(t.id)}
          >
            {t.label}
            {t.badge ? (
              <span className="pv-badge" aria-label={t.badgeLabel ?? String(t.badge)} title={t.badgeLabel}>
                {t.badge}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

export function TabPanel({ idPrefix, active, children, className }: { idPrefix: string; active: string; children: ReactNode; className?: string }) {
  return (
    <div id={`${idPrefix}-panel`} role="tabpanel" aria-labelledby={`${idPrefix}-tab-${active}`} className={cx('pv-tabpanel', className)} tabIndex={-1}>
      {children}
    </div>
  );
}
