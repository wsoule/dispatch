// Groups the command menu's ranked rows into Linear's sectioned layout: a fixed section
// order (Inbox, Tasks, Docs, Views, Navigation, Actions) while browsing, a cap on how many rows
// each section shows, and recently-run rows floated to the top of their section while the
// query is empty. While searching, the section holding the best fuzzy hit moves first: cmdk
// re-selects the first rendered row on every search change (also under a controlled
// `value`), so rendering the best hit first is what makes Enter run it.

import type { PaletteEntry, PaletteSection } from './paletteEntries';

export interface PaletteSectionSlice<T extends PaletteEntry = PaletteEntry> {
  section: PaletteSection;
  heading: string;
  items: T[];
}

/** Sections in the order the menu lists them while browsing. */
const PALETTE_SECTION_ORDER: readonly PaletteSection[] = [
  'inbox',
  'tasks',
  'docs',
  'views',
  'navigation',
  'actions',
];

const PALETTE_SECTION_HEADINGS: Record<PaletteSection, string> = {
  inbox: 'Inbox',
  tasks: 'Tasks',
  docs: 'Docs',
  views: 'Views',
  navigation: 'Navigation',
  actions: 'Actions',
};

/** How many rows each section shows; the unbounded ones list every row they have. */
export const PALETTE_SECTION_CAPS: Record<PaletteSection, number> = {
  inbox: 3,
  tasks: 8,
  docs: 6,
  views: 4,
  navigation: Number.POSITIVE_INFINITY,
  actions: Number.POSITIVE_INFINITY,
};

/** How many recently-run ids the menu remembers. */
export const PALETTE_RECENT_LIMIT = 8;

export interface GroupPaletteSectionsOptions {
  /** The current search text; empty means "browsing", non-empty means "searching". */
  query: string;
  /** Entry ids most-recent-first, as `rememberRecent` keeps them. */
  recentIds?: readonly string[];
}

/**
 * Slices `ranked` (already in `rankPaletteItems` order) into sections. With an empty
 * query the sections come in `PALETTE_SECTION_ORDER` and recently-run rows lead their
 * section; with a query the sections are ordered by their best-ranked row (see the file
 * comment), so the menu's first row is the best fuzzy match. Each section keeps at most
 * its cap; empty sections are dropped.
 */
export function groupPaletteSections<T extends PaletteEntry>(
  ranked: readonly T[],
  { query, recentIds = [] }: GroupPaletteSectionsOptions
): PaletteSectionSlice<T>[] {
  const searching = query.trim() !== '';
  const bySection = new Map<PaletteSection, T[]>();
  const bestRank = new Map<PaletteSection, number>();
  ranked.forEach((entry, index) => {
    const bucket = bySection.get(entry.section);
    if (bucket === undefined) {
      bySection.set(entry.section, [entry]);
      bestRank.set(entry.section, index);
    } else {
      bucket.push(entry);
    }
  });

  const order = searching
    ? [...bySection.keys()].sort(
        (a, b) => (bestRank.get(a) ?? 0) - (bestRank.get(b) ?? 0)
      )
    : PALETTE_SECTION_ORDER;

  const slices: PaletteSectionSlice<T>[] = [];
  for (const section of order) {
    const bucket = bySection.get(section);
    if (bucket === undefined) continue;
    const items = searching ? bucket : floatRecent(bucket, recentIds);
    slices.push({
      section,
      heading: PALETTE_SECTION_HEADINGS[section],
      items: items.slice(0, PALETTE_SECTION_CAPS[section]),
    });
  }
  return slices;
}

/** Moves the rows whose ids are in `recentIds` to the front, most recent first; the rest
 * keep their order. */
function floatRecent<T extends PaletteEntry>(
  items: T[],
  recentIds: readonly string[]
): T[] {
  if (recentIds.length === 0) return items;
  const recent: T[] = [];
  for (const id of recentIds) {
    const hit = items.find((item) => item.id === id);
    if (hit !== undefined) recent.push(hit);
  }
  if (recent.length === 0) return items;
  const recentSet = new Set(recent.map((item) => item.id));
  return [...recent, ...items.filter((item) => !recentSet.has(item.id))];
}

/** Returns `recentIds` with `id` at the front (deduplicated) and the list trimmed to
 * `PALETTE_RECENT_LIMIT`. */
export function rememberRecent(
  recentIds: readonly string[],
  id: string
): string[] {
  return [id, ...recentIds.filter((other) => other !== id)].slice(
    0,
    PALETTE_RECENT_LIMIT
  );
}
