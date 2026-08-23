import type { FeedState } from '@/lib/feedState';
import {
  FEED_STATE_LABEL,
  FEED_STATE_ORDER,
  feedTier,
  isUrgentState,
} from '@/lib/feedState';
import { cn } from '@/lib/utils';
import { StateDot } from '@/ui/chrome/StateDot';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

// Urgent chips earn a tinted ground keyed by TIER — amber for your move, red for
// broken. Spelled out rather than composed at runtime because Tailwind cannot
// build class names dynamically.
const URGENT_SKIN: Partial<Record<ReturnType<typeof feedTier>, string>> = {
  you: 'bg-state-waiting-surface text-state-waiting',
  broken: 'bg-state-failed-surface text-state-failed',
};

interface ControlRibbonProps {
  counts: Record<FeedState, number>;
  /** Which run-state chips are filtering the feed, so the ribbon can show the same selection. */
  activeStates: ReadonlySet<FeedState>;
  onSelect: (state: FeedState) => void;
}

/**
 * The seven-counter strip across the top of the Control room — one compact row of
 * dot + count + label chips, not a band of stat tiles: the counts are wayfinding,
 * and wayfinding does not get the biggest type on the page.
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
    <ToggleGroup
      type="multiple"
      value={FEED_STATE_ORDER.filter((state) => activeStates.has(state))}
      // `spacing={1}` opts out of ToggleGroupItem's corner-trimming (GitSummary).
      spacing={1}
      className="flex flex-wrap items-center justify-start gap-1.5"
      onValueChange={(next) => {
        // Radix hands back the whole next selection; exactly one chip differs per
        // click, so find it and hand it to the caller's per-state toggle.
        const nextSet = new Set(next as FeedState[]);
        const changed = FEED_STATE_ORDER.find(
          (state) => activeStates.has(state) !== nextSet.has(state)
        );
        if (changed !== undefined) onSelect(changed);
      }}
    >
      {FEED_STATE_ORDER.map((state, index) => {
        const count = counts[state];
        const alarmed = isUrgentState(state) && count > 0;
        const active = activeStates.has(state);
        // A hairline divider where the tier changes, so the strip reads as
        // "your moves | broken | the machine's | not started" at a glance.
        const previous = FEED_STATE_ORDER[index - 1];
        const newTier =
          previous !== undefined && feedTier(previous) !== feedTier(state);
        return (
          <ToggleGroupItem
            key={state}
            value={state}
            className={cn(
              'ease-out-expo flex h-7 items-center gap-1.5 rounded-md px-2.5 whitespace-nowrap transition-colors duration-100',
              newTier && 'border-border ml-2 border-l pl-3.5 rounded-l-none',
              // toggleVariants' base text-sm/font-medium and pressed-state bg/text
              // are built for a pill button; all neutralized back to the chip.
              'text-[length:inherit] font-[weight:inherit]',
              'shadow-hairline hover:bg-surface-hover hover:text-inherit',
              'data-[state=on]:bg-transparent data-[state=on]:text-inherit',
              alarmed ? URGENT_SKIN[feedTier(state)] : 'text-muted-foreground',
              active && 'bg-surface-hover-strong ring-ring/40 ring-1'
            )}
          >
            <StateDot state={state} pulse={false} />
            <span
              className={cn(
                'font-mono text-[12px] font-medium tabular-nums',
                !alarmed && 'text-foreground'
              )}
            >
              {count}
            </span>
            <span className="text-[10.5px] font-medium tracking-[0.08em] uppercase">
              {FEED_STATE_LABEL[state]}
            </span>
          </ToggleGroupItem>
        );
      })}
    </ToggleGroup>
  );
}
