import type { TimelineView } from '@dispatch/planning';
import {
  CommandPalette as PaletteDialog,
  type PaletteItem,
  useModKeyLabel,
} from '@dispatch/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  buildJumpToItems,
  PALETTE_EMPTY_HINT,
  PALETTE_SECTION_CAPS,
  PALETTE_SECTION_ORDER,
  toPaletteItems,
} from '../../adapters/palette';
import type { NavAction } from '../../lib/appNav';
import type { PaletteEntry } from '../../lib/paletteEntries';
import { parseHref, taskHref, timelineHref } from '../../lib/routes';
import { useShellActions } from './ShellActionsContext';

// The ⌘K command menu: @dispatch/ui's CommandPalette (Gr8r's sections, ↑/↓,
// ↵, Tab, Esc, the fuzzy match over label and hint) over Dispatch's rows: the
// entries lib/paletteEntries.ts builds, the planning's "Jump to" index
// (adapters/palette.ts) and the daemon's doc hits for the typed text,
// searched after a short pause in typing and listed as matched items (the
// daemon ranked them). Each section shows a few rows before "keep typing"
// (adapters/palette.ts PALETTE_SECTION_CAPS). Every choice closes the menu
// first, then acts: an entry runs, a Jump to row's href is parsed into nav
// actions. Tab with a query hands the text to the Overseer; "?" in the
// footer opens the shortcuts sheet, which the reducer stacks over the menu.

export interface CommandPaletteProps {
  isOpen: boolean;
  entries: PaletteEntry[];
  /** The planning's timeline: its lanes and bars are the Jump to rows. Null
   * when no project is open. */
  timeline: TimelineView | null;
  /** Dispatches a nav action: closing the menu, opening the sheet, the
   * actions a Jump to row's href parses to (App's `navigate`, which gives an
   * openTask without a run the task's latest). */
  onNavigate: (action: NavAction) => void;
  /** The Docs rows for a non-empty query, searched on the daemon; omitted when
   * this caller cannot read docs. */
  searchDocs?: (query: string) => Promise<PaletteEntry[]>;
}

// How long typing must pause before the palette searches docs.
const DOC_SEARCH_DEBOUNCE_MS = 150;

/** How many recently run ids the menu remembers. */
const RECENT_LIMIT = 8;

const NO_DOC_HITS: { query: string; entries: PaletteEntry[] } = {
  query: '',
  entries: [],
};

/** `recentIds` with `id` at the front (deduplicated), trimmed to RECENT_LIMIT. */
function rememberRecent(recentIds: readonly string[], id: string): string[] {
  return [id, ...recentIds.filter((other) => other !== id)].slice(
    0,
    RECENT_LIMIT
  );
}

/**
 * The items whose ids are in `recentIds` moved to the front, most recent
 * first; the rest keep their order. The palette keeps an item's order within
 * its section while the query is empty, so a recent row leads its section.
 */
function floatRecent(
  items: PaletteItem[],
  recentIds: readonly string[]
): PaletteItem[] {
  if (recentIds.length === 0) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const recent: PaletteItem[] = [];
  for (const id of recentIds) {
    const hit = byId.get(id);
    if (hit !== undefined) recent.push(hit);
  }
  if (recent.length === 0) return items;
  const lifted = new Set(recent.map((item) => item.id));
  return [...recent, ...items.filter((item) => !lifted.has(item.id))];
}

/**
 * Mounted by App for the life of the shell, so the recently run rows (which
 * lead their section while the query is empty) survive closing; the menu
 * itself mounts while `isOpen`, so its query and doc hits start clean on
 * every open. Entries and Jump to rows are remembered (both show while the
 * query is empty, so both float); doc hits are not: they exist only for a
 * query, so a remembered hit could never lead its section and would only
 * push a row that can out of the RECENT_LIMIT.
 */
export function CommandPalette({
  isOpen,
  entries,
  timeline,
  onNavigate,
  searchDocs,
}: CommandPaletteProps) {
  // Ids of the rows run most recently, newest first. Kept for the life of
  // the shell, not persisted.
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const remember = useCallback(
    (id: string) => setRecentIds((ids) => rememberRecent(ids, id)),
    []
  );
  if (!isOpen) return null;
  return (
    <OpenPalette
      entries={entries}
      timeline={timeline}
      onNavigate={onNavigate}
      searchDocs={searchDocs}
      recentIds={recentIds}
      onRan={remember}
    />
  );
}

interface OpenPaletteProps extends Omit<CommandPaletteProps, 'isOpen'> {
  recentIds: readonly string[];
  onRan: (id: string) => void;
}

function OpenPalette({
  entries,
  timeline,
  onNavigate,
  searchDocs,
  recentIds,
  onRan,
}: OpenPaletteProps) {
  const { openOverseer } = useShellActions();
  const modLabel = useModKeyLabel();
  const [query, setQuery] = useState('');

  // The daemon's doc hits and the query they answer; they keep the daemon's
  // rank after the local rows, and hits for an earlier query are never shown
  // or run.
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

  const localItems = useMemo(
    () => floatRecent(toPaletteItems(entries, { modLabel }), recentIds),
    [entries, modLabel, recentIds]
  );
  const jumpItems = useMemo(
    () =>
      timeline === null
        ? []
        : floatRecent(
            buildJumpToItems(timeline, {
              task: taskHref,
              timeline: timelineHref,
            }),
            recentIds
          ),
    [timeline, recentIds]
  );
  const docItems = useMemo(
    () =>
      searchDocs !== undefined && docHits.query === query.trim()
        ? toPaletteItems(docHits.entries, { modLabel, matched: true })
        : [],
    [searchDocs, docHits, query, modLabel]
  );
  const items = useMemo(
    () => [...localItems, ...jumpItems, ...docItems],
    [localItems, jumpItems, docItems]
  );

  const close = useCallback(
    () => onNavigate({ type: 'closePalette' }),
    [onNavigate]
  );

  // Closes first, then acts: an entry runs itself; a Jump to row (href only)
  // dispatches its route's actions, in order. Matched rows (doc hits) are
  // not remembered: see CommandPalette.
  function run(item: PaletteItem): void {
    if (item.matched !== true) onRan(item.id);
    close();
    if (item.onSelect !== undefined) {
      item.onSelect();
      return;
    }
    if (item.href === undefined) return;
    for (const action of parseHref(item.href) ?? []) onNavigate(action);
  }

  function askAgent(text: string): void {
    close();
    openOverseer(text);
  }

  return (
    <PaletteDialog
      items={items}
      onClose={close}
      onRun={run}
      onQueryChange={setQuery}
      onSubmitFreeText={askAgent}
      freeTextLabel="Ask your agent"
      onShowShortcuts={() => onNavigate({ type: 'openShortcuts' })}
      placeholder="Type a command or search…"
      sectionOrder={PALETTE_SECTION_ORDER}
      maxPerSection={PALETTE_SECTION_CAPS}
      emptyHint={PALETTE_EMPTY_HINT}
    />
  );
}
