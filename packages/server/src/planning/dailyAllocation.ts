import type {
  CommentStorePort,
  Person,
  TaskDoc,
  TaskStorePort,
  UpdatePatch,
} from '@dispatch-foo/core';
import { loadConfig, statusModelOf } from '@dispatch-foo/core';
import {
  assessWorkspace,
  BLOCK_REASON_LABEL,
  buildEvalContext,
  buildWorkspaceData,
  indexWorkspace,
  milestoneMetaFrom,
  planAllocation,
  type Snapshot,
  tuningFrom,
} from '@dispatch/planning';

import type {
  AllocationRun,
  AllocationRunInput,
  AllocationRunItem,
  AllocationRunStore,
} from './allocationRuns.js';

// The daily allocation (Better Tracker's daily run): when config.yml's
// `planning.allocation` is `daily`, the daemon applies the planning's
// allocation once a day on its own, the same chain the desktop's Apply runs
// (@dispatch/planning's buildWorkspaceData → assess → planAllocation), over
// the daemon's own task docs. Each unassigned issue in a project's next
// milestone goes to the project's lead and leaves Backlog, with a comment
// saying why, and the run is logged with trigger `daily`. It runs at the
// first check on or after DAILY_HOUR local time, at most once a calendar day.

/** The local hour from which the day's run may start. */
const DAILY_HOUR = 8;

/** How often the daemon checks whether today's run is due. */
const CHECK_EVERY_MS = 15 * 60 * 1000;

/** The first check after boot. */
const FIRST_CHECK_MS = 60 * 1000;

export interface AllocationDeps {
  rootDir: string;
  store: Pick<TaskStorePort, 'list' | 'update'>;
  comments: Pick<CommentStorePort, 'add'>;
  runs: AllocationRunStore;
  /** Who the run, its comments and its log entry are credited to. */
  actor: string;
  /** The people registry, for leads and the run log's names. */
  people: () => readonly Person[];
  /** After the changes: refresh caches and tell clients what changed. */
  changed: (taskIds: string[]) => void;
  now?: () => Date;
}

// The run log's comment on an allocated issue, as the desktop's Apply writes it.
function note(
  snapshot: Snapshot,
  projectId: string,
  milestoneId: string
): string {
  const project = snapshot.projects.get(projectId)?.name ?? 'the project';
  const milestone = snapshot.milestones.get(milestoneId);
  const due =
    milestone?.targetDate == null ? '' : `, due ${milestone.targetDate}`;
  return `Assigned by the daily allocation: you lead ${project} and this is in its next milestone ${milestone?.name ?? ''}${due}.`;
}

/**
 * Plans and applies the allocation now, one issue at a time, and logs the
 * run (trigger `daily`). A refused update fails only that issue.
 */
export function applyAllocation(deps: AllocationDeps): AllocationRun {
  const now = deps.now?.() ?? new Date();
  const config = loadConfig(deps.rootDir);
  const tasks: TaskDoc[] = deps.store.list();
  const people = deps.people();
  const workspace = buildWorkspaceData({
    tasks,
    model: statusModelOf(config),
    people,
    executors: [],
    me: deps.actor,
    hrefFor: (taskId) => taskId,
  });
  const ctx = buildEvalContext(
    now,
    tuningFrom(config.planning),
    milestoneMetaFrom(config.planning)
  );
  const snapshot = indexWorkspace(workspace);
  const assessments = assessWorkspace(snapshot, ctx);
  const plan = planAllocation(snapshot, ctx, assessments);

  const nameOf = (id: string) => snapshot.users.get(id)?.name ?? id;
  const items: AllocationRunItem[] = [];
  const changed: string[] = [];
  for (const project of plan.projects) {
    for (const action of project.actions) {
      const patch: UpdatePatch = { assignee: action.assigneeId };
      if (action.toStateId !== null) patch.status = action.toStateId;
      let failure: string | null = null;
      try {
        deps.store.update(action.issueId, patch);
        changed.push(action.issueId);
        deps.comments.add({
          taskId: action.issueId,
          author: deps.actor,
          body: note(snapshot, action.projectId, action.milestoneId),
        });
      } catch (err) {
        failure = (err as Error).message;
      }
      items.push({
        issueId: action.issueId,
        identifier: action.identifier,
        title: action.title,
        projectId: action.projectId,
        projectName: snapshot.projects.get(action.projectId)?.name ?? '',
        milestoneId: action.milestoneId,
        milestoneName: snapshot.milestones.get(action.milestoneId)?.name ?? '',
        assigneeId: action.assigneeId,
        assigneeName: nameOf(action.assigneeId),
        fromStatus: action.fromStateId,
        toStatus: action.toStateId,
        outcome: failure === null ? 'assigned' : 'failed',
        note: failure,
      });
    }
  }
  if (changed.length > 0) deps.changed(changed);
  const input: AllocationRunInput = {
    mode: 'applied',
    items,
    projects: plan.projects.map((project) => ({
      projectId: project.projectId,
      projectName: snapshot.projects.get(project.projectId)?.name ?? '',
      outcome: project.outcome,
      reason:
        project.blockReason === null
          ? null
          : BLOCK_REASON_LABEL[project.blockReason],
      skipped: project.skipped.length,
    })),
  };
  return deps.runs.record(input, deps.actor, 'daily');
}

// The local calendar day of an instant, YYYY-MM-DD.
function localDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whether today's daily run is due: the project asks for it, it is
 * DAILY_HOUR or later, and no daily run was logged today.
 */
export function dailyRunDue(deps: AllocationDeps, now: Date): boolean {
  if (loadConfig(deps.rootDir).planning?.allocation !== 'daily') return false;
  if (now.getHours() < DAILY_HOUR) return false;
  const today = localDay(now);
  return !deps.runs
    .list()
    .some(
      (run) => run.trigger === 'daily' && localDay(new Date(run.at)) === today
    );
}

/** The daemon's timer for the daily run; `stop` clears it. */
export function startDailyAllocation(deps: AllocationDeps): {
  stop: () => void;
  check: () => AllocationRun | null;
} {
  const check = (): AllocationRun | null => {
    const now = deps.now?.() ?? new Date();
    try {
      return dailyRunDue(deps, now) ? applyAllocation(deps) : null;
    } catch (err) {
      // A config the loader refuses, or a store that is not ready: try again
      // at the next check rather than take the daemon down.
      console.error(
        `dispatchd: daily allocation skipped: ${(err as Error).message}`
      );
      return null;
    }
  };
  // A first look soon after boot, so a daemon started mid-morning does not
  // wait a whole interval; then every CHECK_EVERY_MS.
  const first = setTimeout(check, FIRST_CHECK_MS);
  const timer = setInterval(check, CHECK_EVERY_MS);
  first.unref?.();
  timer.unref?.();
  return {
    stop: () => {
      clearTimeout(first);
      clearInterval(timer);
    },
    check,
  };
}
