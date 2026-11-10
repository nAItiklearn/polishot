import { Search } from 'lucide-react';
import { Fragment, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { filterActions, type ActionId, type PaletteItem } from '../lib/commands';
import { cx } from '../lib/format';
import { useModal } from './Dialog';
import { Keys } from './Keys';

export interface CommandPaletteProps {
  open: boolean;
  items: readonly PaletteItem[];
  onRun: (id: ActionId) => void;
  onClose: () => void;
}

/**
 * Ctrl+K. A combobox over every action with its shortcut. Arrow keys move, Enter runs, Escape
 * closes; disabled actions stay listed (dimmed) so the full set of shortcuts is always discoverable.
 */
export function CommandPalette({ open, items, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const uid = useId();
  const listId = `${uid}-list`;
  const ref = useModal(open, onClose, () => inputRef.current);

  const results = useMemo(() => filterActions(items, query), [items, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    if (!open) return;
    listRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active, open, results]);

  if (!open) return null;

  const run = (item: PaletteItem | undefined) => {
    if (!item || !item.enabled) return;
    onRun(item.id);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActive(Math.max(0, results.length - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      run(results[active]);
    }
  };

  const showGroups = query.trim() === '';
  let lastGroup = '';

  return createPortal(
    <div className="pv-scrim pv-scrim-top" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className="pv-palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="pv-palette-search">
          <Search size={16} strokeWidth={1.5} aria-hidden="true" />
          <input
            ref={inputRef}
            className="pv-palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={results[active] ? `${uid}-${results[active]!.id}` : undefined}
            aria-label="Search commands"
            placeholder="Type a command"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <ul ref={listRef} id={listId} className="pv-palette-list" role="listbox" aria-label="Commands">
          {results.length === 0 ? (
            <li className="pv-palette-empty" role="presentation">
              Nothing matches “{query.trim()}”.
            </li>
          ) : null}
          {results.map((item, i) => {
            const heading = showGroups && item.group !== lastGroup ? item.group : null;
            lastGroup = item.group;
            return (
              <Fragment key={item.id}>
                {heading ? (
                  <li className="pv-palette-group" role="presentation">
                    {heading}
                  </li>
                ) : null}
                <li
                  id={`${uid}-${item.id}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={!item.enabled}
                  className={cx('pv-palette-item', !item.enabled && 'is-disabled')}
                  onMouseMove={() => i !== active && setActive(i)}
                  onClick={() => run(item)}
                >
                  <span className="pv-palette-label">{item.label}</span>
                  {item.hint ? <span className="pv-palette-hint">{item.hint}</span> : null}
                  {item.shortcut ? <Keys accelerator={item.shortcut} /> : null}
                </li>
              </Fragment>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
