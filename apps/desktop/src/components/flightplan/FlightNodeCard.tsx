import type { MergeQueueEntryState } from '@dispatch/client';
import { CircleDashed, Hourglass } from 'lucide-react';
import { memo } from 'react';

import { useRunStep } from '../../hooks/useRunStep';
import { formatUsd } from '../../lib/epicSession';
import { landingBadgeTitle } from '../../lib/landingBadge';
import { withLiveStep } from '../../lib/runStep';
import { AssigneeAvatar } from '../tasks/AssigneeAvatar';
import { LandingBadge } from '../tasks/LandingBadge';
import { StatusIcon } from '../tasks/StatusIcon';
import { NODE_HEIGHT, NODE_WIDTH } from './flightLayout';
import type { FlightNodeState } from './flightPlan';
import type { SentenceTone } from './flightSentences';
import { cn } from '@/lib/utils';
import { useElapsed } from '@/ui/ai/use-elapsed';

/** A node's DOM id, for the canvas's `aria-activedescendant` and scrolling it into view. */
export function flightNodeDomId(id: string): string {
  return `flight-node-${id}`;
}

/** Everything one card draws — primitives only, so `memo` skips every card whose own
 * values did not change when the plan around it does. */
export interface FlightNodeView {
  id: string;
  /** The id people know it by (a Linear identifier when linked). */
  refLabel: string;
  title: string;
  state: FlightNodeState;
  /** The status the glyph draws. */
  glyphStatus: string;
  sentence: string;
  tone: SentenceTone;
  /** A person's avatar in the corner, or null. */
  owner: string | null;
  /** The live run's start, for a ticking clock. */
  startedAt: number | null;
  /** The live run, for a running node's latest step. */
  runId: string | null;
  /** The run's cost so far, for a running or finished node. */
  costUsd: number | null;
  /** Where the task's run stands in the merge queue, while it is landing. */
  landing: MergeQueueEntryState | null;
  critical: boolean;
  x: number;
  y: number;
}

const STATE_CLASS: Record<FlightNodeState, string> = {
  done: 'bg-surface-secondary shadow-hairline',
  running:
    'bg-surface-quaternary shadow-[inset_0_0_0_1px_var(--state-working-edge),var(--shadow-card)]',
  teammate: 'bg-surface-quaternary shadow-card',
  review:
    'bg-surface-quaternary shadow-[inset_0_0_0_1px_var(--state-review-edge),var(--shadow-card)]',
  queued: 'bg-surface-quaternary shadow-card',
  blocked: 'bg-(--surface-page) border border-dashed border-border-strong',
};

const TONE_CLASS: Record<SentenceTone, string> = {
  done: 'text-status-done',
  working: 'text-state-working',
  waiting: 'text-state-waiting',
  review: 'text-state-review',
  failed: 'text-state-failed',
  ready: 'text-text-secondary',
  muted: 'text-(--text-muted)',
};

// ✓ landed, ◐ running and the teammate's and reviewer's own status glyphs come from the
// status vocabulary; ⏳ queued and ○ blocked are the plan's own.
function NodeGlyph({
  state,
  status,
}: {
  state: FlightNodeState;
  status: string;
}) {
  if (state === 'queued') {
    return (
      <Hourglass
        aria-hidden
        strokeWidth={1.75}
        className="text-state-ready size-3.5 shrink-0"
      />
    );
  }
  if (state === 'blocked') {
    return (
      <CircleDashed
        aria-hidden
        strokeWidth={1.75}
        className="size-3.5 shrink-0 text-(--text-ghost)"
      />
    );
  }
  return (
    <StatusIcon
      status={state === 'running' ? 'working' : status}
      className="size-3.5 shrink-0"
    />
  );
}

// The node's sentence, with a running node's latest step folded in. Its own component so a
// chatty run re-renders only this line, never the card.
function Sentence({
  text,
  runId,
  className,
}: {
  text: string;
  runId: string | null;
  className: string;
}) {
  const shown = withLiveStep(text, useRunStep(runId));
  return (
    <span data-slot="flight-node-sentence" title={shown} className={className}>
      {shown}
    </span>
  );
}

