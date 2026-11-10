import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Editor } from '../editor';

/**
 * Subscribes a component to an editor. The returned number changes on every document, selection, tool or
 * view update, so reading `editor.doc` etc. during render is always current.
 */
export function useEditorVersion(editor: Editor): number {
  const subscribe = useCallback(
    (cb: () => void) => {
      const offs = [editor.on('change', cb), editor.on('select', cb), editor.on('tool', cb), editor.on('view', cb)];
      return () => offs.forEach((off) => off());
    },
    [editor],
  );
  return useSyncExternalStore(
    subscribe,
    () => editor.version,
    () => 0,
  );
}

/** Routes keyboard shortcuts from the whole document (outside inputs) to the editor. */
export function useEditorShortcuts(editor: Editor | null | undefined, enabled = true): void {
  useEffect(() => {
    if (!editor || !enabled) return;
    const onKey = (e: KeyboardEvent) => {
      editor.handleKey(e);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [editor, enabled]);
}
