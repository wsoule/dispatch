import type { RunMeta } from '@dispatch/client';

/**
 * Drops every run belonging to an archived task, for the Runs list when the
 * "show archived" toggle is off — otherwise a run whose task has since been
 * archived would linger in the Runs view forever with nothing left to act on
 * it. Returns the same array reference when nothing needs filtering (empty
 * `archivedTaskIds`), so callers get referential stability instead of a new
 * array every render. Pure so the toggle's filtering is unit-testable
 * without a live tasks/runs fetch.
 */
export function hideArchivedRuns(
  runs: RunMeta[],
  archivedTaskIds: Set<string>
): RunMeta[] {
  if (archivedTaskIds.size === 0) return runs;
  return runs.filter((run) => !archivedTaskIds.has(run.taskId));
}
