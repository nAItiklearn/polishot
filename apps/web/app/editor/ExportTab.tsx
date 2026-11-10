'use client';

import { APP_SLUG } from '@polishot/brand';
import { computeExportSize, type Editor, type ExportOptions } from '@polishot/editor';
import { useEditorVersion } from '@polishot/editor/react';
import { Copy, Download, Share2 } from 'lucide-react';
import Link from 'next/link';
import { useCallback, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Notify } from './EditorApp';
import { canCopyImage, canShareFiles, copyImage, downloadBlob, EXTENSION, shareImage, timestamp } from './output';

export interface ExportSettings {
  format: ExportOptions['format'];
  scale: ExportOptions['scale'];
  quality: number;
}

type ExportAction = 'download' | 'copy' | 'share';

const FORMAT_LABEL: Record<ExportSettings['format'], string> = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' };

function explain(err: unknown, action: ExportAction): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return action === 'copy'
      ? 'Your browser blocked copying. Click the page once and try again, or use Download.'
      : 'Your browser blocked that. Try Download instead.';
  }
  return action === 'copy'
    ? 'The image could not be copied. Try Download, or a smaller scale.'
    : 'The image could not be exported. Try a smaller scale or another format.';
}

/**
 * Renders the finished image through `editor.export` and sends it somewhere: a download, the clipboard or
 * the system share sheet. One export runs at a time; the UI stays responsive while it renders.
 */
export function useExporter(editor: Editor, settings: ExportSettings, notify: Notify) {
  const [busy, setBusy] = useState<ExportAction | null>(null);
  const running = useRef(false);
  const [capabilities] = useState(() => ({ copy: canCopyImage(), share: canShareFiles() }));

  const run = useCallback(
    async (action: ExportAction) => {
      if (running.current || !editor.hasImage) return;
      running.current = true;
      setBusy(action);
      try {
        const base = { quality: settings.quality, scale: settings.scale, licensed: editor.licensed };
        if (action === 'copy') {
          // Clipboard images are PNG. The render is handed over as a promise so Safari keeps the click's permission.
          await copyImage(editor.export({ ...base, format: 'png', quality: 1 }));
          notify('Copied');
          return;
        }
        const blob = await editor.export({ ...base, format: settings.format });
        const filename = `${APP_SLUG}-${timestamp()}.${EXTENSION[settings.format]}`;
        if (action === 'download') {
          downloadBlob(blob, filename);
          const { width, height } = computeExportSize(editor.doc, settings.scale);
          notify(`Saved ${width} × ${height} ${FORMAT_LABEL[settings.format]}`);
        } else if (await shareImage(blob, filename)) {
          notify('Shared');
        }
      } catch (err) {
        notify(explain(err, action), 'error');
      } finally {
        running.current = false;
        setBusy(null);
      }
    },
    [editor, settings.format, settings.quality, settings.scale, notify],
  );

  return useMemo(() => ({ run, busy, canCopy: capabilities.copy, canShare: capabilities.share }), [run, busy, capabilities]);
}

type Exporter = ReturnType<typeof useExporter>;

interface Option<T> {
  value: T;
  label: string;
  name?: string;
}

function Choice<T extends string | number>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div className="pe-field">
      <div className="pe-field-head">
        <span className="pe-label">{label}</span>
      </div>
      <div className="pe-segmented" role="group" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            type="button"
            className="pe-seg"
            aria-pressed={o.value === value}
            aria-label={o.name}
            onClick={() => onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

interface ExportTabProps {
  editor: Editor;
  settings: ExportSettings;
  onSettings: (next: ExportSettings) => void;
  exporter: Exporter;
}

/** Format, scale and quality, then download, copy or share. Free exports always carry the watermark. */
export function ExportTab({ editor, settings, onSettings, exporter }: ExportTabProps) {
  useEditorVersion(editor);
  const titleId = useId();
  const qualityId = useId();
  const size = computeExportSize(editor.doc, settings.scale);
  const pct = ((settings.quality - 0.4) / 0.6) * 100;
  const disabled = exporter.busy !== null;

  return (
    <div className="pe-export">
      <section className="pe-section" aria-labelledby={titleId}>
        <div className="pe-section-head">
          <h3 className="pe-section-title" id={titleId}>
            Export
          </h3>
          <output className="pe-value" data-testid="export-size" aria-label="Output size">
            {size.width}×{size.height}
          </output>
        </div>
        <div className="pe-section-body">
          <Choice<ExportSettings['format']>
            label="Format"
            value={settings.format}
            onChange={(format) => onSettings({ ...settings, format })}
            options={[
              { value: 'png', label: 'PNG' },
              { value: 'jpeg', label: 'JPEG' },
              { value: 'webp', label: 'WebP' },
            ]}
          />
          <Choice<ExportSettings['scale']>
            label="Scale"
            value={settings.scale}
            onChange={(scale) => onSettings({ ...settings, scale })}
            options={[
              { value: 1, label: '1x', name: 'Scale 1x' },
              { value: 2, label: '2x', name: 'Scale 2x' },
              { value: 3, label: '3x', name: 'Scale 3x' },
            ]}
          />
          {settings.format !== 'png' && (
            <div className="pe-field">
              <div className="pe-field-head">
                <label className="pe-label" htmlFor={qualityId}>
                  Quality
                </label>
                <output className="pe-value">{Math.round(settings.quality * 100)}%</output>
              </div>
              <input
                id={qualityId}
                className="pe-range"
                type="range"
                min={0.4}
                max={1}
                step={0.01}
                value={settings.quality}
                style={{ '--pe-fill': `${Math.min(100, Math.max(0, pct))}%` } as CSSProperties}
                aria-valuetext={`${Math.round(settings.quality * 100)}%`}
                onChange={(e) => onSettings({ ...settings, quality: Number(e.currentTarget.value) })}
              />
            </div>
          )}
          {size.clamped && <p className="pe-hint">Scaled down to fit the browser&apos;s canvas limits.</p>}

          <div className="pe-actions ed-actions">
            <button type="button" className="pe-btn" disabled={disabled} onClick={() => void exporter.run('download')}>
              <Download size={16} strokeWidth={1.5} aria-hidden="true" />
              Download
            </button>
            {exporter.canCopy && (
              <button type="button" className="pe-btn" disabled={disabled} onClick={() => void exporter.run('copy')}>
                <Copy size={16} strokeWidth={1.5} aria-hidden="true" />
                Copy image
              </button>
            )}
            {exporter.canShare && (
              <button type="button" className="pe-btn" disabled={disabled} onClick={() => void exporter.run('share')}>
                <Share2 size={16} strokeWidth={1.5} aria-hidden="true" />
                Share
              </button>
            )}
          </div>

          {!editor.licensed && (
            <p className="pe-hint">
              Free exports include a small watermark.{' '}
              <Link href="/pricing" className="ed-link">
                Remove it with Pro
              </Link>
              .
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
