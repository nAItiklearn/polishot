import type { Editor } from '@polishot/editor';
import {
  EditorCanvas,
  ExportPanel,
  Inspector,
  RedactPanel,
  TextLayer,
  Toolbar,
  useEditorVersion,
  wordsToText,
  type ExportResult,
} from '@polishot/editor/react';
import type { Detection, OcrWord } from '@polishot/redact';
import { Check, Copy, EyeOff, ImageUp } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Keys } from '../components/Keys';
import { TabPanel, Tabs, type TabDef } from '../components/Tabs';
import { useApp } from '../context';
import type { CaptureState } from '../hooks/useCaptureSession';
import type { Looks } from '../hooks/useLooks';
import { actionDef } from '../lib/commands';
import { plural } from '../lib/format';

export type InspectorTab = 'style' | 'redact' | 'text' | 'export';

export const TAB_IDS: readonly InspectorTab[] = ['style', 'redact', 'text', 'export'];

export interface EditorViewProps {
  capture: CaptureState;
  tab: InspectorTab;
  onTab: (t: InspectorTab) => void;
  detections: readonly Detection[];
  looks: Looks;
  /** A file is being dragged over the window. */
  dragging: boolean;
  onExport: (r: ExportResult) => Promise<void>;
  onCopyText: (text: string) => Promise<void>;
  onRescan: () => void;
  onUpgrade: () => void;
}

function EmptyState({ shortcut, error }: { shortcut: string; error: string | null }) {
  if (error) {
    return (
      <div className="pv-empty" role="status">
        <p className="pv-empty-title">{error}</p>
        <p className="pv-empty-sub">Capture again, or open a file with Ctrl O.</p>
      </div>
    );
  }
  return (
    <div className="pv-empty">
      <p className="pv-empty-title">Press your capture shortcut to begin.</p>
      <Keys accelerator={shortcut} className="pv-keys-lg" />
    </div>
  );
}

