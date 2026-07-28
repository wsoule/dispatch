import { Search } from 'lucide-react';

import type { FeedState } from '@/lib/feedState';

interface FeedFilterBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  activeStates: ReadonlySet<FeedState>;
  /** Clears every state filter — the ribbon toggles them one at a time. */
  onClearStates: () => void;
  shown: number;
  total: number;
  allCollapsed: boolean;
  onToggleCollapseAll: () => void;
}

/**
 * Query, status chips, and the shown/total readout.
 *
 * The readout is the load-bearing part rather than decoration: the feed caps each group, so
 * without a count of what is being held back, a capped feed silently lies about how much work
 * exists. The chips share their selection with the ribbon above — one piece of state, two
 * controls, so they can't disagree.
 */
export function FeedFilterBar({
  query,
  onQueryChange,
  activeStates,
  onClearStates,
  shown,
  total,
  allCollapsed,
  onToggleCollapseAll,
}: FeedFilterBarProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="shadow-hairline flex w-64 items-center gap-2 rounded-md px-2.5">
        <Search className="text-muted-foreground size-3.5 shrink-0" />
        <input
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter by task, id or epic"
          className="text-foreground min-w-0 flex-1 bg-transparent py-1.5 text-[12.5px] outline-none"
        />
      </div>

      {/* The per-state chips used to live here as well as on the ribbon
          above — two controls, the same counts, the same activeStates, stacked
          one on top of the other. The ribbon already filters, so this row is
          now only the things the ribbon cannot say: free-text search, how much
          the filter is hiding, and collapse-all. */}
      <span className="flex-1" />
      {activeStates.size > 0 && (
        <button
          type="button"
          onClick={onClearStates}
          className="text-muted-foreground hover:text-foreground rounded-md px-2 py-1.5 text-[12px]"
        >
          Clear filter
        </button>
      )}
      <span className="dense-meta">
        {shown} of {total} shown
      </span>
      <button
        type="button"
        onClick={onToggleCollapseAll}
        className="text-muted-foreground hover:bg-muted/50 hover:text-foreground rounded-md px-2.5 py-1.5 text-[12px] transition-colors duration-150"
      >
        {allCollapsed ? 'Expand all' : 'Collapse all'}
      </button>
    </div>
  );
}
