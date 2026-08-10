import { Search } from 'lucide-react';

import type { FeedState } from '@/lib/feedState';
import { Button } from '@/ui/button';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/ui/input-group';

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
      {/* `shadow-[var(--hairline)]`, not `shadow-hairline` — twMerge can't see the
          custom token as the same "shadow" group as InputGroup's own `shadow-xs`, so
          the arbitrary-value form is what actually overrides it (DispatchDialog
          precedent). Border and focus-ring are neutralized the same way. */}
      <InputGroup className="h-auto w-64 gap-2 rounded-md border-0 bg-transparent px-2.5 shadow-[var(--hairline)] outline-none has-[[data-slot=input-group-control]:focus-visible]:border-transparent has-[[data-slot=input-group-control]:focus-visible]:ring-0 dark:bg-transparent">
        <InputGroupAddon className="p-0">
          <Search className="text-muted-foreground size-3.5 shrink-0" />
        </InputGroupAddon>
        <InputGroupInput
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Filter by task, id or epic"
          className="text-foreground h-auto px-0 py-1.5 text-[12.5px] md:text-[12.5px]"
        />
      </InputGroup>

      {/* The per-state chips used to live here as well as on the ribbon
          above — two controls, the same counts, the same activeStates, stacked
          one on top of the other. The ribbon already filters, so this row is
          now only the things the ribbon cannot say: free-text search, how much
          the filter is hiding, and collapse-all. */}
      <span className="flex-1" />
      {activeStates.size > 0 && (
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={onClearStates}
          // Ghost's hover bg/transition are neutralized — the old button had neither.
          className="text-muted-foreground hover:text-foreground h-auto rounded-md px-2 py-1.5 text-[12px] font-normal transition-none hover:bg-transparent dark:hover:bg-transparent"
        >
          Clear filter
        </Button>
      )}
      <span className="dense-meta">
        {shown} of {total} shown
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onToggleCollapseAll}
        className="text-muted-foreground hover:bg-muted/50 hover:text-foreground dark:hover:bg-muted/50 h-auto rounded-md px-2.5 py-1.5 text-[12px] font-normal transition-colors duration-150"
      >
        {allCollapsed ? 'Expand all' : 'Collapse all'}
      </Button>
    </div>
  );
}
