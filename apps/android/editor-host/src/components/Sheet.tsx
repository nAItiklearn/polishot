import { Download, EyeOff, Palette, ScanText, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type TabId = 'style' | 'redact' | 'text' | 'export';

const TABS: { id: TabId; label: string; Icon: LucideIcon }[] = [
  { id: 'style', label: 'Style', Icon: Palette },
  { id: 'redact', label: 'Redact', Icon: EyeOff },
  { id: 'text', label: 'Text', Icon: ScanText },
  { id: 'export', label: 'Export', Icon: Download },
];

export interface SheetProps {
  active: TabId | null;
  onSelect: (tab: TabId | null) => void;
  /** Panel for the active tab; only rendered while a tab is open. */
  children: ReactNode;
}

/**
 * The bottom sheet: a row of four tabs that is always visible, and a panel that opens above it. Tapping the active
 * tab (or Back on the phone) closes the panel. The sheet sits in the page layout, so opening it shrinks the canvas
 * instead of covering the screenshot.
 */
export function Sheet({ active, onSelect, children }: SheetProps) {
  return (
    <nav className="eh-sheet" data-open={active !== null} aria-label="Editor panels">
      {active !== null && (
        <div className="eh-panel" role="tabpanel" id="eh-panel" aria-labelledby={`eh-tab-${active}`}>
          {children}
        </div>
      )}
      <div className="eh-tabs" role="tablist" aria-label="Panels">
        {TABS.map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`eh-tab-${id}`}
            aria-selected={active === id}
            aria-controls="eh-panel"
            className="eh-tab"
            onClick={() => onSelect(active === id ? null : id)}
          >
            <Icon size={20} strokeWidth={1.5} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}
