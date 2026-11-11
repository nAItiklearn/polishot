'use client';

/**
 * The editor proper: canvas, floating toolbar and the Style / Redact / Text / Export inspector. This module
 * (with Konva and the shared editor UI) is only downloaded once there is an image to work on.
 *
 * Free tier: the editor is created unlicensed, so exports always carry the watermark, the brand mark is
 * locked, and at most 3 looks can be saved (in this browser's localStorage, never sent anywhere). The
 * website has no licence activation; /pricing is the way to remove all of that, and it opens in a new tab so
 * nobody loses their work.
 */
import '@polishot/editor/editor.css';
import './workspace.css';
import { Editor, TOOL_LABEL, TOOL_ORDER, TOOL_SHORTCUT, type Annotation } from '@polishot/editor';
import {
  EditorCanvas,
  Inspector,
  RedactPanel,
  TextLayer,
  Toolbar,
  useEditorShortcuts,
} from '@polishot/editor/react';
import { detect } from '@polishot/redact';
import { ChevronDown, Command as CommandIcon, Copy, Download, EyeOff, Lock, ScanText, SlidersHorizontal, Upload } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { CommandPalette, type Command } from './CommandPalette';
import type { Notify } from './EditorApp';
import { ExportTab, useExporter, type ExportSettings } from './ExportTab';
import type { LoadedImage } from './image';
import { addLook, browserStorage, readLooks, removeLook, SAVE_ERROR } from './looks';
import { reloadOnce } from './csp';
import { isTextEntry } from './textEntry';
import { OcrStatus, TextTab } from './TextTab';
import { warmOcr } from './ocr';
import { useOcr } from './useOcr';

type TabId = 'style' | 'redact' | 'text' | 'export';

const TABS: { id: TabId; label: string; Icon: typeof Upload }[] = [
  { id: 'style', label: 'Style', Icon: SlidersHorizontal },
  { id: 'redact', label: 'Redact', Icon: EyeOff },
  { id: 'text', label: 'Text', Icon: ScanText },
  { id: 'export', label: 'Export', Icon: Download },
];

/** The sidebar becomes a bottom sheet below this width (kept in sync with workspace.css). */
const DESKTOP_QUERY = '(min-width: 900px)';
function useDesktop(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(DESKTOP_QUERY);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
    },
    () => window.matchMedia(DESKTOP_QUERY).matches,
    () => true,
  );
}

/** "arrow:10,20,110,120" for the newest annotation, in source pixels (only read by tests and handy for debugging). */
function describeLast(a: Annotation | undefined): string {
  if (!a) return '';
  const n = (v: number) => Math.round(v);
  switch (a.type) {
    case 'arrow':
    case 'line':
      return `${a.type}:${a.points.map(n).join(',')}`;
    case 'rect':
    case 'ellipse':
    case 'blur':
      return `${a.type}:${[a.x, a.y, a.w, a.h].map(n).join(',')}`;
    case 'step':
      return `step:${n(a.x)},${n(a.y)},${a.n}`;
    default:
      return a.type;
  }
}

interface WorkspaceProps {
  image: LoadedImage;
  onChooseFile: () => void;
  notify: Notify;
}

export default function Workspace(props: WorkspaceProps) {
  const [editor, setEditor] = useState<Editor | null>(null);

  // The editor owns canvases and observers, so it is created and destroyed in an effect (StrictMode-safe).
  useEffect(() => {
    const ed = new Editor(document.createElement('div'), { licensed: false });
    setEditor(ed);
    return () => ed.destroy();
  }, []);

  if (!editor) {
    return (
      <div className="ed-opening" aria-hidden="true">
        Opening
      </div>
    );
  }
  return <Studio editor={editor} {...props} />;
}

