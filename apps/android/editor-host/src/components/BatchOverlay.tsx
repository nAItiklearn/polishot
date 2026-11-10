import { APP_NAME } from '@polishot/brand';

export interface BatchOverlayProps {
  processed: number;
  total: number;
  failed: number;
}

/** Full-screen, calm progress while a batch run works through the shared images. */
export function BatchOverlay({ processed, total, failed }: BatchOverlayProps) {
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;
  return (
    <div className="eh-batch" role="status" aria-live="polite">
      <div className="eh-batch-card">
        <p className="eh-batch-title">
          {processed >= total ? 'Finishing up' : `Beautifying ${Math.min(processed + 1, total)} of ${total}`}
        </p>
        <div className="eh-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
          <div className="eh-progress-fill" style={{ width: `${percent}%` }} />
        </div>
        <p className="eh-batch-hint">
          Using your last look. Results are saved to Pictures/{APP_NAME}.
          {failed > 0 ? ` ${failed} could not be processed.` : ''}
        </p>
      </div>
    </div>
  );
}
