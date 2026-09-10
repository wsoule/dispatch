import {
  Ban,
  CirclePlay,
  CircleX,
  Eye,
  Gavel,
  LoaderCircle,
  MessageCircleQuestion,
  PlaneLanding,
  ScanSearch,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from 'lucide-react';

import { type FeedState, feedTier, isInFlightState } from '../lib/feedState';
import { cn } from '../lib/utils';

// One lucide glyph per state — the glyph names the specific move, literal
// where a literal exists (a gavel for a ruling, a plane landing, a wrench for
// a fix round).
const MARK_ICON: Record<FeedState, typeof Ban> = {
  answer: MessageCircleQuestion,
  approve: ShieldCheck,
  review: Eye,
  ruling: Gavel,
  unblock: TriangleAlert,
  failed: CircleX,
  working: LoaderCircle,
  fixing: Wrench,
  checking: ScanSearch,
  landing: PlaneLanding,
  ready: CirclePlay,
  blocked: Ban,
};

// Hue comes from the TIER, not the state: amber means your move whatever the
// move is, blue means the machine's, red means broken, gray means resting.
// Spelled out because Tailwind cannot build class names at runtime.
const TIER_COLOR = {
  you: 'text-state-waiting',
  broken: 'text-state-failed',
  machine: 'text-state-working',
  resting: 'text-muted-foreground',
} as const;

interface StateMarkProps {
  state: FeedState;
  /** `sm` for inline text and board cards, `md` for row leads and page headers. */
  size?: 'sm' | 'md';
  /** Force the pulse on or off. Defaults to pulsing whenever the state is in flight. */
  pulse?: boolean;
  className?: string;
}

/**
 * The small mark that tells a row's state apart: glyph = which move, hue =
 * whose move. Pulse means "in flight" and nothing else — it is the only motion
 * these surfaces have, and `motion-safe:` gates it.
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
        TIER_COLOR[feedTier(state)],
        animate && 'motion-safe:animate-pulse',
        className
      )}
    />
  );
}
