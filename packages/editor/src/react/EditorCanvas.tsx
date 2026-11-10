import { useLayoutEffect, useRef, type ReactNode } from 'react';
import type { Editor, ViewInsets } from '../editor';

export interface EditorCanvasProps {
  editor: Editor;
  className?: string;
  /** Space kept free around the canvas. Defaults leave room for the floating Toolbar at the bottom. */
  insets?: Partial<ViewInsets>;
  /** Overlays rendered above the canvas: the floating Toolbar, a TextLayer, status chips. */
  children?: ReactNode;
}

/**
 * Mounts the editor's canvas. The editor is created by the host (`new Editor(document.createElement('div'),
 * { licensed })`) and keeps living when this component re-mounts; the canvas element is simply moved in.
 */
export function EditorCanvas({ editor, className, children, insets }: EditorCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    el.appendChild(editor.element);
    return () => {
      if (editor.element.parentElement === el) el.removeChild(editor.element);
    };
  }, [editor]);
  const { top, right, bottom, left } = { top: 24, right: 24, bottom: 80, left: 24, ...insets };
  useLayoutEffect(() => {
    editor.setInsets({ top, right, bottom, left });
  }, [editor, top, right, bottom, left]);
  return (
    <div className={`pe-canvas ${className ?? ''}`}>
      <div className="pe-canvas-host" ref={host} />
      {children}
    </div>
  );
}
