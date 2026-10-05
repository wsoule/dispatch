import type {
  EffortLevel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import {
  isCanceledStatus,
  isContainer,
  isDoneStatus,
  parseLinearExternal,
  statusLabel,
  statusType,
} from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';
import {
  Archive,
  ArchiveRestore,
  Ban,
  Copy,
  Ellipsis,
  Link2,
  Maximize2,
  MessagesSquare,
  MonitorPlay,
  Play,
  Star,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useTaskComments } from '../../../hooks/useTaskComments';
import { useTaskDoc } from '../../../hooks/useTaskDoc';
import { parseActivity } from '../../../lib/activityFeed';
import type { TaskTab } from '../../../lib/appNav';
import { liveClaimsFrom } from '../../../lib/dispatchPreview';
import {
  dispatchesOnKey,
  dispatchReadiness,
  unmetBlockers,
} from '../../../lib/dispatchReadiness';
import {
  isTypingTagName,
  type ListKeyCommand,
  resolveListKeyCommand,
} from '../../../lib/keyboard';
import { colorForLabel } from '../../../lib/labelColor';
import {
  isLinearConfigured,
  pushToLinearError,
} from '../../../lib/linearSettings';
import { presenceLine } from '../../../lib/remotePresence';
import { criteriaItems } from '../../../lib/reviewCriteria';
import { isTerminalRunState } from '../../../lib/runState';
import { useStatusModelOf } from '../../../lib/statusModel';
import { dueDateInfo } from '../../../lib/taskDates';
import { parseTaskSections } from '../../../lib/taskDisplay';
import { ancestorsOf } from '../../../lib/taskHierarchy';
import { childrenIn, taskIndexOf } from '../../../lib/taskIndex';
import {
  defaultTaskPageMode,
  executeRuns,
  lifecycleStages,
  runsNewestFirst,
  type TaskPageMode,
  taskPageModes,
} from '../../../lib/taskPageMode';
import { useDeepLinkActions } from '../../shell/DeepLinkContext';
import { ErrorBoundary } from '../../shell/ErrorBoundary';
import { AlsoViewing } from '../../shell/PresenceStack';
import { useSavedViewsContext } from '../../shell/SavedViewsContext';
import { useShellActions } from '../../shell/ShellActionsContext';
import { useToasts } from '../../shell/Toasts';
import {
  AssigneeControl,
  cycleLabel,
  estimateLabel,
  PriorityControl,
  StatusControl,
} from '../PropertyControls';
import { statusColor } from '../StatusIcon';
import { TaskPreviewTab } from '../TaskPreviewTab';
import { LifecycleTrack } from './LifecycleTrack';
import type { TaskPageLayout, TaskPageModel } from './pageModel';
import { PlanMode } from './PlanMode';
import { ReviewMode } from './ReviewMode';
import { RunMode } from './RunMode';
import { SpecMode } from './SpecMode';
import { SummaryMode } from './SummaryMode';
import type { TaskPageHost } from './TaskPageHost';
import { useTaskPageHost } from './TaskPageHost';
import { type RailPicker, TaskRail } from './TaskRail';
import { TaskTitle } from './TaskTitle';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { PageHeader, SidePanelIconButton } from '@/ui/ai/page-header';
import { LabelPill, Pill } from '@/ui/ai/pill';
import { EmptyState } from '@/ui/chrome';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Skeleton } from '@/ui/skeleton';

export interface TaskPageProps {
  taskId: string;
  layout: TaskPageLayout;
  /** The mode, when the caller keeps it (the full page keeps it in history); omitted, the
   * page holds it and starts on `auto`. */
  mode?: TaskTab;
  onModeChange?: (mode: TaskTab) => void;
  /** The run the Run and Review modes show, when the caller keeps it. */
  runId?: string | null;
  onSelectRun?: (runId: string) => void;
  /** Closes a peek or split pane. */
  onClose?: () => void;
  /** Grows a peek or split pane into the full page. */
  onExpand?: () => void;
  /** Leaves the full page once its task has gone. */
  onBack?: () => void;
}

