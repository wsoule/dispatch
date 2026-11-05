import type { MergeQueueEntryState } from '@dispatch/client';
import { cx, type UiTone } from '@dispatch/ui';
import { CircleDashed, Hourglass } from 'lucide-react';
import { memo } from 'react';

import { useRunStep } from '../../hooks/useRunStep';
import { landingBadgeTitle } from '../../lib/landingBadge';
import { formatUsd } from '../../lib/milestoneSession';
import { withLiveStep } from '../../lib/runStep';
import { AssigneeAvatar } from '../tasks/AssigneeAvatar';
import { LandingBadge } from '../tasks/LandingBadge';
import { StatusIcon } from '../tasks/StatusIcon';
import { NODE_HEIGHT, NODE_WIDTH } from './flightLayout';
import styles from './FlightNodeCard.module.css';
import type { FlightNodeState } from './flightPlan';
import type { SentenceTone } from './flightSentences';
import { useElapsed } from '@/hooks/useElapsed';

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

/**
 * The status tone a card's edge takes (its `data-tone`, read as `--tone-line`): a running
 * node is in progress (info), a node in review is green (success). Every other state is
 * neutral and drawn by `data-state` alone.
 */
const STATE_TONE: Record<FlightNodeState, UiTone | null> = {
  done: null,
  running: 'info',
  teammate: null,
  review: 'success',
  queued: null,
  blocked: null,
};

/**
 * The tone a sentence's words take through the global `toneText` class: working is in
 * progress, waiting needs input, review is green, failed is red; done and ready stay in
 * the secondary ink (null), and muted takes the faint grey.
 */
const SENTENCE_TONE: Record<SentenceTone, UiTone | null> = {
  done: null,
  working: 'info',
  waiting: 'warning',
  review: 'success',
  failed: 'danger',
  ready: null,
  muted: 'muted',
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
        size={14}
        strokeWidth={1.8}
        className={styles.glyphQueued}
      />
    );
  }
  if (state === 'blocked') {
    return (
      <CircleDashed
        aria-hidden
        size={14}
        strokeWidth={1.8}
        className={styles.glyphBlocked}
      />
    );
  }
  return (
    <StatusIcon
      status={state === 'running' ? 'working' : status}
      className={styles.glyph}
    />
  );
}

// The node's sentence, with a running node's latest step folded in. Its own component so a
// chatty run re-renders only this line, never the card.
function Sentence({
  text,
  runId,
  tone,
}: {
  text: string;
  runId: string | null;
  tone: UiTone | null;
}) {
  const shown = withLiveStep(text, useRunStep(runId));
  return (
    <span
      data-slot="flight-node-sentence"
      title={shown}
      data-tone={tone ?? undefined}
      className={cx(styles.sentence, tone !== null && 'toneText')}
    >
      {shown}
    </span>
  );
}

// A live clock. Its own component so only it re-renders each second.
function Elapsed({ since }: { since: number }) {
  return <span className={cx(styles.meta, 'num')}>{useElapsed(since)}</span>;
}

/**
 * One Flight Plan node, 240×68 at its layout position, on the board card's anatomy: the
 * glyph, id, cost and the owner's avatar (or a live run's clock) on top, the title, then
 * the node's sentence. The state tints the card in place — done fills neutral, running and
 * review carry their hue's edge, blocked goes to a dashed outline — and a critical-path
 * node carries an accent rail. Fill and edge ease between states (when motion is welcome),
 * so a landing reads as the card settling, not a re-render.
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
  // Its own compositing layer (`will-change` in the module): in WebKit a card culled in or
  // out as the plan pans would otherwise repaint the canvas under every other card.
  return (
    <button
      type="button"
      id={flightNodeDomId(id)}
      tabIndex={-1}
      aria-label={`${refLabel} ${title}: ${text}`}
      data-slot="flight-node"
      data-node-id={id}
      data-state={state}
      data-tone={STATE_TONE[state] ?? undefined}
      data-critical={critical || undefined}
      data-focused={focused || undefined}
      onClick={() => onActivate(id)}
      className={styles.card}
      style={{
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        transform: `translate(${x}px, ${y}px)`,
      }}
    >
      <span className={styles.head}>
        <NodeGlyph state={state} status={glyphStatus} />
        <span className={styles.ref}>{refLabel}</span>
        {landing !== null && landingSentence === null && (
          <LandingBadge state={landing} variant="inline" />
        )}
        {costUsd !== null && costUsd > 0 && (
          <span className={cx(styles.meta, 'num')}>{formatUsd(costUsd)}</span>
        )}
        {state === 'running' && startedAt !== null ? (
          <Elapsed since={startedAt} />
        ) : owner !== null ? (
          <AssigneeAvatar assignee={owner} size={16} />
        ) : null}
      </span>
      <span className={styles.title}>{title}</span>
      <Sentence
        text={text}
        runId={state === 'running' ? runId : null}
        tone={landingSentence === null ? SENTENCE_TONE[tone] : 'info'}
      />
    </button>
  );
});
