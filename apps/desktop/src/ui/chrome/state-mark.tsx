import { type FeedState, isInFlightState } from '@/lib/feedState';
import { cn } from '@/lib/utils';

// Spelled out because Tailwind cannot build class names at runtime. With the
// palette grayscale, form distinguishes states and tone ranks their urgency.
// `failed` is a wedge bitten out of the disc, not a ring: a ring is drawn in a
// border tone that all but vanishes against the light theme's near-white ground,
// whereas a cut silhouette survives either ground.
const MARK_FORM: Record<FeedState, string> = {
  waiting: 'bg-state-waiting rounded-full',
  failed:
    'bg-state-failed rounded-full [clip-path:polygon(0%_0%,100%_0%,100%_25%,35%_50%,100%_75%,100%_100%,0%_100%)]',
  working: 'bg-state-working rounded-full',
  review: 'border border-state-review rounded-full',
  landing: 'bg-state-landing rounded-full [clip-path:inset(0_50%_0_0)]',
  ready: 'border border-dashed border-state-ready rounded-full',
  blocked: 'bg-state-blocked h-px self-center',
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
 * The small mark that tells a row's state apart without using colour. Pulse
 * means "in flight" and nothing else — it is the only motion these surfaces
 * have, and `motion-safe:` gates it.
 */
export function StateMark({
  state,
  size = 'sm',
  pulse,
  className,
}: StateMarkProps) {
  const animate = pulse ?? isInFlightState(state);
  return (
    <span
      aria-hidden
      className={cn(
        'shrink-0',
        size === 'sm' ? 'size-1.5' : 'size-2',
        MARK_FORM[state],
        animate && 'motion-safe:animate-pulse',
        className
      )}
    />
  );
}
