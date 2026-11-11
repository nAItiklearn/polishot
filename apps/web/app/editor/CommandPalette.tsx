'use client';

/**
 * Ctrl+K: every action in the editor, with its shortcut, in one searchable list (docs/UX-BAR.md, "Keyboard
 * first"). Type to filter, arrows to move, Enter to run, Esc to close. It is a Radix dialog, so focus is
 * trapped while it is open and returns to where it was when it closes.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Search } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';

export interface Command {
  id: string;
  label: string;
  /** Extra words that should also find this command. */
  keywords?: string;
  /** Written with "Ctrl" and "+", for example "Ctrl+Shift+Z". Shown as key caps. */
  shortcut?: string;
  run: () => void;
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

/** "Ctrl" is written for Windows and Linux; on a Mac the same keys are Command. */
function keyCaps(shortcut: string): string[] {
  const mac = isMac();
  return shortcut.split('+').map((k) => (mac && k === 'Ctrl' ? '⌘' : k));
}

/** Every word typed must appear in the label or keywords; labels that start with the text come first. */
export function filterCommands(commands: readonly Command[], query: string): Command[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...commands];
  const first = words[0]!;
  return commands
    .map((c, order) => ({ c, order, hay: `${c.label} ${c.keywords ?? ''}`.toLowerCase() }))
    .filter(({ hay }) => words.every((w) => hay.includes(w)))
    .sort((a, b) => {
      const sa = a.c.label.toLowerCase().startsWith(first) ? 0 : 1;
      const sb = b.c.label.toLowerCase().startsWith(first) ? 0 : 1;
      return sa - sb || a.order - b.order;
    })
    .map(({ c }) => c);
}

interface PaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commands: readonly Command[];
}

export function CommandPalette({ open, onOpenChange, commands }: PaletteProps) {
  const pending = useRef<Command | null>(null);
  const returnTo = useRef<HTMLElement | null>(null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="ed-palette-overlay" />
        <Dialog.Content
          className="ed-palette"
          aria-describedby={undefined}
          onOpenAutoFocus={() => {
            // Radix only restores focus to a Dialog.Trigger, and this palette opens from the keyboard, so
            // remember where the person was.
            returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          }}
          onCloseAutoFocus={() => {
            const back = returnTo.current;
            returnTo.current = null;
            if (back?.isConnected && back !== document.body) back.focus({ preventScroll: true });
            // Run the chosen command once the dialog has gone and focus is back where it was, so a command
            // that moves focus or opens the file picker is not undone by the focus restore.
            const chosen = pending.current;
            pending.current = null;
            if (chosen) window.setTimeout(chosen.run, 0);
          }}
        >
          <Dialog.Title className="sr-only">Command palette</Dialog.Title>
          <Body
            commands={commands}
            onChoose={(c) => {
              pending.current = c;
              onOpenChange(false);
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({ commands, onChoose }: { commands: readonly Command[]; onChoose: (c: Command) => void }) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(() => filterCommands(commands, query), [commands, query]);
  const index = results.length === 0 ? -1 : Math.min(active, results.length - 1);
  const optionId = (i: number) => `${listId}-${results[i]?.id ?? i}`;

  useEffect(() => {
    if (index < 0) return;
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [index, results]);

  const move = (delta: number) => setActive((i) => (results.length === 0 ? 0 : (Math.min(i, results.length - 1) + delta + results.length) % results.length));

  return (
    <>
      <div className="ed-palette-search">
        <Search size={16} strokeWidth={1.5} aria-hidden="true" />
        <input
          className="ed-palette-input"
          type="text"
          role="combobox"
          aria-label="Search commands"
          aria-expanded={results.length > 0}
          aria-controls={results.length > 0 ? listId : undefined}
          aria-activedescendant={index >= 0 ? optionId(index) : undefined}
          aria-autocomplete="list"
          placeholder="Type a command"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          value={query}
          onChange={(e) => {
            setQuery(e.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const chosen = results[index];
              if (chosen) onChoose(chosen);
            }
          }}
        />
      </div>

      {results.length > 0 ? (
        <ul className="ed-palette-list" id={listId} role="listbox" aria-label="Commands" ref={listRef}>
          {results.map((c, i) => (
            <li
              key={c.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === index}
              aria-keyshortcuts={c.shortcut?.replace('Ctrl', 'Control')}
              className="ed-palette-option"
              onPointerMove={() => i !== index && setActive(i)}
              onClick={() => onChoose(c)}
            >
              <span className="ed-palette-label">{c.label}</span>
              {c.shortcut && (
                <span className="ed-keys" aria-hidden="true">
                  {keyCaps(c.shortcut).map((k, n) => (
                    <kbd key={n} className="ed-key">
                      {k}
                    </kbd>
                  ))}
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="ed-palette-empty" role="status">
          No command matches &ldquo;{query.trim()}&rdquo;.
        </p>
      )}
    </>
  );
}