function Studio({ editor, image, onChooseFile, notify }: WorkspaceProps & { editor: Editor }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const loaded = useRef<ImageBitmap | null>(null);
  const [tab, setTab] = useState<TabId>('style');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settings, setSettings] = useState<ExportSettings>({ format: 'png', scale: 1, quality: 0.92 });
  const desktop = useDesktop();
  const ocr = useOcr(image.bitmap, image.id);
  const exporter = useExporter(editor, settings, notify);

  useEditorShortcuts(editor);

  // Hand the decoded image to the editor before the first paint, so the capture opens already styled.
  useLayoutEffect(() => {
    editor.load({ id: image.id, width: image.width, height: image.height, element: image.bitmap });
    const previous = loaded.current;
    loaded.current = image.bitmap;
    if (previous && previous !== image.bitmap) previous.close();
  }, [editor, image]);

  // Mirror a few document facts onto the root as data attributes (cheap, and handy for tests).
  useEffect(() => {
    const sync = () => {
      const el = rootRef.current;
      if (!el) return;
      el.dataset.padding = String(editor.doc.padding);
      el.dataset.annotations = String(editor.doc.annotations.length);
      el.dataset.steps = editor.doc.annotations.flatMap((a) => (a.type === 'step' ? [a.n] : [])).join(',');
      el.dataset.selected = editor.selected?.type ?? '';
      el.dataset.last = describeLast(editor.doc.annotations.at(-1));
      el.dataset.tool = editor.tool;
    };
    sync();
    const offs = [editor.on('change', sync), editor.on('select', sync), editor.on('tool', sync)];
    return () => offs.forEach((off) => off());
  }, [editor]);

  // The editor was built on a detached element, so it could not read the page's accent colour yet: read it
  // once the canvas is in the document, and again whenever the page's theme or the system scheme changes.
  useEffect(() => {
    let frame = 0;
    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => editor.refreshTheme());
    };
    refresh();
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', refresh);
    return () => {
      cancelAnimationFrame(frame);
      mo.disconnect();
      mq.removeEventListener('change', refresh);
    };
  }, [editor]);

  // Ctrl+C copies the finished image, unless text is selected (then the text layer owns the copy).
  const { run: runExport, canCopy } = exporter;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'c') return;
      if (isTextEntry(e.target) || !canCopy) return;
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed && sel.toString().trim() !== '') return;
      e.preventDefault();
      void runExport('copy');
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [runExport, canCopy]);

  // Text recognition loads only when the Redact or Text panel is actually in front of the user.
  const panelVisible = desktop || sheetOpen;
  const wantsOcr = panelVisible && (tab === 'redact' || tab === 'text');
  const { start: startOcr } = ocr;
  useEffect(() => {
    if (wantsOcr) void startOcr();
  }, [wantsOcr, startOcr]);

  // Warm the text engine in the background shortly after an image opens (the worker runs off the main thread),
  // so Redact and Text start reading at once instead of first fetching and compiling the engine.
  useEffect(() => {
    let idle: number | undefined;
    const timer = window.setTimeout(() => {
      if ('requestIdleCallback' in window) idle = window.requestIdleCallback(() => warmOcr(), { timeout: 5000 });
      else warmOcr();
    }, 800);
    return () => {
      window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback(idle);
    };
  }, [image.id]);

  // If the page's own policy blocked the engine and nothing has been edited yet, load the page fresh (once).
  // With edits on the canvas the message and its Reload button stay on screen instead of discarding them.
  const blocked = ocr.blocked;
  useEffect(() => {
    if (blocked && !editor.canUndo()) reloadOnce();
  }, [blocked, editor]);

  const found = useMemo(() => (ocr.words && ocr.words.length > 0 ? detect(ocr.words).length : 0), [ocr.words]);

  const selectTab = useCallback((id: TabId) => {
    setTab(id);
    setSheetOpen(true);
  }, []);

  // Saved looks live in this browser only. Free keeps 3; the Inspector shows the limit and a link to Pro.
  const storage = useMemo(() => browserStorage(), []);
  const loadPresets = useCallback(() => readLooks(storage), [storage]);
  const onSavePreset = useCallback(
    (preset: Parameters<typeof addLook>[1]) => {
      const result = addLook(storage, preset);
      if (!result.ok) notify(SAVE_ERROR[result.reason], 'error');
    },
    [storage, notify],
  );
  const onDeletePreset = useCallback((id: string) => void removeLook(storage, id), [storage]);
  // Opens in a new tab: leaving this page would throw away the work in progress.
  const onUpgrade = useCallback(() => void window.open('/pricing', '_blank', 'noopener'), []);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    if (canCopy) list.push({ id: 'copy', label: 'Copy image', keywords: 'clipboard', shortcut: 'Ctrl+C', run: () => void runExport('copy') });
    list.push({ id: 'download', label: 'Download image', keywords: 'save export', shortcut: 'Ctrl+S', run: () => void runExport('download') });
    if (exporter.canShare) list.push({ id: 'share', label: 'Share image', shortcut: 'Ctrl+Shift+S', run: () => void runExport('share') });
    list.push(
      { id: 'open', label: 'Open another image', keywords: 'file choose', shortcut: 'Ctrl+O', run: onChooseFile },
      { id: 'undo', label: 'Undo', shortcut: 'Ctrl+Z', run: () => editor.undo() },
      { id: 'redo', label: 'Redo', shortcut: 'Ctrl+Shift+Z', run: () => editor.redo() },
      { id: 'duplicate', label: 'Duplicate selection', keywords: 'copy', shortcut: 'Ctrl+D', run: () => void editor.duplicateSelection() },
      { id: 'delete', label: 'Delete selection', keywords: 'remove', shortcut: 'Delete', run: () => editor.deleteSelection() },
      { id: 'style', label: 'Panel: Style', keywords: 'background padding frame shadow corners', shortcut: '1', run: () => selectTab('style') },
      { id: 'redact', label: 'Panel: Redact', keywords: 'blur hide sensitive email card key ip', shortcut: '2', run: () => selectTab('redact') },
      { id: 'text', label: 'Panel: Find and copy text', keywords: 'ocr recognise read', shortcut: '3', run: () => selectTab('text') },
      { id: 'export', label: 'Panel: Export', keywords: 'format scale quality', shortcut: '4', run: () => selectTab('export') },
    );
    for (const tool of TOOL_ORDER) {
      list.push({ id: `tool-${tool}`, label: `${TOOL_LABEL[tool]} tool`, shortcut: TOOL_SHORTCUT[tool], run: () => editor.setTool(tool) });
    }
    return list;
  }, [canCopy, exporter.canShare, runExport, onChooseFile, editor, selectTab]);

  // Ctrl+K opens the command palette. Ctrl+S saves, Ctrl+O opens, 1 to 4 switch panels (never while typing).
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && !e.altKey && !e.shiftKey && key === 'k') {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (e.repeat) return;
      if (mod && !e.altKey && key === 's') {
        e.preventDefault();
        if (!e.shiftKey) void runExport('download');
        else if (exporter.canShare) void runExport('share');
      } else if (mod && !e.altKey && !e.shiftKey && key === 'o') {
        e.preventDefault();
        onChooseFile();
      } else if (!mod && !e.altKey && !e.shiftKey && /^[1-4]$/.test(e.key) && !isTextEntry(e.target)) {
        e.preventDefault();
        selectTab(TABS[Number(e.key) - 1]!.id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [runExport, exporter.canShare, onChooseFile, selectTab]);

  const onTabClick = (id: TabId) => {
    if (!desktop && id === tab && sheetOpen) setSheetOpen(false);
    else selectTab(id);
  };

  // Arrow keys move focus between tabs; Enter or Space activates, so browsing never starts OCR by accident.
  const onTabKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const tabs = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
  };

  const primary = canCopy ? 'copy' : 'download';
  const copyBusy = exporter.busy === 'copy';
  const downloadBusy = exporter.busy === 'download';

  return (
    <div className="ed-studio" ref={rootRef} data-testid="editor-studio">
      <div className="ed-bar">
        <button type="button" className="pe-btn" aria-label="Open image" onClick={onChooseFile}>
          <Upload size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="ed-label">Open image</span>
        </button>
        <div className="ed-file" title={image.name}>
          <span className="ed-file-name">{image.name}</span>
          <span className="ed-file-dims">
            {image.width} × {image.height}
          </span>
        </div>
        <p className="ed-privacy ed-privacy-bar">
          <Lock size={14} strokeWidth={1.5} aria-hidden="true" />
          Nothing is uploaded
        </p>
        <button
          type="button"
          className="pe-btn ed-iconbtn"
          aria-label="Commands"
          aria-keyshortcuts="Control+K"
          title="Commands (Ctrl+K)"
          onClick={() => setPaletteOpen(true)}
        >
          <CommandIcon size={16} strokeWidth={1.5} aria-hidden="true" />
        </button>
        <button type="button" className="pe-btn" aria-label="Find text" onClick={() => selectTab('text')}>
          <ScanText size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="ed-label">Find text</span>
        </button>
        <button
          type="button"
          className={`pe-btn ${primary === 'download' ? 'pe-btn-primary ed-cta btn-ember' : ''}`}
          aria-label="Download"
          disabled={exporter.busy !== null}
          onClick={() => void runExport('download')}
        >
          <Download size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="ed-label">{downloadBusy ? 'Saving' : 'Download'}</span>
        </button>
        {canCopy && (
          <button
            type="button"
            className="pe-btn pe-btn-primary ed-cta btn-ember"
            disabled={exporter.busy !== null}
            onClick={() => void runExport('copy')}
          >
            <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
            {copyBusy ? 'Copying' : 'Copy'}
          </button>
        )}
      </div>

      <div className="ed-main">
        <div className="ed-stage">
          <EditorCanvas editor={editor}>
            <TextLayer editor={editor} words={ocr.words} />
            <Toolbar editor={editor} />
          </EditorCanvas>
        </div>

        <div className="ed-side" data-open={desktop || sheetOpen}>
          <div className="ed-tabbar">
            <div className="ed-tabs" role="tablist" aria-label="Editor panels" onKeyDown={onTabKeys}>
              {TABS.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  id={`ed-tab-${id}`}
                  className="ed-tab"
                  aria-selected={tab === id}
                  aria-controls={`ed-panel-${id}`}
                  tabIndex={tab === id ? 0 : -1}
                  onClick={() => onTabClick(id)}
                >
                  <Icon className="ed-tab-icon" size={18} strokeWidth={1.5} aria-hidden="true" />
                  {label}
                  {id === 'redact' && found > 0 && (
                    <span className="ed-badge" data-testid="found-badge">
                      {found}
                      <span className="sr-only"> found</span>
                    </span>
                  )}
                </button>
              ))}
            </div>
            <button type="button" className="ed-sheet-close" aria-label="Hide panel" onClick={() => setSheetOpen(false)}>
              <ChevronDown size={18} strokeWidth={1.5} aria-hidden="true" />
            </button>
          </div>

          <div className="ed-panels">
            <div role="tabpanel" id="ed-panel-style" aria-labelledby="ed-tab-style" className="ed-panel" hidden={tab !== 'style'}>
              <h2 className="sr-only">Style</h2>
              <Inspector
                editor={editor}
                loadPresets={loadPresets}
                onSavePreset={onSavePreset}
                onDeletePreset={onDeletePreset}
                onUpgrade={onUpgrade}
              />
            </div>
            <div role="tabpanel" id="ed-panel-redact" aria-labelledby="ed-tab-redact" className="ed-panel" hidden={tab !== 'redact'}>
              <h2 className="sr-only">Redact</h2>
              <OcrStatus ocr={ocr} className="ed-ocr-pad" />
              <RedactPanel editor={editor} words={ocr.words} onScan={ocr.start} scanning={ocr.status === 'running'} />
            </div>
            <div role="tabpanel" id="ed-panel-text" aria-labelledby="ed-tab-text" className="ed-panel" hidden={tab !== 'text'}>
              <h2 className="sr-only">Text</h2>
              <TextTab ocr={ocr} onFind={ocr.start} />
            </div>
            <div role="tabpanel" id="ed-panel-export" aria-labelledby="ed-tab-export" className="ed-panel" hidden={tab !== 'export'}>
              <h2 className="sr-only">Export</h2>
              <ExportTab editor={editor} settings={settings} onSettings={setSettings} exporter={exporter} />
            </div>
          </div>
        </div>
      </div>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} commands={commands} />
    </div>
  );
}
