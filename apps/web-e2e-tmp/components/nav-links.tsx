'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils';
import { NAV } from '@/lib/site';

/** Desktop navigation. Marks the current page with aria-current. */
export function NavLinks({ className }: { className?: string }) {
  const pathname = usePathname();
  return (
    <ul className={cn('flex items-center gap-1', className)}>
      {NAV.map((item) => {
        const current = pathname === item.href;
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={current ? 'page' : undefined}
              className={cn(
                'inline-flex h-10 items-center rounded-md px-3 text-[15px] transition-colors',
                current ? 'text-ink' : 'text-ink-2 hover:text-ink',
              )}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
