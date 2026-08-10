import { git } from '@dispatch/demo/git';
import { TEAMMATE } from '@dispatch/demo/paths';
import type { SessionPaths } from '@dispatch/demo/seed';
import {
  addTaskIn,
  claimIn,
  conflictIn,
  findTaskFile,
} from '@dispatch/demo/teammate';

export interface TeammateAction {
  atMs: number;
  run(paths: SessionPaths): void;
}

// The task the teammate claims at 45s: seeded `todo` and assigned to the
// owner (not the teammate), so the claim is a real, visible assignee change
// — see board.ts's comment on t-1d77e5, the same target the CLI runbook
// uses. Also anchors sessions.ts's 5-minute conflict fallback.
export const CLAIM_TASK_ID = 't-1d77e5';

// Rebases the teammate's clone onto whatever board state has landed since it
// was last synced, before either half of a beat touches a file.
function pull(paths: SessionPaths): void {
  git(paths.teammateRoot, 'pull', '-q', '--rebase');
}

/** Fixed timeline: claim a seeded todo task at 45s, file a new task at 120s. */
export const TIMELINE: TeammateAction[] = [
  {
    atMs: 45_000,
    run(paths) {
      pull(paths);
      const file = findTaskFile(paths.teammateRoot, CLAIM_TASK_ID);
      claimIn(paths.teammateRoot, file, TEAMMATE.handle);
    },
  },
  {
    atMs: 120_000,
    run(paths) {
      pull(paths);
      addTaskIn(paths.teammateRoot);
    },
  },
];

/**
 * Pull, then move `taskId` to in-progress as the teammate — the conflict
 * beat. Called by the manager ~30s after the visitor's first task mutation,
 * or (absent one) 5 minutes in against `CLAIM_TASK_ID`.
 */
export function conflictOn(paths: SessionPaths, taskId: string): void {
  pull(paths);
  const file = findTaskFile(paths.teammateRoot, taskId);
  conflictIn(paths.teammateRoot, file);
}

/**
 * Schedules every `TIMELINE` action against `paths`, handing each timer to
 * `register` so the caller (SessionManager) can clear it on destroy.
 */
export function scheduleTeammate(
  paths: SessionPaths,
  register: (t: ReturnType<typeof setTimeout>) => void
): void {
  for (const action of TIMELINE) {
    register(setTimeout(() => action.run(paths), action.atMs));
  }
}
