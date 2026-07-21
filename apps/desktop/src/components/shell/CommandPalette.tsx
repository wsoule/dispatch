import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { PaletteItem } from '../../lib/paletteMatch';
import { rankPaletteItems } from '../../lib/paletteMatch';
import { cn } from '@/lib/utils';

export interface PaletteEntry extends PaletteItem {
  /** A short tag shown at the entry's right edge — "task", "go to", "action" — so the fuzzy
   * list stays scannable once tasks and view-switch actions are mixed together. */
  kind: string;
  run: () => void;
}

interface CommandPaletteProps {
  isOpen: boolean;
  entries: PaletteEntry[];
  onClose: () => void;
}

/**
 * The Linear-signature ⌘K palette: fuzzy-matches task ids/titles and app actions ("Dispatch
 * <task>", "New task", every view switch) against a single query. Arrow keys (not j/k — the
 * input itself is a text field, and "j"/"k" are real letters someone might type into a
 * search box) move the highlighted row and keep it scrolled into view; Enter runs it;
 * Escape closes via the caller's `onClose` (also wired through the app-level `navReducer`'s
 * `escape` action). `useFocusTrap` handles focusing the input on open, trapping Tab inside
 * the panel, and restoring whatever had focus before the palette opened once it closes (I7).
 *
 * Styling is hand-rolled Tailwind (not shadcn's `cmdk`-based `command` primitive) so this
 * keeps its existing fuzzy-match/keyboard-nav logic byte-for-byte — only the presentation
 * layer changed.
 */
export function CommandPalette({
  isOpen,
  entries,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [highlighted, setHighlighted] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  useFocusTrap(panelRef, isOpen);

  const ranked = useMemo(
    () => rankPaletteItems(entries, query),
    [entries, query]
  );

  // Reset to a clean search every time the palette opens — focusing the input itself is
  // `useFocusTrap`'s job now (the input is the panel's first focusable element).
  useEffect(() => {
    if (isOpen) {
      setQuery('');
      setHighlighted(0);
    }
  }, [isOpen]);

  useEffect(() => {
    setHighlighted(0);
  }, [query]);

  // Keeps the highlighted row visible as ArrowUp/ArrowDown moves it, same treatment as
  // TasksListView's row list.
  useEffect(() => {
    resultsRef.current?.children[highlighted]?.scrollIntoView({
      block: 'nearest',
    });
  }, [highlighted]);

  if (!isOpen) return null;

  function runHighlighted() {
    const entry = ranked[highlighted];
    if (entry !== undefined) {
      entry.run();
      onClose();
    }
  }

  return (
    <div
      className="animate-in fade-in-0 fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh] duration-150"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        className="border-border bg-popover animate-in fade-in-0 zoom-in-95 flex max-h-[60vh] w-[min(34rem,90vw)] flex-col overflow-hidden rounded-lg border shadow-lg duration-150"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Command palette"
      >
        <div className="border-border flex items-center gap-2 border-b px-3">
          <Search className="text-muted-foreground size-4 shrink-0" />
          <input
            className="text-foreground placeholder:text-muted-foreground w-full bg-transparent py-3 text-[13px] outline-none"
            placeholder="Jump to a task, dispatch work, or switch views…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setHighlighted((h) => Math.min(h + 1, ranked.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setHighlighted((h) => Math.max(h - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                runHighlighted();
              }
            }}
          />
        </div>
        <div className="overflow-y-auto p-1.5" ref={resultsRef}>
          {ranked.length === 0 && (
            <div className="text-muted-foreground px-3 py-6 text-center text-[13px]">
              No matches.
            </div>
          )}
          {ranked.map((entry, i) => (
            <button
              key={entry.id}
              type="button"
              className={cn(
                'flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[13px] text-foreground',
                i === highlighted && 'bg-accent text-accent-foreground'
              )}
              onMouseEnter={() => setHighlighted(i)}
              onClick={() => {
                entry.run();
                onClose();
              }}
            >
              <span className="truncate">{entry.label}</span>
              {entry.sublabel !== undefined && (
                <span className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-[11px]">
                  {entry.sublabel}
                </span>
              )}
              <span className="text-muted-foreground shrink-0 text-[11px]">
                {entry.kind}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
