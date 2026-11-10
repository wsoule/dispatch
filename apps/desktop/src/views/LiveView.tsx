import {
  DEFAULT_STATUS_MODEL,
  fanoutScope,
  isUnstartedStatus,
  statusModelOf,
} from '@dispatch-foo/core/browser';
import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  Button,
  ConfirmDialog,
  type RowWindowGroup,
  SkeletonRows,
  useRowWindows,
} from '@dispatch/ui';
import { Zap } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useRef, useState } from 'react';

import type { FlightNode } from '../components/flightplan/flightPlan';
import {
  tasksWithRunBranch,
  viewerHolderOf,
} from '../components/flightplan/flightPlan';
import { canDispatch } from '../components/flightplan/FlightPlanView';
import { childrenByParent } from '../components/flightplan/flightScope';
import {
  LiveBand,
  type LiveBandActions,
  type LiveBandContext,
  liveBandHeight,
} from '../components/live/LiveBand';
import {
  buildLiveBand,
  type LiveBandModel,
  type LiveGeometryCache,
  type LiveShared,
  liveTotals,
} from '../components/live/liveBandModel';
import {
  orderLiveBands,
  readyContainers,
  selectLiveBands,
} from '../components/live/liveGraph';
import { LiveHeader } from '../components/live/LiveHeader';
import { LiveReady } from '../components/live/LiveReady';
import { usePeople } from '../components/people/PeopleContext';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { PageHead, RUNS_BACK } from '../components/shell/PageHead';
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useOptimisticDispatch } from '../hooks/useOptimisticDispatch';
import type { TaskTab } from '../lib/appNav';
import { liveClaimsFrom } from '../lib/dispatchPreview';
import { ISSUES_DISPLAY } from '../lib/issuesPrefs';
import { landingStateByTaskId } from '../lib/landingBadge';
import { resolveLinearLink } from '../lib/linearSettings';
import { groupTasks } from '../lib/listGrouping';
import { liveCeilingsOf, spendToday } from '../lib/liveSpend';
import {
  unlimitedFanoutOptions,
  type WorkMilestoneOptions,
} from '../lib/milestoneSession';
import { pendingStarts } from '../lib/optimisticDispatch';
import { tasksWithFinishedRun } from '../lib/runState';
import { LIVE_PAGE_TITLE } from '../lib/shellRoutes';
import type { TaskBucket } from '../lib/taskStatus';
import styles from './LiveView.module.css';

/** How many ready containers the empty state offers. */
const READY_LIMIT = 6;

/** The band list's one window group: every band is a row of it. */
const BAND_GROUP = 'live';
/** A band's height before the first measurement: a title row over its chart.
 * Every band's height is known exactly (`liveBandHeight`), so this only sizes the
 * overscan until a band has been measured. */
const BAND_ESTIMATE = 320;
/** Bands kept mounted past each edge of the viewport, in band heights. */
const BAND_OVERSCAN = 1;
/** Bands the first render draws before anything is measured. */
const INITIAL_BANDS = 4;
/** Nothing is ever dragged in the band list: one shared empty set, so a render never
 * hands the row windows a new one (which would measure again). */
const NO_DRAG: ReadonlySet<string> = new Set();
/** The band list has no sticky header over it. */
const NO_HEAD: { readonly current: HTMLElement | null } = { current: null };
/** A band's chart groups its tasks under their milestones, subtasks included. */
const BAND_DISPLAY = { ...ISSUES_DISPLAY, showSubtasks: true };

// The fan-out dialog, open for one container: `start` sends a fresh session, `raise`
// edits a paused one's ceilings.
interface FanoutDialogState {
  milestoneId: string;
  mode: 'start' | 'raise';
}

export interface LiveViewProps {
  data: DispatchProjectData;
  /** An open task's one bucket (App's `itemBucket`), for the charts' state words. */
  bucketOf: (task: TaskListItem) => TaskBucket | null;
  /** Open asks per task. */
  asksByTask: ReadonlyMap<string, number>;
  /** The project's path: keys each band's remembered chart choices. */
  projectKey: string;
  /** Dispatches without leaving the view, rejecting on failure so `d` can roll back. */
  dispatchTask: (taskId: string) => Promise<void>;
  /** A dispatch or fan-out verb the daemon refused — App toasts it. */
  onDispatchFailed: (taskId: string, message: string) => void;
  /** The full task page (a band's Flight Plan). */
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** The quick-look slide-over (a card's double click, the inspector's Open task). */
  onPeekTask: (taskId: string) => void;
  /** Hosted by App, the page leads with the Runs back chip, which calls this
   * to return to the Runs page (Live reads as Runs › Live). */
  onBack?: () => void;
}