function TextPanel({
  words,
  pending,
  onCopy,
  onRescan,
}: {
  words: OcrWord[] | null;
  pending: boolean;
  onCopy: (text: string) => Promise<void>;
  onRescan: () => void;
}) {
  const [copied, setCopied] = useState(false);
  if (pending && !words) {
    return (
      <div className="pv-panel-pad">
        <p className="pe-hint" role="status">
          Recognising text in the background. You can keep editing.
        </p>
      </div>
    );
  }
  if (!words || words.length === 0) {
    return (
      <div className="pv-panel-pad">
        <p className="pe-hint">No text was found in this capture.</p>
        <button type="button" className="pe-btn pv-mt" onClick={onRescan}>
          Scan again
        </button>
      </div>
    );
  }
  const text = wordsToText(words);
  const lines = text.split('\n').length;
  const copy = async () => {
    await onCopy(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };
  return (
    <div className="pv-panel-pad pv-textpanel">
      <div className="pv-textpanel-head">
        <h3 className="pe-section-title">Recognised text</h3>
        <span className="pe-count">
          {plural(words.length, 'word')} · {plural(lines, 'line')}
        </span>
      </div>
      <pre className="pv-ocr" tabIndex={0} aria-label="Recognised text">
        {text}
      </pre>
      <button type="button" className="pe-btn pe-btn-primary" onClick={() => void copy()}>
        {copied ? <Check size={16} strokeWidth={1.5} aria-hidden="true" /> : <Copy size={16} strokeWidth={1.5} aria-hidden="true" />}
        {copied ? 'Copied' : 'Copy all text'}
        {!copied ? <Keys accelerator={actionDef('copy-text').shortcut} /> : null}
      </button>
      <p className="pe-hint">Or drag across the screenshot to select part of it.</p>
    </div>
  );
}

function LooksNote({ looks, onUpgrade }: { looks: Looks; onUpgrade: () => void }) {
  if (!looks.quota.atLimit) return null;
  return (
    <div className="pv-note">
      <p className="pe-hint">
        You have saved all {looks.quota.limit} looks that Free includes.{' '}
        <button type="button" className="pv-link" onClick={onUpgrade}>
          Get Pro for unlimited.
        </button>
      </p>
    </div>
  );
}

/** "3 found  Hide": sensitive data found by OCR, hidden with one click. A chip, never a modal. */
function FoundChip({ editor, pending }: { editor: Editor; pending: readonly Detection[] }) {
  if (pending.length === 0) return null;
  return (
    <div className="pv-found" role="group" aria-label="Sensitive data">
      <span className="pv-found-count" role="status">
        {pending.length} found
      </span>
      <button type="button" className="pv-found-btn" onClick={() => editor.applyDetections(pending, 'blur')}>
        <EyeOff size={14} strokeWidth={1.5} aria-hidden="true" />
        Hide
      </button>
    </div>
  );
}

function InspectorPane({
  editor,
  tab,
  capture,
  looks,
  onExport,
  onCopyText,
  onRescan,
  onUpgrade,
}: Pick<EditorViewProps, 'tab' | 'capture' | 'looks' | 'onExport' | 'onCopyText' | 'onRescan' | 'onUpgrade'> & { editor: Editor }) {
  const { settings, ent } = useApp();
  switch (tab) {
    case 'style':
      return (
        <>
          <Inspector editor={editor} loadPresets={looks.loadPresets} onSavePreset={looks.onSavePreset} onDeletePreset={looks.onDeletePreset} />
          <LooksNote looks={looks} onUpgrade={onUpgrade} />
        </>
      );
    case 'redact':
      return <RedactPanel editor={editor} words={capture.words} scanning={capture.ocr === 'pending'} onScan={onRescan} />;
    case 'text':
      return <TextPanel words={capture.words} pending={capture.ocr === 'pending'} onCopy={onCopyText} onRescan={onRescan} />;
    case 'export':
      return (
        <>
          <ExportPanel
            // Re-initialise when the defaults change in Settings.
            key={settings ? `${settings.format}-${settings.quality}` : 'defaults'}
            editor={editor}
            onExport={onExport}
            defaults={settings ? { format: settings.format, quality: settings.quality, scale: 1 } : { scale: 1 }}
          />
          {!ent.pro ? (
            <div className="pv-note">
              <p className="pe-hint">
                <button type="button" className="pv-link" onClick={onUpgrade}>
                  Remove the watermark with Pro.
                </button>
              </p>
            </div>
          ) : null}
        </>
      );
  }
}

/**
 * The editor screen: the canvas card (about 70% of the window) with the floating toolbar, and the 280 px
 * inspector with four tabs. Before the first capture it shows one sentence and the capture shortcut.
 */
export function EditorView({ capture, tab, onTab, detections, looks, dragging, onExport, onCopyText, onRescan, onUpgrade }: EditorViewProps) {
  const { editor, settings } = useApp();
  useEditorVersion(editor);
  const hasCapture = capture.meta !== null && capture.phase !== 'error';
  const ready = capture.phase === 'ready';

  // Only what is still visible counts: once data is hidden the badge goes away.
  const pending = ready ? detections.filter((d) => !editor.isDetectionApplied(d)) : [];
  const found = pending.length;
  const tabs: TabDef<InspectorTab>[] = [
    { id: 'style', label: 'Style' },
    { id: 'redact', label: 'Redact', badge: found, badgeLabel: `${found} found` },
    { id: 'text', label: 'Text' },
    { id: 'export', label: 'Export' },
  ];

  let overlay: ReactNode = null;
  if (dragging) {
    overlay = (
      <div className="pv-drop" role="presentation">
        <ImageUp size={20} strokeWidth={1.5} aria-hidden="true" />
        <span>Drop an image to open it</span>
      </div>
    );
  }

  return (
    <div className="pv-editor" data-has-capture={hasCapture}>
      <section className="pv-card pv-canvas-card" aria-label="Canvas" data-phase={capture.phase} data-reveal-text={tab === 'text'}>
        {hasCapture ? (
          <EditorCanvas editor={editor}>
            <TextLayer editor={editor} words={capture.words} onCopyText={onCopyText} />
            <FoundChip editor={editor} pending={pending} />
            <Toolbar editor={editor} />
          </EditorCanvas>
        ) : (
          <EmptyState shortcut={settings?.shortcut ?? ''} error={capture.phase === 'error' ? capture.error : null} />
        )}
        {overlay}
      </section>

      {hasCapture && (ready || editor.hasImage) ? (
        <aside className="pv-card pv-inspector" aria-label="Inspector" data-ready={ready}>
          <div className="pv-inspector-tabs">
            <Tabs tabs={tabs} value={tab} onChange={onTab} label="Inspector sections" idPrefix="pv-insp" />
          </div>
          <TabPanel idPrefix="pv-insp" active={tab} className="pv-inspector-body">
            <InspectorPane
              editor={editor}
              tab={tab}
              capture={capture}
              looks={looks}
              onExport={onExport}
              onCopyText={onCopyText}
              onRescan={onRescan}
              onUpgrade={onUpgrade}
            />
          </TabPanel>
        </aside>
      ) : null}
    </div>
  );
}
