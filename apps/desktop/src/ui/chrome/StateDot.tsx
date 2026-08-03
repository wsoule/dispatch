import { type FeedState, isInFlightState } from '@/lib/feedState';
import { cn } from '@/lib/utils';

// Tailwind can't build class names at runtime, so the state -> class map has to be spelled
// out. The colors themselves live in styles/tokens.css; these are only the utility names that
// forward to them (see the @theme block in styles/tailwind.css).
const DOT_COLOR: Record<FeedState, string> = {
  working: 'bg-state-working',
  waiting: 'bg-state-waiting',
  failed: 'bg-state-failed',
  review: 'bg-state-review',
  landing: 'bg-state-landing',
  ready: 'bg-state-ready',
  blocked: 'bg-state-blocked',
};

interface StateDotProps {
  state: FeedState;
  /** `sm` for inline text and board cards, `md` for row leads and page headers. */
  size?: 'sm' | 'md';
  /** Force the pulse on or off. Defaults to pulsing whenever the state is in flight. */
  pulse?: boolean;
  className?: string;
}

/**
 * The small colored circle that marks a row's state, shared by the feed, task rows, board
 * cards, the queue and run headers.
 *
 * It pulses while something is actually moving, which is the only animation in these surfaces
 * and therefore the only thing a glance catches — so it has to mean "in flight" and nothing
 * else. `motion-safe:` gates it, since a page of pulsing dots is exactly what someone with a
 * vestibular disorder turns reduced-motion on to avoid.
 */
export function StateDot({
  state,
  size = 'sm',
  pulse,
  className,
}: StateDotProps) {
  const animate = pulse ?? isInFlightState(state);
  return (
    <span
      aria-hidden
      className={cn(
        'shrink-0 rounded-full',
        size === 'sm' ? 'size-1.5' : 'size-2',
        DOT_COLOR[state],
        animate && 'motion-safe:animate-pulse',
        className
      )}
    />
  );
}
