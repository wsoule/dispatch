import type {
  LabelDefinition,
  StatusModel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import { isCanceledStatus, isContainerKind } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import type {
  EstimateChoice,
  LabelChoice,
  SaveResult,
  StateChoice,
  TaskActivityItem,
  TaskDetailAlert,
  TaskSearchResult,
} from '@dispatch/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { AssigneeChoice } from '../../../adapters/people';
import {
  acceptancePatch,
  blockerAddPatch,
  blockerRemovePatch,
  blocksRemovePatch,
  buildDetailActivity,
  buildDetailAlerts,
  buildDetailComments,
  buildDetailDescription,
  buildDetailFacts,
  buildDetailHeader,
  buildDetailRelations,
  descriptionPatch,
  type DetailComment,
  type DetailContext,
  type DetailDescription,
  type DetailFact,
  type DetailHeader,
  type DetailRelations,
  type EditableFactId,
  estimateChoices,
  type FactValues,
  labelChoices,
  patchFor,
  personChoices,
  type PlanChoices,
  planChoices,
  type RelationError,
  relationSearch,
  stateChoices,
} from '../../../adapters/taskDetail';
import { useTaskComments } from '../../../hooks/useTaskComments';
import { useTaskDoc } from '../../../hooks/useTaskDoc';
import type { TaskTab } from '../../../lib/appNav';
import { liveClaimsFrom } from '../../../lib/dispatchPreview';
import {
  type DispatchReadiness,
  dispatchReadiness,
} from '../../../lib/dispatchReadiness';
import { isTerminalRunState } from '../../../lib/runState';
import { taskHref } from '../../../lib/shellRoutes';
import { useStatusModelOf } from '../../../lib/statusModel';
import { dayFromNow } from '../../../lib/taskDates';
import { childrenIn, taskIndexOf } from '../../../lib/taskIndex';
import { executeRuns, runsNewestFirst } from '../../../lib/taskPageMode';
import { usePeople } from '../../people/PeopleContext';
import { useDeepLinkActions } from '../../shell/DeepLinkContext';
import { useShellActions } from '../../shell/ShellActionsContext';
import type { TaskPageHost } from '../page/TaskPageHost';

// One task, resolved for the quick-look drawer (TaskDrawer) and the task page
// (page/TaskPageView, through useTaskDetailProps): the cached list
// item, its body and comments as they stream in, its runs and readiness, and
// the plain models @dispatch/ui's TaskDetail family takes (adapters/taskDetail),
// plus every write the drawer can make as a SaveResult-returning callback. The
// edit controls own the pending state: each callback returns the mutation's
// promise, the host's value moves after the refetch, and a rejection rolls the
// control back and prints the message beside it. Nothing here renders.

/** Why a blocker could not be added, as the relation picker prints it. */
const RELATION_ERROR: Record<RelationError, string> = {
  self: 'A task cannot block itself.',
  duplicate: 'Already a blocker of this task.',
  missing: 'That task is not in this project.',
  cycle: 'That would make a dependency cycle.',
};

const NO_LABELS: readonly LabelDefinition[] = [];

/** The picker choices the drawer's controls list. */
interface DetailChoices {
  states: StateChoice[];
  people: AssigneeChoice[];
  labels: LabelChoice[];
  plans: PlanChoices;
  estimates: EstimateChoice[];
}

/** Everything the drawer draws and does for one task. */
export interface TaskDetailState {
  item: TaskListItem;
  header: DetailHeader;
  alerts: TaskDetailAlert[];
  /** The property sheet, status included (the view decides where it goes). */
  facts: DetailFact[];
  choices: DetailChoices;
  relations: DetailRelations;
  /** Null while the body is still loading. */
  description: DetailDescription | null;
  /** Null while the first fetch is in flight. */
  comments: DetailComment[] | null;
  commentsError: string | null;
  /** Null while the body is still loading (the Activity section is in it). */
  activity: TaskActivityItem[] | null;
  /** The task's execute runs, newest first. */
  runs: RunMeta[];
  latestRun: RunMeta | undefined;
  readiness: DispatchReadiness;
  /** The project's status model (which statuses are done, canceled…). */
  statusModel: StatusModel;
  /** The task is a container (a milestone, a project, a parent issue). */
  container: boolean;
  /** Its direct children, in list order. */
  children: readonly TaskListItem[];
  canEdit: boolean;
  archived: boolean;
  /** Already canceled: Drop has nothing to do. */
  dropped: boolean;
  /** A dispatch went out and its run has not shown up yet. */
  dispatching: boolean;
  /** `me`, for the assignee picker's "You" row. */
  me: string | null;
  /** The clock every relative date in the models was read against. */
  now: Date;

  saveTitle: (title: string) => SaveResult;
  saveStatus: (status: string) => SaveResult;
  saveFact: <K extends EditableFactId>(
    id: K,
    next: FactValues[K]
  ) => SaveResult;
  saveDescription: (text: string) => SaveResult;
  saveAcceptance: (text: string) => SaveResult;
  /** Rejects with the reason when the link is refused (itself, a repeat, an
   * unknown task, a cycle), so the picker prints it and writes nothing. */
  addBlocker: (otherId: string) => Promise<unknown>;
  removeBlocker: (otherId: string) => SaveResult;
  /** Edits the other task: it stops waiting on this one. */
  removeBlocks: (otherId: string) => SaveResult;
  /** The relation picker's search over the window's tasks. */
  searchRelations: (
    query: string,
    exclude: readonly string[]
  ) => TaskSearchResult[];
  addComment: (body: string, parentId?: string | null) => Promise<void>;
  editComment: (commentId: string, body: string) => Promise<void>;
  removeComment: (commentId: string) => Promise<void>;
  /** Archives, or unarchives an archived task. */
  toggleArchive: () => Promise<unknown>;
  drop: () => Promise<unknown>;
  /** Sends the task to an agent, staying in the drawer. */
  dispatch: () => Promise<void>;
  copyId: () => void;
  /** Absent outside App's deep-link provider (no link to copy). */
  copyLink: (() => void) | undefined;
  /** The full page, on a mode when given. */
  openPage: (mode?: TaskTab, runId?: string) => void;
  /** Quick-looks another task in this drawer. */
  peek: (taskId: string) => void;
}

/**
 * Resolves `item` (a task the window knows) for the drawer, from the host App
 * provides (TaskPageHostContext). The models are memoised on their inputs; the
 * body and the comments load behind the cached metadata, so the header, the
 * properties and the relations draw at once.
 */
export function useTaskDetail(
  host: TaskPageHost,
  item: TaskListItem
): TaskDetailState {
  const { project } = host;
  const taskId = item.meta.id;
  const shell = useShellActions();
  const deepLink = useDeepLinkActions();
  const directory = usePeople();
  const model = useStatusModelOf(project.config);
  const doc = useTaskDoc(project.client, project.port, taskId);
  const comments = useTaskComments(
    project.client,
    project.port,
    taskId,
    project.me
  );

  // Rebuilt only when the list changes: every model below keys on it, and a
  // fresh index per render would recompute them all (and churn the relation
  // picker's exclude list) on each keystroke in a comment box.
  const tasks = project.tasksIncludingArchived;
  const index = useMemo(() => taskIndexOf(tasks), [tasks]);
  const runs = useMemo(
    () =>
      executeRuns(
        runsNewestFirst(project.runs.filter((r) => r.taskId === taskId))
      ),
    [project.runs, taskId]
  );
  const latestRun = runs[0];
  // Read once per data change, not per render, so every relative date in the
  // models ("2d ago") is stable while nothing moved.
  const [now, setNow] = useState(() => new Date());
  const commentList = comments.comments;
  useEffect(() => {
    setNow(new Date());
  }, [item, doc, commentList, project.runs]);
  const canEdit = project.myTier !== 'request';
  const config = project.config;
  const labelCatalogue = useMemo(() => config?.labels ?? NO_LABELS, [config]);
  const ctx = useMemo<DetailContext>(
    () => ({
      model,
      tasksById: index.byId,
      index,
      personFor: directory.personFor,
      me: project.me,
      linearLinks: project.linearLinks,
      people: directory.people,
      executors: (project.executors?.executors ?? []).map((e) => e.name),
      labelCatalogue,
      now,
      today: dayFromNow(0, now),
      hrefFor: taskHref,
      canEdit,
    }),
    [
      model,
      index,
      directory,
      project.me,
      project.linearLinks,
      project.executors,
      labelCatalogue,
      now,
      canEdit,
    ]
  );

  const header = useMemo(() => buildDetailHeader(item, ctx), [item, ctx]);
  const facts = useMemo(() => buildDetailFacts(item, ctx), [item, ctx]);
  const relations = useMemo(() => buildDetailRelations(item, ctx), [item, ctx]);
  const description = useMemo(
    () => (doc === undefined ? null : buildDetailDescription(doc)),
    [doc]
  );
  const activity = useMemo(
    () =>
      doc === undefined
        ? null
        : buildDetailActivity({
            doc,
            runs,
            now,
            personFor: directory.personFor,
          }),
    [doc, runs, now, directory]
  );
  const commentItems = useMemo(
    () =>
      comments.comments === undefined
        ? null
        : buildDetailComments(comments.comments, ctx),
    [comments.comments, ctx]
  );
  const choices = useMemo<DetailChoices>(
    () => ({
      states: stateChoices(model, item.meta.status),
      people: personChoices(ctx),
      labels: labelChoices(labelCatalogue, item, index.labels),
      plans: planChoices(index.byId, item, index, now),
      estimates: estimateChoices(),
    }),
    [model, item, ctx, labelCatalogue, index, now]
  );

  const container = isContainerKind(item.meta.kind);
  const liveClaims = useMemo(
    () => liveClaimsFrom(project.runs),
    [project.runs]
  );
  const readiness = useMemo(
    () =>
      dispatchReadiness({
        task: item,
        body:
          description === null
            ? null
            : {
                description: description.description,
                criteria: description.criteria,
              },
        tasksById: index.byId,
        model,
        liveRun: runs.find((r) => !isTerminalRunState(r.state)),
        reading: project.readinessById.get(taskId),
        liveClaims,
      }),
    [
      item,
      description,
      index,
      model,
      runs,
      project.readinessById,
      taskId,
      liveClaims,
    ]
  );
  const alerts = useMemo(
    () =>
      buildDetailAlerts({
        doc: item,
        model,
        readiness,
        latestRun,
        asksCount:
          (project.openQuestions.get(taskId)?.length ?? 0) +
          (project.pendingApprovals.get(taskId)?.length ?? 0),
        now,
      }),
    [
      item,
      model,
      readiness,
      latestRun,
      project.openQuestions,
      project.pendingApprovals,
      taskId,
      now,
    ]
  );

  // A dispatch counts as landed once a run it did not already know about
  // appears, or after a while regardless (the card's spinner must not stick).
  const [awaitingRun, setAwaitingRun] = useState<ReadonlySet<string> | null>(
    null
  );
  useEffect(() => {
    if (awaitingRun === null) return;
    if (runs.some((r) => !awaitingRun.has(r.id))) setAwaitingRun(null);
  }, [runs, awaitingRun]);
  useEffect(() => {
    if (awaitingRun === null) return;
    const timer = setTimeout(() => setAwaitingRun(null), 15_000);
    return () => clearTimeout(timer);
  }, [awaitingRun]);

  // The host's raw writes: they reject when the daemon refuses, so each
  // control prints the reason beside itself and rolls back (the project's
  // `handleUpdate` toasts instead and never rejects).
  const { updateTask: handleUpdate, moveTaskStatus } = host;
  const patch = useCallback(
    (next: UpdatePatch) => handleUpdate(taskId, next),
    [handleUpdate, taskId]
  );
  const saveFact = useCallback(
    <K extends EditableFactId>(id: K, next: FactValues[K]) =>
      patch(patchFor(id, next)),
    [patch]
  );
  const dispatchTask = host.dispatchTask;
  const dispatch = useCallback(async () => {
    setAwaitingRun(new Set(runs.map((r) => r.id)));
    try {
      await dispatchTask(taskId, undefined, undefined, true);
    } catch (err) {
      setAwaitingRun(null);
      throw err;
    }
  }, [dispatchTask, taskId, runs]);
  const tasksById = index.byId;
  const openTaskPage = host.openTaskPage;
  const peekTask = host.peekTask;

  return {
    item,
    header,
    alerts,
    facts,
    choices,
    relations,
    description,
    comments: commentItems,
    commentsError: comments.error,
    activity,
    runs,
    latestRun,
    readiness,
    statusModel: model,
    container,
    children: childrenIn(index, taskId),
    canEdit,
    archived: item.meta.archivedAt !== undefined,
    dropped: isCanceledStatus(item.meta.status, model),
    dispatching: awaitingRun !== null,
    me: project.me,
    now,
    saveTitle: (title) => patch({ title }),
    saveStatus: (status) => moveTaskStatus(taskId, status),
    saveFact,
    saveDescription: (text) => patch(descriptionPatch(text)),
    saveAcceptance: (text) => patch(acceptancePatch(text)),
    addBlocker: (otherId) => {
      const result = blockerAddPatch(item, otherId, tasksById);
      if ('error' in result) {
        return Promise.reject(new Error(RELATION_ERROR[result.error]));
      }
      return patch(result.patch);
    },
    removeBlocker: (otherId) => patch(blockerRemovePatch(item, otherId)),
    removeBlocks: (otherId) => {
      const other = tasksById.get(otherId);
      if (other === undefined) return undefined;
      const change = blocksRemovePatch(other, taskId);
      return handleUpdate(change.taskId, change.patch);
    },
    searchRelations: (query, exclude) =>
      relationSearch(query, ctx, new Set([taskId, ...exclude])),
    addComment: comments.add,
    editComment: comments.edit,
    removeComment: comments.remove,
    toggleArchive: () =>
      patch({
        archivedAt:
          item.meta.archivedAt === undefined ? new Date().toISOString() : null,
      }),
    drop: () => moveTaskStatus(taskId, model.roles.dropped),
    dispatch,
    copyId: () => shell.copyTaskId(taskId),
    copyLink:
      deepLink === null ? undefined : () => deepLink.copyTaskLink(taskId),
    openPage: (mode, runId) => openTaskPage(taskId, mode, runId),
    peek: peekTask,
  };
}
