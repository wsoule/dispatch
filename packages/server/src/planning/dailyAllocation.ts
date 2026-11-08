import type {
  CommentStorePort,
  DispatchConfig,
  Person,
  TaskDoc,
  TaskStorePort,
  UpdatePatch,
} from '@dispatch-foo/core';
import { loadConfig, statusModelOf } from '@dispatch-foo/core';
import {
  type AllocationPlan,
  assessWorkspace,
  BLOCK_REASON_LABEL,
  buildEvalContext,
  buildWorkspaceData,
  type EvalContext,
  indexWorkspace,
  type MilestoneAssessment,
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
// first check on or after DAILY_HOUR local time, at most once a calendar day
// (startDailyJobs, which also runs the daily digest of warningRuns).

/** The local hour from which the day's runs may start. */
export const DAILY_HOUR = 8;

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

/** The planning chain over the daemon's own task docs, as of now. */
export interface PlanningNow {
  config: DispatchConfig;
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: Map<string, MilestoneAssessment>;
  plan: AllocationPlan;
}

/**
 * The same chain the desktop runs (@dispatch/planning's buildWorkspaceData →
 * assess → planAllocation), over the daemon's task docs and config.yml.
 */
export function planningNow(
  deps: Pick<AllocationDeps, 'rootDir' | 'store' | 'actor' | 'people' | 'now'>
): PlanningNow {
  const now = deps.now?.() ?? new Date();
  const config = loadConfig(deps.rootDir);
  const tasks: TaskDoc[] = deps.store.list();
  const workspace = buildWorkspaceData({
    tasks,
    model: statusModelOf(config),
    people: deps.people(),
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
  return { config, snapshot, ctx, assessments, plan };
}

/**
 * Plans and applies the allocation now, one issue at a time, and logs the
 * run (trigger `daily`). A refused update fails only that issue.
 */
export function applyAllocation(deps: AllocationDeps): AllocationRun {
  const { snapshot, plan } = planningNow(deps);

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

/** The local calendar day of an instant, YYYY-MM-DD. */
export function localDay(date: Date): string {
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

/** A job the daily timer runs: whether it is due now, and running it. */
export interface DailyJob {
  name: string;
  due: (now: Date) => boolean;
  run: () => unknown;
}

/**
 * The daemon's timer for the daily planning jobs (the allocation, the
 * digests): a first look a minute after boot, so a daemon started mid-morning
 * does not wait a whole interval, then every CHECK_EVERY_MS. A job that throws
 * (a config the loader refuses, a store not ready) is logged and tried again
 * at the next check rather than taking the daemon down.
 */
export function startDailyJobs(
  jobs: readonly DailyJob[],
  now: () => Date = () => new Date()
): { stop: () => void; check: () => Promise<void> } {
  const check = async (): Promise<void> => {
    for (const job of jobs) {
      try {
        if (job.due(now())) await job.run();
      } catch (err) {
        console.error(
          `dispatchd: ${job.name} skipped: ${(err as Error).message}`
        );
      }
    }
  };
  const first = setTimeout(() => void check(), FIRST_CHECK_MS);
  const timer = setInterval(() => void check(), CHECK_EVERY_MS);
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