// Where the task's run is live on the team and whom it waits on; nothing
// when board sync is off or the task has no live run.
function TeamPresenceLine({
  client,
  port,
  taskId,
}: {
  client: ApiClient | null;
  port: number | undefined;
  taskId: string;
}) {
  const query = useQuery({
    queryKey: ['task-presence', port, taskId],
    queryFn: () => {
      if (client === null) throw new Error('no client');
      return client.getTaskPresence(taskId);
    },
    enabled: client !== null,
    retry: false,
  });
  const line =
    query.data === undefined
      ? null
      : presenceLine(query.data.presence, query.data.waitingOn);
  if (line === null) return null;
  return (
    <p
      data-slot="team-presence"
      className="text-muted-foreground -mt-4 text-[12px]"
    >
      {line}
    </p>
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Something went wrong.';
}

// Which rail picker each single-key command opens.
const PICKER_FOR_KEY: Partial<Record<ListKeyCommand, RailPicker>> = {
  'list-set-status': 'status',
  'list-set-priority': 'priority',
  'list-set-assignee': 'assignee',
  'list-set-labels': 'labels',
  'list-set-epic': 'parent',
  'list-set-milestone': 'parent',
};

/**
 * One task, state-adaptive: the main pane follows where the task is — Spec before it is
 * dispatched, Run while an agent works it, Review once a run finishes, Summary when it is
 * done (a container shows its Plan) — and the lifecycle track above it switches modes by
 * hand; the header's Thread toggle shows the task's message threads instead. The rail
 * beside it holds every property, relations, sub-issues, comments and
 * activity. One component for every mount: `split` beside a list (the rail opens over
 * the pane), `peek` in a dialog, `full` as the window. Metadata renders from the cached
 * list at once; the body, comments and run data stream in behind skeletons.
 */
export function TaskPage(props: TaskPageProps) {
  const host = useTaskPageHost();
  if (host === null) return null;
  return <TaskPageResolver host={host} {...props} />;
}

function TaskPageResolver({
  host,
  ...props
}: TaskPageProps & { host: TaskPageHost }) {
  const tasks = host.project.tasksIncludingArchived;
  const item = useMemo(
    () => tasks.find((t) => t.meta.id === props.taskId),
    [tasks, props.taskId]
  );
  if (item === undefined) {
    if (!host.project.tasksReady) return <PageSkeleton />;
    const leave = props.layout === 'full' ? props.onBack : props.onClose;
    return (
      <EmptyState
        className="h-full"
        heading="That task is no longer available."
        description="It was archived or deleted while it was open."
        secondary={
          leave === undefined
            ? undefined
            : {
                label: props.layout === 'full' ? 'Back' : 'Close',
                onClick: leave,
              }
        }
      />
    );
  }
  return (
    <ErrorBoundary label="this task">
      <TaskPageLoaded key={props.taskId} host={host} item={item} {...props} />
    </ErrorBoundary>
  );
}

function PageSkeleton() {
  return (
    <div aria-label="Loading the task" className="flex flex-col gap-3 p-6">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-12 w-full max-w-[720px]" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/** The task's id beside its title: the crumb's last segment. */
function TaskCrumb({ id, title }: { id: string; title: string }) {
  return (
    <span data-slot="task-crumb" className="flex min-w-0 items-center gap-1.5">
      <span className="font-book text-muted-foreground shrink-0 tracking-(--id-tracking)">
        {id}
      </span>
      <span className="min-w-0 truncate">{title || 'Untitled task'}</span>
    </span>
  );
}

/** The narrow pane's stand-in for the rail: the properties you scan most, inline. */
function PropertyChips({
  page,
  onOpenRail,
}: {
  page: TaskPageModel;
  onOpenRail: () => void;
}) {
  const { meta } = page.item;
  const due =
    meta.dueDate === null
      ? null
      : dueDateInfo(
          meta.dueDate,
          new Date(),
          isDoneStatus(meta.status, page.statusModel)
        );
  return (
    <div
      data-slot="property-chips"
      className="flex flex-wrap items-center gap-1.5"
    >
      <PriorityControl
        value={meta.priority}
        onChange={(priority) => void page.patch({ priority })}
      />
      <AssigneeControl
        value={meta.assignee}
        onChange={(assignee) => void page.patch({ assignee })}
      />
      {meta.estimate !== null && <Pill>{estimateLabel(meta.estimate)}</Pill>}
      {due !== null && (
        <Pill title="Due" className={cn(due.overdue && 'text-red')}>
          {due.date}
        </Pill>
      )}
      {meta.cycle !== null && <Pill>{cycleLabel(meta.cycle)}</Pill>}
      {meta.labels.map((label) => (
        <LabelPill key={label} color={colorForLabel(label)}>
          {label}
        </LabelPill>
      ))}
      <button
        type="button"
        onClick={onOpenRail}
        className="text-muted-foreground rounded-control focus-visible:ring-ring h-6 px-1.5 text-[12px] font-medium outline-none hover:text-(--text-secondary) focus-visible:ring-2"
      >
        All details
      </button>
    </div>
  );
}

function TaskPageLoaded({
  host,
  item,
  taskId,
  layout,
  mode: controlledMode,
  onModeChange,
  runId: controlledRunId,
  onSelectRun,
  onClose,
  onExpand,
}: TaskPageProps & { host: TaskPageHost; item: TaskListItem }) {
  const { project } = host;
  const meta = item.meta;
  const shell = useShellActions();
  const toasts = useToasts();
  // Null until App mounts their providers; the page then shows no Copy link and no star.
  const deepLink = useDeepLinkActions();
  const savedViews = useSavedViewsContext();
  const rootRef = useRef<HTMLDivElement>(null);
  const [railOpen, setRailOpen] = useState(layout !== 'split');
  const [picker, setPicker] = useState<RailPicker | null>(null);
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
  const comments = useTaskComments(
    project.client,
    project.port,
    taskId,
    project.me
  );

  const index = taskIndexOf(project.tasksIncludingArchived);
  const tasksById = index.byId;
  const container = isContainer(meta, index.parentIds);
  const children = childrenIn(index, taskId);
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
  const { threadView } = host;
  const mode: TaskPageMode | 'thread' | 'preview' =
    requested === 'auto'
      ? autoMode
      : requested === 'preview'
        ? layout === 'full' && latestRun !== undefined
          ? 'preview'
          : autoMode
        : requested === 'thread'
          ? threadView !== undefined
            ? 'thread'
            : autoMode
          : modes.includes(requested)
            ? requested
            : autoMode;
  const selectedRunId = controlledRunId ?? localRunId;
  // Any kind: a review or verify run opened by id (the live rail, the inbox) shows itself.
  const selectedRun = allRuns.find((r) => r.id === selectedRunId) ?? latestRun;

  // A dispatch counts as landed once a run it did not already know about appears.
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
  const selectMode = useCallback(
    (next: TaskPageMode | 'thread' | 'preview') => {
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
        await dispatchTask(
          taskId,
          executor,
          runModel,
          layout !== 'full',
          effort
        );
      } catch (err) {
        setAwaitingRun(null);
        fail('Dispatch failed', err);
      }
    },
    [dispatchTask, taskId, layout, runs, fail]
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
  const openTask =
    layout === 'full'
      ? host.peekTask
      : (id: string) => (id === taskId ? undefined : host.peekTask(id));

  const page: TaskPageModel = {
    host,
    project,
    layout,
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
    selectMode,
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

  // Linear's single-key property shortcuts and `d` to dispatch, for a key that lands on
  // this page or on nothing at all. A key typed into a field, a menu, a dialog stacked
  // above the page, a task page nested in this one (the Flight Plan's pane), or already
  // handled (the Flight Plan's own h/j/k/l and `d`) is left alone.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const root = rootRef.current;
      const target = event.target;
      if (root === null || !(target instanceof HTMLElement)) return;
      if (event.defaultPrevented) return;
      // An unfocused key goes to the innermost page.
      if (
        target === document.body &&
        root.querySelector('[data-slot="task-page"]') !== null
      ) {
        return;
      }
      if (
        target !== document.body &&
        target.closest('[data-slot="task-page"]') !== root &&
        !target.contains(root)
      ) {
        return;
      }
      if (isTypingTagName(target.tagName, target.isContentEditable)) return;
      if (
        target.closest('[role="menu"], [data-slot="popover-content"]') !== null
      )
        return;
      const command = resolveListKeyCommand(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        { isTyping: false }
      );
      const next = command === null ? undefined : PICKER_FOR_KEY[command];
      if (next !== undefined) {
        event.preventDefault();
        setRailOpen(true);
        setPicker(next);
        return;
      }
      if (command === 'list-dispatch' && keyDispatches && !dispatching) {
        event.preventDefault();
        void dispatch();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [keyDispatches, dispatching, dispatch]);

  const ancestors = useMemo(
    () => ancestorsOf(item, tasksById),
    [item, tasksById]
  );
  const openCrumb = layout === 'full' ? host.openTaskPage : host.peekTask;
  const crumb: ReactNode[] = [
    ...(host.projectName !== null ? [host.projectName] : []),
    ...ancestors.map((a) => (
      <button
        key={a.meta.id}
        type="button"
        onClick={() => openCrumb(a.meta.id)}
        className="hover:text-foreground min-w-0 truncate outline-none focus-visible:underline"
      >
        {a.meta.title}
      </button>
    )),
    <TaskCrumb key="task" id={meta.id} title={meta.title} />,
  ];

  // Any Linear record counts: an issue, or a project, milestone or initiative.
  const linked = parseLinearExternal(meta.external) !== null;
  const archived = meta.archivedAt !== undefined;
  async function pushToLinear() {
    const failure = pushToLinearError(await project.handleSyncLinear([taskId]));
    if (failure !== null) fail('Push to Linear failed', failure);
  }

  const headerActions = (
    <>
      <AlsoViewing
        viewers={project.presence.filter(
          (p) => p.viewing === taskId && p.ref !== project.me
        )}
      />
      {threadView !== undefined && (
        <IconButton
          label="Thread"
          active={mode === 'thread'}
          onClick={() => selectMode(mode === 'thread' ? autoMode : 'thread')}
        >
          <MessagesSquare />
        </IconButton>
      )}
      {layout === 'full' && latestRun !== undefined && (
        <IconButton
          label="Preview the run's app"
          active={mode === 'preview'}
          onClick={() => selectMode(mode === 'preview' ? autoMode : 'preview')}
        >
          <MonitorPlay />
        </IconButton>
      )}
      <IconButton label="Copy task id" onClick={() => shell.copyTaskId(taskId)}>
        <Copy />
      </IconButton>
      {deepLink !== null && (
        <IconButton
          label="Copy link"
          onClick={() => deepLink.copyTaskLink(taskId)}
        >
          <Link2 />
        </IconButton>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger render={<IconButton label="More actions" />}>
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={!canDispatch || dispatching}
            onClick={() => void dispatch()}
          >
            <Play />
            {readiness.blocked ? 'Dispatch anyway' : 'Dispatch'}
          </DropdownMenuItem>
          {!linked && isLinearConfigured(project.linearStatus) && (
            <DropdownMenuItem onClick={() => void pushToLinear()}>
              <Link2 />
              Push to Linear
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              void patch({
                archivedAt: archived ? null : new Date().toISOString(),
              })
            }
          >
            {archived ? <ArchiveRestore /> : <Archive />}
            {archived ? 'Unarchive' : 'Archive'}
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={isCanceledStatus(meta.status, model)}
            onClick={() => changeStatus(model.roles.dropped)}
          >
            <Ban />
            Drop
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SidePanelIconButton
        active={railOpen}
        onClick={() => setRailOpen((open) => !open)}
      />
      {layout !== 'full' && onExpand !== undefined && (
        <IconButton label="Open the full page" onClick={onExpand}>
          <Maximize2 />
        </IconButton>
      )}
      {layout !== 'full' && onClose !== undefined && (
        <IconButton label="Close" onClick={onClose}>
          <X />
        </IconButton>
      )}
    </>
  );

  const favoriteRef = { kind: 'task' as const, id: taskId };
  const favorite = savedViews?.isFavorite(favoriteRef) ?? false;
  const star =
    savedViews === null ? undefined : (
      <IconButton
        label={favorite ? 'Unfavorite' : 'Favorite'}
        active={favorite}
        onClick={() => savedViews.toggleFavorite(favoriteRef)}
      >
        <Star />
      </IconButton>
    );

  // Spec and Summary read as a column that scrolls; Run, Review, Plan and the thread fill
  // the pane and scroll inside (the transcript, the diff, the Flight Plan's canvas).
  const fills =
    mode === 'run' ||
    mode === 'review' ||
    mode === 'plan' ||
    mode === 'thread' ||
    mode === 'preview';
  let modeView: ReactNode;
  switch (mode) {
    case 'spec':
      modeView = <SpecMode page={page} />;
      break;
    case 'run':
      modeView = <RunMode page={page} />;
      break;
    case 'review':
      modeView = <ReviewMode page={page} />;
      break;
    case 'summary':
      modeView = <SummaryMode page={page} />;
      break;
    case 'plan':
      modeView = <PlanMode page={page} />;
      break;
    case 'thread':
      // Its own boundary, so a crashing thread view never strands the other modes.
      modeView = threadView && (
        <ErrorBoundary label="this tab">{threadView(taskId)}</ErrorBoundary>
      );
      break;
    case 'preview':
      modeView = <TaskPreviewTab data={project} selectedRun={selectedRun} />;
      break;
  }

  const rail = railOpen && (
    <TaskRail
      page={page}
      comments={comments}
      picker={picker}
      onPickerChange={setPicker}
      showRelations={mode !== 'spec'}
      showActivity={mode !== 'summary'}
      showSubIssues={mode !== 'plan' && mode !== 'spec'}
      className={cn(
        layout === 'split'
          ? 'bg-surface-panel shadow-overlay absolute inset-y-0 right-0 z-20 w-[300px]'
          : cn(
              'shadow-hairline-left',
              layout === 'peek' ? 'w-[280px]' : 'w-[320px]'
            )
      )}
    />
  );

  return (
    <div
      ref={rootRef}
      data-slot="task-page"
      data-layout={layout}
      data-mode={mode}
      className="@container/task-page flex h-full min-h-0 flex-col"
    >
      {layout === 'full' ? (
        <PageHeader crumb={crumb} star={star} actions={headerActions} />
      ) : (
        <div
          data-slot="task-pane-chrome"
          className="shadow-hairline-bottom text-muted-foreground flex h-10 shrink-0 items-center gap-1.5 pr-2 pl-4 text-[12px] font-medium"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {/* A pane too narrow for the trail keeps only the task's own segment. */}
            {crumb.map((segment, index) => {
              const last = index === crumb.length - 1;
              return (
                <span
                  key={index}
                  className={cn(
                    'flex min-w-0 items-center gap-1.5',
                    // The trail gives way before the task's own title does.
                    !last && 'shrink-[4] @max-[520px]/task-page:hidden'
                  )}
                >
                  {index > 0 && (
                    <span aria-hidden className="@max-[520px]/task-page:hidden">
                      ›
                    </span>
                  )}
                  <span
                    className={cn(
                      'flex min-w-0 items-center truncate',
                      last && 'text-foreground'
                    )}
                  >
                    {segment}
                  </span>
                </span>
              );
            })}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
          </div>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        <main
          data-slot="task-main"
          className={cn(
            'flex min-w-0 flex-1 flex-col',
            !fills && 'overflow-y-auto'
          )}
        >
          <div
            data-slot="task-head"
            className={cn(
              'flex shrink-0 flex-col gap-3 px-6 pt-5 pb-3',
              !fills && 'max-w-[920px]'
            )}
          >
            <div className="flex items-start gap-2">
              <span className="mt-1.5">
                <StatusControl
                  value={meta.status}
                  statuses={project.config?.statuses ?? [meta.status]}
                  onChange={changeStatus}
                />
              </span>
              <div className="min-w-0 flex-1">
                <TaskTitle
                  value={meta.title}
                  onCommit={(title) => void patch({ title })}
                />
              </div>
            </div>
            <TeamPresenceLine
              client={project.client}
              port={project.port}
              taskId={meta.id}
            />
            {layout === 'split' && !railOpen && (
              <PropertyChips page={page} onOpenRail={() => setRailOpen(true)} />
            )}
            <LifecycleTrack
              stages={stages}
              active={mode === 'preview' || mode === 'thread' ? autoMode : mode}
              onSelect={selectMode}
              statusColor={statusColor(meta.status, model)}
              className="max-w-[720px]"
            />
          </div>
          <div
            data-slot="task-mode"
            className={cn(
              mode === 'plan'
                ? 'flex min-h-0 flex-1 flex-col'
                : fills
                  ? 'flex min-h-0 flex-1 flex-col px-6 pb-4'
                  : 'max-w-[920px] px-2'
            )}
          >
            <ErrorBoundary label="this view">{modeView}</ErrorBoundary>
          </div>
        </main>
        {rail}
      </div>
    </div>
  );
}
