import {
  DEFAULT_STATUS_MODEL,
  fanoutScope,
  isUnstartedStatus,
  statusModelOf,
} from '@dispatch-foo/core/browser';
import type { MilestoneProgressChild } from '@dispatch/client';
import {
  ConfirmDialog,
  type RowWindowGroup,
  SkeletonRows,
  useRowWindows,
} from '@dispatch/ui';
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { runPace } from '../components/flightplan/criticalPath';
import { flightNodeDomId } from '../components/flightplan/FlightNodeCard';
import type { FlightNode } from '../components/flightplan/flightPlan';
import {
  tasksWithRunBranch,
  viewerHolderOf,
} from '../components/flightplan/flightPlan';
import { canDispatch } from '../components/flightplan/FlightPlanView';
import { childrenByParent } from '../components/flightplan/flightScope';
import type { NodeViewContext } from '../components/flightplan/flightViews';
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
import {
  type LiveCursor,
  moveLiveCursor,
  resolveLiveKey,
  settleLiveCursor,
} from '../components/live/liveKeys';
import { LiveReady } from '../components/live/LiveReady';
import { usePeople } from '../components/people/PeopleContext';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { PageHead, RUNS_BACK } from '../components/shell/PageHead';
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isTypingTarget } from '../hooks/useGlobalKeyboard';
import { useOptimisticDispatch } from '../hooks/useOptimisticDispatch';
import type { TaskTab } from '../lib/appNav';
import { liveClaimsFrom } from '../lib/dispatchPreview';
import { landingStateByTaskId } from '../lib/landingBadge';
import { resolveLinearLink } from '../lib/linearSettings';
import { liveCeilingsOf, spendToday } from '../lib/liveSpend';
import type { WorkMilestoneOptions } from '../lib/milestoneSession';
import { pendingStarts } from '../lib/optimisticDispatch';
import { tasksWithFinishedRun } from '../lib/runState';
import { LIVE_PAGE_TITLE } from '../lib/shellRoutes';
import { assigneeRef } from '../lib/taskDisplay';
import styles from './LiveView.module.css';

/** How many ready containers the empty state offers. */
const READY_LIMIT = 6;

/** The band list's one window group: every band is a row of it. */
const BAND_GROUP = 'live';
/** The space above the first band inside the scroller: `.scroller`'s padding-top in
 * LiveView.module.css. Every band's `top` (for its card culling) adds it. */
const LIST_TOP = 8;
/** A band's height before the first measurement: a title row over two rows of cards.
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

// A clock for estimates that age: a running node's remaining time shrinks with it.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// The fan-out dialog, open for one container: `start` sends a fresh session, `raise`
// edits a paused one's ceilings.
interface FanoutDialogState {
  milestoneId: string;
  mode: 'start' | 'raise';
}

export interface LiveViewProps {
  data: DispatchProjectData;
  /** Dispatches without leaving the view, rejecting on failure so `d` can roll back. */
  dispatchTask: (taskId: string) => Promise<void>;
  /** A dispatch or fan-out verb the daemon refused — App toasts it. */
  onDispatchFailed: (taskId: string, message: string) => void;
  /** The full task page (`o`, a band's Flight Plan). */
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** The quick-look slide-over (a card click, Enter, Space). */
  onPeekTask: (taskId: string) => void;
  /** Hosted by App, the page leads with the Runs back chip, which calls this
   * to return to the Runs page (Live reads as Runs › Live). */
  onBack?: () => void;
}

/**
 * Everything in motion across the project, on one screen: a band per container with work
 * moving (a live or paused fan-out, or a child running, landing or waiting on a review),
 * running first, then queued, then paused, and a Loose work band for agents outside every
 * container. Each band is that container's Flight Plan (waves, live node states, blocked
 * sentences, the critical path) with finished waves folded to a count. Only bands near
 * the viewport mount, and each draws only the cards near it; everything derives from the
 * cached task list, runs and fan-out progress.
 *
 * Keyboard: j/k walk every node in reading order, J/K jump a band, h/l cross columns,
 * Enter and Space quick-look the task in the shell's slide-over, `o` opens its page, `d`
 * dispatches (never a teammate's); Escape is the shell's (it closes the drawer, then
 * goes back one place with the Runs page open).
 */
