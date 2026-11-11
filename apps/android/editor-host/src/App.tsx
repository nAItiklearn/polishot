import type { EditorDoc } from '@polishot/editor';
import {
  EditorCanvas,
  Inspector,
  RedactPanel,
  TextLayer,
  Toolbar,
  useEditorShortcuts,
  wordsToText,
  type ExportResult,
  type UserPreset,
} from '@polishot/editor/react';
import type { OcrWord } from '@polishot/redact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { runBatch } from './batch';
import { BatchOverlay } from './components/BatchOverlay';
import { Chips } from './components/Chips';
import { ExportTab } from './components/ExportTab';
import { Sheet, type TabId } from './components/Sheet';
import { TextPanel } from './components/TextPanel';
import { Toast, type ToastAction, type ToastState } from './components/Toast';
import { TopBar, type TopAction } from './components/TopBar';
import { getEditor, loadImage } from './editorInstance';
import { attachHost } from './host';
import { batchLimit, FREE_SAVED_LOOKS } from './limits';
import { exportFileName } from './naming';
import { native, type HostHandlers } from './native';
import {
  MAX_DOC_JSON_CHARS,
  MAX_SAVE_DOC_CHARS,
  MIME,
  type BatchPayload,
  type ExportDefaults,
  type ExportFormat,
  type LoadPayload,
  type NotifyPayload,
  type ThemeName,
} from './payload';
import { looks } from './presetsStore';

interface Session {
  id: string;
  defaults: ExportDefaults;
  quickSendAvailable: boolean;
}

interface BatchProgress {
  processed: number;
  total: number;
  failed: number;
}

type SaveResult = 'saved' | 'error';

const AUTOSAVE_DELAY_MS = 800;
const BUSY_TIMEOUT_MS = 20_000;
const SAVE_RESULT_TIMEOUT_MS = 30_000;

/** The saved document, or undefined when there is none or it is not JSON (the editor validates the rest). */
function parseSavedDoc(json: string | undefined): EditorDoc | undefined {
  if (!json || json.length > MAX_DOC_JSON_CHARS) return undefined;
  try {
    return JSON.parse(json) as EditorDoc;
  } catch {
    return undefined;
  }
}

