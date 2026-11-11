import { APP_SLUG } from '@polishot/brand';
import { TOOL_LABEL, TOOL_ORDER, TOOL_SHORTCUT, type Tool } from '@polishot/editor';
import { useEditorShortcuts, wordsToText, type ExportResult } from '@polishot/editor/react';
import { detect } from '@polishot/redact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { TitleBar } from './components/TitleBar';
import { Toasts } from './components/Toasts';
import { AppProvider, useApp, useBrandMarkState, useLicenseState, useSettingsState, useToasts, type View } from './context';
import { useCaptureSession } from './hooks/useCaptureSession';
import { useCopyPrewarm } from './hooks/useCopyPrewarm';
import { useLooks } from './hooks/useLooks';
import {
  ACTIONS,
  buildToolActions,
  withToolActions,
  type ActionDef,
  type ActionId,
  type PaletteItem,
} from './lib/commands';
import { basename, exportFilename, formatFromFilename, joinPath, middleEllipsis, sleep } from './lib/format';
import { formatAccelerator, matchesShortcut } from './lib/shortcuts';
import { getEditor } from './session';
import { EditorView, type InspectorTab } from './views/EditorView';
import { HistoryView } from './views/HistoryView';
import { LicenseView } from './views/LicenseView';
import { SettingsView } from './views/SettingsView';
import {
  blobToBytes,
  errorMessage,
  events,
  ipc,
  type AppInfo,
  type CaptureMeta,
  type HistoryItem,
  type ThemeSetting,
} from '../shared/ipc';
import { IMAGE_EXTENSIONS, native } from '../shared/native';

const TOOL_ACTIONS = buildToolActions(
  TOOL_ORDER,
  TOOL_LABEL as Record<Tool, string>,
  TOOL_SHORTCUT as Record<Tool, string>,
);
const CATALOGUE: readonly ActionDef[] = withToolActions(ACTIONS, TOOL_ACTIONS);

/** Actions that stay available while a text field has focus. */
const WORKS_WHILE_TYPING: ReadonlySet<ActionId> = new Set<ActionId>([
  'palette',
  'go-history',
  'go-settings',
  'go-license',
  'go-editor',
  'open-file',
  'capture-region',
  'capture-window',
]);

const THEME_CYCLE: Record<ThemeSetting, ThemeSetting> = { system: 'light', light: 'dark', dark: 'system' };
const IMAGE_FILE = new RegExp(`\\.(${IMAGE_EXTENSIONS.join('|')})$`, 'i');

function isTypingTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  if (t instanceof HTMLTextAreaElement) return true;
  if (t instanceof HTMLSelectElement) return true;
  if (t instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'color', 'file'].includes(t.type);
  return false;
}

function hasTextSelection(): boolean {
  const sel = window.getSelection();
  return !!sel && !sel.isCollapsed && sel.toString().length > 0;
}

export function App() {
  const editor = getEditor();
  const { toasts, notify, dismiss } = useToasts();
  const { settings, updateSettings } = useSettingsState();
  const { license, ent, setLicense } = useLicenseState();
  const { brandMark, setBrandMark } = useBrandMarkState();
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [view, setView] = useState<View>('editor');

  useEffect(() => {
    let alive = true;
    ipc
      .appInfo()
      .then((i) => alive && setInfo(i))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // Mica needs a transparent page; without it (Windows 10) paint the token surface instead.
  useEffect(() => {
    document.documentElement.dataset.backdrop = info?.backdrop ?? 'solid';
  }, [info?.backdrop]);

  // Theme: the setting wins; "system" removes the override so the tokens follow prefers-color-scheme.
  const theme = settings?.theme ?? 'system';
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      if (settings) window.localStorage.setItem('polishot.theme.v1', theme);
    } catch {
      // storage may be unavailable
    }
    editor.refreshTheme();
  }, [theme, editor, settings]);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const on = () => editor.refreshTheme();
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, [editor]);

  const navigate = useCallback((v: View) => setView(v), []);
  const value = useMemo(
    () => ({ editor, settings, updateSettings, license, ent, setLicense, info, brandMark, setBrandMark, notify, navigate, view }),
    [editor, settings, updateSettings, license, ent, setLicense, info, brandMark, setBrandMark, notify, navigate, view],
  );

  return (
    <AppProvider value={value}>
      <Shell toasts={toasts} onDismiss={dismiss} />
    </AppProvider>
  );
}

