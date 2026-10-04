import type { RunMeta } from '@dispatch/client';

import type { RunQuestion, RunScopeRequest } from './gates';
import { isTerminalRunState } from './runState';

// Questions and scope gates an execute run asked stay open after it ends, and
// their answer reaches the task's next run, so they belong to the task.

/** The runs whose open asks a task's chat shows: the selected run, then the
 *  task's other ended execute runs, whose asks wait for the task. */
export function askRunIdsForChat(
  runs: readonly RunMeta[],
  selected: RunMeta
): string[] {
  const ended = runs
    .filter(
      (r) =>
        r.taskId === selected.taskId &&
        r.id !== selected.id &&
        (r.kind ?? 'execute') === 'execute' &&
        isTerminalRunState(r.state)
    )
    .map((r) => r.id);
  return [selected.id, ...ended];
}

/** Every open question the given runs asked, oldest first. */
export function questionsOfRuns(
  byRun: ReadonlyMap<string, readonly RunQuestion[]>,
  runIds: readonly string[]
): RunQuestion[] {
  return runIds
    .flatMap((id) => byRun.get(id) ?? [])
    .sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

/** The newest open scope gate among the given runs, or null. */
export function newestScopeRequestOf(
  byRun: ReadonlyMap<string, RunScopeRequest>,
  runIds: readonly string[]
): RunScopeRequest | null {
  let newest: RunScopeRequest | null = null;
  for (const id of runIds) {
    const request = byRun.get(id);
    if (
      request !== undefined &&
      (newest === null || request.requestedAt >= newest.requestedAt)
    ) {
      newest = request;
    }
  }
  return newest;
}

/** Tasks with an open question or scope gate from any of their runs, live or
 *  ended. */
export function taskIdsWithOpenAsks(
  runs: readonly RunMeta[],
  questions: ReadonlyMap<string, readonly RunQuestion[]>,
  scopeRequests: ReadonlyMap<string, RunScopeRequest>
): Set<string> {
  const asking = new Set<string>();
  for (const run of runs) {
    if ((questions.get(run.id)?.length ?? 0) > 0 || scopeRequests.has(run.id)) {
      asking.add(run.taskId);
    }
  }
  return asking;
}
