'use client';

import type { RefObject } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { APP_NAME } from '@polishot/brand';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Wordmark } from '@/components/logo';
import { FOOTER_LINKS, MOBILE_NAV } from '@/lib/site';

interface MobileSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The menu button; focus goes back to it when the menu closes. */
  returnFocusTo: RefObject<HTMLButtonElement | null>;
}

/**
 * The full-screen menu. It lives in its own module so the dialog code (Radix) is only downloaded when
 * someone opens the menu, not on every page load. Radix handles the focus trap and Escape.
 */
export default function MobileSheet({ open, onOpenChange, returnFocusTo }: MobileSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        data-theme="dark"
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          returnFocusTo.current?.focus();
        }}
      >
        <SheetTitle className="sr-only">Menu</SheetTitle>
        <SheetDescription className="sr-only">Site navigation</SheetDescription>
        <div className="container-page flex h-16 items-center justify-between border-b border-line">
          <SheetClose asChild>
            <Link href="/" aria-label={`${APP_NAME}, home`}>
              <Wordmark />
            </Link>
          </SheetClose>
          <SheetClose asChild>
            <Button type="button" variant="ghost" size="icon" aria-label="Close menu">
              <X aria-hidden="true" />
            </Button>
          </SheetClose>
        </div>
        <nav aria-label="Mobile" className="container-page flex-1 overflow-y-auto py-6">
          <ul>
            {MOBILE_NAV.map((item, i) => (
              <li
                key={item.href}
                className="sheet-item border-b border-line"
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <SheetClose asChild>
                  <Link href={item.href} className="display-3 block py-5 text-ink">
                    {item.label}
                  </Link>
                </SheetClose>
              </li>
            ))}
          </ul>
        </nav>
        <div className="container-page flex gap-6 border-t border-line py-5 text-sm text-ink-2">
          {FOOTER_LINKS.legal.map((item) => (
            <SheetClose asChild key={item.href}>
              <Link href={item.href} className="inline-flex h-10 items-center">
                {item.label}
              </Link>
            </SheetClose>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
