import type { FeedState } from '@/lib/feedState';
import {
  FEED_STATE_LABEL,
  FEED_STATE_ORDER,
  isUrgentState,
} from '@/lib/feedState';
import { cn } from '@/lib/utils';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

// Urgent cells earn a tinted ground and a top rule; everything else stays flat. Spelled out
// rather than composed at runtime because Tailwind cannot build class names dynamically.
const URGENT_SKIN: Partial<Record<FeedState, string>> = {
  waiting: 'bg-state-waiting-surface text-state-waiting border-t-state-waiting',
  failed: 'bg-state-failed-surface text-state-failed border-t-state-failed',
};

interface ControlRibbonProps {
  counts: Record<FeedState, number>;
  /** Which run-state chips are filtering the feed, so the ribbon can show the same selection. */
  activeStates: ReadonlySet<FeedState>;
  onSelect: (state: FeedState) => void;
}

/**
 * The seven-counter band across the top of the Control room.
 *
 * The rule that matters: an urgent counter only *looks* urgent when it is non-zero. A calm repo
 * has to look calm, or the tint stops meaning anything and the screen reads as permanently
 * alarmed. Zero-state waiting and failed are as quiet as the rest.
 */
export function ControlRibbon({
  counts,
  activeStates,
  onSelect,
}: ControlRibbonProps) {
  return (
    <div className="grid grid-cols-4 gap-2 lg:grid-cols-7">
      <ToggleGroup
        type="multiple"
        value={FEED_STATE_ORDER.filter((state) => activeStates.has(state))}
        // `spacing={1}` opts out of ToggleGroupItem's `data-[spacing=0]:rounded-none`
        // corner-trimming (see GitSummary); `contents` keeps the grid above as the
        // real layout container instead of nesting a flex row inside it.
        spacing={1}
        className="contents"
        onValueChange={(next) => {
          // Radix hands back the whole next selection; exactly one cell differs per
          // click, so find it and hand it to the caller's per-state toggle.
          const nextSet = new Set(next as FeedState[]);
          const changed = FEED_STATE_ORDER.find(
            (state) => activeStates.has(state) !== nextSet.has(state)
          );
          if (changed !== undefined) onSelect(changed);
        }}
      >
        {FEED_STATE_ORDER.map((state) => {
          const count = counts[state];
          const alarmed = isUrgentState(state) && count > 0;
          const active = activeStates.has(state);
          return (
            <ToggleGroupItem
              key={state}
              value={state}
              className={cn(
                'flex h-auto flex-col items-start gap-1.5 rounded-lg border-t-2 px-3 py-2.5 text-left whitespace-normal transition-colors duration-150',
                // toggleVariants' base text-sm/font-medium and pressed-state bg/text
                // are built for a pill button; all neutralized back to the stat tile.
                'text-[length:inherit] font-[weight:inherit]',
                'shadow-hairline hover:bg-muted/50 hover:text-inherit',
                'data-[state=on]:bg-transparent data-[state=on]:text-inherit',
                alarmed
                  ? URGENT_SKIN[state]
                  : 'text-foreground border-t-transparent',
                active && 'ring-ring/40 ring-1'
              )}
            >
              <span className="text-xl leading-none font-semibold tabular-nums">
                {count}
              </span>
              <span className="dense-label">{FEED_STATE_LABEL[state]}</span>
            </ToggleGroupItem>
          );
        })}
      </ToggleGroup>
    </div>
  );
}
