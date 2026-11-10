'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@/lib/theme';
import { Button } from '@/components/ui/button';

/** Header button: flips between light and dark. The icon swap is pure CSS (no flash, no mismatch). */
export function ThemeToggle() {
  const { resolved, setPref } = useTheme();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Dark theme"
      aria-pressed={resolved === 'dark'}
      onClick={() => setPref(resolved === 'dark' ? 'light' : 'dark')}
      data-testid="theme-toggle"
    >
      <Moon className="theme-when-light" aria-hidden="true" />
      <Sun className="theme-when-dark" aria-hidden="true" />
    </Button>
  );
}

const OPTIONS = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
] as const;

/** Footer control: System, Light or Dark. "System" is the default and follows the OS. */
export function ThemeSwitch() {
  const { pref, setPref } = useTheme();
  return (
    <div role="group" aria-label="Theme" className="flex items-center gap-1 text-sm">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={pref === o.value}
          onClick={() => setPref(o.value)}
          data-testid={`theme-${o.value}`}
          className="h-9 rounded-md px-3 text-ink-3 transition-colors hover:text-ink aria-pressed:bg-surface-2 aria-pressed:text-ink"
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
