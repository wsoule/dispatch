import type { TaskDoc } from '@dispatch/core';

// Mirrors packages/web/src/taskGraph.ts's `isTerminal`/`computeBlockedIds` —
// display-only blocked-badge logic duplicated here rather than pulled from
// @dispatch/client, since it never touches the network (unlike the
// api/useTasks/connectEvents pieces that package extracts) and both apps
// want it inline with their own board rendering. Never gates what's safe to
// start — that stays server-side via GET /api/tasks/ready, whose result
// flows into TasksPanel's readyIds.
function isTerminal(doc: TaskDoc): boolean {
  return doc.meta.status === 'done' || doc.meta.status === 'cancelled';
}

/** Ids of every task that lists at least one blocker id resolving to a non-terminal task.
 * Dangling blocker ids (no matching task in the set) don't block. Computed once over the
 * whole task list so the board can look up "is this card blocked?" in O(1) per card. */
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
