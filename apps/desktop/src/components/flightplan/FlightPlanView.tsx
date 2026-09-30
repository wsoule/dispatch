import type { EpicProgress, EpicProgressChild } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import {
  DEFAULT_STATUS_MODEL,
  fanoutCoverers,
  fanoutScope,
  isCompletedStatus,
  isDoneStatus,
  isUnstartedStatus,
  statusModelOf,
  usesIntegrationBranch,
} from '@dispatch/core/browser';
import { Waypoints } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useOptimisticDispatch } from '../../hooks/useOptimisticDispatch';
import type { TaskTab } from '../../lib/appNav';
import { liveClaimsFrom } from '../../lib/dispatchPreview';
import {
  concurrencyChoices,
  concurrencyLabel,
} from '../../lib/epicConcurrency';
import type { WorkEpicOptions } from '../../lib/epicSession';
import { landingStateByTaskId } from '../../lib/landingBadge';
import { resolveLinearLink } from '../../lib/linearSettings';
import { rollupMilestoneStatus } from '../../lib/milestoneRollup';
import { pendingStarts } from '../../lib/optimisticDispatch';
import { assigneeRef } from '../../lib/taskDisplay';
import { FanoutControls } from '../milestones/FanoutControls';
import { usePeople } from '../people/PeopleContext';
import { DispatchDialog } from '../tasks/DispatchDialog';
import { criticalPath, etaMs, runPace } from './criticalPath';
import type { BranchLaneGroup } from './FlightBranchLane';
import type { FlightBandView } from './FlightCanvas';
import { flightNavIndex } from './flightKeys';
import { flightGeometry, flightStructureKey } from './flightLayout';
import {
  buildFlightPlan,
  type FlightNode,
  tasksWithRunBranch,
  viewerHolderOf,
} from './flightPlan';
import { type FlightHeaderStats, FlightPlanHeader } from './FlightPlanHeader';
import {
  childrenByParent,
  DIRECT_BAND,
  type FlightScope,
  flightScope,
  sameScope,
} from './flightScope';
import { type FlightLaneData, FlightStage } from './FlightStage';
import {
  flightEdgeViews,
  flightNodeViews,
  flightWaveViews,
  queuePositions,
} from './flightViews';
import { cn } from '@/lib/utils';
import { SelectPill } from '@/ui/ai/pill';
import { EmptyState } from '@/ui/chrome';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Spinner } from '@/ui/spinner';

export interface FlightPlanProps {
  containerId: string;
  data: DispatchProjectData;
  /** Dispatches without leaving the plan, rejecting on failure so `d` can roll back. */
  dispatchTask: (taskId: string) => Promise<void>;
  /** A dispatch or ceiling change the daemon refused — the caller toasts it. */
  onDispatchFailed: (taskId: string, message: string) => void;
  /** The full task page (`o`, the pane's expand, a band's Open). */
  onOpenTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** The peek dialog (Space); omitted leaves Space alone. */
  onPeekTask?: (taskId: string) => void;
  /** Where a node opens on click or Enter: a split pane beside the plan (the default), or
   * the full task page — for a host that is itself a pane. */
  openIn?: 'pane' | 'page';
  /** The branch lane beneath the plan; on by default. */
  showBranches?: boolean;
  /** Take keyboard focus once the plan is on screen. */
  focusOnMount?: boolean;
  className?: string;
}

// A clock for estimates that age: remaining time on a running node shrinks with it.
function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Whether `d` may send an agent at a node: unstarted, no blocker ahead of it, not its
// own plan, not a teammate's or a derived task, and not already running. A held
// (critical) node qualifies — by hand is exactly how it starts. "A teammate's" reads
// against the viewer (`viewerHolderOf`): in a teammate's fan-out a node's state reads
// against its starter. The Live view shares it.
export function canDispatch(
  node: FlightNode | undefined,
  model: Parameters<typeof isUnstartedStatus>[1],
  holderOf: (task: TaskListItem) => string | null
): node is FlightNode {
  return (
    node !== undefined &&
    node.state !== 'running' &&
    holderOf(node.task) === null &&
    !node.subPlan &&
    node.task.meta.derivedFrom === undefined &&
    node.waitingOn.length === 0 &&
    isUnstartedStatus(node.task.meta.status, model)
  );
}

// The fan-out dialog, open for one container: `start` sends a fresh session, `raise`
// edits a paused one's ceilings.
interface FanoutDialogState {
  epicId: string;
  mode: 'start' | 'raise';
}

