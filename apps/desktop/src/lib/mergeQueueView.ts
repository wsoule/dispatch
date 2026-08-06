import type {
  MergeQueueEntry,
  MergeQueueEntryState,
  VerifyStepResult,
} from '@dispatch/client';

import type { Step } from '@/ui/chrome/StepStrip';

/**
 * The Landing view's read model over the merge queue.
 *
 * The mockup drew a four-segment strip labelled install / typecheck / tests / merge. Those
 * sub-steps do not exist: the queue runs one configured verify command, and its own pipeline is
 * three phases. The strip reports the phases that are real rather than the four that were drawn.
 */

export type QueuePhase = 'rebase' | 'verify' | 'merge';

/** The pipeline every entry walks, in order. Matches `processEntry` in the server's
 * mergeQueue.ts: rebase, then verify, then merge. */
export const QUEUE_PHASES: readonly QueuePhase[] = [
  'rebase',
  'verify',
  'merge',
];

const PHASE_LABEL: Record<QueuePhase, string> = {
  rebase: 'rebase',
  verify: 'verify',
  merge: 'merge',
};

/** How far each phase has got, or `null` when the entry's phase cannot be known.
 *
 * `failed` returns null on purpose. The server wraps rebase, verify and merge in one try block
 * and records only the thrown message, so a failed entry genuinely does not say which phase
 * broke. Painting all three red would claim the rebase failed when it may well have succeeded;
 * painting them grey would claim nothing ran. The honest move is to show no strip at all and
 * let the recorded reason speak. */
export function phaseSteps(
  state: MergeQueueEntryState,
  /** Real per-step verify results, when the entry has reached verification. */
  verifySteps?: VerifyStepResult[]
): Step[] | null {
  // Once the queue reports named verify steps, show those instead of the coarse three phases —
  // "typecheck failed" is worth an entire pipeline diagram of "verify failed". Only while
  // verification is actually the current phase; before and after, the phase view is the honest
  // summary.
  if (
    state === 'verifying' &&
    verifySteps !== undefined &&
    verifySteps.length > 0
  ) {
    return verifySteps.map((s) => ({
      name: s.name,
      status:
        s.status === 'running'
          ? 'active'
          : s.status === 'passed'
            ? 'passed'
            : s.status === 'failed'
              ? 'failed'
              : 'pending',
    }));
  }

  if (state === 'failed') return null;

  const reached: Record<MergeQueueEntryState, number> = {
    queued: 0,
    'waiting-blockers': 0,
    'blocked-environment': 0,
    rebasing: 0,
    verifying: 1,
    merging: 2,
    merged: 3,
    failed: 0,
  };
  const active: ReadonlySet<MergeQueueEntryState> = new Set([
    'rebasing',
    'verifying',
    'merging',
  ]);
  const at = reached[state];

  return QUEUE_PHASES.map((phase, i) => ({
    name: PHASE_LABEL[phase],
    status:
      i < at ? 'passed' : i === at && active.has(state) ? 'active' : 'pending',
  }));
}

/** What the entry is doing, phrased for someone scanning the queue. */
export function queueStateLabel(state: MergeQueueEntryState): string {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'waiting-blockers':
      return 'waiting on blockers';
    case 'blocked-environment':
      return 'held — checkout is not clean';
    case 'rebasing':
      return 'rebasing';
    case 'verifying':
      return 'running verify';
    case 'merging':
      return 'merging';
    case 'merged':
      return 'merged';
    case 'failed':
      return 'failed';
  }
}

/**
 * Whether a retry is meaningful.
 *
 * Only a held entry qualifies. A held entry is still in the queue and its cause — a dirty
 * checkout — is exactly what the user can go fix, so rechecking is the natural next move. A
 * failed entry has already left the queue; re-running it means enqueuing the run again, which is
 * a different action with a different button. And an entry mid-flight has nothing to retry.
 */
export function isRetryable(state: MergeQueueEntryState): boolean {
  return state === 'blocked-environment';
}

/** Rebasing, verifying or merging — actively moving, so leave it alone. */
export function isMidFlight(state: MergeQueueEntryState): boolean {
  return state === 'rebasing' || state === 'verifying' || state === 'merging';
}

/** A held entry is stalled indefinitely, which reads as urgent even though it is not a failure. */
function isStalled(state: MergeQueueEntryState): boolean {
  return state === 'blocked-environment';
}

/**
 * How long this entry has been in its CURRENT state.
 *
 * `enqueuedAt` cannot answer this — it never moves, so it only ever reports time
 * since queued. That distinction is the whole point: an entry that has been
 * `verifying` for two minutes is working, and one that has been `verifying` for
 * eleven is wedged, and both look identical measured from enqueue.
 *
 * Falls back to `enqueuedAt` for entries persisted before `stateSince` existed,
 * so an old entry renders a plausible number rather than NaN.
 */
export function elapsedInStateMs(entry: MergeQueueEntry, now: number): number {
  const since = entry.stateSince ?? entry.enqueuedAt;
  return now - new Date(since).getTime();
}

// How long a mid-flight step may run before it is worth a second look. Above the
// measured install+build+test verify (~2-3 min on this repo) and above the
// default verifyTimeoutSec is NOT the goal — the point is to surface a suspicious
// entry BEFORE the server's timeout fires, so a human sees "this is taking
// unusually long" rather than only ever seeing the failure after the fact.
const OVERDUE_MS = 8 * 60 * 1000;

/**
 * Whether a mid-flight entry has been in its step long enough to be suspicious.
 *
 * Deliberately only mid-flight states. A `blocked-environment` entry is waiting
 * on a human by design and a `queued` one is waiting its turn — neither is
 * overdue however long it sits, and flagging them would cry wolf on the entirely
 * normal case, which is how a warning stops being read at all.
 */
export function isOverdue(entry: MergeQueueEntry, now: number): boolean {
  if (!isMidFlight(entry.state)) return false;
  return elapsedInStateMs(entry, now) >= OVERDUE_MS;
}

export interface QueueRow {
  entry: MergeQueueEntry;
  /** 1-based place in line, as shown. */
  position: number;
  label: string;
  steps: Step[] | null;
  retryable: boolean;
  stalled: boolean;
  /**
   * A mid-flight step running unusually long — worth a look before the server's
   * verify timeout fires. Distinct from `stalled`, which means "waiting on you by
   * design"; this one means "this should have finished by now".
   */
  overdue: boolean;
  /** How long in the current state, for the row's elapsed readout. */
  elapsedSince: string;
  /** Present on held and failed entries — why it is not moving. */
  reason: string | null;
}

export function toQueueRows(
  entries: MergeQueueEntry[],
  now: number = Date.now()
): QueueRow[] {
  return entries.map((entry, i) => ({
    entry,
    position: i + 1,
    label: queueStateLabel(entry.state),
    steps: phaseSteps(entry.state, entry.steps),
    retryable: isRetryable(entry.state),
    stalled: isStalled(entry.state),
    overdue: isOverdue(entry, now),
    // Time in the current state, not time since enqueue — see elapsedInStateMs.
    elapsedSince: entry.stateSince ?? entry.enqueuedAt,
    reason: entry.reason ?? null,
  }));
}

/** How many held entries a single recheck would retry — the Retry button's subject. */
export function heldCount(entries: MergeQueueEntry[]): number {
  return entries.filter((e) => isRetryable(e.state)).length;
}
