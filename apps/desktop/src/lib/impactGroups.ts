// Mirrors `ImpactEntry` in @dispatch/client (one file reachable from a
// subject's seed set, at its closest hop distance) — named for the server's
// `BlastEntry` since that's the concept `ImpactView` groups and filters.
export interface BlastEntry {
  path: string;
  hops: number;
}

export interface HopGroup {
  hops: number;
  paths: string[];
}

/** Buckets entries by hop distance, closest first, so `ImpactView` can render
 *  direct dependents ahead of everything further out. Each bucket keeps
 *  entries in their original (already hop-shortest) order. */
export function groupByHop(entries: BlastEntry[]): HopGroup[] {
  const byHop = new Map<number, string[]>();
  for (const entry of entries) {
    const paths = byHop.get(entry.hops);
    if (paths === undefined) byHop.set(entry.hops, [entry.path]);
    else paths.push(entry.path);
  }
  return [...byHop.entries()]
    .sort(([a], [b]) => a - b)
    .map(([hops, paths]) => ({ hops, paths }));
}

/** Case-insensitive substring match against the full path — matches a
 *  directory segment or a bare filename equally. An empty filter is "show
 *  everything" rather than "show nothing", since a blank input is the
 *  unfiltered state, not a filter that excludes every path. */
export function filterByPath(
  entries: BlastEntry[],
  filter: string
): BlastEntry[] {
  const needle = filter.trim().toLowerCase();
  if (needle === '') return entries;
  return entries.filter((entry) => entry.path.toLowerCase().includes(needle));
}
