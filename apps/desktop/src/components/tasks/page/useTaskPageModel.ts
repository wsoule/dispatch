import type {
  EffortLevel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import {
  isContainer,
  isDoneStatus,
  statusLabel,
  statusType,
} from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { useTaskDoc } from '../../../hooks/useTaskDoc';
import { parseActivity } from '../../../lib/activityFeed';
import type { TaskTab } from '../../../lib/appNav';
import { liveClaimsFrom } from '../../../lib/dispatchPreview';
import {
  dispatchesOnKey,
  dispatchReadiness,
  unmetBlockers,
} from '../../../lib/dispatchReadiness';
import { criteriaItems } from '../../../lib/reviewCriteria';
import { isTerminalRunState } from '../../../lib/runState';
import { useStatusModelOf } from '../../../lib/statusModel';
import { parseTaskSections } from '../../../lib/taskDisplay';
import { childrenIn, taskIndexOf } from '../../../lib/taskIndex';
import {
  defaultTaskPageMode,
  executeRuns,
  type LifecycleStage,
  lifecycleStages,
  runsNewestFirst,
  type TaskPageMode,
  taskPageModes,
} from '../../../lib/taskPageMode';
import { useToasts } from '../../shell/Toasts';
import type { TaskPageModel } from './pageModel';
import type { TaskPageHost } from './TaskPageHost';

// The task page's model, resolved once per task for every mode (RunMode, ReviewMode,
// SummaryMode, PlanMode take it as `page`), plus the page's own state: which view the
// body shows and the lifecycle stages the tabs draw. Extracted from the old TaskPage so
// TaskPageView (on @dispatch/ui's TaskDetail) feeds the modes exactly what they had.

/** Every view the page body can show: a lifecycle mode or one of the side views (the
 * conversation, a run's preview, files or terminal). */
export type TaskPageView =
  | TaskPageMode
  | 'thread'
  | 'preview'
  | 'files'
  | 'terminal';

export function isStage(view: TaskPageView): view is TaskPageMode {
  return (
    view !== 'thread' &&
    view !== 'preview' &&
    view !== 'files' &&
    view !== 'terminal'
  );
}

export interface TaskPageModelOptions {
  /** The mode, when the caller keeps it (the Tasks page keeps it in history); omitted,
   * the hook holds it and starts on `auto`. */
  mode?: TaskTab;
  onModeChange?: (mode: TaskTab) => void;
  /** The run the Run and Review modes show, when the caller keeps it. */
  runId?: string | null;
  onSelectRun?: (runId: string) => void;
  /** Mounted inside another view (the Overseer's focus column): a dispatch stays in
   * place, the plan does not take focus, and there is no room for the run's preview. */
  embedded?: boolean;
}

/** Which side views the host offers for this task right now. */
interface TaskPageSideViews {
  thread: boolean;
  preview: boolean;
  files: boolean;
  terminal: boolean;
}

export interface TaskPageState {
  page: TaskPageModel;
  /** What the body shows: the view picked, else the one the task's state calls for. */
  view: TaskPageView;
  /** The mode the task's state calls for (`defaultTaskPageMode`). */
  autoMode: TaskPageMode;
  /** The lifecycle tabs: each mode the task offers, captioned and marked. */
  stages: LifecycleStage[];
  /** Shows a view; picking the state's own mode returns the page to following the
   * state (the caller's tab goes back to `auto`). */
  selectView: (view: TaskPageView) => void;
  sideViews: TaskPageSideViews;
  /** Dispatch may go now (a container never dispatches as one run). */
  canDispatch: boolean;
  /** `d` dispatches: the card offers its D (ready, or a blocker that is as good as done). */
  keyDispatches: boolean;
  latestRun: RunMeta | undefined;
}

// The view a tab asks for, or the state's own mode when the host does not offer that
// side view (no thread view, no run to preview) or the task has not got that mode (a
// container's Run).
function resolveView(
  requested: TaskTab,
  autoMode: TaskPageMode,
  modes: readonly TaskPageMode[],
  sideViews: TaskPageSideViews
): TaskPageView {
  switch (requested) {
    case 'auto':
      return autoMode;
    case 'thread':
    case 'preview':
    case 'files':
    case 'terminal':
      return sideViews[requested] ? requested : autoMode;
    default:
      return modes.includes(requested) ? requested : autoMode;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Something went wrong.';
}

/**
 * Resolves `item` (a task the window knows) for the page's modes: the task's cached
 * metadata at once, its body sections as they arrive, its runs and readiness, and the
 * actions every mode shares (patch, change status, dispatch, select a mode or a run),
 * each reporting its failure as a toast. The view follows the task's state until a tab
 * is picked by hand.
 */
export function useTaskPageModel(
  host: TaskPageHost,
  item: TaskListItem,
  {
    mode: controlledMode,
    onModeChange,
    runId: controlledRunId,
    onSelectRun,
    embedded = false,
  }: TaskPageModelOptions
): TaskPageState {
  const { project } = host;
  const meta = item.meta;
  const taskId = meta.id;
  const toasts = useToasts();
  const [localMode, setLocalMode] = useState<TaskTab>('auto');
  const [localRunId, setLocalRunId] = useState<string | null>(null);
  // Set from a dispatch until its run shows up: the ids of the runs that already existed.
  const [awaitingRun, setAwaitingRun] = useState<ReadonlySet<string> | null>(
    null
  );

  const doc = useTaskDoc(project.client, project.port, taskId);
  const body = doc?.body ?? null;
  const sections = useMemo(
    () => (body === null ? null : parseTaskSections(body)),
    [body]
  );
  const description = sections?.get('Description') ?? '';
  const acceptance = sections?.get('Acceptance Criteria') ?? '';
  const activitySection = sections?.get('Activity') ?? '';
  const criteria = useMemo(() => criteriaItems(acceptance), [acceptance]);
  const activity = useMemo(
    () => parseActivity(activitySection),
    [activitySection]
  );

  const tasks = project.tasksIncludingArchived;
  const index = useMemo(() => taskIndexOf(tasks), [tasks]);
  const tasksById = index.byId;
  const container = isContainer(meta, index.parentIds);
  const children = useMemo(() => childrenIn(index, taskId), [index, taskId]);
  const allRuns = useMemo(
    () => runsNewestFirst(project.runs.filter((r) => r.taskId === taskId)),
    [project.runs, taskId]
  );
  const runs = useMemo(() => executeRuns(allRuns), [allRuns]);
  const latestRun = runs[0];
  const model = useStatusModelOf(project.config);
  const unmet = useMemo(
    () => unmetBlockers(item, tasksById, model),
    [item, tasksById, model]
  );
  const stateInput = {
    statusType: statusType(meta.status, model),
    isContainer: container,
    latestRun,
  };
  const autoMode = defaultTaskPageMode(stateInput);
  const modes = taskPageModes(container);
  const requested = controlledMode ?? localMode;
  const { threadView, filesView, terminalView } = host;
  const sideViews: TaskPageSideViews = {
    thread: threadView !== undefined,
    preview: !embedded && latestRun !== undefined,
    files: filesView !== undefined && latestRun !== undefined,
    terminal: terminalView !== undefined && latestRun !== undefined,
  };
  const view = resolveView(requested, autoMode, modes, sideViews);
  const selectedRunId = controlledRunId ?? localRunId;
  // Any kind: a review or verify run opened by id (the live rail, the inbox) shows itself.
  const selectedRun = allRuns.find((r) => r.id === selectedRunId) ?? latestRun;

  // A dispatch counts as landed once a run it did not already know about appears, or
  // after a while regardless (the card's spinner must not stick).
  useEffect(() => {
    if (awaitingRun === null) return;
    if (runs.some((r) => !awaitingRun.has(r.id))) setAwaitingRun(null);
  }, [runs, awaitingRun]);
  useEffect(() => {
    if (awaitingRun === null) return;
    const timer = setTimeout(() => setAwaitingRun(null), 15_000);
    return () => clearTimeout(timer);
  }, [awaitingRun]);

  const fail = useCallback(
    (title: string, err: unknown) => {
      toasts.push({ title, description: errorMessage(err), tone: 'error' });
    },
    [toasts]
  );
  const { handleUpdate, moveTaskStatus } = project;
  const patch = useCallback(
    async (next: UpdatePatch) => {
      try {
        await handleUpdate(taskId, next);
      } catch (err) {
        fail('Could not save the task', err);
      }
    },
    [handleUpdate, taskId, fail]
  );
  const changeStatus = useCallback(
    (status: string) => {
      moveTaskStatus(taskId, status).catch((err: unknown) =>
        fail('Could not change the status', err)
      );
    },
    [moveTaskStatus, taskId, fail]
  );
  const selectView = useCallback(
    (next: TaskPageView) => {
      // Picking the state's own mode returns the page to following the state.
      const tab: TaskTab = next === autoMode ? 'auto' : next;
      if (onModeChange !== undefined) onModeChange(tab);
      else setLocalMode(tab);
    },
    [autoMode, onModeChange]
  );
  const selectRun = useCallback(
    (runId: string) => {
      if (onSelectRun !== undefined) onSelectRun(runId);
      else setLocalRunId(runId);
    },
    [onSelectRun]
  );
  const { dispatchTask } = host;
  const dispatching = awaitingRun !== null;
  const dispatch = useCallback(
    async (executor?: string, runModel?: string, effort?: EffortLevel) => {
      const known = new Set(runs.map((r) => r.id));
      setAwaitingRun(known);
      try {
        await dispatchTask(taskId, executor, runModel, embedded, effort);
      } catch (err) {
        setAwaitingRun(null);
        fail('Dispatch failed', err);
      }
    },
    [dispatchTask, taskId, embedded, runs, fail]
  );
  // One verdict for the card, the header menu and `d`.
  const liveClaims = useMemo(
    () => liveClaimsFrom(project.runs),
    [project.runs]
  );
  const readiness = dispatchReadiness({
    task: item,
    body: sections === null ? null : { description, criteria },
    tasksById,
    model,
    liveRun: runs.find((r) => !isTerminalRunState(r.state)),
    reading: project.readinessById.get(taskId),
    liveClaims,
  });
  // A container goes out from its plan, never as one run.
  const canDispatch = !container && readiness.canDispatch;
  const keyDispatches = !container && dispatchesOnKey(readiness);
  const peekTask = host.peekTask;
  // A link to the task itself goes nowhere; any other task quick-looks in the slide-over.
  const openTask = useCallback(
    (id: string) => {
      if (id !== taskId) peekTask(id);
    },
    [peekTask, taskId]
  );

  const page: TaskPageModel = {
    host,
    project,
    embedded,
    item,
    bodyLoaded: sections !== null,
    description,
    acceptance,
    criteria,
    amendments: sections?.get('Amendments') ?? '',
    activity,
    runs,
    allRuns,
    selectedRun,
    selectRun,
    isContainer: container,
    children,
    tasksById,
    unmetBlockers: unmet,
    readiness,
    statusModel: model,
    patch,
    changeStatus,
    fail,
    openTask,
    selectMode: selectView,
    dispatch,
    dispatching,
  };

  const stages = lifecycleStages({
    ...stateInput,
    runs,
    criteriaCount: sections === null ? null : criteria.length,
    writesCount: meta.writes.length,
    unmetBlockers: unmet.length,
    statusLabel: statusLabel(meta.status),
    children: {
      total: children.length,
      done: children.filter((c) => isDoneStatus(c.meta.status, model)).length,
      running: children.filter((c) => {
        const run = project.latestRunByTaskId.get(c.meta.id);
        return run !== undefined && !isTerminalRunState(run.state);
      }).length,
    },
  });

  return {
    page,
    view,
    autoMode,
    stages,
    selectView,
    sideViews,
    canDispatch,
    keyDispatches,
    latestRun,
  };
}
