import { Search } from 'lucide-react';

import { FEED_GROUPS } from '@/lib/controlRoom';
import type { FeedState } from '@/lib/feedState';
import { FEED_STATE_LABEL } from '@/lib/feedState';
import { cn } from '@/lib/utils';

interface FeedFilterBarProps {
  query: string;
  onQueryChange: (value: string) => void;
  counts: Record<FeedState, number>;
  activeStates: ReadonlySet<FeedState>;
  onToggleState: (state: FeedState) => void;
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
  counts,
  activeStates,
  onToggleState,
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

      {FEED_GROUPS.map((state) => {
        const active = activeStates.has(state);
        return (
          <button
            key={state}
            type="button"
            aria-pressed={active}
            onClick={() => onToggleState(state)}
            className={cn(
              'flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] transition-colors duration-150',
              active
                ? 'bg-accent text-accent-foreground shadow-hairline-strong'
                : 'text-muted-foreground shadow-hairline hover:bg-muted/50'
            )}
          >
            {FEED_STATE_LABEL[state]}
            <span className="dense-meta">{counts[state]}</span>
          </button>
        );
      })}

      <span className="flex-1" />
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