// A live clock. Its own component so only it re-renders each second.
function Elapsed({ since }: { since: number }) {
  return (
    <span className="font-book shrink-0 text-[12px] text-(--text-muted) tabular-nums">
      {useElapsed(since)}
    </span>
  );
}

/**
 * One Flight Plan node, 240×68 at its layout position, on the board card's anatomy: the
 * glyph, id, cost and the owner's avatar (or a live run's clock) on top, the title, then
 * the node's sentence. The state tints the card in place — running and review carry their
 * hue's hairline, blocked goes to a dashed outline — and a critical-path node carries an
 * accent rail. Colour and shadow ease between states, so a landing reads as the card
 * settling, not a re-render.
 */
export const FlightNodeCard = memo(function FlightNodeCard({
  id,
  refLabel,
  title,
  state,
  glyphStatus,
  sentence,
  tone,
  owner,
  startedAt,
  runId,
  costUsd,
  landing,
  critical,
  x,
  y,
  focused,
  onActivate,
}: FlightNodeView & {
  focused: boolean;
  onActivate: (id: string) => void;
}) {
  // A review node in the queue says where it is instead of "Ready for review"; any other
  // node in the queue carries the badge in its header.
  const landingSentence =
    landing !== null && state === 'review' ? landingBadgeTitle(landing) : null;
  const text = landingSentence ?? sentence;
  // Its own compositing layer: in WebKit a card culled in or out as the plan pans would
  // otherwise repaint the canvas under every other card.
  return (
    <button
      type="button"
      id={flightNodeDomId(id)}
      tabIndex={-1}
      aria-label={`${refLabel} ${title}: ${text}`}
      data-slot="flight-node"
      data-node-id={id}
      data-state={state}
      data-critical={critical || undefined}
      data-focused={focused || undefined}
      onClick={() => onActivate(id)}
      className={cn(
        'rounded-card absolute top-0 left-0 flex cursor-pointer scroll-mt-10 scroll-ml-5 flex-col justify-center gap-0.5 overflow-hidden px-2.5 text-left will-change-transform',
        'transition-[background-color,box-shadow,border-color] duration-300 ease-(--ease-out-expo)',
        'hover:bg-surface-active',
        STATE_CLASS[state],
        critical &&
          'before:absolute before:inset-y-2.5 before:left-0 before:w-[2px] before:rounded-r-full before:bg-(--accent)',
        focused && 'outline-focus-ring outline-2 outline-offset-1'
      )}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        transform: `translate(${x}px, ${y}px)`,
      }}
    >
      <span className="flex h-4 min-w-0 items-center gap-1.5 text-[12px] leading-4">
        <NodeGlyph state={state} status={glyphStatus} />
        <span className="font-book min-w-0 flex-1 truncate tracking-(--id-tracking) text-(--text-muted) tabular-nums">
          {refLabel}
        </span>
        {landing !== null && landingSentence === null && (
          <LandingBadge state={landing} variant="inline" />
        )}
        {costUsd !== null && costUsd > 0 && (
          <span className="font-book shrink-0 text-(--text-muted) tabular-nums">
            {formatUsd(costUsd)}
          </span>
        )}
        {state === 'running' && startedAt !== null ? (
          <Elapsed since={startedAt} />
        ) : owner !== null ? (
          <AssigneeAvatar assignee={owner} size={16} />
        ) : null}
      </span>
      <span
        className={cn(
          'truncate text-[13px] leading-[18px] font-medium',
          state === 'done' || state === 'blocked'
            ? 'text-(--text-muted)'
            : 'text-foreground'
        )}
      >
        {title}
      </span>
      <Sentence
        text={text}
        runId={state === 'running' ? runId : null}
        className={cn(
          'truncate text-[12px] leading-4',
          landingSentence === null ? TONE_CLASS[tone] : 'text-state-landing'
        )}
      />
    </button>
  );
});
