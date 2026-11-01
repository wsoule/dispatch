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

import { type FeedState, feedTier } from '../lib/feedState';
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

// T3 Code's status dots: the same tier hues as a filled 9px disc, slightly softened in
// dark so they glow rather than shout.
const TIER_DOT = {
  you: 'bg-state-waiting dark:bg-state-waiting/90',
  broken: 'bg-state-failed dark:bg-state-failed/90',
  machine: 'bg-state-working dark:bg-state-working/80',
  resting: 'bg-muted-foreground',
} as const;

interface StateMarkProps {
  state: FeedState;
  /** Accepted for the call sites that still pass it; every mark is 14px now. */
  size?: 'sm' | 'md';
  /** Machine-tier states (in flight) dim on a stepped 2s loop, like T3 Code's working
   * dot. Off for reduced motion. */
  pulse?: boolean;
  /** `mark` is the 14px glyph; `dot` is T3 Code's 9px status disc for dense rails. */
  variant?: 'mark' | 'dot';
  className?: string;
}

/**
 * What tells a row's state apart. The `mark` is a 14px glyph (which move) in a tier hue
 * (whose move); the `dot` keeps only the hue. In-flight states may pulse.
 */
export function StateMark({
  state,
  pulse = false,
  variant = 'mark',
  className,
}: StateMarkProps) {
  const tier = feedTier(state);
  const pulsing =
    pulse && tier === 'machine' && 'motion-safe:animate-status-pulse';
  if (variant === 'dot') {
    return (
      <span
        aria-hidden
        data-slot="state-dot"
        className={cn(
          'inline-block size-[9px] shrink-0 rounded-full',
          TIER_DOT[tier],
          pulsing,
          className
        )}
      />
    );
  }
  const Icon = MARK_ICON[state];
  return (
    <Icon
      aria-hidden
      strokeWidth={1.75}
      className={cn('size-3.5 shrink-0', TIER_COLOR[tier], pulsing, className)}
    />
  );
}