export function LiveView({
  data,
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
      landing,
    ]
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  // Waves and layouts per band, kept while a band's structure holds.
  const geometry = useRef<LiveGeometryCache>(new Map());
  const bands = useMemo(() => {
    const cache = geometry.current;
    const built = specs.map((spec) =>
      buildLiveBand(spec, shared, {
        expanded: expanded.has(spec.key),
        cache,
      })
    );
    const keep = new Set(specs.map((s) => s.key));
    for (const key of cache.keys()) if (!keep.has(key)) cache.delete(key);
    return orderLiveBands(built);
  }, [specs, shared, expanded]);

  // Every drawn node's band and plan node, for the keyboard and clicks.
  const located = useMemo(() => {
    const out = new Map<string, { band: string; node: FlightNode }>();
    for (const band of bands) {
      const drawn = new Set(band.order);
      for (const node of band.plan.nodes) {
        if (drawn.has(node.task.meta.id)) {
          out.set(node.task.meta.id, { band: band.spec.key, node });
        }
      }
    }
    return out;
  }, [bands]);
  const navBands = useMemo(
    () => bands.map((b) => ({ key: b.spec.key, order: b.order, nav: b.nav })),
    [bands]
  );

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
  const phases = useMemo(() => {
    const out = new Map<string, MilestoneProgressChild>();
    for (const progress of sessions) {
      for (const child of progress.children) out.set(child.id, child);
    }
    return out;
  }, [sessions]);
  const liveClaims = useMemo(() => liveClaimsFrom(data.runs), [data.runs]);
  const viewCtx = useMemo<NodeViewContext>(
    () => ({
      model,
      refFor,
      latestRunByTaskId: data.latestRunByTaskId,
      live: liveTaskIds,
      pending,
      sessionActive: (owner) =>
        sessionById.get(owner)?.session?.state === 'active',
      phaseOf: (id) => phases.get(id),
      liveClaims,
      landingByTaskId: landing,
      personName: (assignee) =>
        directory.personFor(assignee)?.name ??
        assigneeRef(assignee)?.handle ??
        null,
    }),
    [
      model,
      refFor,
      data.latestRunByTaskId,
      liveTaskIds,
      pending,
      sessionById,
      phases,
      liveClaims,
      landing,
      directory,
    ]
  );
  const pace = useMemo(() => runPace(data.runs), [data.runs]);
  const now = useNow(30_000);
  const bandCtx = useMemo<LiveBandContext>(
    () => ({
      view: viewCtx,
      paceMs: pace.medianMs,
      now,
      startedAt: (id) => {
        const sent = pending.get(id);
        if (sent !== undefined) return sent;
        const run = data.latestRunByTaskId.get(id);
        return run === undefined ? undefined : Date.parse(run.createdAt);
      },
    }),
    [viewCtx, pace, now, pending, data.latestRunByTaskId]
  );

  // The cursor and the dialogs.
  const [cursor, setCursor] = useState<LiveCursor | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const [dialog, setDialog] = useState<FanoutDialogState | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  const [busy, setBusy] = useState(false);
  const gArmedAt = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  // The band list scrolls itself and holds the keyboard; the bands window against it.
  const attachGrid = useCallback((el: HTMLDivElement | null) => {
    gridRef.current = el;
    setScroller(el);
  }, []);

  const settled = useMemo(
    () => settleLiveCursor(navBands, cursor),
    [navBands, cursor]
  );
  const focused = cursor !== null || hasFocus ? settled : null;
  const focusedBand = focused?.band ?? null;
  const focusedId = focused?.id ?? null;

  const daemonReady =
    !data.portLoading && !data.portError && data.client !== null;
  const hasBands = bands.length > 0;
  useEffect(() => {
    if (daemonReady && hasBands) {
      gridRef.current?.focus({ preventScroll: true });
    }
  }, [daemonReady, hasBands]);

  // A card's click, read through refs so its identity never changes: every card takes it,
  // and a new one would re-render them all on each event. It quick-looks the task.
  const locatedRef = useRef(located);
  useEffect(() => {
    locatedRef.current = located;
  }, [located]);
  const peekRef = useRef(onPeekTask);
  useEffect(() => {
    peekRef.current = onPeekTask;
  }, [onPeekTask]);
  const activate = useCallback((taskId: string) => {
    const where = locatedRef.current.get(taskId);
    if (where === undefined) return;
    setCursor({ band: where.band, id: taskId });
    peekRef.current(taskId);
    gridRef.current?.focus({ preventScroll: true });
  }, []);
  const openPlan = useCallback(
    (containerId: string) => onOpenTask(containerId, 'plan'),
    [onOpenTask]
  );
  const toggleFold = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);
  const {
    milestoneProgressById,
    handlePauseMilestone,
    handleResumeMilestone,
    handleStopMilestone,
    handleLandMilestone,
    handleWorkMilestone,
  } = data;
  const actions = useMemo<LiveBandActions>(
    () => ({
      model,
      progressOf: (id) => milestoneProgressById.get(id),
      onSendAgents: (id) => setDialog({ milestoneId: id, mode: 'start' }),
      onRaiseCeiling: (id) => setDialog({ milestoneId: id, mode: 'raise' }),
      onPause: handlePauseMilestone,
      onResume: handleResumeMilestone,
      onStop: handleStopMilestone,
      onLand: handleLandMilestone,
      onOpenPlan: openPlan,
      onToggleFold: toggleFold,
      onActivate: activate,
    }),
    [
      model,
      milestoneProgressById,
      handlePauseMilestone,
      handleResumeMilestone,
      handleStopMilestone,
      handleLandMilestone,
      openPlan,
      toggleFold,
      activate,
    ]
  );

  // Every band's exact height and its top in the scroller (under the list's top
  // padding): bands are exactly their computed height, so neither needs a measurement.
  // A new `heights` (a band grew, folded or re-sorted) hands the row windows a new
  // `rowHeight`, which re-windows before paint, so the gaps and `tops` always agree.
  const { heights, tops } = useMemo(() => {
    const heightOf = new Map<string, number>();
    const topOf = new Map<string, number>();
    let y = LIST_TOP;
    for (const band of bands) {
      const height = liveBandHeight(band);
      heightOf.set(band.spec.key, height);
      topOf.set(band.spec.key, y);
      y += height;
    }
    return { heights: heightOf, tops: topOf };
  }, [bands]);
  const bandIndex = useMemo(
    () => new Map(bands.map((band, index) => [band.spec.key, index])),
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
  // The cursor's band stays mounted however far the list scrolls, so
  // aria-activedescendant always points at a drawn card: a j/k/h/l move into a band the
  // window left out mounts it at once (setFocusedRow measures again), a re-sort keeps it
  // mounted, and the band then scrolls its card into view. Both callbacks are stable (the
  // windows object itself is new on every window change).
  const { setFocusedRow, registerList } = rowWindows;
  useLayoutEffect(() => {
    setFocusedRow(focusedBand);
  }, [setFocusedRow, focusedBand]);
  const registerBands = useCallback(
    (el: HTMLUListElement | null) => registerList(BAND_GROUP, el),
    [registerList]
  );

  // A band jump brings the band's title to the top; the band scrolls its own card into
  // view (the cursor's band is pinned first, so it is there to find).
  const revealBand = useCallback(
    (band: string) => {
      const index = bandIndex.get(band);
      if (index === undefined) return;
      rowWindows.setFocusedRow(band);
      rowWindows.revealRow(BAND_GROUP, index, 'start');
    },
    [bandIndex, rowWindows]
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
        <LiveBand
          band={band}
          ctx={bandCtx}
          actions={actions}
          focusedId={focusedBand === key ? focusedId : null}
          expanded={expanded.has(key)}
          scroller={scroller}
          top={tops.get(key) ?? LIST_TOP}
        />
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

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (isTypingTarget(e.target)) return;
    // Enter or Space on a control inside a band (its fan-out verbs) belongs to it.
    if (
      e.target !== e.currentTarget &&
      (e.target as HTMLElement).closest(
        'button, a, input, select, textarea'
      ) !== null &&
      (e.key === 'Enter' || e.key === ' ')
    ) {
      return;
    }
    const { command, gArmedAt: armed } = resolveLiveKey(
      {
        key: e.key,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        at: Date.now(),
      },
      gArmedAt.current
    );
    gArmedAt.current = armed;
    if (command === null) return;
    switch (command) {
      case 'next':
      case 'prev':
      case 'next-band':
      case 'prev-band':
      case 'left':
      case 'right': {
        e.preventDefault();
        const next = moveLiveCursor(navBands, focused, command);
        if (next === null) return;
        setCursor(next);
        if (command === 'next-band' || command === 'prev-band') {
          revealBand(next.band);
        }
        return;
      }
      case 'open':
        if (focused === null) return;
        e.preventDefault();
        onPeekTask(focused.id);
        return;
      case 'open-full':
        if (focused === null) return;
        e.preventDefault();
        onOpenTask(focused.id);
        return;
      case 'peek':
        if (focused === null) return;
        e.preventDefault();
        onPeekTask(focused.id);
        return;
      case 'dispatch': {
        if (focused === null) return;
        const node = located.get(focused.id)?.node;
        if (!canDispatch(node, model, holderOf)) return;
        e.preventDefault();
        void optimistic.dispatch(focused.id);
        return;
      }
      case 'close':
        // Nothing of the view's own to close: the shell's Escape closes the drawer.
        return;
    }
  }

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
          onSendAgents={(id) => setDialog({ milestoneId: id, mode: 'start' })}
          onOpenPlan={openPlan}
        />
      ) : (
        <div
          ref={attachGrid}
          role="group"
          aria-label="Live work"
          aria-activedescendant={
            focusedId === null ? undefined : flightNodeDomId(focusedId)
          }
          tabIndex={0}
          onKeyDown={handleKeyDown}
          onFocus={() => setHasFocus(true)}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget)) {
              setHasFocus(false);
            }
          }}
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
