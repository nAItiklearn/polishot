import { Pencil, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { IconButton } from '../components/IconButton';
import { ViewHeader } from '../components/ViewHeader';
import { useApp } from '../context';
import { errorMessage, ipc, thumbUrl, type HistoryItem } from '../../shared/ipc';
import { excerpt, formatCaptureTime, formatDimensions, groupByDay } from '../lib/format';
import { isGridKey, neighbour } from '../lib/gridNav';

const PAGE = 48;
const SEARCH_DELAY_MS = 200;

type Load = 'loading' | 'ready' | 'error';

/**
 * The first page of the last unfiltered listing. Reopening History shows it at once and refreshes behind it,
 * so the grid never starts empty and fills in (that read as a flash). Only ever shown for a moment.
 */
let lastFirstPage: HistoryItem[] = [];

export interface HistoryViewProps {
  onBack: () => void;
  /** Re-open a capture (and its saved edits) in the editor. */
  onOpen: (item: HistoryItem) => void;
}

/**
 * Past captures: full-text search over their recognised text, a thumbnail grid, open to re-edit,
 * delete one, or clear everything (the only action that asks first).
 */
export function HistoryView({ onBack, onOpen }: HistoryViewProps) {
  const { notify } = useApp();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<HistoryItem[]>(lastFirstPage);
  const [more, setMore] = useState(lastFirstPage.length === PAGE);
  const [load, setLoad] = useState<Load>(lastFirstPage.length > 0 ? 'ready' : 'loading');
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  // Roving tab stop: Tab enters the grid once, arrow keys move inside it.
  const [tabId, setTabId] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const request = useRef(0);
  const shown = useRef(items.length);
  shown.current = items.length;
  const searchRef = useRef<HTMLInputElement>(null);

  // Debounce typing into the actual query.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [text]);

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      const mine = ++request.current;
      // With something already on screen (the remembered page) refresh quietly instead of blanking it.
      if (replace && shown.current === 0) setLoad('loading');
      try {
        const page = await ipc.historyList({ query: query || undefined, limit: PAGE, offset });
        if (mine !== request.current) return;
        setItems((prev) => (replace ? page : [...prev, ...page.filter((p) => !prev.some((q) => q.id === p.id))]));
        if (replace && !query && offset === 0) lastFirstPage = page;
        setMore(page.length === PAGE);
        setLoad('ready');
      } catch (e) {
        if (mine !== request.current) return;
        setError(errorMessage(e));
        setLoad('error');
      }
    },
    [query],
  );

  useEffect(() => {
    void fetchPage(0, true);
  }, [fetchPage]);

  // "/" jumps to the search field, like most list views.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !(e.target instanceof HTMLInputElement)) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const remove = async (item: HistoryItem) => {
    try {
      await ipc.historyDelete(item.id);
      lastFirstPage = lastFirstPage.filter((p) => p.id !== item.id);
      setItems((prev) => prev.filter((p) => p.id !== item.id));
    } catch (e) {
      notify({ message: errorMessage(e), tone: 'error' });
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      await ipc.historyClear();
      lastFirstPage = [];
      setItems([]);
      setMore(false);
      setConfirmClear(false);
      notify('History cleared');
    } catch (e) {
      notify({ message: errorMessage(e), tone: 'error' });
    } finally {
      setClearing(false);
    }
  };

  const scrollRef = useRef<HTMLDivElement>(null);

  const onCardKey = (e: KeyboardEvent<HTMLLIElement>, item: HistoryItem) => {
    if (e.key === 'Delete' && e.target === e.currentTarget.querySelector('.pv-hcard-open')) {
      e.preventDefault();
      void remove(item);
      return;
    }
    // Arrow keys move between cards by where they are on screen, whatever the window width.
    if (!isGridKey(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('pv-hcard-open')) return;
    const cards = [...(scrollRef.current?.querySelectorAll<HTMLElement>('.pv-hcard-open') ?? [])];
    const from = cards.indexOf(target);
    if (from < 0) return;
    const rects = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width };
    });
    const to = neighbour(rects, from, e.key);
    e.preventDefault();
    if (to !== from) {
      cards[to]?.focus();
      cards[to]?.scrollIntoView({ block: 'nearest' });
    }
  };

  const groups = useMemo(() => groupByDay(items), [items]);
  const tabStop = items.some((i) => i.id === tabId) ? tabId : (items[0]?.id ?? null);

  const searching = query !== '';

  return (
    <div className="pv-page">
      <ViewHeader title="History" onBack={onBack}>
        <label className="pv-search">
          <Search size={14} strokeWidth={1.5} aria-hidden="true" />
          <input
            ref={searchRef}
            type="search"
            className="pv-search-input"
            placeholder="Search the text in your captures"
            aria-label="Search the text in your captures"
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <button type="button" className="pe-btn pe-btn-quiet" disabled={items.length === 0 && !searching} onClick={() => setConfirmClear(true)}>
          Clear all
        </button>
      </ViewHeader>

      <div className="pv-scroll" ref={scrollRef} aria-busy={load === 'loading'}>
        {load === 'error' ? (
          <div className="pv-state">
            <p>{error || 'History could not be loaded.'} Try again in a moment.</p>
            <button type="button" className="pe-btn" onClick={() => void fetchPage(0, true)}>
              Retry
            </button>
          </div>
        ) : null}

        {load === 'ready' && items.length === 0 ? (
          <div className="pv-state">
            <p>{searching ? `Nothing matches “${query}”.` : 'Your captures will appear here.'}</p>
          </div>
        ) : null}

        {groups.map((group) => (
          <section key={group.label} className="pv-hgroup" aria-label={group.label}>
            <h2 className="pv-group-title">{group.label}</h2>
            <ul className="pv-hgrid">
              {group.items.map((item) => {
                const when = formatCaptureTime(item.createdAt);
                const dims = formatDimensions(item.width, item.height);
                return (
                  <li key={item.id} className="pv-hcard" onKeyDown={(e) => onCardKey(e, item)}>
                    <button type="button" className="pv-hcard-open" tabIndex={tabStop === item.id ? 0 : -1} onFocus={() => setTabId(item.id)} onClick={() => onOpen(item)} aria-label={`Open the capture from ${when}, ${dims}${item.hasDoc ? ', has edits' : ''}`}>
                      <span className="pv-hthumb">
                        <img src={thumbUrl(item.id)} alt="" loading="lazy" decoding="async" draggable={false} />
                        {item.hasDoc ? (
                          <span className="pv-hedited" title="Has saved edits">
                            <Pencil size={12} strokeWidth={1.5} aria-hidden="true" />
                            Edited
                          </span>
                        ) : null}
                      </span>
                      <span className="pv-hmeta">
                        <span className="pv-hwhen">{when}</span>
                        <span className="pv-hdim">{dims}</span>
                      </span>
                      {item.excerpt ? <span className="pv-hexcerpt">{excerpt(item.excerpt, 90)}</span> : null}
                    </button>
                    <IconButton label={`Delete the capture from ${when}`} className="pv-hdelete" tipAlign="end" tabIndex={-1} onClick={() => void remove(item)}>
                      <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
                    </IconButton>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}

        {more ? (
          <div className="pv-more">
            <button type="button" className="pe-btn" onClick={() => void fetchPage(items.length, false)}>
              Show more
            </button>
          </div>
        ) : null}
      </div>

      <ConfirmDialog
        open={confirmClear}
        title="Clear all history?"
        body="This removes every capture and its saved edits from this computer. It cannot be undone."
        confirmLabel="Clear all"
        busy={clearing}
        onConfirm={() => void clearAll()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