export function App() {
  const editor = useMemo(() => getEditor(), []);
  useEditorShortcuts(editor); // hardware keyboards: V, A, R, E, L, T, B, N, P, Delete, Ctrl+Z, Ctrl+D ...

  const [session, setSession] = useState<Session | null>(null);
  const [words, setWords] = useState<OcrWord[] | null>(null);
  const [pro, setPro] = useState(false);
  const [ready, setReady] = useState(false);
  const [tab, setTab] = useState<TabId | null>(null);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [busy, setBusy] = useState<TopAction | null>(null);
  const [batch, setBatch] = useState<BatchProgress | null>(null);

  // Mutable state that callbacks from Android must see without re-subscribing.
  const currentId = useRef<string | null>(null);
  const lastSaved = useRef('');
  const loadToken = useRef(0);
  const tabRef = useRef<TabId | null>(null);
  const proRef = useRef(false);
  const batchActive = useRef(false);
  const toastId = useRef(0);
  const toastTimer = useRef<number | undefined>(undefined);
  const busyTimer = useRef<number | undefined>(undefined);
  const saveWaiters = useRef<((result: SaveResult) => void)[]>([]);
  const flushSave = useRef<() => void>(() => undefined);

  tabRef.current = tab;
  proRef.current = pro;

  const dismissToast = useCallback(() => {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  }, []);

  const showToast = useCallback((kind: ToastState['kind'], message: string, action?: ToastAction) => {
    window.clearTimeout(toastTimer.current);
    toastId.current += 1;
    setToast({ id: toastId.current, kind, message, ...(action ? { action } : {}) });
    toastTimer.current = window.setTimeout(() => setToast(null), kind === 'error' || action ? 4500 : 2200);
  }, []);

  const startBusy = useCallback((action: TopAction) => {
    setBusy(action);
    window.clearTimeout(busyTimer.current);
    busyTimer.current = window.setTimeout(() => setBusy(null), BUSY_TIMEOUT_MS);
  }, []);

  const stopBusy = useCallback(() => {
    window.clearTimeout(busyTimer.current);
    setBusy(null);
  }, []);

  const applyTheme = useCallback(
    (theme: ThemeName) => {
      document.documentElement.dataset.theme = theme;
      editor.refreshTheme();
    },
    [editor],
  );

  /* ---------------------------------------------------------------- calls from Android */

  useEffect(() => {
    const handleLoad = async (p: LoadPayload) => {
      loadToken.current += 1;
      const token = loadToken.current;
      flushSave.current();
      batchActive.current = false;
      // Hide the canvas until the styled result is ready: the raw screenshot must never flash first.
      setReady(false);
      setBatch(null);
      setTab(null);
      setWords(p.words ?? null);
      setPro(p.licensed);
      editor.setLicensed(p.licensed);
      editor.setBrandMark(p.brandMark ?? null);
      applyTheme(p.theme);
      setSession({ id: p.id, defaults: p.exportDefaults, quickSendAvailable: p.quickSendAvailable });
      try {
        const img = await loadImage(p.imageUrl);
        if (token !== loadToken.current) return;
        const doc = parseSavedDoc(p.docJson);
        // For a new document `load` runs auto-balance and the auto background before the first frame is drawn.
        editor.load({ id: p.id, width: img.naturalWidth, height: img.naturalHeight, element: img }, doc);
        // The default canvas preset from Settings only applies to documents the user has not styled yet.
        if (!doc && p.defaultPreset !== 'auto' && p.defaultPreset !== 'custom') editor.update({ preset: p.defaultPreset });
        currentId.current = p.id;
        lastSaved.current = JSON.stringify(editor.doc);
        // Reveal on the next frame, after the editor has painted the styled scene.
        requestAnimationFrame(() => {
          if (token === loadToken.current) setReady(true);
        });
      } catch {
        if (token !== loadToken.current) return;
        setReady(true);
        showToast('error', 'This screenshot could not be opened. Go back and try again.');
      }
    };

    const handleNotify = (n: NotifyPayload) => {
      stopBusy();
      if (n.kind === 'saved' || n.kind === 'error') saveWaiters.current.shift()?.(n.kind);
      // A batch run saves many images; one confirmation at the end (from Android) is enough.
      if (n.message && !batchActive.current) showToast(n.kind === 'error' ? 'error' : 'ok', n.message);
    };

    const handleBatch = async (p: BatchPayload) => {
      loadToken.current += 1;
      flushSave.current();
      batchActive.current = true;
      setReady(true);
      setTab(null);
      setPro(p.licensed);
      editor.setLicensed(p.licensed);
      editor.setBrandMark(p.brandMark ?? null);
      applyTheme(p.theme);
      setBatch({ processed: 0, total: Math.min(p.items.length, batchLimit(p.licensed)), failed: 0 });
      await runBatch(editor, p, {
        onProgress: (processed, failed, total) => setBatch({ processed, failed, total }),
        waitForSaveResult: () =>
          new Promise<SaveResult>((resolve) => {
            const waiter = (result: SaveResult) => {
              window.clearTimeout(timer);
              resolve(result);
            };
            const timer = window.setTimeout(() => {
              saveWaiters.current = saveWaiters.current.filter((w) => w !== waiter);
              resolve('error');
            }, SAVE_RESULT_TIMEOUT_MS);
            saveWaiters.current.push(waiter);
          }),
      });
    };

    const handlers: HostHandlers = {
      load: (p) => void handleLoad(p),
      setWords: (w) => setWords(w),
      setLicensed: (value) => {
        setPro(value);
        editor.setLicensed(value);
      },
      notify: handleNotify,
      onBack: () => {
        if (tabRef.current === null) return false;
        setTab(null);
        return true;
      },
      batch: (p) => void handleBatch(p),
      flush: () => flushSave.current(),
    };
    const detach = attachHost(handlers);
    native.ready();
    return detach;
  }, [editor, applyTheme, showToast, stopBusy]);

  /* ---------------------------------------------------------------- autosave */

  useEffect(() => {
    let timer: number | undefined;
    const flush = () => {
      window.clearTimeout(timer);
      const id = currentId.current;
      if (!id || !editor.hasImage || batchActive.current) return;
      const json = JSON.stringify(editor.doc);
      if (json === lastSaved.current || editor.doc.image.id !== id) return;
      lastSaved.current = json;
      // Android keeps documents up to ~1.2M characters (one database column); a larger one (an embedded background
      // photo) would be refused, so do not transfer it. The screenshot itself is already stored.
      if (json.length > MAX_SAVE_DOC_CHARS) return;
      native.saveDoc(id, json);
    };
    flushSave.current = flush;
    const off = editor.on('change', () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(flush, AUTOSAVE_DELAY_MS);
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pagehide', flush);
    return () => {
      off();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.clearTimeout(timer);
    };
  }, [editor]);

  /* ---------------------------------------------------------------- actions */

  const render = useCallback(
    async (format: ExportFormat, quality: number, scale: 1 | 2 | 3) => {
      return editor.export({ format, quality, scale, licensed: editor.licensed });
    },
    [editor],
  );

  const failRender = useCallback(() => {
    stopBusy();
    showToast('error', 'The image could not be rendered. Try again.');
  }, [stopBusy, showToast]);

  // Copy is always PNG: it is the one format every app accepts from the clipboard.
  const copyImage = useCallback(async () => {
    if (!session) return;
    startBusy('copy');
    try {
      await native.copyImage(await render('png', 1, session.defaults.scale));
    } catch {
      failRender();
    }
  }, [session, render, startBusy, failRender]);

  const saveImage = useCallback(async () => {
    if (!session) return;
    const { format, quality, scale } = session.defaults;
    startBusy('save');
    try {
      await native.saveImage(await render(format, quality, scale), MIME[format], exportFileName(format));
    } catch {
      failRender();
    }
  }, [session, render, startBusy, failRender]);

  const shareImage = useCallback(async () => {
    if (!session) return;
    const { format, quality, scale } = session.defaults;
    startBusy('share');
    try {
      await native.shareImage(await render(format, quality, scale), MIME[format]);
    } catch {
      failRender();
    }
  }, [session, render, startBusy, failRender]);

  const quickSend = useCallback(async () => {
    try {
      await native.quickSend(await render('png', 1, 2));
    } catch {
      failRender();
    }
  }, [render, failRender]);

  const onExport = useCallback(async (result: ExportResult) => {
    if (result.action === 'copy') await native.copyImage(result.blob);
    else await native.saveImage(result.blob, MIME[result.options.format], result.filename);
  }, []);

  const onSavePreset = useCallback(
    (preset: Omit<UserPreset, 'id'>) => {
      const result = looks.save(preset, proRef.current);
      if (result === 'limit') {
        showToast(
          'error',
          proRef.current ? 'That is the most looks that can be saved.' : `Free keeps ${FREE_SAVED_LOOKS} saved looks. Pro removes the limit.`,
        );
      } else if (result === 'failed') {
        showToast('error', 'The look could not be saved. Try again.');
      }
    },
    [showToast],
  );

  const copyText = useCallback((text: string) => native.copyText(text), []);
  const copyAllText = useCallback(() => {
    if (words && words.length > 0) native.copyText(wordsToText(words));
  }, [words]);

  const onHidden = useCallback(
    (count: number) => {
      showToast('ok', count === 1 ? 'Hid 1 item' : `Hid ${count} items`, { label: 'Undo', run: () => editor.undo() });
    },
    [editor, showToast],
  );

  return (
    <div className="eh-root">
      <main className="eh-stage" data-ready={ready}>
        <EditorCanvas editor={editor}>
          <TextLayer editor={editor} words={words} onCopyText={copyText} />
          <Toolbar editor={editor} />
        </EditorCanvas>
        <TopBar
          busy={busy}
          disabled={!ready || batch !== null}
          onClose={() => {
            flushSave.current();
            native.close();
          }}
          onShare={() => void shareImage()}
          onSave={() => void saveImage()}
          onCopy={() => void copyImage()}
        />
        <Chips
          editor={editor}
          words={words}
          suppressed={!ready || batch !== null}
          onCopyText={copyAllText}
          onHidden={onHidden}
        />
        <Toast toast={toast} onDone={dismissToast} />
        {!ready && batch === null && <div className="eh-loading" role="status" aria-label="Preparing" />}
      </main>

      <Sheet active={tab} onSelect={setTab}>
        {tab === 'style' && (
          <Inspector editor={editor} loadPresets={looks.load} onSavePreset={onSavePreset} onDeletePreset={looks.remove} />
        )}
        {tab === 'redact' && (
          <RedactPanel
            editor={editor}
            words={words}
            scanning={words === null}
            onScan={() => {
              if (currentId.current) native.requestOcr(currentId.current);
            }}
          />
        )}
        {tab === 'text' && <TextPanel words={words} onCopy={copyText} />}
        {tab === 'export' && session && (
          <ExportTab
            editor={editor}
            defaults={session.defaults}
            quickSendAvailable={session.quickSendAvailable}
            onExport={onExport}
            onShare={shareImage}
            onQuickSend={quickSend}
          />
        )}
      </Sheet>

      {batch && <BatchOverlay {...batch} />}
    </div>
  );
}
