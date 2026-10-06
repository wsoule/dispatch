import {
  ArrowRightIcon,
  BookTextIcon,
  CircleDashedIcon,
  InboxIcon,
  LayersIcon,
  PlayIcon,
  ZapIcon,
} from 'lucide-react';
import type { KeyboardEvent, ReactNode } from 'react';
import { useEffect, useMemo, useState } from 'react';

import type { PaletteEntry } from '../../lib/paletteEntries';
import { rankPaletteItems } from '../../lib/paletteMatch';
import {
  groupPaletteSections,
  rememberRecent,
} from '../../lib/paletteSections';
import { useShellActions } from './ShellActionsContext';
import { EmptyState } from '@/ui/chrome/empty-state';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/ui/command';
import { Dialog, DialogContent, DialogTitle } from '@/ui/dialog';
import { Kbd } from '@/ui/kbd';

interface CommandPaletteProps {
  isOpen: boolean;
  entries: PaletteEntry[];
  onClose: () => void;
  /** The Docs rows for a non-empty query, searched on the daemon; omitted when
   * this caller cannot read docs. */
  searchDocs?: (query: string) => Promise<PaletteEntry[]>;
  /** Two views: Tab hands the query to "your agent", not the Assistant. */
  twoViews?: boolean;
}

// How long typing must pause before the palette searches docs.
const DOC_SEARCH_DEBOUNCE_MS = 150;

const NO_DOC_HITS: { query: string; entries: PaletteEntry[] } = {
  query: '',
  entries: [],
};

/** The 14px glyph a row shows when its entry brings none: one per section, with the
 * "Dispatch …" task rows (`dispatch-<task id>` in `buildPaletteEntries`) getting a play
 * glyph so they read as verbs. */
function defaultIcon(entry: PaletteEntry): ReactNode {
  if (entry.id.startsWith('dispatch-')) return <PlayIcon />;
  switch (entry.section) {
    case 'inbox':
      return <InboxIcon />;
    case 'tasks':
      return <CircleDashedIcon />;
    case 'docs':
      return <BookTextIcon />;
    case 'views':
      return <LayersIcon />;
    case 'navigation':
      return <ArrowRightIcon />;
    case 'actions':
      return <ZapIcon />;
  }
}

/**
 * The ⌘K command menu: a 720×450 dialog pinned 121px from the top, fuzzy-matching task
 * ids/titles and app actions against one query (docs are searched on the daemon, after
 * a short pause in typing) and listing the hits in Linear's sections
 * (Inbox, Tasks, Docs, Views, Navigation, Actions) with per-section caps from
 * `lib/paletteSections`. Ranking stays `rankPaletteItems` (cmdk's own filtering is off,
 * `shouldFilter={false}`); cmdk owns arrow-key selection, wraparound and Enter; `Dialog`
 * owns the backdrop, focus trap and Escape, which reaches `onClose` once through
 * `onOpenChange`. `Tab` with a non-empty query hands the text to the Overseer instead of
 * running a row. A long title truncates; the task id and keycaps keep their width.
 */
export function CommandPalette({
  isOpen,
  entries,
  onClose,
  searchDocs,
  twoViews = false,
}: CommandPaletteProps) {
  const agent = twoViews ? 'your agent' : 'the Assistant';
  const { openOverseer } = useShellActions();
  const [query, setQuery] = useState('');
  // Ids of the rows run most recently, newest first; they lead their section while the
  // query is empty. Kept for the life of the shell, not persisted.
  const [recentIds, setRecentIds] = useState<string[]>([]);

  // Reset to a clean search every time the palette closes, so reopening it never shows a
  // stale filter from the last time it was used.
  useEffect(() => {
    if (!isOpen) setQuery('');
  }, [isOpen]);

  // The daemon's doc hits and the query they answer; they keep their own rank
  // after the local rows, and hits for an earlier query are never shown or run.
  const [docHits, setDocHits] = useState(NO_DOC_HITS);
  useEffect(() => {
    const q = query.trim();
    if (searchDocs === undefined || q === '') return;
    let live = true;
    const timer = setTimeout(() => {
      const show = (found: PaletteEntry[]): void => {
        if (live) setDocHits({ query: q, entries: found });
      };
      searchDocs(q).then(show, () => show([]));
    }, DOC_SEARCH_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [query, searchDocs]);
  const docEntries =
    searchDocs !== undefined && docHits.query === query.trim()
      ? docHits.entries
      : NO_DOC_HITS.entries;

  const sections = useMemo(
    () =>
      groupPaletteSections(
        [...rankPaletteItems(entries, query), ...docEntries],
        { query, recentIds }
      ),
    [entries, docEntries, query, recentIds]
  );

  function runEntry(entry: PaletteEntry) {
    setRecentIds((ids) => rememberRecent(ids, entry.id));
    onClose();
    entry.run();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Tab' || event.shiftKey) return;
    const prompt = query.trim();
    if (prompt === '') return;
    event.preventDefault();
    onClose();
    openOverseer(prompt);
  }

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="rounded-popover top-[121px] h-[450px] max-h-[calc(100vh-121px-2rem)] w-[720px] max-w-[calc(100vw-2rem)] translate-y-0 overflow-hidden sm:max-w-[calc(100vw-2rem)]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">Command menu</DialogTitle>
        <Command shouldFilter={false} onKeyDown={handleKeyDown}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command or search…"
            hint={
              <>
                <span>{twoViews ? 'Ask your agent' : 'Ask the Assistant'}</span>
                <Kbd>Tab</Kbd>
              </>
            }
          />
          <CommandList className="max-h-none flex-1">
            <CommandEmpty className="p-0">
              <EmptyState
                heading="No results"
                description={`Try another task id or title, or press Tab to ask ${agent}.`}
                className="py-6"
              />
            </CommandEmpty>
            {sections.map((slice) => (
              <CommandGroup key={slice.section} heading={slice.heading}>
                {slice.items.map((entry) => (
                  <CommandItem
                    key={entry.id}
                    value={entry.id}
                    onSelect={() => runEntry(entry)}
                  >
                    {entry.icon ?? defaultIcon(entry)}
                    <span className="min-w-0 truncate">{entry.label}</span>
                    {entry.sublabel !== undefined && (
                      <span className="text-muted-foreground shrink-0">
                        {entry.sublabel}
                      </span>
                    )}
                    {entry.shortcut !== undefined && (
                      <CommandShortcut>{entry.shortcut}</CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
