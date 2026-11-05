import type {
  EffortLevel,
  StatusModel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';

import type { ActivityEntry } from '../../../lib/activityFeed';
import type { DispatchReadiness } from '../../../lib/dispatchReadiness';
import { isTerminalRunState } from '../../../lib/runState';
import type { TaskPageMode } from '../../../lib/taskPageMode';
import type { TaskPageHost, TaskPageProject } from './TaskPageHost';

/**
 * Everything a mode of the task page draws from, resolved once by the page: the task's
 * cached metadata (instant), its body sections (null until fetched), its runs, and the
 * page's own actions, each of which reports its failure as a toast.
 */
export interface TaskPageModel {
  host: TaskPageHost;
  project: TaskPageProject;
  /** Mounted inside another view (the Overseer's focus column) rather than as the Tasks
   * page: a dispatch stays in place instead of opening the run, and the plan does not
   * take keyboard focus when it mounts. */
  embedded: boolean;
  item: TaskListItem;
  /** False until the task's body has loaded. */
  bodyLoaded: boolean;
  description: string;
  /** The Acceptance Criteria section as written. */
  acceptance: string;
  criteria: string[];
  amendments: string;
  activity: ActivityEntry[];
  /** Execute runs, newest first. */
  runs: RunMeta[];
  /** Runs of every kind (review and verify too), newest first. */
  allRuns: RunMeta[];
  /** The run the Run and Review modes show: the one picked (any kind), else the newest
   * execute run. */
  selectedRun: RunMeta | undefined;
  selectRun: (runId: string) => void;
  isContainer: boolean;
  /** Direct children, for a container. */
  children: readonly TaskListItem[];
  tasksById: ReadonlyMap<string, TaskListItem>;
  unmetBlockers: string[];
  /** Whether a task's latest run has ended: review where review shares dispatched's status. */
  finishedRun: (id: string) => boolean;
  /** Whether it can go now and what to check first; the card, the menu and `d` share it. */
  readiness: DispatchReadiness;
  /** The project's statuses, from its config in the render that carries it. */
  statusModel: StatusModel;
  patch: (patch: UpdatePatch) => Promise<void>;
  changeStatus: (status: string) => void;
  fail: (title: string, err: unknown) => void;
  /** Peeks another task. */
  openTask: (taskId: string) => void;
  selectMode: (mode: TaskPageMode) => void;
  dispatch: (
    executor?: string,
    model?: string,
    effort?: EffortLevel
  ) => Promise<void>;
  dispatching: boolean;
}

/**
 * The task id to read the task's verify result with, or `undefined` (no read) until
 * one of its verify runs has ended. The daemon keeps a result only for a finished
 * verify run and answers 404 otherwise, and the browser logs every 404 as a console
 * error, so Review and Summary ask only once a result can exist. The run's end and
 * `verification.changed` both refresh the read.
 */
export function verificationTaskId(
  page: Pick<TaskPageModel, 'item' | 'allRuns'>
): string | undefined {
  return page.allRuns.some(
    (run) => run.kind === 'verify' && isTerminalRunState(run.state)
  )
    ? page.item.meta.id
    : undefined;
}

/**
 * The task id to read the task's fix loop with, or `undefined` (no read) while the task
 * has no execute run: a loop opens off the task's latest implementer run, so before one
 * there is none, and the daemon's 404 would only log a console error.
 */
export function fixLoopTaskId(
  page: Pick<TaskPageModel, 'item' | 'runs'>
): string | undefined {
  return page.runs.length > 0 ? page.item.meta.id : undefined;
}
