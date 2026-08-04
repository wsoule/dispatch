import type { RunState } from '@dispatch/client';

import { cn } from '@/lib/utils';

// Shared 14x14 viewBox and 16px rendered size with `StatusIcon`/`PriorityIcon` — see
// StatusIcon.tsx for why size is a Tailwind class rather than an SVG attribute.
const VIEWBOX = 14;
const CENTER = VIEWBOX / 2;
const RADIUS = 5.25;
const STROKE_WIDTH = 1.7;

/** A task is blocked by an unmet dependency rather than by anything a run is doing, so it
 * isn't a `RunState` — but it occupies the same slot on a card and deserves the same glyph
 * language, hence one shared component keyed by this widened type. */
export type RunStateIconState = RunState | 'blocked';

type Shape =
  | 'dotted'
  | 'sweep'
  | 'bang'
  | 'cross'
  | 'triangle'
  | 'dash'
  | 'tick';

interface RunStateVisual {
  shape: Shape;
  /** Tailwind text-color class, driving `stroke`/`fill="currentColor"` below. */
  colorClass: string;
  label: string;
}

// Every state forwards to one of the `--state-*` role tokens rather than naming a hue, so the
// glyphs stay in step with how the rest of the app already paints run state (dense rows, the
// runs list) and inherit the dark-theme overrides for free.
//
// `blocked` keeps the red that `TaskCardTile` already shipped for it. Note that tokens.css
// declares blocked deliberately colorless (`--state-blocked-fg` is ghost gray) — the two have
// been out of step since before this change, and quietly resolving it either way would move
// shipped behavior, so this preserves what's on screen today.
const RUN_STATE_VISUALS: Record<RunStateIconState, RunStateVisual> = {
  provisioning: {
    shape: 'dotted',
    colorClass: 'text-state-working',
    label: 'Provisioning',
  },
  running: {
    shape: 'sweep',
    colorClass: 'text-state-working',
    label: 'Running',
  },
  'awaiting-approval': {
    shape: 'bang',
    colorClass: 'text-state-waiting',
    label: 'Awaiting approval',
  },
  failed: {
    shape: 'cross',
    colorClass: 'text-state-failed',
    label: 'Failed',
  },
  'interrupted-dirty': {
    shape: 'triangle',
    colorClass: 'text-state-waiting',
    label: 'Interrupted',
  },
  blocked: {
    shape: 'dash',
    colorClass: 'text-destructive',
    label: 'Blocked',
  },
  finished: {
    shape: 'tick',
    colorClass: 'text-state-review',
    label: 'Finished',
  },
  cancelled: {
    shape: 'cross',
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

export interface RunStateIconProps {
  state: RunStateIconState;
  className?: string;
}

/**
 * The agent-state counterpart to `StatusIcon`: what a run (or a dependency block) currently
 * wants from a human, as a 16px glyph in the run-state palette. Status answers "how far along
 * is this task", this answers "is something happening to it right now" — the two sit next to
 * each other on a card and deliberately don't share shapes, so neither is mistaken for the
 * other.
 *
 * `running` animates a sweeping arc; the animation is dropped under `prefers-reduced-motion`,
 * where the partial arc still reads as distinct from provisioning's dotted ring.
 */
export function RunStateIcon({ state, className }: RunStateIconProps) {
  const visual = RUN_STATE_VISUALS[state];

  return (
    <svg
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      className={cn('size-4 shrink-0', visual.colorClass, className)}
      role="img"
      aria-label={visual.label}
    >
      {visual.shape === 'dotted' && (
        <circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE_WIDTH}
          strokeLinecap="round"
          strokeDasharray="0.1 2.5"
        />
      )}
      {visual.shape === 'sweep' && (
        <>
          <circle
            cx={CENTER}
            cy={CENTER}
            r={RADIUS}
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE_WIDTH}
            strokeOpacity={0.28}
          />
          <g
            className="origin-center animate-spin motion-reduce:animate-none"
            style={{ animationDuration: '1.4s' }}
          >
            <circle
              cx={CENTER}
              cy={CENTER}
              r={RADIUS}
              fill="none"
              stroke="currentColor"
              strokeWidth={STROKE_WIDTH}
              strokeLinecap="round"
              // ~30% of the circumference drawn, the rest gapped — one visible arc chasing
              // the ring.
              strokeDasharray={`${2 * Math.PI * RADIUS * 0.3} ${2 * Math.PI * RADIUS}`}
            />
          </g>
        </>
      )}
      {visual.shape === 'bang' && (
        <>
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="currentColor" />
          <rect
            x={6.3}
            y={3.5}
            width={1.4}
            height={4.2}
            rx={0.7}
            fill="var(--color-background)"
          />
          <rect
            x={6.3}
            y={8.7}
            width={1.4}
            height={1.4}
            rx={0.7}
            fill="var(--color-background)"
          />
        </>
      )}
      {visual.shape === 'cross' && (
        <>
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="currentColor" />
          <path
            d="M5.1 5.1 L8.9 8.9 M8.9 5.1 L5.1 8.9"
            stroke="var(--color-background)"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </>
      )}
      {visual.shape === 'triangle' && (
        <>
          <path
            d="M7 1.9 L12.9 11.8 L1.1 11.8 Z"
            fill="currentColor"
            strokeLinejoin="round"
          />
          <rect
            x={6.3}
            y={5.2}
            width={1.4}
            height={3.4}
            rx={0.7}
            fill="var(--color-background)"
          />
          <rect
            x={6.3}
            y={9.4}
            width={1.4}
            height={1.4}
            rx={0.7}
            fill="var(--color-background)"
          />
        </>
      )}
      {visual.shape === 'dash' && (
        <>
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="currentColor" />
          <rect
            x={4.2}
            y={6.3}
            width={5.6}
            height={1.4}
            rx={0.7}
            fill="var(--color-background)"
          />
        </>
      )}
      {visual.shape === 'tick' && (
        <>
          <circle cx={CENTER} cy={CENTER} r={RADIUS} fill="currentColor" />
          <path
            d="M4.1 7.2 L6.1 9.2 L9.9 4.9"
            fill="none"
            stroke="var(--color-background)"
            strokeWidth={1.6}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}
