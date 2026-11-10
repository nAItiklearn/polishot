'use client';

/**
 * The editor proper: canvas, floating toolbar and the Style / Redact / Text / Export inspector. This module
 * (with Konva and the shared editor UI) is only downloaded once there is an image to work on.
 *
 * Free tier: the editor is created unlicensed, so exports always carry the watermark. The website has no
 * licence activation; /pricing is the way to remove it.
 */
import '@polishot/editor/editor.css';
import './workspace.css';
import { Editor } from '@polishot/editor';
import {
  EditorCanvas,
  Inspector,
  RedactPanel,
  TextLayer,
  Toolbar,
  useEditorShortcuts,
} from '@polishot/editor/react';
import { detect } from '@polishot/redact';
import { ChevronDown, Copy, Download, EyeOff, Lock, ScanText, SlidersHorizontal, Upload } from 'lucide-react';
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
import type { Notify } from './EditorApp';
import { ExportTab, useExporter, type ExportSettings } from './ExportTab';
import type { LoadedImage } from './image';
import { OcrStatus, TextTab } from './TextTab';
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

function isTextEntry(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
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
      el.dataset.tool = editor.tool;
    };
    sync();
    const offs = [editor.on('change', sync), editor.on('select', sync), editor.on('tool', sync)];
    return () => offs.forEach((off) => off());
  }, [editor]);

  // The canvas draws with the accent colour, so repaint when the site switches between light and dark.
  useEffect(() => {
    const refresh = () => requestAnimationFrame(() => editor.refreshTheme());
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', refresh);
    return () => {
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

  const found = useMemo(() => (ocr.words && ocr.words.length > 0 ? detect(ocr.words).length : 0), [ocr.words]);

  const selectTab = useCallback((id: TabId) => {
    setTab(id);
    setSheetOpen(true);
  }, []);

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
        <button type="button" className="pe-btn" aria-label="Find text" onClick={() => selectTab('text')}>
          <ScanText size={16} strokeWidth={1.5} aria-hidden="true" />
          <span className="ed-label">Find text</span>
        </button>
        <button
          type="button"
          className={`pe-btn ${primary === 'download' ? 'pe-btn-primary ed-cta' : ''}`}
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
            className="pe-btn pe-btn-primary ed-cta"
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
              <Inspector editor={editor} />
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
    </div>
  );
}
