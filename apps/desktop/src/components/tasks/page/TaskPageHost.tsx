import type { EffortLevel } from '@dispatch-foo/core/browser';
import type { ReactNode } from 'react';
import { createContext, useContext } from 'react';

import type { DispatchProjectData } from '../../../hooks/useDispatchProject';
import type { ImpactSubjectRef, TaskTab } from '../../../lib/appNav';

/** The slice of the project the task page reads and writes through. App hands it the
 * whole project; tests fake only what they touch. */
export type TaskPageProject = Pick<
  DispatchProjectData,
  | 'client'
  | 'port'
  | 'daemonBaseUrl'
  | 'me'
  | 'messageAccess'
  | 'config'
  | 'executors'
  | 'health'
  | 'tasksIncludingArchived'
  | 'tasksReady'
  | 'runs'
  | 'latestRunByTaskId'
  | 'readinessById'
  | 'linearLinks'
  | 'linearStatus'
  | 'presence'
  | 'mergeQueue'
  | 'epicProgressById'
  | 'pendingApprovals'
  | 'openQuestions'
  | 'pendingScopeRequests'
  | 'scopeDecide'
  | 'enrichTaskId'
  | 'enrichPlanRecord'
  | 'handleUpdate'
  | 'moveTaskStatus'
  | 'handleEnrichTask'
  | 'handleDismissEnrich'
  | 'handleApprove'
  | 'fetchApprovalInput'
  | 'handleSendMessage'
  | 'handleAnswerQuestion'
  | 'handleDecideScopeRequest'
  | 'handleRestartDaemon'
  | 'handleRequestChanges'
  | 'handleReview'
  | 'handlePublishRun'
  | 'handleOpenPr'
  | 'handleEnqueueMerge'
  | 'handleEnqueueMergeStack'
  | 'handleSyncLinear'
  | 'handleStopRun'
  | 'handleCancelRun'
>;

/**
 * What every task page draws a task with, provided once by App: the project, and where
 * its links go. Any surface renders `<TaskPage taskId layout>` without threading these.
 */
export interface TaskPageHost {
  /** The active project's display name, the first crumb. */
  projectName: string | null;
  project: TaskPageProject;
  /** Peeks a task from a link on the page (a blocker, a sub-issue, a crumb). */
  peekTask: (taskId: string) => void;
  /** Opens a task's full page, on a mode and run when given. */
  openTaskPage: (taskId: string, mode?: TaskTab, runId?: string) => void;
  /** Dispatches without the app's own error toast, rejecting when the daemon refuses.
   * `stayInPlace` keeps a split pane or peek where it is instead of opening the run. */
  dispatchTask: (
    taskId: string,
    executor: string | undefined,
    model: string | undefined,
    stayInPlace: boolean,
    /** The effort picker's choice; absent lets the daemon apply the config's. */
    effort?: EffortLevel
  ) => Promise<void>;
  /** Opens a run's pull request on the PR review page. */
  openPr: (runId: string) => void;
  openImpact: (subject: ImpactSubjectRef) => void;
  /** Opens a linked doc in the Docs view; absent hides the spec's Docs block, for a
   * window that cannot read docs. */
  openDoc?: (docId: string, anchor: string | null) => void;
  /** The task's message threads, which the Thread toggle shows; absent hides it. */
  threadView?: (taskId: string) => ReactNode;
  /** A run's worktree as files and as a shell; without them the page has no such tabs. */
  filesView?: (runId: string) => ReactNode;
  /** Summary lists the memory this task's runs wrote (Two views). */
  showLessons?: boolean;
  /** A milestone's plan opens a task as its own page, not a pane beside the plan (Two views). */
  planOpensPages?: boolean;
  /** Two views' page: properties as chips under the title, the column on demand, "‹ tasks" back. */
  compactPage?: boolean;
  /** A run's pull request reviewed in place; without it "Review PR" leaves for the PR page. */
  prView?: (runId: string, onClose: () => void) => ReactNode;
  terminalView?: (runId: string) => ReactNode;
}

export const TaskPageHostContext = createContext<TaskPageHost | null>(null);

export function useTaskPageHost(): TaskPageHost | null {
  return useContext(TaskPageHostContext);
}
