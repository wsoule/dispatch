import type { TaskDoc } from '@dispatch/core';

// Mirrors core/graph.ts's `isDone` (status is one of the two built-in
// terminal states) purely so the board/list can show a "blocked" badge
// without a runtime import from @dispatch/core — this package only imports
// core *types*, never its functions (see the phase-2 plan's web constraint).
// This is display-only: it never gates what's safe to start — that stays
// server-side via GET /api/tasks/ready, whose result flows into readyIds.
function isTerminal(doc: TaskDoc): boolean {
  return doc.meta.status === 'done' || doc.meta.status === 'cancelled';
}

// Ids of every task that lists at least one blocker id resolving to a
// non-terminal task. Dangling blocker ids (no matching task in the set)
// don't block, matching core's readyTasks semantics. Computed once over the
// whole task list so the board/list can look up "is this card blocked?" in
// O(1) per card instead of re-walking blockers for each one.
export function computeBlockedIds(tasks: TaskDoc[]): Set<string> {
  const byId = new Map(tasks.map((t) => [t.meta.id, t]));
  const blocked = new Set<string>();
  for (const doc of tasks) {
    const hasUnresolvedBlocker = doc.meta.blockedBy.some((id) => {
      const blocker = byId.get(id);
      return blocker !== undefined && !isTerminal(blocker);
    });
    if (hasUnresolvedBlocker) blocked.add(doc.meta.id);
  }
  return blocked;
}
