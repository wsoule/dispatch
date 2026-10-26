// Per-milestone issue counts (§2.2).

import { isOpenState, issueStateType } from './snapshot';
import type { Issue, Progress, Snapshot } from './types';

/**
 * Counts the given issues the way §2.2 defines progress: canceled issues
 * (including duplicates) leave the scope; triage issues are open, and an open
 * triage issue with no assignee also counts as unassigned.
 */
export function progressOf(
  snapshot: Snapshot,
  issues: readonly Issue[]
): Progress {
  let completed = 0;
  let canceled = 0;
  let open = 0;
  let openUnassigned = 0;
  let openTriage = 0;
  for (const issue of issues) {
    const type = issueStateType(snapshot, issue);
    if (type === 'completed') completed += 1;
    else if (type === 'canceled') canceled += 1;
    if (!isOpenState(type)) continue;
    open += 1;
    if (issue.assigneeId === null) openUnassigned += 1;
    if (type === 'triage') openTriage += 1;
  }
  const total = issues.length;
  return {
    total,
    completed,
    canceled,
    scope: total - canceled,
    open,
    openUnassigned,
    openTriage,
  };
}

/** Progress of one milestone; all zeros for an unknown milestone. */
export function milestoneProgress(
  snapshot: Snapshot,
  milestoneId: string
): Progress {
  return progressOf(
    snapshot,
    snapshot.issuesByMilestone.get(milestoneId) ?? []
  );
}
