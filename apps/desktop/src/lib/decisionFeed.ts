// The daemon's decision feed — everything awaiting a human, aggregated
// server-side (packages/server/src/decisionFeed.ts) and served by
// `GET /api/decisions`. This module is the desktop's client for it: the mirror
// types, the fetch, and the pure mapping from a feed item to the in-app
// destination where that decision actually happens. The fetch lives here
// rather than on `ApiClient` only because @dispatch/client is outside this
// surface's write scope; it presents the same bearer token to the same
// daemon. Pure and relative-import only so it stays bun-testable.

import type { TaskTab } from './appNav';

/** Mirrors DecisionKind in packages/server/src/decisionFeed.ts. */
type DecisionKind =
  | 'approval'
  | 'scope-request'
  | 'memory'
  | 'doc'
  | 'question'
  | 'fix-loop-capped'
  | 'run-stalled';

/** Mirrors core's FloorCheck, plus the feed's `'unknown'` for a hold whose
 * check can no longer be named. */
type DecisionFloor =
  | 'force-push'
  | 'delete-outside-writes'
  | 'budget-cap'
  | 'publish'
  | 'repo-settings'
  | 'finding-ruling'
  | 'unknown';

/** Mirrors DecisionItem in packages/server/src/decisionFeed.ts: one thing
 * awaiting a human, as the daemon sees it right now. */
export interface DecisionItem {
  /** `<kind>:<source id>` — stable across recomputes, safe as a React key. */
  id: string;
  kind: DecisionKind;
  summary: string;
  reason?: string;
  /** `scope-request` only: every path the agent asked for. */
  paths?: string[];
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  /** When this started waiting. */
  since: string;
  ageMs: number;
  state: 'open' | 'resolved';
  resolvedAt?: string;
  /** Set when the irreversibility floor holds this item; it always blocks. */
  floor?: DecisionFloor;
  /** ActorRef of the human it is for (the run's, or a system gate's
   * addressee); absent means everyone's. */
  owner?: string;
  /** The gate message behind a gate item. */
  messageId?: string;
  /** The Overseer conversation an overseer-action or tool-approval gate is parked on. */
  conversation?: string;
  /** The policy engine's split: `blocking` items demand an answer, `recorded`
   * ones land quietly. Everything is `blocking` until epic e-ad1978 ships. */
  disposition: 'blocking' | 'recorded';
}

/**
 * Fetches the feed, resolved tail included — the panel renders a just-decided
 * item settling (dimmed, for the daemon's five-minute retention window) rather
 * than letting rows vanish out from under whoever is reading them.
 * `fetchFn` is a test seam; production callers pass nothing.
 */
export async function fetchDecisions(
  baseUrl: string,
  token: string | undefined,
  fetchFn: typeof fetch = fetch
): Promise<DecisionItem[]> {
  const headers: Record<string, string> =
    token !== undefined ? { authorization: `Bearer ${token}` } : {};
  const res = await fetchFn(`${baseUrl}/api/decisions?resolved=1`, { headers });
  if (!res.ok) throw new Error(`decision feed request failed: ${res.status}`);
  const body = (await res.json()) as { items: DecisionItem[] };
  return body.items;
}

/**
 * True for the daemon's "the feed's contents changed" broadcast. Typed against
 * the frame's structural shape rather than @dispatch/client's `ServerEvent`,
 * whose union predates this event — comparing against a literal outside the
 * union would be a type error, and widening here keeps the cast in one place.
 */
export function isDecisionsChanged(event: { type: string }): boolean {
  return event.type === 'decisions.changed';
}

/** Open items still demanding an answer — the shell badge's count. `recorded`
 * items are excluded by contract so the policy epic's reclassification quiets
 * the badge without this file changing. */
export function pendingDecisionCount(items: DecisionItem[]): number {
  return items.filter(
    (item) => item.state === 'open' && item.disposition === 'blocking'
  ).length;
}

/** Where clicking a decision lands: a task page on a specific tab (optionally
 * pinned to a run), the run itself when the feed could name no task, or a
 * gate message in Threads. */
export type DecisionTarget =
  | { kind: 'task'; taskId: string; tab: TaskTab; runId: string | null }
  | { kind: 'run'; runId: string }
  | { kind: 'thread'; messageId: string };

/**
 * Maps a feed item to the exact surface where its decision happens, so a
 * notification is a door and not just a fact. Pinning matters: the chat tab
 * renders the approval/scope/question cards only for the run it is pinned to.
 *
 * - approval / scope-request / question → the run's transcript, where the
 *   answer/approve cards render inline.
 * - memory, doc → the gate message in Threads, whose card shows the
 *   proposal. The item's id is `<kind>:<gate message id>`.
 * - fix-loop-capped → the task's review, where FixLoopSection takes the
 *   ruling.
 * - run-stalled → the run's review: the stranded work is the thing to look at.
 *
 * `null` only when the item names neither a task, a run nor a gate.
 */
export function decisionTarget(item: DecisionItem): DecisionTarget | null {
  if (item.kind === 'memory' || item.kind === 'doc') {
    return {
      kind: 'thread',
      messageId: item.messageId ?? item.id.slice(item.kind.length + 1),
    };
  }
  const tab: TaskTab =
    item.kind === 'fix-loop-capped' || item.kind === 'run-stalled'
      ? 'review'
      : 'run';
  if (item.taskId !== undefined) {
    return {
      kind: 'task',
      taskId: item.taskId,
      tab,
      runId: item.runId ?? null,
    };
  }
  if (item.runId !== undefined) return { kind: 'run', runId: item.runId };
  return null;
}
