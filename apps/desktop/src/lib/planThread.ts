import type {
  PlanProposal,
  PlanRecord,
  ProposalAction,
} from '@dispatch/client';
import { reduceProposal } from '@dispatch/client';

// One rendered row of a plan's conversation. `message` rows come straight from
// the server transcript; `pending` and `failed` are the *current turn's* live
// state rendered as a trailing row, so "the planner is answering" and "the
// planner's answer errored" read as part of the thread rather than as banners
// somewhere else on the page.
export type PlanThreadItem =
  | {
      kind: 'message';
      key: string;
      role: 'user' | 'assistant';
      text: string;
      at: string;
    }
  | { kind: 'pending'; key: string }
  | { kind: 'failed'; key: string; error: string };

const TURN_FAILED_FALLBACK =
  'The planner stopped before it answered. Send the message again to retry.';

/**
 * Flattens a plan record into the rows the Plans view renders. The transcript
 * is append-only server-side (every turn pushes the user message, then the
 * assistant reply), so a message's array position is a stable React key.
 * A `running` record always has a user message with no reply yet — that's the
 * trailing `pending` row; a `failed` one lost its reply — that's the trailing
 * `failed` row, which carries the server's own error text when it sent one.
 */
export function buildPlanThread(
  record: PlanRecord | undefined
): PlanThreadItem[] {
  if (record === undefined) return [];
  const items: PlanThreadItem[] = record.messages.map((message, i) => ({
    kind: 'message',
    key: `${record.id}-msg-${i}`,
    role: message.role,
    text: message.text,
    at: message.at,
  }));
  if (record.state === 'running') {
    items.push({ kind: 'pending', key: `${record.id}-pending` });
  } else if (record.state === 'failed') {
    items.push({
      kind: 'failed',
      key: `${record.id}-failed`,
      error:
        record.error !== undefined && record.error.trim() !== ''
          ? record.error
          : TURN_FAILED_FALLBACK,
    });
  }
  return items;
}

// The editable proposal the review list renders, plus everything needed to
// keep it in sync with a conversation that keeps producing new proposals.
export interface PlanDraft {
  /** Which plan this draft belongs to — switching plans always re-seeds. */
  planId: string;
  /** The edited proposal: what the review list renders and confirm submits. */
  proposal: PlanProposal;
  /** Stable per-row identity for `proposal.tasks` — same length, same order.
   * Index-based keys would make React reuse a row's DOM node (and its focus and
   * scroll position) for whatever task slides into that index after a removal,
   * which reads as one row's in-progress edit jumping to a different task. */
  taskKeys: string[];
  /** The last *server* proposal this draft was seeded from. Comparing against
   * it is what tells "the planner refined the plan on a new turn" (adopt it)
   * apart from "a poll returned the same plan again" (keep local edits). */
  base: PlanProposal;
  /** How many server proposals this draft has adopted. Mixed into `taskKeys`
   * so a row minted by a later turn can never collide with an earlier one. */
  revision: number;
}

/**
 * Folds the server's current proposal into the local draft. A brand-new plan
 * (or a different one) seeds from scratch; an unchanged proposal returns the
 * previous draft *by identity* so local edits survive the plan query's polling;
 * a changed proposal replaces the draft, because the user asked the planner for
 * that revision and the planner has no idea what they edited by hand meanwhile.
 */
export function syncPlanDraft(
  prev: PlanDraft | null,
  incoming: PlanProposal,
  planId: string
): PlanDraft {
  if (prev === null || prev.planId !== planId) {
    return seedDraft(incoming, planId, 0);
  }
  if (proposalsEqual(prev.base, incoming)) return prev;
  return seedDraft(incoming, planId, prev.revision + 1);
}

function seedDraft(
  proposal: PlanProposal,
  planId: string,
  revision: number
): PlanDraft {
  return {
    planId,
    proposal,
    taskKeys: proposal.tasks.map(
      (_, i) => `plan-task-${planId}-r${revision}-${i}`
    ),
    base: proposal,
    revision,
  };
}

/**
 * Applies one review-list edit to a draft, keeping `taskKeys` in lockstep with
 * `proposal.tasks` — `removeTask` is the only action that changes the row set,
 * so it's the only one that has to splice the keys too. Edits deliberately
 * leave `base` alone: the draft stays "edited away from the last server
 * proposal" until a new turn hands down a different one.
 */
export function editPlanDraft(
  draft: PlanDraft,
  action: ProposalAction
): PlanDraft {
  const proposal = reduceProposal(draft.proposal, action);
  if (proposal === draft.proposal) return draft;
  return {
    ...draft,
    proposal,
    taskKeys:
      action.type === 'removeTask'
        ? draft.taskKeys.filter((_, i) => i !== action.index)
        : draft.taskKeys,
  };
}

/** Structural comparison of two proposals — field-by-field rather than a
 * JSON.stringify of each, so a serializer that emits the same fields in a
 * different order never reads as a change the user has to re-review. */
export function proposalsEqual(a: PlanProposal, b: PlanProposal): boolean {
  if (a === b) return true;
  if ((a.epic === undefined) !== (b.epic === undefined)) return false;
  if (a.epic !== undefined && b.epic !== undefined) {
    if (a.epic.title !== b.epic.title) return false;
    if (a.epic.description !== b.epic.description) return false;
  }
  if (a.tasks.length !== b.tasks.length) return false;
  return a.tasks.every((task, i) => {
    const other = b.tasks[i];
    return (
      task.title === other.title &&
      task.description === other.description &&
      task.priority === other.priority &&
      sameStrings(task.acceptanceCriteria, other.acceptanceCriteria) &&
      sameNumbers(task.blockedByIndices, other.blockedByIndices)
    );
  });
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function sameNumbers(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
