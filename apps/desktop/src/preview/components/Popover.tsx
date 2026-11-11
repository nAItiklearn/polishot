import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export interface PopoverProps {
  open: boolean;
  onClose: () => void;
  /** The button that opened it; the menu hangs below it and focus returns to it on close. */
  anchor: RefObject<HTMLElement | null>;
  /** Accessible name of the menu. */
  label: string;
  align?: 'start' | 'end';
  children: ReactNode;
}

const ITEM = '[role="menuitem"]:not(:disabled):not([aria-disabled="true"])';

/**
 * A small menu anchored under a button. Arrow keys move between items, Home/End jump, Escape or a click
 * outside closes it, Tab leaves it. It marks itself `data-owns-keyboard` so the app's own shortcuts
 * (Esc hides the window) stay out of the way while it is open.
 */
export function Popover({ open, onClose, anchor, label, align = 'end', children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [pos, setPos] = useState<CSSProperties>({ visibility: 'hidden' });

  // Place it before paint so it never flashes in the wrong spot.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      if (!a) return;
      setPos(align === 'end' ? { top: a.bottom + 6, right: Math.max(8, window.innerWidth - a.right) } : { top: a.bottom + 6, left: Math.max(8, a.left) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchor, align]);

  useEffect(() => {
    if (!open) return;
    const opener = anchor.current;
    const raf = requestAnimationFrame(() => ref.current?.querySelector<HTMLElement>(ITEM)?.focus());
    const items = () => [...(ref.current?.querySelectorAll<HTMLElement>(ITEM) ?? [])];
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        closeRef.current();
        return;
      }
      if (e.key === 'Tab') {
        closeRef.current();
        return;
      }
      const list = items();
      if (list.length === 0) return;
      const i = list.indexOf(document.activeElement as HTMLElement);
      let next = -1;
      if (e.key === 'ArrowDown') next = (i + 1) % list.length;
      else if (e.key === 'ArrowUp') next = (i - 1 + list.length) % list.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = list.length - 1;
      if (next < 0) return;
      e.preventDefault();
      e.stopPropagation();
      list[next]?.focus();
    };
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (ref.current?.contains(t) || opener?.contains(t))) return;
      closeRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', onPointer, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', onPointer, true);
      // Hand focus back, unless the user already moved on to something else.
      const active = document.activeElement;
      if (!active || active === document.body || ref.current?.contains(active)) opener?.focus?.();
    };
  }, [open, anchor]);

  if (!open) return null;
  return createPortal(
    <div ref={ref} className="pv-menu" role="menu" aria-label={label} style={pos} data-owns-keyboard="">
      {children}
    </div>,
    document.body,
  );
}
