import {
  Ban,
  CirclePlay,
  CircleX,
  Eye,
  Hand,
  LoaderCircle,
  PlaneLanding,
} from 'lucide-react';

import { type FeedState, isInFlightState } from '../lib/feedState';
import { cn } from '../lib/utils';

// One lucide glyph per state — literal where a literal exists (a plane landing,
// a hand asking, a ban sign) so the mark carries meaning before color does.
const MARK_ICON: Record<FeedState, typeof Hand> = {
  waiting: Hand,
  failed: CircleX,
  working: LoaderCircle,
  review: Eye,
  landing: PlaneLanding,
  ready: CirclePlay,
  blocked: Ban,
};

// Spelled out because Tailwind cannot build class names at runtime. Same
// state-token hues the rest of the app keys on.
const MARK_COLOR: Record<FeedState, string> = {
  waiting: 'text-state-waiting',
  failed: 'text-state-failed',
  working: 'text-state-working',
  review: 'text-state-review',
  landing: 'text-state-landing',
  ready: 'text-state-ready',
  blocked: 'text-state-blocked',
};

interface StateMarkProps {
  state: FeedState;
  /** `sm` for inline text and board cards, `md` for row leads and page headers. */
  size?: 'sm' | 'md';
  /** Force the pulse on or off. Defaults to pulsing whenever the state is in flight. */
  pulse?: boolean;
  className?: string;
}

/**
 * The small mark that tells a row's state apart. Pulse means "in flight" and
 * nothing else — it is the only motion these surfaces have, and `motion-safe:`
 * gates it.
 */
export function StateMark({
  state,
  size = 'sm',
  pulse,
  className,
}: StateMarkProps) {
  const animate = pulse ?? isInFlightState(state);
  const Icon = MARK_ICON[state];
  return (
    <Icon
      aria-hidden
      strokeWidth={2.25}
      className={cn(
        'shrink-0',
        size === 'sm' ? 'size-3.5' : 'size-4',
        MARK_COLOR[state],
        animate && 'motion-safe:animate-pulse',
        className
      )}
    />
  );
}
