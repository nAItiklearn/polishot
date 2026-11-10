import { ArrowLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { IconButton } from './IconButton';

/** Header shared by History, Settings and License: a back button, the title, and optional controls. */
export function ViewHeader({ title, onBack, children }: { title: string; onBack: () => void; children?: ReactNode }) {
  return (
    <div className="pv-viewhead">
      <IconButton label="Back to the editor" shortcut="Esc" tipAlign="start" onClick={onBack}>
        <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
      </IconButton>
      <h1 className="pv-viewtitle">{title}</h1>
      <div className="pv-viewhead-aside">{children}</div>
    </div>
  );
}
