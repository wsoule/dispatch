import {
  DEFAULT_STATUS_MODEL,
  fanoutScope,
  isUnstartedStatus,
  statusModelOf,
} from '@dispatch-foo/core/browser';
import type { EpicProgressChild } from '@dispatch/client';
import {
  type KeyboardEvent,
  useCallback,
  useDeferredValue,
  useEffect,
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
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import { TaskPane } from '../components/tasks/TaskPane';
import {
  VirtualRows,
  type VirtualRowsHandle,
} from '../components/virtual/VirtualRows';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isTypingTarget } from '../hooks/useGlobalKeyboard';
import { useOptimisticDispatch } from '../hooks/useOptimisticDispatch';
import type { TaskTab } from '../lib/appNav';
import { liveClaimsFrom } from '../lib/dispatchPreview';
import type { WorkEpicOptions } from '../lib/epicSession';
import { landingStateByTaskId } from '../lib/landingBadge';
import { resolveLinearLink } from '../lib/linearSettings';
import { liveCeilingsOf, spendToday } from '../lib/liveSpend';
import { pendingStarts } from '../lib/optimisticDispatch';
import { assigneeRef } from '../lib/taskDisplay';
import { PageHeader } from '@/ui/ai/page-header';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/ui/alert-dialog';
import { Spinner } from '@/ui/spinner';

/** How long the cursor rests on a node before an open side pane follows it. */
const PANE_FOLLOW_MS = 120;
/** How many ready containers the empty state offers. */
const READY_LIMIT = 6;

const bandKey = (band: LiveBandModel) => band.spec.key;

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
  epicId: string;
  mode: 'start' | 'raise';
}

