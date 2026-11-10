import { useEffect, useId, useRef, useState } from 'react';
import {
  acceleratorFromEvent,
  heldModifiers,
  isModifierKey,
  normalizeAccelerator,
  validateAccelerator,
} from '../lib/shortcuts';
import { Keys, Kbd } from './Keys';

export interface ShortcutRecorderProps {
  /** Name of the action, for the accessible label ("Capture shortcut"). */
  label: string;
  /** Current accelerator (empty = none). */
  value: string;
  /** Optional shortcuts may be cleared with Backspace or Delete. */
  optional?: boolean;
  /** Persist the new value. Resolve to an error message (a conflict, say) or null on success. */
  onCommit: (accelerator: string) => Promise<string | null>;
  /** Shown under the control, e.g. a conflict found when the app started. */
  notice?: string | null;
}

/**
 * Click, press the combination, done. Escape cancels. The value is checked locally with the same rules
 * the backend uses, then saved; whatever the backend says (for example "already in use by another
 * application") is shown right under the control and the previous shortcut stays active.
 */
export function ShortcutRecorder({ label, value, optional, onCommit, notice }: ShortcutRecorderProps) {
  const [recording, setRecording] = useState(false);
  const [held, setHeld] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const errId = useId();
  const commitRef = useRef(onCommit);
  commitRef.current = onCommit;

  useEffect(() => {
    if (!recording) return;
    // Tells the app-wide key handler to stand down while a shortcut is being recorded.
    document.body.dataset.recordingShortcut = '1';
    const stop = () => {
      setRecording(false);
      setHeld([]);
    };

    const onKeyDown = (e: KeyboardEvent) => {
      // While recording, every key belongs to the recorder, including the ones the app would use.
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.repeat) return;
      if (isModifierKey(e)) {
        setHeld(heldModifiers(e));
        return;
      }
      if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        stop();
        return;
      }
      if ((e.key === 'Backspace' || e.key === 'Delete') && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
        if (optional) {
          stop();
          setSaving(true);
          void commitRef.current('').then((err) => {
            setError(err);
            setSaving(false);
          });
        } else {
          setError('This shortcut is required. Press a new combination instead.');
        }
        return;
      }
      const acc = acceleratorFromEvent(e);
      if (!acc) {
        setError('That key cannot be used in a shortcut.');
        return;
      }
      const problem = validateAccelerator(acc);
      if (problem) {
        setError(problem);
        return;
      }
      const normal = normalizeAccelerator(acc) ?? acc;
      stop();
      if (normal === normalizeAccelerator(value)) {
        setError(null);
        return;
      }
      setSaving(true);
      void commitRef.current(normal).then((err) => {
        setError(err);
        setSaving(false);
      });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (isModifierKey(e)) setHeld(heldModifiers(e));
    };
    const onBlur = () => stop();

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      delete document.body.dataset.recordingShortcut;
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [recording, optional, value]);

  const shownError = error ?? notice ?? null;

  return (
    <div className="pv-recorder">
      <button
        ref={buttonRef}
        type="button"
        className="pv-recorder-btn"
        data-recording={recording}
        aria-label={`${label}: ${value ? value.replace(/\+/g, ' plus ') : 'none'}. Activate to change.`}
        aria-describedby={shownError ? errId : undefined}
        disabled={saving}
        onClick={() => {
          setError(null);
          setRecording((r) => !r);
        }}
        onBlur={() => setRecording(false)}
      >
        {recording ? (
          <span className="pv-recorder-live">
            {held.length > 0 ? (
              <>
                {held.map((h) => (
                  <Kbd key={h}>{h}</Kbd>
                ))}
                <span className="pv-recorder-plus">+</span>
              </>
            ) : null}
            <span className="pv-recorder-prompt">{held.length > 0 ? 'press a key' : 'Press the new shortcut'}</span>
          </span>
        ) : value ? (
          <Keys accelerator={value} />
        ) : (
          <span className="pv-recorder-none">Not set</span>
        )}
      </button>
      <div className="pv-recorder-msg" id={errId} role={error ? 'alert' : undefined}>
        {shownError}
      </div>
    </div>
  );
}
