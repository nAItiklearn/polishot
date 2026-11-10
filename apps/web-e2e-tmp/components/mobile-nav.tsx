'use client';

import { useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import { Menu } from 'lucide-react';
import { Button } from '@/components/ui/button';

// The menu (and Radix Dialog behind it) is fetched on first use, keeping it off the critical path.
const loadSheet = () => import('./mobile-sheet');
const MobileSheet = dynamic(loadSheet, { ssr: false });

export function MobileNav() {
  const [open, setOpen] = useState(false);
  const [used, setUsed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);

  return (
    <>
      <Button
        ref={trigger}
        type="button"
        variant="ghost"
        size="icon"
        className="md:hidden"
        aria-label="Open menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        onPointerDown={() => void loadSheet()}
        onFocus={() => void loadSheet()}
        onClick={() => {
          setUsed(true);
          setOpen(true);
        }}
      >
        <Menu aria-hidden="true" />
      </Button>
      {used ? <MobileSheet open={open} onOpenChange={setOpen} returnFocusTo={trigger} /> : null}
    </>
  );
}