export interface LiveViewProps {
  data: DispatchProjectData;
  projectName: string | null;
  /** Dispatches without leaving the view, rejecting on failure so `d` can roll back. */
  dispatchTask: (taskId: string) => Promise<void>;
  /** A dispatch or fan-out verb the daemon refused — App toasts it. */
  onDispatchFailed: (taskId: string, message: string) => void;
  /** The full task page (`o`, the pane's expand, a band's Flight Plan). */
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** The peek dialog (Space). */
  onPeekTask: (taskId: string) => void;
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
 * Enter opens the task beside the bands, `o` its page, Space peeks, `d` dispatches (never
 * a teammate's), Escape closes the pane.
 */
export function LiveView({
  data,
  projectName,
  dispatchTask,
  onDispatchFailed,
  onOpenTask,
  onPeekTask,
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
  const sessions = data.liveEpicSessions;
  const sessionById = useMemo(
    () => new Map(sessions.map((p) => [p.epicId, p])),
    [sessions]
  );
  const withRunBranch = useMemo(
    () => tasksWithRunBranch(data.runs),
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
      if (session?.state === 'active') active.push(progress.epicId);
      else if (session?.state === 'paused') {
        if (
          session.pausedReason === 'budget' ||
          session.pausedReason === 'runs'
        ) {
          capped++;
        } else resumable.push(progress.epicId);
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
    const out = new Map<string, EpicProgressChild>();
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

  // The cursor, the side pane, and the dialogs.
  const [cursor, setCursor] = useState<LiveCursor | null>(null);
  const [hasFocus, setHasFocus] = useState(false);
  const [paneTaskId, setPaneTaskId] = useState<string | null>(null);
  const deferredPaneTaskId = useDeferredValue(paneTaskId);
  const [dialog, setDialog] = useState<FanoutDialogState | null>(null);
  const [confirmPause, setConfirmPause] = useState(false);
  const [busy, setBusy] = useState(false);
  const gArmedAt = useRef<number | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const rows = useRef<VirtualRowsHandle>(null);
  // The band list scrolls itself and holds the keyboard; the rows window against it.
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

  // Where a key last moved the cursor: the open pane follows it once it rests. A node
  // leaving the view (its run finished, its wave folded) settles the cursor elsewhere but
  // never swaps the task being read.
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const showInPane = useCallback((taskId: string | null) => {
    setMovedTo(null);
    setPaneTaskId(taskId);
  }, []);
  useEffect(() => {
    if (paneTaskId === null || movedTo === null || movedTo === paneTaskId) {
      return;
    }
    const timer = setTimeout(() => setPaneTaskId(movedTo), PANE_FOLLOW_MS);
    return () => clearTimeout(timer);
  }, [movedTo, paneTaskId]);

  const daemonReady =
    !data.portLoading && !data.portError && data.client !== null;
  const hasBands = bands.length > 0;
  useEffect(() => {
    if (daemonReady && hasBands) {
      gridRef.current?.focus({ preventScroll: true });
    }
  }, [daemonReady, hasBands]);

  // A card's click, read through a ref so its identity never changes: every card takes it,
  // and a new one would re-render them all on each event.
  const locatedRef = useRef(located);
  useEffect(() => {
    locatedRef.current = located;
  }, [located]);
  const activate = useCallback(
    (taskId: string) => {
      const where = locatedRef.current.get(taskId);
      if (where === undefined) return;
      setCursor({ band: where.band, id: taskId });
      showInPane(taskId);
      gridRef.current?.focus({ preventScroll: true });
    },
    [showInPane]
  );
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
    epicProgressById,
    handlePauseEpic,
    handleResumeEpic,
    handleStopEpic,
    handleLandEpic,
    handleWorkEpic,
  } = data;
  const actions = useMemo<LiveBandActions>(
    () => ({
      model,
      progressOf: (id) => epicProgressById.get(id),
      onSendAgents: (id) => setDialog({ epicId: id, mode: 'start' }),
      onRaiseCeiling: (id) => setDialog({ epicId: id, mode: 'raise' }),
      onPause: handlePauseEpic,
      onResume: handleResumeEpic,
      onStop: handleStopEpic,
      onLand: handleLandEpic,
      onOpenPlan: openPlan,
      onToggleFold: toggleFold,
      onActivate: activate,
    }),
    [
      model,
      epicProgressById,
      handlePauseEpic,
      handleResumeEpic,
      handleStopEpic,
      handleLandEpic,
      openPlan,
      toggleFold,
      activate,
    ]
  );

  // Every band's top in the scroller: bands are exactly their computed height.
  const tops = useMemo(() => {
    const out = new Map<string, number>();
    let y = 0;
    for (const band of bands) {
      out.set(band.spec.key, y);
      y += liveBandHeight(band);
    }
    return out;
  }, [bands]);
  const pinnedKeys = useMemo(
    () => (focusedBand === null ? [] : [focusedBand]),
    [focusedBand]
  );
  const renderBand = useCallback(
    (band: LiveBandModel) => {
      const key = band.spec.key;
      return (
        <LiveBand
          band={band}
          ctx={bandCtx}
          actions={actions}
          focusedId={focusedBand === key ? focusedId : null}
          expanded={expanded.has(key)}
          scroller={scroller}
          top={tops.get(key) ?? 0}
        />
      );
    },
    [bandCtx, actions, focusedBand, focusedId, expanded, scroller, tops]
  );

  // A band jump brings the band's title to the top; the band scrolls its own card into
  // view (the cursor's band stays mounted, so it is there to find).
  const revealBand = useCallback((band: string) => {
    rows.current?.scrollToKey(band, 'start');
  }, []);

  const pauseAll = useCallback(async () => {
    setBusy(true);
    const ids = fleet.active;
    const results = await Promise.allSettled(
      ids.map((id) => handlePauseEpic(id))
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
  }, [fleet.active, handlePauseEpic, onDispatchFailed]);
  const resumeAll = useCallback(async () => {
    setBusy(true);
    const ids = fleet.resumable;
    const results = await Promise.allSettled(
      ids.map((id) => handleResumeEpic(id))
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
  }, [fleet.resumable, handleResumeEpic, onDispatchFailed]);

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
        setMovedTo(next.id);
        if (command === 'next-band' || command === 'prev-band') {
          revealBand(next.band);
        }
        return;
      }
      case 'open':
        if (focused === null) return;
        e.preventDefault();
        showInPane(focused.id);
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
        if (paneTaskId === null) return;
        // The shell's Escape would also navigate back.
        e.preventDefault();
        e.stopPropagation();
        showInPane(null);
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

  const dialogEpic = dialog === null ? undefined : taskById.get(dialog.epicId);
  const dialogSession =
    dialog?.mode === 'raise'
      ? (epicProgressById.get(dialog.epicId)?.session ?? null)
      : null;
  const split = deferredPaneTaskId !== null;
  const crumb = [...(projectName === null ? [] : [projectName]), 'Live'];

  return (
    <div data-slot="live-view" className="flex h-full min-h-0 flex-col">
      <PageHeader crumb={crumb} />
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
        <div className="flex min-h-0 flex-1 items-center justify-center">
          <Spinner className="text-muted-foreground size-4" />
        </div>
      ) : !hasBands ? (
        <LiveReady
          containers={ready}
          refFor={refFor}
          onSendAgents={(id) => setDialog({ epicId: id, mode: 'start' })}
          onOpenPlan={openPlan}
        />
      ) : (
        <div className="flex min-h-0 flex-1">
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
            // The focused node carries the ring, so the scroller's own would only frame it.
            style={{ outline: 'none' }}
            className="relative min-h-0 min-w-0 flex-1 overflow-y-auto pt-2"
          >
            <VirtualRows
              rows={bands}
              rowKey={bandKey}
              estimateSize={liveBandHeight}
              renderRow={renderBand}
              scrollElement={scroller}
              overscan={1}
              pinnedKeys={pinnedKeys}
              handleRef={rows}
            />
          </div>
          {split && (
            <div className="shadow-hairline-left w-[min(520px,45%)] min-w-0 shrink-0">
              <TaskPane
                taskId={deferredPaneTaskId}
                onClose={() => {
                  showInPane(null);
                  gridRef.current?.focus({ preventScroll: true });
                }}
                onExpand={() => onOpenTask(deferredPaneTaskId)}
              />
            </div>
          )}
        </div>
      )}
      {confirmPause && (
        <AlertDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirmPause(false);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                Pause{' '}
                {fleet.active.length === 1
                  ? 'the fan-out'
                  : `all ${fleet.active.length} fan-outs`}
                ?
              </AlertDialogTitle>
              <AlertDialogDescription>
                Nothing new starts in them until you resume. Agents already
                running finish what they are on.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel variant="ghost">Cancel</AlertDialogCancel>
              <AlertDialogAction
                data-slot="live-pause-all-confirm"
                onClick={() => {
                  setConfirmPause(false);
                  void pauseAll();
                }}
              >
                Pause all
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
      {dialog !== null && dialogEpic !== undefined && (
        <DispatchDialog
          title={`${dialog.mode === 'raise' ? 'Raise ceiling' : 'Send agents'} · ${dialogEpic.meta.title}`}
          tasks={fanoutScope(
            dialog.epicId,
            (id) => children.get(id) ?? []
          ).filter((t) => !containerIds.has(t.meta.id))}
          // A teammate's task never starts in a fan-out, so the dialog never says it will.
          readyIds={
            new Set(
              [...data.readyIds].filter((id) => {
                const task = taskById.get(id);
                return task !== undefined && holderOf(task) === null;
              })
            )
          }
          runningNow={data.liveRunStateByTaskId.size}
          liveClaims={liveClaims}
          defaultConcurrency={data.config?.orchestrator.epicConcurrency ?? 3}
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
          onConfirm={async (opts: WorkEpicOptions) => {
            if (dialog.mode === 'raise') {
              await handleResumeEpic(dialog.epicId, opts);
            } else {
              await handleWorkEpic(dialog.epicId, opts);
            }
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
