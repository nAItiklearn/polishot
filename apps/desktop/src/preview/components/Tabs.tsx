import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
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
            aria-controls={`${idPrefix}-panel-${t.id}`}
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

/**
 * The panels of a tab set. A panel is built the first time its tab is opened and then kept, hidden with
 * `visibility` (so it keeps its size and scroll position and costs nothing to show again): switching tabs is a
 * change of two attributes, not a mount. Hidden panels are out of the tab order and the accessibility tree.
 */
export function TabPanels<T extends string>({
  idPrefix,
  active,
  className,
  render,
  ids,
}: {
  idPrefix: string;
  active: T;
  /** Every tab id, in order. */
  ids: readonly T[];
  className?: string;
  render: (id: T) => ReactNode;
}) {
  // Panels that have been opened at least once. The state is written during render, which React allows for
  // values derived from props: it re-renders at once, before anything is painted.
  const [opened, setOpened] = useState<ReadonlySet<T>>(() => new Set([active]));
  if (!opened.has(active)) setOpened(new Set([...opened, active]));
  return (
    <div className="pv-panels">
      {ids.map((id) =>
        opened.has(id) || id === active ? (
          <div
            key={id}
            id={`${idPrefix}-panel-${id}`}
            role="tabpanel"
            aria-labelledby={`${idPrefix}-tab-${id}`}
            className={cx('pv-tabpanel', className)}
            data-active={id === active}
            tabIndex={-1}
          >
            {render(id)}
          </div>
        ) : null,
      )}
    </div>
  );
}
