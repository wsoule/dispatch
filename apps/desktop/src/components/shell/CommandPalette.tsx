import { SearchIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type { PaletteItem } from '../../lib/paletteMatch';
import { rankPaletteItems } from '../../lib/paletteMatch';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';

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
 * <task>", "New task", every view switch) against a single query. Ranking stays
 * `rankPaletteItems` (cmdk's own filtering is off, `shouldFilter={false}`) so the fuzzy-match
 * scoring this app ships is the only ranking that ever runs. cmdk itself now owns arrow-key
 * selection, wraparound, and Enter; `Dialog` (Radix) owns the backdrop, focus trap/restore,
 * and Escape — Escape reaches `onClose` once, through `Dialog`'s `onOpenChange`, and the
 * app-level `navReducer` closes the palette via the same `onClose` callback rather than a
 * second Escape listener (see `useGlobalKeyboard`'s `isAnyModalOpen`, which now recognizes
 * this dialog like every other one and steps aside while it's open).
 */
export function CommandPalette({
  isOpen,
  entries,
  onClose,
}: CommandPaletteProps) {
  const [query, setQuery] = useState('');

  // Reset to a clean search every time the palette closes, so reopening it never shows a
  // stale filter from the last time it was used.
  useEffect(() => {
    if (!isOpen) setQuery('');
  }, [isOpen]);

  const ranked = useMemo(
    () => rankPaletteItems(entries, query),
    [entries, query]
  );

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="bg-popover rounded-card shadow-overlay top-24 flex max-h-[60vh] w-[min(34rem,90vw)] max-w-none translate-y-0 flex-col gap-0 overflow-hidden p-0 duration-150 sm:max-w-none"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Jump to a task, dispatch work, or switch views…"
          />
          <CommandList className="max-h-none">
            <CommandEmpty>
              <span
                aria-hidden
                className="bg-surface-inset text-muted-foreground shadow-hairline rounded-control flex size-8 items-center justify-center"
              >
                <SearchIcon className="size-3.5" />
              </span>
              <span>No matches.</span>
            </CommandEmpty>
            {ranked.map((entry) => (
              <CommandItem
                key={entry.id}
                value={entry.id}
                onSelect={() => {
                  onClose();
                  entry.run();
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
              </CommandItem>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
