import { APP_SLUG } from '@polishot/brand';
import { Copy, Download } from 'lucide-react';
import { useState } from 'react';
import type { Editor } from '../editor';
import { computeExportSize } from '../layout';
import type { ExportOptions } from '../types';
import { useEditorVersion } from './hooks';
import { Section, Segmented, Slider } from './ui';

export type ExportAction = 'save' | 'copy';

export interface ExportResult {
  blob: Blob;
  options: ExportOptions;
  action: ExportAction;
  filename: string;
  width: number;
  height: number;
}

export interface ExportPanelProps {
  editor: Editor;
  /** Receives the rendered image; the host decides where it goes (disk, clipboard, share sheet). */
  onExport: (result: ExportResult) => void | Promise<void>;
  /** Buttons to show. Default: save and copy. */
  actions?: ExportAction[];
  defaults?: Partial<Pick<ExportOptions, 'format' | 'quality' | 'scale'>>;
  className?: string;
}

const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function ExportPanel({ editor, onExport, actions = ['save', 'copy'], defaults, className }: ExportPanelProps) {
  useEditorVersion(editor);
  const [format, setFormat] = useState<ExportOptions['format']>(defaults?.format ?? 'png');
  const [scale, setScale] = useState<ExportOptions['scale']>(defaults?.scale ?? 2);
  const [quality, setQuality] = useState(defaults?.quality ?? 0.92);
  const [busy, setBusy] = useState<ExportAction | null>(null);
  const [error, setError] = useState<string | null>(null);

  const size = computeExportSize(editor.doc, scale);

  const run = async (action: ExportAction) => {
    if (busy) return;
    setBusy(action);
    setError(null);
    try {
      // The clipboard only reliably takes PNG, so "Copy" always renders PNG.
      const options: ExportOptions = {
        format: action === 'copy' ? 'png' : format,
        quality,
        scale,
        licensed: editor.licensed,
      };
      const blob = await editor.export(options);
      await onExport({
        blob,
        options,
        action,
        filename: `${APP_SLUG}-${stamp()}.${EXT[options.format]}`,
        width: size.width,
        height: size.height,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={`pe-export ${className ?? ''}`}>
      <Section
        title="Export"
        aside={
          <output className="pe-value" data-testid="export-size" aria-label="Output size">
            {size.width}×{size.height}
          </output>
        }
      >
        <Segmented<ExportOptions['format']>
          label="Format"
          value={format}
          onChange={setFormat}
          options={[
            { value: 'png', label: 'PNG' },
            { value: 'jpeg', label: 'JPEG' },
            { value: 'webp', label: 'WebP' },
          ]}
        />
        <Segmented<ExportOptions['scale']>
          label="Scale"
          value={scale}
          onChange={setScale}
          options={[
            { value: 1, label: '1x', name: 'Scale 1x' },
            { value: 2, label: '2x', name: 'Scale 2x' },
            { value: 3, label: '3x', name: 'Scale 3x' },
          ]}
        />
        {format !== 'png' && (
          <Slider
            editor={editor}
            label="Quality"
            min={0.4}
            max={1}
            step={0.01}
            value={quality}
            format={(v) => `${Math.round(v * 100)}%`}
            onChange={setQuality}
          />
        )}
        {size.clamped && <p className="pe-hint">Scaled down to fit the browser's canvas limits.</p>}
        {!editor.licensed && <p className="pe-hint">Free exports include a small watermark.</p>}
        <div className="pe-actions">
          {actions.includes('save') && (
            <button type="button" className="pe-btn pe-btn-primary" disabled={busy !== null} onClick={() => void run('save')}>
              <Download size={16} strokeWidth={1.5} aria-hidden="true" />
              {busy === 'save' ? 'Rendering…' : 'Save image'}
            </button>
          )}
          {actions.includes('copy') && (
            <button type="button" className="pe-btn" disabled={busy !== null} onClick={() => void run('copy')}>
              <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
              {busy === 'copy' ? 'Copying…' : 'Copy image'}
            </button>
          )}
        </div>
        {error && (
          <p className="pe-error" role="alert">
            {error}
          </p>
        )}
      </Section>
    </div>
  );
}
