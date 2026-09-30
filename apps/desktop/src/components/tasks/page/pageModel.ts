import type { RunMeta } from '@dispatch/client';
import type {
  EffortLevel,
  StatusModel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch/core/browser';

import type { ActivityEntry } from '../../../lib/activityFeed';
import type { DispatchReadiness } from '../../../lib/dispatchReadiness';
import type { TaskPageMode } from '../../../lib/taskPageMode';
import type { TaskPageHost, TaskPageProject } from './TaskPageHost';

/** Where the page is mounted: beside a list, in a dialog, or as the whole window. */
export type TaskPageLayout = 'split' | 'peek' | 'full';

/**
 * Everything a mode of the task page draws from, resolved once by the page: the task's
 * cached metadata (instant), its body sections (null until fetched), its runs, and the
 * page's own actions, each of which reports its failure as a toast.
 */
export interface TaskPageModel {
  host: TaskPageHost;
  project: TaskPageProject;
  layout: TaskPageLayout;
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
