import type { MergeQueueEntryState, VerifyStepResult } from '@dispatch/client';

import type { Step } from '@/ui/chrome/StepStrip';

/**
 * How the Landing table reads one merge-queue entry: its progress strip, its
 * label, and whether a retry is meaningful.
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
    'waiting-github': 0,
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
      return 'held: checkout not clean';
    case 'waiting-github':
      return 'Waiting on GitHub';
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
 * failed entry has already left the queue; re-running it means enqueuing the run again — a
 * different action entirely, not a recheck. And an entry mid-flight has nothing to retry.
 */
export function isRetryable(state: MergeQueueEntryState): boolean {
  return state === 'blocked-environment';
}
