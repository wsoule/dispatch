import type {
  LinearStatus,
  LinearSyncSummary,
  LinearWorkflowState,
} from '@dispatch/client';

/** Sentinel for "no team state chosen" in the status-map editor's `<select>` — native select
 *  values can't be the empty string, matching PropertyControls' `NO_EPIC` convention. */
export const NO_LINEAR_STATE = '__unmapped__';

/** Whether there is enough Linear config to actually run a sync: connected and a team chosen.
 *  Gates the enable toggle and the "Sync now" button so neither fires against a half-set-up
 *  connection. */
export function isLinearConfigured(status: LinearStatus | null): boolean {
  return (
    status !== null &&
    status.connected &&
    status.teamId !== null &&
    status.teamId.trim() !== ''
  );
}

/** The workflow-state id a configured status-map name currently resolves to, matched
 *  case-insensitively against `states`. Returns the "unmapped" sentinel both for an empty
 *  entry and for a name that no longer matches any state in `states` — the latter is exactly
 *  what happens right after the team changes, so the editor shows an honest "not mapped"
 *  instead of a stale selection. */
export function resolveMappedStateId(
  name: string | undefined,
  states: LinearWorkflowState[]
): string {
  if (name === undefined || name.trim() === '') return NO_LINEAR_STATE;
  const wanted = name.trim().toLowerCase();
  return (
    states.find((s) => s.name.toLowerCase() === wanted)?.id ?? NO_LINEAR_STATE
  );
}

/** How many of `statuses` currently resolve to a real state in `states`, and which don't —
 *  feeds the status-map editor's summary line and lets it flag unmapped rows. */
export function statusMapCompleteness(
  statuses: readonly string[],
  statusMap: Record<string, string>,
  states: LinearWorkflowState[]
): { mapped: number; total: number; unmapped: string[] } {
  const unmapped = statuses.filter(
    (status) =>
      resolveMappedStateId(statusMap[status], states) === NO_LINEAR_STATE
  );
  return {
    mapped: statuses.length - unmapped.length,
    total: statuses.length,
    unmapped,
  };
}

/** A short line of what one sync pass did, every zero-valued count omitted — "Nothing changed"
 *  when the pass was a no-op. Errors and the rate-limit flag are the caller's own concern
 *  (a sync can 200 and still carry them), so they are deliberately not folded in here. */
export function formatSyncCounts(summary: LinearSyncSummary): string {
  const parts: string[] = [];
  if (summary.pulled > 0) parts.push(`${summary.pulled} pulled`);
  if (summary.pushed > 0) parts.push(`${summary.pushed} pushed`);
  if (summary.created > 0) parts.push(`${summary.created} created locally`);
  if (summary.createdIssues > 0) {
    parts.push(`${summary.createdIssues} created in Linear`);
  }
  if (summary.conflicts > 0) {
    parts.push(`${summary.conflicts} conflict(s) kept local`);
  }
  return parts.length === 0 ? 'Nothing changed' : parts.join(' · ');
}
