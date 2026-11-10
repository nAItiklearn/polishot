import {
  Brush,
  Circle,
  Droplet,
  ListOrdered,
  Minus,
  MousePointer2,
  MoveUpRight,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { Editor } from '../editor';
import { TOOL_LABEL, TOOL_SHORTCUT } from '../shortcuts';
import type { Tool } from '../types';
import { useEditorVersion } from './hooks';
import { IconButton } from './ui';

const ICON = { size: 16, strokeWidth: 1.5, 'aria-hidden': true } as const;

const TOOL_ICONS: Record<Tool, ReactNode> = {
  select: <MousePointer2 {...ICON} />,
  arrow: <MoveUpRight {...ICON} />,
  rect: <Square {...ICON} />,
  ellipse: <Circle {...ICON} />,
  line: <Minus {...ICON} />,
  text: <Type {...ICON} />,
  blur: <Droplet {...ICON} />,
  step: <ListOrdered {...ICON} />,
  'redact-brush': <Brush {...ICON} />,
};

const GROUPS: Tool[][] = [['select'], ['arrow', 'line', 'rect', 'ellipse'], ['text', 'step'], ['blur', 'redact-brush']];

export interface ToolbarProps {
  editor: Editor;
  className?: string;
  /** Where tooltips open. Default "top" (toolbar at the bottom of the canvas). */
  tipSide?: 'top' | 'bottom';
}

/** Quiet floating pill of tool buttons plus undo, redo and delete. Rendered inside EditorCanvas it floats. */
export function Toolbar({ editor, className, tipSide = 'top' }: ToolbarProps) {
  useEditorVersion(editor);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(e.key)) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next =
      e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div
      className={`pe-toolbar ${className ?? ''}`}
      role="toolbar"
      aria-label="Annotation tools"
      aria-orientation="horizontal"
      onKeyDown={onKeyDown}
    >
      {GROUPS.map((group, gi) => (
        <div className="pe-toolgroup" key={gi} role="group">
          {group.map((t) => (
            <IconButton
              key={t}
              label={TOOL_LABEL[t]}
              shortcut={TOOL_SHORTCUT[t]}
              pressed={editor.tool === t}
              tipSide={tipSide}
              onClick={() => editor.setTool(t)}
            >
              {TOOL_ICONS[t]}
            </IconButton>
          ))}
        </div>
      ))}
      <span className="pe-sep" role="separator" aria-orientation="vertical" />
      <div className="pe-toolgroup" role="group">
        <IconButton label="Undo" shortcut="Ctrl Z" disabled={!editor.canUndo()} tipSide={tipSide} onClick={() => editor.undo()}>
          <Undo2 {...ICON} />
        </IconButton>
        <IconButton label="Redo" shortcut="Ctrl Shift Z" disabled={!editor.canRedo()} tipSide={tipSide} onClick={() => editor.redo()}>
          <Redo2 {...ICON} />
        </IconButton>
        <IconButton
          label="Delete selection"
          shortcut="Del"
          disabled={editor.selectedId === null}
          tipSide={tipSide}
          onClick={() => editor.deleteSelection()}
        >
          <Trash2 {...ICON} />
        </IconButton>
      </div>
    </div>
  );
}
