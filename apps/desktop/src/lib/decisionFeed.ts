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
export type DecisionKind =
  | 'approval'
  | 'scope-request'
  | 'question'
  | 'fix-loop-capped'
  | 'run-stalled';

/** Mirrors DecisionItem in packages/server/src/decisionFeed.ts: one thing
 * awaiting a human, as the daemon sees it right now. */
export interface DecisionItem {
  /** `<kind>:<source id>` — stable across recomputes, safe as a React key. */
  id: string;
  kind: DecisionKind;
  summary: string;
  reason?: string;
  runId?: string;
  taskId?: string;
  taskTitle?: string;
  /** When this started waiting. */
  since: string;
  ageMs: number;
  state: 'open' | 'resolved';
  resolvedAt?: string;
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
 * pinned to a run), or — when the item's run was never tied to a task the
 * feed could name — the run itself, routed by App's own run lookup. */
export type DecisionTarget =
  | { kind: 'task'; taskId: string; tab: TaskTab; runId: string | null }
  | { kind: 'run'; runId: string };

/**
 * Maps a feed item to the exact surface where its decision happens, so a
 * notification is a door and not just a fact. Pinning matters: the chat tab
 * renders the approval/scope/question cards only for the run it is pinned to.
 *
 * - approval / scope-request / question → the run's chat transcript, where the
 *   answer/approve cards render inline.
 * - fix-loop-capped → the task's details tab, where FixLoopSection takes the
 *   ruling.
 * - run-stalled → the run's diff: the stranded work is the thing to look at.
 *
 * `null` only when the item names neither a task nor a run — nothing to open.
 */
export function decisionTarget(item: DecisionItem): DecisionTarget | null {
  const tab: TaskTab =
    item.kind === 'fix-loop-capped'
      ? 'details'
      : item.kind === 'run-stalled'
        ? 'diff'
        : 'chat';
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

/** The row's kind chip — a two-word ceiling, since it sits beside the summary
 * rather than replacing it. */
export const DECISION_KIND_LABELS: Record<DecisionKind, string> = {
  approval: 'Approval',
  'scope-request': 'Scope',
  question: 'Question',
  'fix-loop-capped': 'Fix loop',
  'run-stalled': 'Stalled',
};
