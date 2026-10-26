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

interface StateMarkProps {
  state: FeedState;
  /** Accepted for the call sites that still pass it; every mark is 14px now. */
  size?: 'sm' | 'md';
  /** Accepted for the call sites that still pass it; marks no longer pulse — the
   * in-progress hue says "in flight" on its own. */
  pulse?: boolean;
  className?: string;
}

/**
 * The 14px mark that tells a row's state apart: glyph = which move, hue =
 * whose move. Still, like Linear's status icons — no motion.
 */
export function StateMark({ state, className }: StateMarkProps) {
  const Icon = MARK_ICON[state];
  return (
    <Icon
      aria-hidden
      strokeWidth={1.75}
      className={cn(
        'size-3.5 shrink-0',
        TIER_COLOR[feedTier(state)],
        className
      )}
    />
  );
}
