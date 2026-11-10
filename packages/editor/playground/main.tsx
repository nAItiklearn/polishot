import { APP_NAME } from '@polishot/brand';
import '@polishot/brand/tokens.css';
import type { OcrWord } from '@polishot/redact';
import { Moon, Sun, Upload } from 'lucide-react';
import { StrictMode, useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Editor, exportDoc, type ImageSource } from '../src/index';
import {
  EditorCanvas,
  ExportPanel,
  Inspector,
  RedactPanel,
  TextLayer,
  Toolbar,
  useEditorShortcuts,
  type ExportResult,
  type UserPreset,
} from '../src/react/index';
import '../src/react/editor.css';
import './playground.css';
import { makeSample } from './sample';

interface PlaygroundApi {
  editor: Editor;
  words: OcrWord[];
  lastExport: ExportResult | null;
  /** The image the editor currently shows (for tests that call the standalone exporter). */
  image: ImageSource | null;
  /** The standalone exporter, exposed so tests can check the licence gate without an Editor. */
  exportDoc: typeof exportDoc;
  /** The Editor class, so tests can build a second editor (e.g. one that loads before it is attached). */
  EditorClass: typeof Editor;
  loadSample(scale?: number): number;
  /** Like loadSample but hands the editor a decoded ImageBitmap, as a real host would; resolves to the load time in ms. */
  loadSampleBitmap(scale?: number): Promise<number>;
}

declare global {
  interface Window {
    __polishot?: PlaygroundApi;
  }
}

const editor = new Editor(document.createElement('div'), { licensed: false });

const api: PlaygroundApi = {
  editor,
  words: [],
  lastExport: null,
  image: null,
  exportDoc,
  EditorClass: Editor,
  loadSample(scale = 1) {
    const s = makeSample(scale);
    api.words = s.words;
    api.image = { id: `sample-${scale}`, width: s.width, height: s.height, element: s.canvas };
    const t0 = performance.now();
    editor.load(api.image);
    return performance.now() - t0;
  },
  async loadSampleBitmap(scale = 1) {
    const s = makeSample(scale);
    const bitmap = await createImageBitmap(s.canvas);
    api.words = s.words;
    api.image = { id: `sample-bitmap-${scale}`, width: bitmap.width, height: bitmap.height, element: bitmap };
    const t0 = performance.now();
    editor.load(api.image);
    return performance.now() - t0;
  },
};
window.__polishot = api;

const LOOKS_KEY = 'pe-playground-looks';

/** Saved looks live in localStorage here; a real host persists them however it likes. */
const looks = {
  load(): UserPreset[] {
    try {
      const raw = JSON.parse(localStorage.getItem(LOOKS_KEY) ?? '[]') as unknown;
      return Array.isArray(raw) ? (raw as UserPreset[]) : [];
    } catch {
      return [];
    }
  },
  save(p: Omit<UserPreset, 'id'>): void {
    const list = looks.load();
    list.push({ ...p, id: `look-${Date.now().toString(36)}` });
    localStorage.setItem(LOOKS_KEY, JSON.stringify(list.slice(-12)));
  },
  remove(id: string): void {
    localStorage.setItem(LOOKS_KEY, JSON.stringify(looks.load().filter((l) => l.id !== id)));
  },
};

function App() {
  const [words, setWords] = useState<OcrWord[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [theme, setTheme] = useState<'light' | 'dark'>(
    new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light',
  );
  const [licensed, setLicensed] = useState(false);
  const [status, setStatus] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEditorShortcuts(editor);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    editor.refreshTheme();
  }, [theme]);

  useEffect(() => {
    editor.setLicensed(licensed);
  }, [licensed]);

  const loadSample = useCallback((scale = 1) => {
    setWords(null);
    api.loadSample(scale);
  }, []);

  useEffect(() => {
    loadSample(1);
  }, [loadSample]);

  const scan = useCallback(async () => {
    setScanning(true);
    await new Promise((r) => setTimeout(r, 250)); // stands in for the host's OCR call
    setWords(api.words);
    setScanning(false);
  }, []);

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const bmp = await createImageBitmap(file);
      setWords(null);
      api.words = [];
      api.image = { id: `file-${Date.now()}`, width: bmp.width, height: bmp.height, element: bmp };
      editor.load(api.image);
    } catch {
      setStatus('That file could not be opened as an image.');
    }
  };

  return (
    <div className="pg-app">
      <header className="pg-top">
        <span className="pg-brand">{APP_NAME}</span>
        <span className="pg-sub">editor playground</span>
        <div className="pg-spacer" />
        <button type="button" className="pe-btn" onClick={() => loadSample(1)}>
          Load sample
        </button>
        <button type="button" className="pe-btn" onClick={() => loadSample(3)} data-testid="load-4k">
          Load 4K sample
        </button>
        <button type="button" className="pe-btn" onClick={() => fileRef.current?.click()}>
          <Upload size={16} strokeWidth={1.5} aria-hidden="true" />
          Open image
        </button>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(e) => void onFile(e.target.files?.[0])} aria-label="Open an image" />
        <button type="button" className="pe-btn" aria-pressed={licensed} onClick={() => setLicensed(!licensed)}>
          {licensed ? 'Licensed' : 'Free'}
        </button>
        <button
          type="button"
          className="pe-btn"
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? <Sun size={16} strokeWidth={1.5} aria-hidden="true" /> : <Moon size={16} strokeWidth={1.5} aria-hidden="true" />}
        </button>
      </header>

      <div className="pe-shell">
        <EditorCanvas editor={editor}>
          <TextLayer editor={editor} words={words} />
          <Toolbar editor={editor} />
        </EditorCanvas>
        <div className="pe-sidebar">
          <div className="pe-sidebar-scroll">
            <RedactPanel editor={editor} words={words} onScan={scan} scanning={scanning} />
            <Inspector
              editor={editor}
              loadPresets={looks.load}
              onSavePreset={looks.save}
              onDeletePreset={looks.remove}
              onUpgrade={() => setStatus('Upgrade: the host opens its pricing page here.')}
            />
          </div>
          <div className="pe-sidebar-footer">
            <ExportPanel
              editor={editor}
              onExport={(r) => {
                api.lastExport = r;
                setStatus(`${r.action === 'copy' ? 'Copied' : 'Saved'} ${r.width} × ${r.height} px ${r.options.format.toUpperCase()}`);
              }}
            />
          </div>
        </div>
      </div>
      <p className="pg-status" role="status" aria-live="polite" data-testid="status">
        {status}
      </p>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
