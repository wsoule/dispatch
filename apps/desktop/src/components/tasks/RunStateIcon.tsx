import type { RunState } from '@dispatch/client';
import {
  Ban,
  CircleSlash,
  CircleX,
  Ellipsis,
  Eye,
  LoaderCircle,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react';

import { cn } from '@/lib/utils';

/** A task is blocked by an unmet dependency rather than by anything a run is doing, so it
 * isn't a `RunState` — but it occupies the same slot on a card and deserves the same glyph
 * language, hence one shared component keyed by this widened type. */
export type RunStateIconState = RunState | 'blocked';

interface RunStateVisual {
  icon: typeof Ban;
  /** Tailwind text-color class, driving `currentColor` on the glyph. */
  colorClass: string;
  label: string;
  /** `running` is the one state that moves — the loader spins. */
  spin?: boolean;
}

// The same lucide glyph-per-move language as the feed's StateMark (packages/ui
// chrome/state-mark.tsx), translated to run states: awaiting-approval is the
// shield ('approve'), finished is the eye ('review'), and so on. Every state
// forwards to one of the `--state-*` role tokens rather than naming a hue.
//
// `blocked` keeps the red that `TaskCardTile` already shipped for it. Note that tokens.css
// declares blocked deliberately colorless (`--state-blocked-fg` is ghost gray) — the two have
// been out of step since before this change, and quietly resolving it either way would move
// shipped behavior, so this preserves what's on screen today.
const RUN_STATE_VISUALS: Record<RunStateIconState, RunStateVisual> = {
  provisioning: {
    icon: Ellipsis,
    colorClass: 'text-state-working',
    label: 'Provisioning',
  },
  running: {
    icon: LoaderCircle,
    colorClass: 'text-state-working',
    label: 'Working',
    spin: true,
  },
  'awaiting-approval': {
    icon: ShieldCheck,
    colorClass: 'text-state-waiting',
    label: 'Approve',
  },
  failed: {
    icon: CircleX,
    colorClass: 'text-state-failed',
    label: 'Failed',
  },
  'interrupted-dirty': {
    icon: TriangleAlert,
    colorClass: 'text-state-waiting',
    label: 'Interrupted',
  },
  blocked: {
    icon: Ban,
    colorClass: 'text-destructive',
    label: 'Blocked',
  },
  finished: {
    icon: Eye,
    colorClass: 'text-state-review',
    label: 'Review',
  },
  cancelled: {
    icon: CircleSlash,
    colorClass: 'text-muted-foreground',
    label: 'Cancelled',
  },
};

/** Exported so call sites that already render their own text next to the glyph (the card's
 * live-run row) can label it from the same source rather than keeping a parallel map. */
export function runStateLabel(state: RunStateIconState): string {
  return RUN_STATE_VISUALS[state].label;
}

/** The glyph's text-color class, for call sites that put a label beside it — a muted label
 * next to a colored icon reads as two unrelated things rather than one state. */
export function runStateColorClass(state: RunStateIconState): string {
  return RUN_STATE_VISUALS[state].colorClass;
}

// `--state-*` background tokens for a solid dot, the same run-state dot language
// `TaskRow` uses (see ui/ai/task-rows.tsx's `DOT_CLASS`) — spelled out per state because
// Tailwind can't build `bg-${colorClass}` at runtime from the `text-*` map above.
const RUN_STATE_DOT_CLASS: Record<RunStateIconState, string> = {
  provisioning: 'bg-state-working',
  running: 'bg-state-working',
  'awaiting-approval': 'bg-state-waiting',
  failed: 'bg-state-failed',
  'interrupted-dirty': 'bg-state-waiting',
  blocked: 'bg-destructive',
  finished: 'bg-state-review',
  cancelled: 'bg-muted-foreground/60',
};

/** Solid-dot background class for a run state, matching `TaskRow`'s dot vocabulary —
 * for call sites (the board card) that want the dense-list dot language rather than this
 * file's own glyphs. */
export function runStateDotClass(state: RunStateIconState): string {
  return RUN_STATE_DOT_CLASS[state];
}

export interface RunStateIconProps {
  state: RunStateIconState;
  className?: string;
}

/**
 * The agent-state counterpart to `StatusIcon`: what a run (or a dependency block) currently
 * wants from a human, as a 16px glyph in the run-state palette. Status answers "how far along
 * is this task", this answers "is something happening to it right now" — the two sit next to
 * each other on a card and deliberately don't share glyph sets, so neither is mistaken for
 * the other.
 *
 * `running` spins its loader; the animation drops under `prefers-reduced-motion`, where the
 * partial ring still reads as distinct from provisioning's ellipsis.
 */
export function RunStateIcon({ state, className }: RunStateIconProps) {
  const visual = RUN_STATE_VISUALS[state];
  const Icon = visual.icon;
  return (
    <Icon
      role="img"
      aria-label={visual.label}
      strokeWidth={2.25}
      className={cn(
        'size-4 shrink-0',
        visual.colorClass,
        visual.spin === true &&
          'animate-spin [animation-duration:1.4s] motion-reduce:animate-none',
        className
      )}
    />
  );
}