/**
 * Everything in motion across the project, on one screen: a band per container with work
 * moving (a live or paused fan-out, or a child running, landing or waiting on a review),
 * running first, then queued, then paused, and a Loose work band for agents outside every
 * container. Each band is that container's dependency chart (the Graph page's chart,
 * embedded), landed work hidden until asked for, under a title row with its fan-out verbs.
 * Only bands near the viewport mount; everything derives from the cached task list, runs
 * and fan-out progress. Escape is the shell's (it closes the drawer, then goes back one
 * place with the Runs page open).
 */
export function LiveView({
  data,
  bucketOf,
  asksByTask,
  projectKey,
  dispatchTask,
  onDispatchFailed,
  onOpenTask,
  onPeekTask,
  onBack,
}: LiveViewProps) {
  const directory = usePeople();
  const me = directory.me;
  const model = useMemo(
    () =>
      data.config === null ? DEFAULT_STATUS_MODEL : statusModelOf(data.config),
    [data.config]
  );
  const tasks = data.tasksIncludingArchived;
  const taskById = useMemo(
    () => new Map(tasks.map((t) => [t.meta.id, t])),
    [tasks]
  );
  const children = useMemo(() => childrenByParent(tasks), [tasks]);
  const containerIds = useMemo(() => new Set(children.keys()), [children]);

  // Live runs, plus the dispatches `d` sent that the run list has not caught up with.
  const liveTaskIds = useMemo(
    () => new Set(data.liveRunStateByTaskId.keys()),
    [data.liveRunStateByTaskId]
  );
  const stillWaiting = useCallback(
    (taskId: string) => {
      const task = taskById.get(taskId);
      return task !== undefined && isUnstartedStatus(task.meta.status, model);
    },
    [taskById, model]
  );
  const optimistic = useOptimisticDispatch(
    dispatchTask,
    liveTaskIds,
    stillWaiting,
    onDispatchFailed
  );
  const pending = useMemo(
    () => pendingStarts(optimistic.pending),
    [optimistic.pending]
  );
  const flying = useMemo(() => {
    if (pending.size === 0) return liveTaskIds;
    const out = new Set(liveTaskIds);
    for (const id of pending.keys()) out.add(id);
    return out;
  }, [liveTaskIds, pending]);

  const landing = useMemo(
    () => landingStateByTaskId(data.mergeQueue),
    [data.mergeQueue]
  );
  const reviewPending = useMemo(() => {
    const out = new Set<string>();
    for (const [id, attention] of data.attentionByTaskId) {
      if (attention === 'review') out.add(id);
    }
    return out;
  }, [data.attentionByTaskId]);
  const sessions = data.liveMilestoneSessions;
  const sessionById = useMemo(
    () => new Map(sessions.map((p) => [p.milestoneId, p])),
    [sessions]
  );
  const startDependents = data.config?.orchestrator.startDependents;
  const withRunBranch = useMemo(
    () => tasksWithRunBranch(data.runs),
    [data.runs]
  );
  const withFinishedRun = useMemo(
    () => tasksWithFinishedRun(data.runs),
    [data.runs]
  );
  // A teammate's task as this window reads it: `d` never sends one, and the fan-out
  // offers never count one.
  const holderOf = useMemo(
    () => viewerHolderOf(me, data.localHuman),
    [me, data.localHuman]
  );

  const specs = useMemo(
    () =>
      selectLiveBands({
        taskById,
        children,
        sessions,
        flying,
        landing,
        reviewPending,
      }),
    [taskById, children, sessions, flying, landing, reviewPending]
  );
  const shared = useMemo<LiveShared>(
    () => ({
      model,
      taskById,
      containerIds,
      flying,
      me,
      local: data.localHuman,
      sessions: sessionById,
      withRunBranch,
      withFinishedRun,
      startDependents,
      landing,
    }),
    [
      model,
      taskById,
      containerIds,
      flying,
      me,
      data.localHuman,
      sessionById,
      withRunBranch,
      withFinishedRun,
      startDependents,
      landing,
    ]
  );
  // Waves per band, kept while a band's structure holds.
  const geometry = useRef<LiveGeometryCache>(new Map());
  const bands = useMemo(() => {
    const cache = geometry.current;
    const built = specs.map((spec) => buildLiveBand(spec, shared, { cache }));
    const keep = new Set(specs.map((s) => s.key));
    for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key);
    return orderLiveBands(built);
  }, [specs, shared]);

  // Every band's plan node by task id, for Send agent.
  const located = useMemo(() => {
    const out = new Map<string, FlightNode>();
    for (const band of bands) {
      for (const node of band.plan.nodes) out.set(node.task.meta.id, node);
    }
    return out;
  }, [bands]);

  const totals = useMemo(() => liveTotals(bands, sessions), [bands, sessions]);
  const today = useMemo(() => spendToday(data.runs), [data.runs]);
  const ceilings = useMemo(() => liveCeilingsOf(sessions), [sessions]);
  // Resume all takes every pause but a ceiling's, which only a raised ceiling lifts: a
  // failed auto-dispatch is the daemon's "resume to try again".
  const fleet = useMemo(() => {
    const active: string[] = [];
    const resumable: string[] = [];
    let capped = 0;
    for (const progress of sessions) {
      const session = progress.session;
      if (session?.state === 'active') active.push(progress.milestoneId);
      else if (session?.state === 'paused') {
        if (
          session.pausedReason === 'budget' ||
          session.pausedReason === 'runs'
        ) {
          capped++;
        } else resumable.push(progress.milestoneId);
      }
    }
    return { active, resumable, capped };
  }, [sessions]);

  // What the cards read.
  const refFor = useCallback(
    (id: string) =>
      resolveLinearLink(
        taskById.get(id)?.meta.external ?? null,
        data.linearLinks
      )?.identifier ?? id,
    [taskById, data.linearLinks]
  );
  const liveClaims = useMemo(() => liveClaimsFrom(data.runs), [data.runs]);
  // What every band's chart reads: its groups, state words and Send agent.
  const { dispatch } = optimistic;
  const taskActions = useCallback(
    (id: string): ReactNode =>
      canDispatch(located.get(id), model, holderOf) ? (
        <Button
          size="sm"
          variant="secondary"
          icon={<Zap size={14} strokeWidth={1.8} aria-hidden />}
          onClick={() => void dispatch(id)}
        >
          Send agent
        </Button>
      ) : null,
    [located, model, holderOf, dispatch]
  );
  const { config, milestones } = data;
  const bandCtx = useMemo<LiveBandContext>(
    () => ({
      groupsOf: (list) =>
        groupTasks(list, BAND_DISPLAY, {
          statuses: config?.statuses ?? [],
          milestones,
          model,
        }),
      bucketOf,
      asksByTask,
      projectKey,
      refFor,
      taskActions,
    }),
    [
      config,
      milestones,
      model,
      bucketOf,
      asksByTask,
      projectKey,
      refFor,
      taskActions,
    ]
  );

  // The dialogs.
  const [dialog, setDialog] = useState<FanoutDialogState | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  const [busy, setBusy] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // The band list scrolls itself; the bands window against it.
  const attachGrid = useCallback((el: HTMLDivElement | null) => {
    gridRef.current = el;
    setScroller(el);
  }, []);

  const daemonReady =
    !data.portLoading && !data.portError && data.client !== null;
  const hasBands = bands.length > 0;
  const openPlan = useCallback(
    (containerId: string) => onOpenTask(containerId, 'plan'),
    [onOpenTask]
  );
  // A card's open from a chart: a tab opens the page, anything else quick-looks it.
  const openFromChart = useCallback(
    (id: string, tab?: TaskTab) => {
      if (tab !== undefined) onOpenTask(id, tab);
      else onPeekTask(id);
    },
    [onOpenTask, onPeekTask]
  );
  const {
    milestoneProgressById,
    handlePauseMilestone,
    handleResumeMilestone,
    handleStopMilestone,
    handleLandMilestone,
    handleWorkMilestone,
  } = data;
  const unlimitedSpend = data.config?.orchestrator.unlimitedSpend === true;
  const milestoneConcurrency =
    data.config?.orchestrator.milestoneConcurrency ?? 3;
  // Send agents… opens the fan-out dialog, unless the project has turned on unlimited
  // spend: then there is no ceiling to choose, so the session starts at the default
  // concurrency straight away and a refusal is toasted. Raise ceiling… is hidden then,
  // and a paused session's Resume ignores its old ceilings daemon-side.
  const sendAgents = useCallback(
    (id: string) => {
      if (!unlimitedSpend) {
        setDialog({ milestoneId: id, mode: 'start' });
        return;
      }
      handleWorkMilestone(
        id,
        unlimitedFanoutOptions(milestoneConcurrency)
      ).catch((err: unknown) =>
        onDispatchFailed(
          id,
          err instanceof Error ? err.message : 'The daemon refused the fan-out.'
        )
      );
    },
    [
      unlimitedSpend,
      milestoneConcurrency,
      handleWorkMilestone,
      onDispatchFailed,
    ]
  );
  const actions = useMemo<LiveBandActions>(
    () => ({
      model,
      progressOf: (id) => milestoneProgressById.get(id),
      onSendAgents: sendAgents,
      onRaiseCeiling: unlimitedSpend
        ? undefined
        : (id) => setDialog({ milestoneId: id, mode: 'raise' }),
      onPause: handlePauseMilestone,
      onResume: handleResumeMilestone,
      onStop: handleStopMilestone,
      onLand: handleLandMilestone,
      onOpenPlan: openPlan,
      onOpenTask: openFromChart,
    }),
    [
      model,
      milestoneProgressById,
      sendAgents,
      unlimitedSpend,
      handlePauseMilestone,
      handleResumeMilestone,
      handleStopMilestone,
      handleLandMilestone,
      openPlan,
      openFromChart,
    ]
  );

  // Every band's exact height: bands are exactly their computed height, so none needs a
  // measurement. A new `heights` (a band appeared or emptied) hands the row windows a new
  // `rowHeight`, which re-windows before paint.
  const heights = useMemo(
    () => new Map(bands.map((band) => [band.spec.key, liveBandHeight(band)])),
    [bands]
  );

  // The band list windows with the library's row windows: one group whose rows are the
  // bands, each its known height, a scroll's new bands rendered inside the scroll event
  // (they are tall and few, as a board's cards are).
  const windowGroups = useMemo<RowWindowGroup[]>(
    () => [{ id: BAND_GROUP, rowIds: bands.map((band) => band.spec.key) }],
    [bands]
  );
  // A new function once the scroller mounts (after the loading or empty state), so the
  // row windows attach to it then rather than only on the view's first render.
  const scrollParent = useCallback(
    () => scroller ?? gridRef.current,
    [scroller]
  );
  const rowHeight = useCallback((key: string) => heights.get(key), [heights]);
  const rowWindows = useRowWindows({
    rootRef: gridRef,
    headRef: NO_HEAD,
    enabled: true,
    scrollParent,
    groups: windowGroups,
    dragging: NO_DRAG,
    estimate: BAND_ESTIMATE,
    rowHeight,
    initialRows: INITIAL_BANDS,
    overscan: BAND_OVERSCAN,
    flushOnScroll: true,
  });
  const { registerList } = rowWindows;
  const registerBands = useCallback(
    (el: HTMLUListElement | null) => registerList(BAND_GROUP, el),
    [registerList]
  );

  // One band in its `<li data-row-id>`, the element the row windows measure. The list is
  // presentation only (each band is a labelled section, and a windowed list would
  // announce only the bands that happen to be mounted).
  const drawBand = (band: LiveBandModel) => {
    const key = band.spec.key;
    return (
      <li
        key={key}
        role="presentation"
        data-row-id={key}
        className={styles.bandItem}
      >
        <LiveBand band={band} ctx={bandCtx} actions={actions} />
      </li>
    );
  };
  const segments = rowWindows.segmentsOf(BAND_GROUP);

  const pauseAll = useCallback(async () => {
    setBusy(true);
    const ids = fleet.active;
    const results = await Promise.allSettled(
      ids.map((id) => handlePauseMilestone(id))
    );
    results.forEach((result, i) => {
      const id = ids[i];
      if (result.status === 'rejected' && id !== undefined) {
        onDispatchFailed(
          id,
          result.reason instanceof Error
            ? result.reason.message
            : 'The daemon refused the pause.'
        );
      }
    });
    setBusy(false);
  }, [fleet.active, handlePauseMilestone, onDispatchFailed]);
  const resumeAll = useCallback(async () => {
    setBusy(true);
    const ids = fleet.resumable;
    const results = await Promise.allSettled(
      ids.map((id) => handleResumeMilestone(id))
    );
    results.forEach((result, i) => {
      const id = ids[i];
      if (result.status === 'rejected' && id !== undefined) {
        onDispatchFailed(
          id,
          result.reason instanceof Error
            ? result.reason.message
            : 'The daemon refused the resume.'
        );
      }
    });
    setBusy(false);
  }, [fleet.resumable, handleResumeMilestone, onDispatchFailed]);

  // The empty state's offer: containers a fan-out would start work in right now.
  const ready = useMemo(
    () =>
      hasBands
        ? []
        : readyContainers({
            taskById,
            children,
            readyIds: data.readyIds,
            holderOf,
            liveIds: new Set(sessionById.keys()),
            limit: READY_LIMIT,
          }),
    [hasBands, taskById, children, data.readyIds, holderOf, sessionById]
  );

  if (!daemonReady) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  const dialogMilestone =
    dialog === null ? undefined : taskById.get(dialog.milestoneId);
  const dialogSession =
    dialog?.mode === 'raise'
      ? (milestoneProgressById.get(dialog.milestoneId)?.session ?? null)
      : null;
  return (
    <div data-slot="live-view" className={styles.view}>
      <div className={styles.head}>
        {/* Runs › Live: the Runs back chip (when hosted) and the h1. No
            in-page trail: the topbar's already reads project / Runs / Live
            (currentShellPageTitle). */}
        <PageHead
          title={LIVE_PAGE_TITLE}
          back={onBack === undefined ? undefined : { ...RUNS_BACK, onBack }}
        />
      </div>
      <LiveHeader
        totals={totals}
        spendToday={today}
        ceilings={ceilings}
        active={fleet.active.length}
        resumable={fleet.resumable.length}
        capped={fleet.capped}
        busy={busy}
        onPauseAll={() => setConfirmPause(true)}
        onResumeAll={() => void resumeAll()}
      />
      {!data.tasksReady ? (
        <div className={styles.loading}>
          <SkeletonRows rows={4} label="Loading the work in flight" />
        </div>
      ) : !hasBands ? (
        <LiveReady
          containers={ready}
          refFor={refFor}
          onSendAgents={sendAgents}
          onOpenPlan={openPlan}
        />
      ) : (
        <div
          ref={attachGrid}
          role="group"
          aria-label="Live work"
          className={styles.scroller}
        >
          <ul ref={registerBands} role="presentation" className={styles.bands}>
            {segments === null
              ? bands.map(drawBand)
              : segments.flatMap((segment) =>
                  segment.kind === 'gap'
                    ? [
                        // The bands not mounted: their exact height, so the scroll
                        // range and every mounted band's place are as if they were.
                        <li
                          key={`gap-${segment.start}`}
                          role="presentation"
                          aria-hidden="true"
                          className={styles.gap}
                          style={{ height: segment.px }}
                        />,
                      ]
                    : bands.slice(segment.start, segment.end).map(drawBand)
                )}
          </ul>
        </div>
      )}
      <ConfirmDialog
        data-slot="live-pause-all-confirm"
        open={confirmPause}
        title={
          fleet.active.length === 1
            ? 'Pause the fan-out?'
            : `Pause all ${fleet.active.length} fan-outs?`
        }
        confirmLabel="Pause all"
        onCancel={() => setConfirmPause(false)}
        onConfirm={() => {
          setConfirmPause(false);
          void pauseAll();
        }}
      >
        Nothing new starts in them until you resume. Agents already running
        finish what they are on.
      </ConfirmDialog>
      {dialog !== null && dialogMilestone !== undefined && (
        <DispatchDialog
          title={`${dialog.mode === 'raise' ? 'Raise ceiling' : 'Send agents'} · ${dialogMilestone.meta.title}`}
          tasks={fanoutScope(
            dialog.milestoneId,
            (id) => children.get(id) ?? []
          ).filter((t) => !containerIds.has(t.meta.id))}
          readyIds={data.readyIds}
          // A teammate's task never starts in a fan-out: the dialog marks it Teammate.
          holderOf={holderOf}
          runningNow={data.liveRunStateByTaskId.size}
          liveClaims={liveClaims}
          defaultConcurrency={
            data.config?.orchestrator.milestoneConcurrency ?? 3
          }
          maxConcurrency={data.config?.orchestrator.maxConcurrency}
          runCostEstimateUsd={data.config?.orchestrator.runCostEstimateUsd}
          fixLoopAuto={data.config?.fixLoop.auto}
          mode={dialog.mode}
          initial={
            dialogSession !== null
              ? {
                  concurrency: dialogSession.concurrency,
                  maxSpendUsd: dialogSession.maxSpendUsd,
                  maxRuns: dialogSession.maxRuns,
                }
              : undefined
          }
          onCancel={() => setDialog(null)}
          onConfirm={async (opts: WorkMilestoneOptions) => {
            if (dialog.mode === 'raise') {
              await handleResumeMilestone(dialog.milestoneId, opts);
            } else {
              await handleWorkMilestone(dialog.milestoneId, opts);
            }
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
