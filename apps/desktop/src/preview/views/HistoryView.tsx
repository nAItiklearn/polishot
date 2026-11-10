import { Pencil, Search, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ConfirmDialog } from '../components/Dialog';
import { IconButton } from '../components/IconButton';
import { ViewHeader } from '../components/ViewHeader';
import { useApp } from '../context';
import { errorMessage, ipc, thumbUrl, type HistoryItem } from '../../shared/ipc';
import { excerpt, formatCaptureTime, formatDimensions } from '../lib/format';

const PAGE = 48;
const SEARCH_DELAY_MS = 200;

type Load = 'loading' | 'ready' | 'error';

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
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [more, setMore] = useState(false);
  const [load, setLoad] = useState<Load>('loading');
  const [error, setError] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);
  const request = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  // Debounce typing into the actual query.
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [text]);

  const fetchPage = useCallback(
    async (offset: number, replace: boolean) => {
      const mine = ++request.current;
      if (replace) setLoad('loading');
      try {
        const page = await ipc.historyList({ query: query || undefined, limit: PAGE, offset });
        if (mine !== request.current) return;
        setItems((prev) => (replace ? page : [...prev, ...page.filter((p) => !prev.some((q) => q.id === p.id))]));
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
      setItems((prev) => prev.filter((p) => p.id !== item.id));
    } catch (e) {
      notify({ message: errorMessage(e), tone: 'error' });
    }
  };

  const clearAll = async () => {
    setClearing(true);
    try {
      await ipc.historyClear();
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

  const onCardKey = (e: KeyboardEvent<HTMLLIElement>, item: HistoryItem) => {
    if (e.key === 'Delete' && e.target === e.currentTarget.querySelector('.pv-hcard-open')) {
      e.preventDefault();
      void remove(item);
    }
  };

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

      <div className="pv-scroll" aria-busy={load === 'loading'}>
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

        {items.length > 0 ? (
          <ul className="pv-hgrid" aria-label="Captures">
            {items.map((item) => {
              const when = formatCaptureTime(item.createdAt);
              const dims = formatDimensions(item.width, item.height);
              return (
                <li key={item.id} className="pv-hcard" onKeyDown={(e) => onCardKey(e, item)}>
                  <button type="button" className="pv-hcard-open" onClick={() => onOpen(item)} aria-label={`Open the capture from ${when}, ${dims}${item.hasDoc ? ', has edits' : ''}`}>
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
                  <IconButton label={`Delete the capture from ${when}`} className="pv-hdelete" tipAlign="end" onClick={() => void remove(item)}>
                    <Trash2 size={14} strokeWidth={1.5} aria-hidden="true" />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        ) : null}

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
