import type { FeedState } from '@/lib/feedState';
import {
  FEED_STATE_LABEL,
  FEED_STATE_ORDER,
  isUrgentState,
} from '@/lib/feedState';
import { cn } from '@/lib/utils';

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
      {FEED_STATE_ORDER.map((state) => {
        const count = counts[state];
        const alarmed = isUrgentState(state) && count > 0;
        const active = activeStates.has(state);
        return (
          <button
            key={state}
            type="button"
            aria-pressed={active}
            onClick={() => onSelect(state)}
            className={cn(
              'flex flex-col items-start gap-1.5 rounded-lg border-t-2 px-3 py-2.5 text-left transition-colors duration-150',
              'shadow-hairline hover:bg-muted/50',
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
          </button>
        );
      })}
    </div>
  );
}
