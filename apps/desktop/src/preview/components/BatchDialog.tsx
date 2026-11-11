import { Editor } from '@polishot/editor';
import type { LookSettings } from '@polishot/editor/react';
import { ImageIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { blobToBytes, errorMessage, ipc } from '../../shared/ipc';
import { useApp } from '../context';
import { useLooks } from '../hooks/useLooks';
import { batchSummary, planBatch, runBatch, type BatchProgress, type BatchResult } from '../lib/batch';
import { batchLimit } from '../lib/entitlement';
import { basename, middleEllipsis, plural } from '../lib/format';
import { applyLook, fetchCaptureImage } from '../session';
import { useModal } from './Dialog';

type Phase = 'choose' | 'running' | 'done';

/** Value of the look picker: the two built-in choices, or `look:<id>` for a saved look. */
const AUTO = 'auto';
const CURRENT = 'current';

const FORMAT_LABEL = { png: 'PNG', jpeg: 'JPEG', webp: 'WebP' } as const;
const VISIBLE_ROWS = 5;

export interface BatchDialogProps {
  /** The images the user picked or dropped. Null keeps the dialog closed. */
  files: readonly string[] | null;
  onClose: () => void;
  onReveal: (path: string) => void;
  onUpgrade: () => void;
}

/**
 * Batch beautify: one look for many images, saved next to each other in the save folder. Free runs take
 * 5 images, Pro as many as are picked (CONTRACTS 5b); the host enforces it, so it is enforced here.
 * Each image is rendered by a private editor, so the capture open in the main editor is left alone.
 */
export function BatchDialog({ files, onClose, onReveal, onUpgrade }: BatchDialogProps) {
  const { editor, settings, ent, brandMark, notify } = useApp();
  const looks = useLooks();
  const [phase, setPhase] = useState<Phase>('choose');
  const [lookChoice, setLookChoice] = useState(AUTO);
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [result, setResult] = useState<BatchResult | null>(null);
  const cancelled = useRef(false);
  const titleId = useId();
  const lookId = useId();
  const primaryRef = useRef<HTMLButtonElement>(null);

  const open = files !== null;
  const running = useRef(false);
  running.current = phase === 'running';
  // A new set of files (dropped while this was open) starts the dialog over, unless a run is in progress.
  useEffect(() => {
    if (running.current) return;
    setPhase('choose');
    setResult(null);
    setProgress(null);
  }, [files]);
  const plan = useMemo(() => planBatch(files ?? [], batchLimit(ent)), [files, ent]);
  const format = settings?.format ?? 'png';
  const canUseCurrent = editor.hasImage;

  const close = () => {
    if (phase === 'running') {
      // Escape or a click outside during a run means "stop", not "hide it and keep going".
      cancelled.current = true;
      return;
    }
    setPhase('choose');
    setResult(null);
    setProgress(null);
    setLookChoice(AUTO);
    onClose();
  };
  const ref = useModal(open, close, () => primaryRef.current);

  const chosenLook = (): LookSettings | null => {
    if (lookChoice === CURRENT) {
      const d = editor.doc;
      return { padding: d.padding, background: d.background, radius: d.radius, shadow: d.shadow, frame: d.frame, preset: d.preset, ...(d.custom ? { custom: d.custom } : {}) };
    }
    if (lookChoice.startsWith('look:')) return looks.list.find((l) => `look:${l.id}` === lookChoice)?.settings ?? null;
    return null;
  };

  const start = async () => {
    if (plan.files.length === 0) return;
    cancelled.current = false;
    setPhase('running');
    setResult(null);
    const look = chosenLook();
    const quality = settings?.quality ?? 0.92;
    // A private editor does the rendering; the one on screen keeps showing the user's own capture.
    const batchEditor = new Editor(document.createElement('div'), { licensed: ent.pro, brandMark: ent.pro ? brandMark : null });
    try {
      const outcome = await runBatch(
        plan.files,
        format,
        {
          open: async (path) => (await ipc.openFile(path)).id,
          render: async (id) => {
            const img = await fetchCaptureImage(id);
            try {
              batchEditor.load(img.source);
              if (look) {
                // An automatic background is worked out per image, from its own edges.
                applyLook(batchEditor, look.background.type === 'auto' ? { ...look, background: batchEditor.computeAutoBackground() } : look);
              }
              return await batchEditor.export({ format, quality, scale: 1, licensed: ent.pro });
            } finally {
              img.bitmap?.close();
            }
          },
          save: async (blob, name) => ipc.exportSave(await blobToBytes(blob), name),
          discard: async (id) => ipc.historyDelete(id),
        },
        { onProgress: setProgress, isCancelled: () => cancelled.current, message: (e) => errorMessage(e) },
      );
      setResult(outcome);
      setPhase('done');
    } catch (e) {
      notify({ message: errorMessage(e), tone: 'error' });
      setPhase('choose');
    } finally {
      batchEditor.destroy();
    }
  };

  if (!open) return null;

  const total = plan.files.length;
  const pct = progress && progress.total ? Math.round(((progress.index + (phase === 'done' ? 1 : 0)) / progress.total) * 100) : 0;

  return createPortal(
    <div className="pv-scrim" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className="pv-dialog pv-batch" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 className="pv-dialog-title" id={titleId}>
          Batch beautify
        </h2>

        {phase === 'choose' ? (
          <>
            {total === 0 ? (
              <p className="pv-dialog-body">None of those files are images. Choose PNG, JPEG, WebP or BMP files.</p>
            ) : (
              <>
                <p className="pv-dialog-body">
                  {plural(total, 'image')} will be saved as {FORMAT_LABEL[format]} in your save folder, with “-polished” added to each name.
                </p>
                <ul className="pv-batch-files" aria-label="Images" data-scroll={total > VISIBLE_ROWS}>
                  {plan.files.map((f) => (
                    <li key={f} title={f}>
                      <ImageIcon size={14} strokeWidth={1.5} aria-hidden="true" />
                      <span>{middleEllipsis(basename(f), 40)}</span>
                    </li>
                  ))}
                </ul>
                {plan.overLimit > 0 ? (
                  <p className="pv-batch-note" role="status">
                    Free handles {total} images per run, so {plural(plan.overLimit, 'image')} {plan.overLimit === 1 ? 'was' : 'were'} left out.{' '}
                    <button type="button" className="pv-link" onClick={onUpgrade}>
                      Pro has no limit.
                    </button>
                  </p>
                ) : null}
                {plan.ignored > 0 ? (
                  <p className="pv-batch-note">{plural(plan.ignored, 'file')} skipped: not an image, or chosen twice.</p>
                ) : null}
                <div className="pv-batch-field">
                  <label className="pe-label" htmlFor={lookId}>
                    Look
                  </label>
                  <select id={lookId} className="pe-select" value={lookChoice} onChange={(e) => setLookChoice(e.target.value)}>
                    <option value={AUTO}>Auto, balanced to each screenshot</option>
                    {canUseCurrent ? <option value={CURRENT}>The look of the open capture</option> : null}
                    {looks.list.length > 0 ? (
                      <optgroup label="Saved looks">
                        {looks.list.map((l) => (
                          <option key={l.id} value={`look:${l.id}`}>
                            {l.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null}
                  </select>
                </div>
              </>
            )}
            <div className="pv-dialog-actions">
              <button type="button" className="pe-btn" onClick={close}>
                Cancel
              </button>
              <button ref={primaryRef} type="button" className="pe-btn pe-btn-primary" disabled={total === 0} onClick={() => void start()}>
                {total > 0 ? `Beautify ${plural(total, 'image')}` : 'Beautify'}
              </button>
            </div>
          </>
        ) : null}

        {phase === 'running' ? (
          <>
            <p className="pv-dialog-body" role="status">
              {progress ? `Image ${progress.index + 1} of ${progress.total}: ${middleEllipsis(progress.name, 36)}` : 'Starting…'}
            </p>
            <div className="pv-bar" role="progressbar" aria-label="Batch progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
              <i style={{ width: `${pct}%` }} />
            </div>
            <div className="pv-dialog-actions">
              <button ref={primaryRef} type="button" className="pe-btn" onClick={close}>
                Stop after this image
              </button>
            </div>
          </>
        ) : null}

        {phase === 'done' && result ? (
          <>
            <p className="pv-dialog-body" role="status">
              {batchSummary(result, total)}
            </p>
            {result.failed.length > 0 ? (
              <ul className="pv-batch-files" aria-label="Images that could not be processed">
                {result.failed.slice(0, 3).map((f) => (
                  <li key={f.path} title={f.message}>
                    <span>
                      {middleEllipsis(basename(f.path), 30)}: {f.message}
                    </span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="pv-dialog-actions">
              {result.saved[0] ? (
                <button type="button" className="pe-btn" onClick={() => onReveal(result.saved[0]!)}>
                  Show in folder
                </button>
              ) : null}
              <button ref={primaryRef} type="button" className="pe-btn pe-btn-primary" onClick={close}>
                Done
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