/**
 * A container's Flight Plan: its work as waves of cards, left to right, that fill in as
 * agents run — landed ✓, running ◐ with the agent's step, clock and cost, a teammate's ●
 * with their avatar and state, queued ⏳ with its place in line, blocked ○ with the exact
 * blockers it auto-starts after. Edges light as blockers land; the critical path glows
 * under its edges; a project draws one band per milestone. The header carries slots,
 * counts, the critical path, the ETA and the fan-out controls; the branch lane beneath
 * shows the same work as git sees it. Everything derives from the cached task list, runs
 * and fan-out progress — no polling of its own — and the layout reads structure only, so
 * live updates flip cards in place.
 *
 * Keyboard: arrows (or h/j/k/l) move, Enter opens the task beside the plan, `o` opens its
 * page, Space peeks, `d` dispatches the focused node (optimistically), Escape closes the
 * pane.
 */
export function FlightPlan({
  containerId,
  data,
  dispatchTask,
  onDispatchFailed,
  onOpenTask,
  onPeekTask,
  openIn = 'pane',
  showBranches = true,
  focusOnMount = false,
  className,
}: FlightPlanProps) {
  const directory = usePeople();
  const [dialog, setDialog] = useState<FanoutDialogState | null>(null);

  const model = useMemo(
    () =>
      data.config === null ? DEFAULT_STATUS_MODEL : statusModelOf(data.config),
    [data.config]
  );
  const tasks = data.tasksIncludingArchived;
  const children = useMemo(() => childrenByParent(tasks), [tasks]);
  const containerIds = useMemo(() => new Set(children.keys()), [children]);
  const container = useMemo(
    () => tasks.find((t) => t.meta.id === containerId) ?? null,
    [tasks, containerId]
  );
  // A change elsewhere in the project leaves this scope's tasks untouched: keep the old
  // scope object then, so nothing below recomputes.
  const lastScope = useRef<FlightScope | null>(null);
  const scope = useMemo(() => {
    const next = container === null ? null : flightScope(container, children);
    const prev = lastScope.current;
    return prev !== null && next !== null && sameScope(prev, next)
      ? prev
      : next;
  }, [container, children]);
  useEffect(() => {
    lastScope.current = scope;
  }, [scope]);
  const nodes = useMemo(() => scope?.nodes ?? [], [scope]);
  const nodeById = useMemo(
    () => new Map(nodes.map((t) => [t.meta.id, t])),
    [nodes]
  );
  // Blockers outside the plan hold their dependents too (the server reads the whole
  // board). Kept as the same map while none of them moves, so a task event elsewhere
  // never rebuilds the plan.
  const lastOutside = useRef<ReadonlyMap<string, TaskListItem>>(new Map());
  const outside = useMemo(() => {
    let byId: Map<string, TaskListItem> | null = null;
    const next = new Map<string, TaskListItem>();
    for (const task of nodes) {
      for (const id of task.meta.blockedBy) {
        if (nodeById.has(id) || next.has(id)) continue;
        byId ??= new Map(tasks.map((t) => [t.meta.id, t]));
        const blocker = byId.get(id);
        if (blocker !== undefined) next.set(id, blocker);
      }
    }
    const prev = lastOutside.current;
    const same =
      prev.size === next.size &&
      [...next].every(([id, t]) => {
        const was = prev.get(id)?.meta;
        return (
          was !== undefined &&
          was.status === t.meta.status &&
          was.assignee === t.meta.assignee &&
          was.external === t.meta.external
        );
      });
    return same ? prev : next;
  }, [nodes, nodeById, tasks]);
  useEffect(() => {
    lastOutside.current = outside;
  }, [outside]);
  const lookup = useCallback((id: string) => outside.get(id), [outside]);

  // Structure only (ids, blockers, bands): a status change keeps the key, so waves, the
  // layout and the keyboard grid are never redone for one.
  const structure = useMemo(
    () =>
      scope === null
        ? flightStructureKey([], null)
        : flightStructureKey(
            scope.nodes.map((t) => ({
              id: t.meta.id,
              created: t.meta.created,
              blockedBy: t.meta.blockedBy,
              band: scope.bandOf.get(t.meta.id) ?? null,
            })),
            scope.bands?.map((b) => b.key) ?? null
          ),
    [scope]
  );
  const geometry = useMemo(() => {
    const { waves, layout } = flightGeometry(structure);
    return { waves, layout, nav: flightNavIndex(layout.boxes) };
  }, [structure]);

  // Live runs, plus the dispatches `d` sent that the run list has not caught up with.
  const liveTaskIds = useMemo(
    () => new Set(data.liveRunStateByTaskId.keys()),
    [data.liveRunStateByTaskId]
  );
  const stillWaiting = useCallback(
    (taskId: string) => {
      const task = nodeById.get(taskId);
      return task !== undefined && isUnstartedStatus(task.meta.status, model);
    },
    [nodeById, model]
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
  const { dispatch } = optimistic;
  const dispatchNode = useCallback(
    (id: string) => void dispatch(id),
    [dispatch]
  );
  const flying = useMemo(() => {
    if (pending.size === 0) return liveTaskIds;
    const out = new Set(liveTaskIds);
    for (const id of pending.keys()) out.add(id);
    return out;
  }, [liveTaskIds, pending]);

  // Every active or paused fan-out, who started it and its scope rule, as a key that
  // only changes when one starts, stops or finishes.
  const liveKey = useMemo(() => {
    const out: string[] = [];
    for (const progress of data.epicProgressById.values()) {
      const session = progress.session;
      if (session?.state === 'active' || session?.state === 'paused') {
        out.push(
          `${progress.epicId}=${session.startedBy ?? ''}=${session.scope ?? 'plan'}`
        );
      }
    }
    return out.sort().join(' ');
  }, [data.epicProgressById]);
  const { liveStarters, directOnly } = useMemo(() => {
    const starters = new Map<string, string | null>();
    const direct = new Set<string>();
    for (const entry of liveKey === '' ? [] : liveKey.split(' ')) {
      const [id = '', startedBy = '', scope = ''] = entry.split('=');
      starters.set(id, startedBy === '' ? null : startedBy);
      if (scope === 'direct') direct.add(id);
    }
    return { liveStarters: starters, directOnly: direct };
  }, [liveKey]);
  // Which fan-out would start each node: the nearest covering container with a live
  // session (the server's rule, core's `fanoutCoverers`; a session from before plan-wide
  // fan-outs covers only its direct children), else its parent. Kept as the same map
  // while no owner moves, so a task event elsewhere never rebuilds the plan.
  const lastOwners = useRef<ReadonlyMap<string, string | null>>(new Map());
  const owners = useMemo(() => {
    const byId =
      liveStarters.size === 0
        ? null
        : new Map(tasks.map((t) => [t.meta.id, t]));
    const next = new Map<string, string | null>();
    for (const task of nodes) {
      const covering =
        byId === null
          ? undefined
          : fanoutCoverers(task, (id) => byId.get(id)).find(
              (id) =>
                liveStarters.has(id) &&
                (id === task.meta.parent || !directOnly.has(id))
            );
      next.set(task.meta.id, covering ?? task.meta.parent);
    }
    const prev = lastOwners.current;
    const same =
      prev.size === next.size &&
      [...next].every(([id, owner]) => prev.get(id) === owner);
    return same ? prev : next;
  }, [nodes, tasks, liveStarters, directOnly]);
  useEffect(() => {
    lastOwners.current = owners;
  }, [owners]);
  const ownerOf = useCallback(
    (task: TaskListItem) => owners.get(task.meta.id) ?? task.meta.parent,
    [owners]
  );
  const startedByOf = useCallback(
    (owner: string) => liveStarters.get(owner) ?? null,
    [liveStarters]
  );

  // The fan-out sessions that own these nodes.
  const sessions = useMemo(() => {
    const out = new Map<string, EpicProgress>();
    for (const task of nodes) {
      const owner = owners.get(task.meta.id) ?? null;
      if (owner === null || out.has(owner)) continue;
      const progress = data.epicProgressById.get(owner);
      if (progress !== undefined) out.set(owner, progress);
    }
    return out;
  }, [nodes, owners, data.epicProgressById]);
  const concurrency = useMemo(() => {
    let total: number | null = null;
    for (const progress of sessions.values()) {
      const session = progress.session;
      if (session?.state === 'active' || session?.state === 'paused') {
        total = (total ?? 0) + session.concurrency;
      }
    }
    return total;
  }, [sessions]);
  const phases = useMemo(() => {
    const out = new Map<string, EpicProgressChild>();
    for (const progress of sessions.values()) {
      if (progress.session === null) continue;
      for (const child of progress.children) out.set(child.id, child);
    }
    return out;
  }, [sessions]);

  const withRunBranch = useMemo(
    () => tasksWithRunBranch(data.runs),
    [data.runs]
  );
  const plan = useMemo(
    () =>
      buildFlightPlan(nodes, {
        liveTaskIds: flying,
        model,
        concurrency,
        containerIds,
        waves: geometry.waves,
        me: directory.me,
        local: data.localHuman,
        ownerOf,
        startedByOf,
        withRunBranch,
        lookup,
      }),
    [
      nodes,
      flying,
      model,
      concurrency,
      containerIds,
      geometry.waves,
      directory.me,
      data.localHuman,
      ownerOf,
      startedByOf,
      withRunBranch,
      lookup,
    ]
  );
  const planNodeById = useMemo(
    () => new Map(plan.nodes.map((n) => [n.task.meta.id, n])),
    [plan]
  );

  const pace = useMemo(() => runPace(data.runs), [data.runs]);
  const now = useNow(30_000);
  const path = useMemo(
    () =>
      criticalPath(
        plan.nodes.map((n) => {
          const id = n.task.meta.id;
          const run = data.latestRunByTaskId.get(id);
          const startedAt =
            pending.get(id) ??
            (run === undefined ? undefined : Date.parse(run.createdAt));
          return {
            id,
            wave: n.wave,
            blockedBy: n.task.meta.blockedBy,
            state: n.state,
            ...(n.state === 'running' && startedAt !== undefined
              ? { startedAt }
              : {}),
          };
        }),
        pace.medianMs,
        now
      ),
    [plan, data.latestRunByTaskId, pending, pace, now]
  );

  const refFor = useCallback(
    (id: string) =>
      resolveLinearLink(
        (nodeById.get(id) ?? outside.get(id))?.meta.external ?? null,
        data.linearLinks
      )?.identifier ?? id,
    [nodeById, outside, data.linearLinks]
  );
  const queue = useMemo(
    () =>
      queuePositions(plan.nodes, (owner) => {
        const session = sessions.get(owner)?.session;
        return session?.state === 'active' ? session.concurrency : null;
      }),
    [plan, sessions]
  );
  const liveClaims = useMemo(() => liveClaimsFrom(data.runs), [data.runs]);
  const landingByTaskId = useMemo(
    () => landingStateByTaskId(data.mergeQueue),
    [data.mergeQueue]
  );
  const nodeViews = useMemo(
    () =>
      flightNodeViews(plan, geometry.layout, path, queue, {
        model,
        refFor,
        latestRunByTaskId: data.latestRunByTaskId,
        live: liveTaskIds,
        pending,
        sessionActive: (owner) =>
          sessions.get(owner)?.session?.state === 'active',
        phaseOf: (id) => phases.get(id),
        liveClaims,
        landingByTaskId,
        personName: (assignee) =>
          directory.personFor(assignee)?.name ??
          assigneeRef(assignee)?.handle ??
          null,
      }),
    [
      plan,
      geometry.layout,
      path,
      queue,
      model,
      refFor,
      data.latestRunByTaskId,
      liveTaskIds,
      pending,
      sessions,
      phases,
      liveClaims,
      landingByTaskId,
      directory,
    ]
  );
  const edgeViews = useMemo(
    () => flightEdgeViews(plan, geometry.layout, path),
    [plan, geometry.layout, path]
  );
  const waveViews = useMemo(
    () => flightWaveViews(plan, geometry.layout),
    [plan, geometry.layout]
  );

  // Each band's work, and the branch lane's groups: held across renders so the lane's
  // graphs lay out again only when the work under them changes.
  const bandNodes = useMemo(() => {
    const out = new Map<string, TaskListItem[]>();
    if (scope === null) return out;
    for (const task of nodes) {
      const key = scope.bandOf.get(task.meta.id);
      if (key === undefined) continue;
      const bucket = out.get(key);
      if (bucket === undefined) out.set(key, [task]);
      else bucket.push(task);
    }
    return out;
  }, [scope, nodes]);
  const laneGroups = useMemo<BranchLaneGroup[]>(() => {
    if (container === null || scope === null) return [];
    const integrationOf = (epic: TaskListItem) =>
      usesIntegrationBranch(epic.meta.kind) ? `epic/${epic.meta.id}` : null;
    if (scope.bands === null) {
      return [
        {
          key: container.meta.id,
          title: null,
          integration: integrationOf(container),
          tasks: nodes,
        },
      ];
    }
    return scope.bands.map((band) => ({
      key: band.key,
      title:
        band.key === DIRECT_BAND
          ? `Directly in ${container.meta.title}`
          : (band.container?.meta.title ?? band.key),
      integration: integrationOf(band.container ?? container),
      tasks: bandNodes.get(band.key) ?? [],
    }));
  }, [container, scope, nodes, bandNodes]);

  // Where the cursor sits before anyone moves it: the first unfinished node, reading
  // column by column, so arriving on a plan lands on the work still ahead.
  const defaultCursor = useMemo(() => {
    for (const column of geometry.nav.columns) {
      for (const id of column) {
        if (planNodeById.get(id)?.state !== 'done') return id;
      }
    }
    return geometry.nav.columns[0]?.[0] ?? null;
  }, [geometry.nav, planNodeById]);
  // `d` sends an agent only at a node the plan says may start now, and never at a
  // teammate's.
  const viewerHolder = useMemo(
    () => viewerHolderOf(directory.me, data.localHuman),
    [directory.me, data.localHuman]
  );
  const dispatchable = useCallback(
    (id: string) => canDispatch(planNodeById.get(id), model, viewerHolder),
    [planNodeById, model, viewerHolder]
  );
  const laneData = useMemo<FlightLaneData>(
    () => ({
      branches: data.branches,
      latestRunByTaskId: data.latestRunByTaskId,
      liveRunStateByTaskId: data.liveRunStateByTaskId,
      refFor,
    }),
    [data.branches, data.latestRunByTaskId, data.liveRunStateByTaskId, refFor]
  );

  // A ceiling change on a live session: pause, then resume at the new concurrency (the
  // daemon only takes new options on resume). Running agents are untouched either way.
  const setCeiling = useCallback(
    async (epicId: string, next: number) => {
      try {
        await data.handlePauseEpic(epicId);
        await data.handleResumeEpic(epicId, { concurrency: next });
      } catch (err) {
        onDispatchFailed(
          epicId,
          err instanceof Error ? err.message : 'The daemon refused the change.'
        );
      }
    },
    [data, onDispatchFailed]
  );

  // One container's fan-out verbs — the header's for the plan's own container, a band's
  // for its milestone — over the same session API the Milestones page uses.
  const fanoutFor = useCallback(
    (epic: TaskListItem, band: boolean): ReactNode => {
      const epicId = epic.meta.id;
      const progress = data.epicProgressById.get(epicId);
      const session = progress?.session ?? null;
      const progressChildren = progress?.children ?? [];
      const landable =
        session?.state !== 'active' &&
        session?.state !== 'paused' &&
        progressChildren.length > 0 &&
        progressChildren.every((c) => isDoneStatus(c.status, model)) &&
        !isCompletedStatus(epic.meta.status, model);
      const choices = concurrencyChoices(
        data.config?.orchestrator.epicConcurrency ?? 3,
        data.config?.orchestrator.maxConcurrency
      );
      return (
        <>
          {!band && session?.state === 'active' && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<SelectPill aria-label={`Agent slots for ${epicId}`} />}
              >
                {session.concurrency}{' '}
                {session.concurrency === 1 ? 'slot' : 'slots'}
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[96px]">
                <DropdownMenuRadioGroup
                  value={String(session.concurrency)}
                  onValueChange={(value) => {
                    const next = Number(value);
                    if (next !== session.concurrency)
                      void setCeiling(epicId, next);
                  }}
                >
                  {choices.map((choice) => (
                    <DropdownMenuRadioItem key={choice} value={String(choice)}>
                      {concurrencyLabel(choice)}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          <FanoutControls
            epic={epic}
            model={model}
            progress={progress}
            landable={landable}
            phases={false}
            onSendAgents={(id) => setDialog({ epicId: id, mode: 'start' })}
            onPause={data.handlePauseEpic}
            onResume={data.handleResumeEpic}
            onRaiseCeiling={(id) => setDialog({ epicId: id, mode: 'raise' })}
            onStop={data.handleStopEpic}
            onLand={data.handleLandEpic}
            onOpenEpic={(id) => onOpenTask(id)}
            showOpen={band}
          />
        </>
      );
    },
    [data, model, setCeiling, onOpenTask]
  );

  // A live fan-out over the whole plan; one from before plan-wide fan-outs covers
  // only the direct band, so the milestone bands keep their own controls.
  const containerLive =
    liveStarters.has(containerId) && !directOnly.has(containerId);
  const bandViews = useMemo<FlightBandView[] | null>(() => {
    if (scope === null || container === null || scope.bands === null) {
      return null;
    }
    return scope.bands.map((band) => {
      const box = geometry.layout.bands.find((b) => b.key === band.key);
      const work = bandNodes.get(band.key) ?? [];
      return {
        key: band.key,
        top: box?.top ?? 0,
        title:
          band.container?.meta.title ?? `Directly in ${container.meta.title}`,
        refLabel: band.container === null ? null : refFor(band.key),
        status: rollupMilestoneStatus(work, model),
        done: work.filter((t) => isDoneStatus(t.meta.status, model)).length,
        total: work.length,
        // The container's own live fan-out already covers every band.
        controls:
          band.container === null || containerLive
            ? null
            : fanoutFor(band.container, true),
      };
    });
  }, [
    scope,
    container,
    containerLive,
    geometry.layout,
    bandNodes,
    refFor,
    model,
    fanoutFor,
  ]);

  if (!data.tasksReady) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner className="text-muted-foreground size-4" />
      </div>
    );
  }
  if (container === null || scope === null) {
    return (
      <EmptyState
        className="h-full"
        heading="This plan is no longer available."
        description="Its container was archived or deleted."
      />
    );
  }

  // Only an active session starts anything on its own, so only its slots make an ETA.
  let activeSlots = 0;
  for (const progress of sessions.values()) {
    if (progress.session?.state === 'active') {
      activeSlots += progress.session.concurrency;
    }
  }
  const eta = etaMs(path, activeSlots === 0 ? null : activeSlots);
  const stats: FlightHeaderStats = {
    slots: { used: plan.running, total: concurrency },
    running: plan.running,
    queued: plan.queued,
    done: plan.done,
    total: plan.total,
    critical: { count: path.ids.length, ms: path.ms },
    eta: eta === null ? null : { at: now + eta, ms: eta },
    pace,
  };

  const dialogEpic =
    dialog === null
      ? null
      : dialog.epicId === containerId
        ? container
        : (scope.bands?.find((b) => b.key === dialog.epicId)?.container ??
          null);
  // A teammate's task can never start in the fan-out, so the dialog never says it will.
  const dialogReadyIds =
    dialog === null
      ? data.readyIds
      : new Set(
          [...data.readyIds].filter(
            (id) => planNodeById.get(id)?.state !== 'teammate'
          )
        );
  const dialogSession =
    dialog?.mode === 'raise'
      ? (data.epicProgressById.get(dialog.epicId)?.session ?? null)
      : null;

  return (
    <div
      data-slot="flight-plan"
      className={cn('flex h-full min-h-0 flex-col', className)}
    >
      {/* The container's fan-out covers the whole plan, every band included. */}
      <FlightPlanHeader stats={stats} controls={fanoutFor(container, false)} />
      {nodes.length === 0 ? (
        <EmptyState
          icon={Waypoints}
          heading="Nothing to plan yet"
          description="Tasks under this container show up here as waves, with their blockers drawn between them."
          className="min-h-0 flex-1"
        />
      ) : (
        <FlightStage
          title={container.meta.title}
          layout={geometry.layout}
          nav={geometry.nav}
          nodes={nodeViews}
          edges={edgeViews}
          waves={waveViews}
          bands={bandViews}
          defaultCursor={defaultCursor}
          laneGroups={showBranches ? laneGroups : null}
          lane={laneData}
          canDispatch={dispatchable}
          onDispatch={dispatchNode}
          onOpenTask={onOpenTask}
          onPeekTask={onPeekTask}
          openIn={openIn}
          focusOnMount={focusOnMount}
        />
      )}
      {dialog !== null && dialogEpic !== null && (
        <DispatchDialog
          title={`${dialog.mode === 'raise' ? 'Raise ceiling' : 'Send agents'} · ${dialogEpic.meta.title}`}
          tasks={fanoutScope(
            dialog.epicId,
            (id) => children.get(id) ?? []
          ).filter((t) => !containerIds.has(t.meta.id))}
          readyIds={dialogReadyIds}
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
              await data.handleResumeEpic(dialog.epicId, opts);
            } else {
              await data.handleWorkEpic(dialog.epicId, opts);
            }
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