function Shell({ toasts, onDismiss }: { toasts: ReturnType<typeof useToasts>['toasts']; onDismiss: (id: number) => void }) {
  const { editor, settings, updateSettings, ent, info, brandMark, notify, navigate, view } = useApp();
  const { state: capture, load, flush, rescan } = useCaptureSession(editor, settings, notify);
  const looks = useLooks();

  const [tab, setTab] = useState<InspectorTab>('style');
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  const ready = capture.phase === 'ready';
  const words = capture.words;

  // Pro unlocks the watermark-free export. Anything but a confirmed Pro entitlement is Free.
  useEffect(() => {
    editor.setLicensed(ent.pro);
  }, [editor, ent.pro]);

  // The editor draws the mark only while licensed (it fails closed), so setting it is always safe.
  useEffect(() => {
    editor.setBrandMark(brandMark);
  }, [editor, brandMark]);

  // A hover preview is only ever for the control under the pointer; never let one outlive its context.
  useEffect(() => {
    editor.clearPreview();
  }, [editor, view, tab, paletteOpen]);

  useEditorShortcuts(editor, view === 'editor' && ready && !paletteOpen);

  // Copy is instant when the image was already rendered during a quiet moment.
  const prewarm = useCopyPrewarm(editor, ready && view === 'editor', ent.pro, brandMark);

  const detections = useMemo(() => (words && words.length > 0 ? detect(words) : []), [words]);

  /* ------------------------------ opening images ------------------------------ */

  const openMeta = useCallback(
    (meta: CaptureMeta, docJson?: string | null) => {
      navigate('editor');
      void load(meta, { docJson, t0: performance.now() });
    },
    [navigate, load],
  );

  // A capture that arrives from the hotkey always lands in the editor.
  const openedId = capture.meta?.id;
  useEffect(() => {
    if (openedId) navigate('editor');
  }, [openedId, navigate]);

  const openPath = useCallback(
    async (path: string) => {
      if (!IMAGE_FILE.test(path)) {
        notify({ message: 'That file is not an image. Use a PNG, JPEG, WebP or BMP.', tone: 'error' });
        return;
      }
      try {
        openMeta(await ipc.openFile(path));
      } catch (e) {
        notify({ message: errorMessage(e), tone: 'error' });
      }
    },
    [notify, openMeta],
  );

  const openFileDialog = useCallback(async () => {
    try {
      const path = await native.pickImage();
      if (path) await openPath(path);
    } catch (e) {
      notify({ message: errorMessage(e), tone: 'error' });
    }
  }, [notify, openPath]);

  const pasteImage = useCallback(async () => {
    try {
      const meta = await ipc.pasteClipboardImage();
      if (meta) openMeta(meta);
      else notify('There is no image on the clipboard. Copy one, then paste again.');
    } catch (e) {
      notify({ message: errorMessage(e), tone: 'error' });
    }
  }, [notify, openMeta]);

  const openHistoryItem = useCallback(
    async (item: HistoryItem) => {
      try {
        const entry = await ipc.historyGet(item.id);
        openMeta(entry.meta, entry.docJson);
      } catch (e) {
        notify({ message: errorMessage(e), tone: 'error' });
      }
    },
    [notify, openMeta],
  );

  /* ------------------------------ events from Rust ------------------------------ */

  useEffect(() => {
    const offs = [
      events.onNavigate((target) => {
        void flush();
        navigate(target);
      }),
      events.onCaptureError((message) => notify({ message, tone: 'error' })),
      events.onShortcutExtra(() => notify('That capture mode is not part of this version yet.')),
      events.onFileDrop(({ paths }) => {
        setDragging(false);
        const first = paths.find((p) => IMAGE_FILE.test(p));
        if (first) void openPath(first);
        else notify({ message: 'That file is not an image. Use a PNG, JPEG, WebP or BMP.', tone: 'error' });
      }),
      events.onDragEnter(() => setDragging(true)),
      events.onDragLeave(() => setDragging(false)),
    ];
    return () => offs.forEach((off) => off());
  }, [navigate, notify, openPath, flush]);

  // Problems found at startup (a shortcut another app already owns) surface once, calmly.
  useEffect(() => {
    const first = info?.warnings[0];
    if (!first) return;
    notify({ message: first, tone: 'error', duration: 9000, action: { label: 'Settings', run: () => navigate('settings') } });
  }, [info, notify, navigate]);

  /* ------------------------------ exporting ------------------------------ */

  const reveal = useCallback(
    async (path: string) => {
      try {
        await ipc.revealInFolder(path);
      } catch {
        try {
          await ipc.copyText(path);
          notify('The folder could not be opened here, so the file path was copied.');
        } catch {
          notify({ message: 'The folder could not be opened. The file is at the location shown.', tone: 'error' });
        }
      }
    },
    [notify],
  );

  const deliver = useCallback(
    async (action: 'copy' | 'save', blob: Blob, filename: string, savePath?: string) => {
      const t0 = performance.now();
      const bytes = await blobToBytes(blob);
      if (action === 'copy') {
        await ipc.copyImage(bytes);
        notify('Copied');
      } else {
        const path = await ipc.exportSave(bytes, filename, { savePath });
        notify({
          message: `Saved to ${middleEllipsis(path, 44)}`,
          action: { label: 'Show in folder', run: () => void reveal(path) },
        });
      }
      if (import.meta.env.DEV) console.info(`[preview] ${action} delivered in ${(performance.now() - t0).toFixed(0)} ms`);
      void flush();
    },
    [notify, reveal, flush],
  );

  const exportNow = useCallback(
    async (action: 'copy' | 'save', opts: { format?: 'png' | 'jpeg' | 'webp'; savePath?: string } = {}) => {
      if (!editor.hasImage || busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      const t0 = performance.now();
      try {
        // Quick actions use the Settings defaults; the Export tab is for one-off choices.
        const format = action === 'copy' ? 'png' : (opts.format ?? settings?.format ?? 'png');
        // A PNG prepared while the user was just looking at the capture is used as is.
        const prepared = format === 'png' && prewarm.isReady();
        const blob =
          format === 'png' ? await prewarm.get() : await editor.export({ format, quality: settings?.quality ?? 0.92, scale: 1, licensed: ent.pro });
        if (import.meta.env.DEV) console.info(`[preview] ${action}: ${prepared ? 'used the prepared image' : 'rendered on demand'}`);
        const name = opts.savePath ? basename(opts.savePath) : exportFilename(APP_SLUG, format);
        await deliver(action, blob, name, opts.savePath);
        if (import.meta.env.DEV) {
          const ms = performance.now() - t0;
          (window as unknown as { __polishotLastExportMs?: Record<string, number> }).__polishotLastExportMs = {
            ...(window as unknown as { __polishotLastExportMs?: Record<string, number> }).__polishotLastExportMs,
            [action]: ms,
          };
          console.info(`[preview] ${action}: export + delivery ${ms.toFixed(0)} ms`);
        }
      } catch (e) {
        notify({ message: errorMessage(e), tone: 'error' });
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [editor, settings, ent.pro, deliver, notify, prewarm],
  );

  const saveAs = useCallback(async () => {
    if (!editor.hasImage) return;
    const format = settings?.format ?? 'png';
    const name = exportFilename(APP_SLUG, format);
    try {
      const chosen = await native.pickSavePath({
        defaultPath: joinPath(settings?.saveFolder ?? '', name),
        extension: name.split('.').pop() ?? 'png',
      });
      if (!chosen) return;
      const picked = formatFromFilename(chosen);
      // A path without a recognised extension keeps the default format and gains its extension.
      const path = picked ? chosen : `${chosen}.${name.split('.').pop()}`;
      await exportNow('save', { format: formatFromFilename(path) ?? format, savePath: path });
    } catch (e) {
      notify({ message: errorMessage(e), tone: 'error' });
    }
  }, [editor, settings, exportNow, notify]);

  const onPanelExport = useCallback(
    async (r: ExportResult) => {
      try {
        await deliver(r.action, r.blob, r.filename);
      } catch (e) {
        notify({ message: errorMessage(e), tone: 'error' });
      }
    },
    [deliver, notify],
  );

  const copyText = useCallback(
    async (text: string) => {
      if (!text) return;
      try {
        await ipc.copyText(text);
        notify('Text copied');
      } catch (e) {
        notify({ message: errorMessage(e), tone: 'error' });
      }
    },
    [notify],
  );

  /* ------------------------------ actions ------------------------------ */

  /** Detections still visible on the canvas. Read live, because hiding one is an editor edit. */
  const getPending = useCallback(
    () => (ready ? detections.filter((d) => !editor.isDetectionApplied(d)) : []),
    [ready, detections, editor],
  );

  const startCapture = useCallback(
    async (mode: 'region' | 'window') => {
      await flush();
      // The window must be gone before the screen is frozen, or it would be in the picture.
      await native.hide().catch(() => undefined);
      await sleep(220);
      try {
        await ipc.captureStart(mode);
      } catch (e) {
        notify({ message: errorMessage(e), tone: 'error' });
      }
    },
    [notify, flush],
  );

  const isEnabled = useCallback(
    (id: ActionId): boolean => {
      const inEditor = view === 'editor';
      switch (id) {
        case 'copy-image':
        case 'save':
        case 'save-as':
        case 'pin':
          return inEditor && ready;
        case 'copy-text':
          return inEditor && !!words && words.length > 0;
        case 'redact-blur':
        case 'redact-bars':
          return inEditor && ready && getPending().length > 0;
        case 'undo':
          return inEditor && ready && editor.canUndo();
        case 'redo':
          return inEditor && ready && editor.canRedo();
        case 'delete-selection':
        case 'duplicate':
          return inEditor && ready && editor.selectedId !== null;
        case 'tab-style':
        case 'tab-redact':
        case 'tab-text':
        case 'tab-export':
          return ready;
        case 'go-editor':
          return !inEditor;
        default:
          if (id.startsWith('tool-')) return ready;
          return true;
      }
    },
    [view, ready, words, getPending, editor],
  );

  const run = useCallback(
    (id: ActionId) => {
      if (id.startsWith('tool-')) {
        navigate('editor');
        editor.setTool(id.slice('tool-'.length) as Tool);
        return;
      }
      switch (id) {
        case 'capture-region':
          void startCapture('region');
          break;
        case 'capture-window':
          void startCapture('window');
          break;
        case 'open-file':
          void openFileDialog();
          break;
        case 'paste-image':
          void pasteImage();
          break;
        case 'copy-image':
          void exportNow('copy');
          break;
        case 'copy-text':
          // Same text the Text tab shows, in reading order.
          if (words?.length) void copyText(wordsToText(words));
          break;
        case 'save':
          void exportNow('save');
          break;
        case 'save-as':
          void saveAs();
          break;
        case 'pin':
          if (capture.meta) {
            ipc
              .pinOpen(capture.meta.id)
              .then(() => notify('Pinned to the screen. Esc closes it.'))
              .catch((e: unknown) => notify({ message: errorMessage(e), tone: 'error' }));
          }
          break;
        case 'redact-blur':
        case 'redact-bars': {
          const left = getPending();
          if (left.length) editor.applyDetections(left, id === 'redact-blur' ? 'blur' : 'bar');
          else notify('No sensitive data to hide.');
          break;
        }
        case 'delete-selection':
          editor.deleteSelection();
          break;
        case 'duplicate':
          editor.duplicateSelection();
          break;
        case 'undo':
          editor.undo();
          break;
        case 'redo':
          editor.redo();
          break;
        case 'tab-style':
        case 'tab-redact':
        case 'tab-text':
        case 'tab-export':
          navigate('editor');
          setTab(id.slice('tab-'.length) as InspectorTab);
          break;
        case 'go-editor':
          navigate('editor');
          break;
        case 'go-history':
          void flush();
          navigate('history');
          break;
        case 'go-settings':
          navigate('settings');
          break;
        case 'go-license':
          navigate('license');
          break;
        case 'palette':
          setPaletteOpen((o) => !o);
          break;
        case 'theme-cycle':
          void updateSettings({ theme: THEME_CYCLE[settings?.theme ?? 'system'] }).then((err) => {
            if (err) notify({ message: err, tone: 'error' });
          });
          break;
        case 'hide':
          void flush();
          void native.hide().catch(() => undefined);
          break;
      }
    },
    [
      navigate, editor, startCapture, openFileDialog, pasteImage, exportNow, words, copyText, saveAs, capture.meta,
      notify, getPending, flush, updateSettings, settings?.theme,
    ],
  );

  /* ------------------------------ keyboard ------------------------------ */

  const stateRef = useRef({ view, isEnabled, run, editor });
  stateRef.current = { view, isEnabled, run, editor };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { view: v, isEnabled: enabled, run: doRun, editor: ed } = stateRef.current;
      // Recording a shortcut, or a dialog / the palette open: they own the keyboard.
      if (document.body.dataset.recordingShortcut) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const typing = isTypingTarget(e.target);

      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (typing) {
          // In a field on one of our screens, Esc first leaves the field; the next Esc leaves the screen.
          // (The editor's own text box handles its Escape itself.)
          if (e.target instanceof HTMLElement && e.target.closest('.pv-page')) e.target.blur();
          return;
        }
        if (v !== 'editor') {
          e.preventDefault();
          doRun('go-editor');
          return;
        }
        // The editor deselects or returns to the select tool first; only a quiet editor hides.
        if (ed.selectedId !== null || ed.tool !== 'select') return;
        e.preventDefault();
        doRun('hide');
        return;
      }

      for (const a of CATALOGUE) {
        if (a.external || a.id === 'hide' || !a.shortcut || !matchesShortcut(e, a.shortcut)) continue;
        if (typing && !WORKS_WHILE_TYPING.has(a.id)) return;
        // Copy with text selected means "copy the text"; Paste into a field means "paste text".
        if (a.id === 'copy-image' && hasTextSelection()) return;
        if (!enabled(a.id)) {
          // Keep the browser's own shortcut (print, find, ...) out of the way even when the action is idle.
          if (a.id !== 'copy-image' && a.id !== 'paste-image') e.preventDefault();
          return;
        }
        e.preventDefault();
        e.stopPropagation();
        doRun(a.id);
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  /* ------------------------------ palette ------------------------------ */

  const paletteItems = useMemo<PaletteItem[]>(() => {
    if (!paletteOpen) return [];
    return CATALOGUE.map((a) => {
      const item: PaletteItem = { ...a, enabled: isEnabled(a.id) };
      if (a.id === 'capture-region' && settings?.shortcut) item.hint = `Anywhere: ${formatAccelerator(settings.shortcut).join('+')}`;
      if (a.id === 'redact-blur' || a.id === 'redact-bars') {
        const n = getPending().length;
        if (n > 0) item.hint = `${n} found`;
      }
      if (a.id === 'theme-cycle') item.hint = settings?.theme ? `Now: ${settings.theme}` : undefined;
      return item;
    });
  }, [paletteOpen, isEnabled, getPending, settings?.shortcut, settings?.theme]);

  /* ------------------------------ render ------------------------------ */

  return (
    <div className="pv-app" data-view={view} data-inspector={view === 'editor' && ready}>
      <TitleBar
        view={view}
        hasImage={ready}
        pro={ent.pro}
        busy={busy}
        onAction={(id) => run(id)}
      />
      <main className="pv-main">
        {view === 'editor' ? (
          <EditorView
            capture={capture}
            tab={tab}
            onTab={setTab}
            detections={detections}
            looks={looks}
            dragging={dragging}
            onExport={onPanelExport}
            onCopyText={copyText}
            onRescan={() => void rescan()}
            onUpgrade={() => navigate('license')}
          />
        ) : null}
        {view === 'history' ? <HistoryView onBack={() => navigate('editor')} onOpen={(item) => void openHistoryItem(item)} /> : null}
        {view === 'settings' ? <SettingsView onBack={() => navigate('editor')} onUpgrade={() => navigate('license')} /> : null}
        {view === 'license' ? <LicenseView onBack={() => navigate('editor')} /> : null}
      </main>
      <Toasts toasts={toasts} onDismiss={onDismiss} />
      <CommandPalette
        open={paletteOpen}
        items={paletteItems}
        onClose={() => setPaletteOpen(false)}
        onRun={(id) => {
          setPaletteOpen(false);
          // Let the palette hand focus back before the action runs (dialogs and pickers take focus themselves).
          window.setTimeout(() => run(id), 0);
        }}
      />
    </div>
  );
}

