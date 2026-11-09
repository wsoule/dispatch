import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  DEFAULT_STATUS_MODEL,
  fanoutCoverers,
  fanoutScope,
  isUnstartedStatus,
  statusModelOf,
  usesIntegrationBranch,
} from '@dispatch-foo/core/browser';
import type { MilestoneProgress } from '@dispatch/client';
import {
  Button,
  cx,
  EmptyState,
  Menu,
  type MenuEntry,
  Skeleton,
  SkeletonRows,
  Tooltip,
} from '@dispatch/ui';
import { ChevronDown, Waypoints, Zap } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { useOptimisticDispatch } from '../../hooks/useOptimisticDispatch';
import type { TaskTab } from '../../lib/appNav';
import { liveClaimsFrom } from '../../lib/dispatchPreview';
import { ISSUES_DISPLAY } from '../../lib/issuesPrefs';
import { resolveLinearLink } from '../../lib/linearSettings';
import { groupTasks } from '../../lib/listGrouping';
import {
  concurrencyChoices,
  concurrencyLabel,
} from '../../lib/milestoneConcurrency';
import {
  spendCellWords,
  unlimitedFanoutOptions,
  waveSteps,
  type WorkMilestoneOptions,
} from '../../lib/milestoneSession';
import { pendingStarts } from '../../lib/optimisticDispatch';
import { taskHref } from '../../lib/routes';
import { tasksWithFinishedRun } from '../../lib/runState';
import type { TaskBucket } from '../../lib/taskStatus';
import { GraphTooLarge } from '../graph/GraphTooLarge';
import { type ChartView, MilestoneMapView } from '../graph/MilestoneMap';
import { FanoutControls } from '../milestones/FanoutControls';
import { usePeople } from '../people/PeopleContext';
import { DispatchDialog } from '../tasks/DispatchDialog';
import { criticalPath, etaMs, runPace } from './criticalPath';
import { type BranchLaneGroup, FlightBranchLane } from './FlightBranchLane';
import {
  buildFlightPlan,
  type FlightNode,
  tasksWithRunBranch,
  viewerHolderOf,
} from './flightPlan';
import { type FlightHeaderStats, FlightPlanHeader } from './FlightPlanHeader';
import styles from './FlightPlanView.module.css';
import {
  childrenByParent,
  DIRECT_BAND,
  type FlightScope,
  flightScope,
  sameScope,
} from './flightScope';
import { flightStructureKey, flightWaves } from './flightStructure';

export interface FlightPlanProps {
  containerId: string;
  data: DispatchProjectData;
  /** An open task's one bucket (App's `itemBucket`): the chart's state words read it. */
  bucketOf: (task: TaskListItem) => TaskBucket | null;
  /** Open asks per task, for a milestone's attention count. */
  asksByTask: ReadonlyMap<string, number>;
  /** Keys the chart's remembered view and display choices (the project's path). */
  projectKey: string;
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
  openIn?: 'peek' | 'page';
  /** The branch lane beneath the plan; on by default. */
  showBranches?: boolean;
  /** Take keyboard focus once the plan is on screen: the chart's canvas holds it. */
  focusOnMount?: boolean;
  /** A one-shot ask to open Send agents on this container, as Plans' "Create &
   * send agents…" leaves it; `nonce` tells two asks apart. */
  sendAgentsRequest?: { nonce: number } | null;
  /** Called once the ask above opened the dialog, so it is not replayed. */
  onSendAgentsServed?: (nonce: number) => void;
  className?: string;
}

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** A plan's chart groups every task under its milestone, subtasks included: a parent
 * issue's plan is its subtasks. */
const PLAN_DISPLAY = { ...ISSUES_DISPLAY, showSubtasks: true };
/** A plan with milestone bands offers the Milestones view too. */
const BANDED_VIEWS: readonly ChartView[] = ['tasks', 'milestones'];
const TASK_VIEW: readonly ChartView[] = ['tasks'];
/** A plan draws all of its tasks, linked or not: they are the plan. The header already
 * counts them, so the inspector opens only on a selection. */
const PLAN_PREFS = { showUnlinked: true, inspector: false };

/** A fan-out's agent slots as the slots picker's name and hint say them: "1 slot",
 * "3 slots". */
function slotsText(slots: number): string {
  return `${slots} ${slots === 1 ? 'slot' : 'slots'}`;
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
  milestoneId: string;
  mode: 'start' | 'raise';
}

/**
 * A container's Flight Plan: the header (slots, counts, the critical path, the ETA and the
 * fan-out controls) over the dependency chart of the container's work (components/graph's
 * MilestoneMapView, the Graph page's chart scoped to this plan), with the branch lane
 * beneath showing the same work as git sees it. A click on a card traces what it waits on
 * and what it unblocks; the inspector opens the task and sends an agent at a card that may
 * start now (optimistically). A project's plan offers the Milestones view too, and a
 * selected milestone's inspector carries that milestone's own fan-out controls.
 * Everything derives from the cached task list, runs and fan-out progress — no polling of
 * its own.
 */
export function FlightPlan({
  containerId,
  data,
  bucketOf,
  asksByTask,
  projectKey,
  dispatchTask,
  onDispatchFailed,
  onOpenTask,
  onPeekTask,
  openIn = 'peek',
  showBranches = true,
  focusOnMount = false,
  sendAgentsRequest = null,
  onSendAgentsServed,
  className,
}: FlightPlanProps) {
  const directory = usePeople();
  const [dialog, setDialog] = useState<FanoutDialogState | null>(null);
  const unlimitedSpend = data.config?.orchestrator.unlimitedSpend === true;
  const milestoneConcurrency =
    data.config?.orchestrator.milestoneConcurrency ?? 3;
  // Send agents… opens the fan-out dialog, unless the project has turned on unlimited
  // spend: then there is no ceiling to choose, so the session starts at the default
  // concurrency straight away and a refusal is toasted. Raise ceiling… is hidden then,
  // and a paused session's Resume ignores its old ceilings daemon-side.
  const sendAgents = useCallback(
    (milestoneId: string) => {
      if (!unlimitedSpend) {
        setDialog({ milestoneId, mode: 'start' });
        return;
      }
      data
        .handleWorkMilestone(
          milestoneId,
          unlimitedFanoutOptions(milestoneConcurrency)
        )
        .catch((err: unknown) =>
          onDispatchFailed(
            milestoneId,
            err instanceof Error
              ? err.message
              : 'The daemon refused the fan-out.'
          )
        );
    },
    [data, unlimitedSpend, milestoneConcurrency, onDispatchFailed]
  );
  const sendAgentsNonce = sendAgentsRequest?.nonce ?? null;
  // An effect event, so a config refetch never re-serves the same request.
  const serveSendAgents = useEffectEvent((nonce: number) => {
    sendAgents(containerId);
    onSendAgentsServed?.(nonce);
  });
  useEffect(() => {
    if (sendAgentsNonce !== null) serveSendAgents(sendAgentsNonce);
  }, [sendAgentsNonce]);

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
  const waves = useMemo(() => flightWaves(structure), [structure]);

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
    for (const progress of data.milestoneProgressById.values()) {
      const session = progress.session;
      if (session?.state === 'active' || session?.state === 'paused') {
        out.push(
          `${progress.milestoneId}=${session.startedBy ?? ''}=${session.scope ?? 'plan'}`
        );
      }
    }
    return out.sort().join(' ');
  }, [data.milestoneProgressById]);
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
    const out = new Map<string, MilestoneProgress>();
    for (const task of nodes) {
      const owner = owners.get(task.meta.id) ?? null;
      if (owner === null || out.has(owner)) continue;
      const progress = data.milestoneProgressById.get(owner);
      if (progress !== undefined) out.set(owner, progress);
    }
    return out;
  }, [nodes, owners, data.milestoneProgressById]);
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

  const withRunBranch = useMemo(
    () => tasksWithRunBranch(data.runs),
    [data.runs]
  );
  const withFinishedRun = useMemo(
    () => tasksWithFinishedRun(data.runs),
    [data.runs]
  );
  const plan = useMemo(
    () =>
      buildFlightPlan(nodes, {
        liveTaskIds: flying,
        model,
        concurrency,
        containerIds,
        waves,
        me: directory.me,
        local: data.localHuman,
        ownerOf,
        startedByOf,
        withRunBranch,
        withFinishedRun,
        lookup,
      }),
    [
      nodes,
      flying,
      model,
      concurrency,
      containerIds,
      waves,
      directory.me,
      data.localHuman,
      ownerOf,
      startedByOf,
      withRunBranch,
      withFinishedRun,
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
  const liveClaims = useMemo(() => liveClaimsFrom(data.runs), [data.runs]);

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
    const integrationOf = (milestone: TaskListItem) =>
      usesIntegrationBranch(milestone.meta.kind)
        ? `milestone/${milestone.meta.id}`
        : null;
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

  // A ceiling change on a live session: pause, then resume at the new concurrency (the
  // daemon only takes new options on resume). Running agents are untouched either way.
  const setCeiling = useCallback(
    async (milestoneId: string, next: number) => {
      try {
        await data.handlePauseMilestone(milestoneId);
        await data.handleResumeMilestone(milestoneId, { concurrency: next });
      } catch (err) {
        onDispatchFailed(
          milestoneId,
          err instanceof Error ? err.message : 'The daemon refused the change.'
        );
      }
    },
    [data, onDispatchFailed]
  );

  // One container's fan-out verbs — the header's for the plan's own container, a band's
  // for its milestone — over the same session API the Milestones page uses. The header
  // (`band` false) shows the spend and the waves as strip cells instead, so its controls
  // are only the verbs (Pause and Stop while running; the paused pill, Resume, Raise
  // ceiling… and Stop while paused), icon-only so the strip keeps the room (owner
  // decisions 2026-11-04); a band keeps its spend pill, its wave strip, its worded verbs
  // and its Open button.
  const fanoutFor = useCallback(
    (milestone: TaskListItem, band: boolean): ReactNode => (
      <FanoutControls
        milestone={milestone}
        model={model}
        progress={data.milestoneProgressById.get(milestone.meta.id)}
        phases={false}
        spend={band}
        waves={band}
        onSendAgents={sendAgents}
        onPause={data.handlePauseMilestone}
        onResume={data.handleResumeMilestone}
        onRaiseCeiling={
          unlimitedSpend
            ? undefined
            : (id) => setDialog({ milestoneId: id, mode: 'raise' })
        }
        onStop={data.handleStopMilestone}
        onLand={data.handleLandMilestone}
        onOpenMilestone={(id) => onOpenTask(id)}
        showOpen={band}
        iconVerbs={!band}
      />
    ),
    [data, model, onOpenTask, sendAgents, unlimitedSpend]
  );

  // The plan's own live session's slots control, drawn in the header's slots cell beside
  // the slots text that already prints the total: an icon button whose name says the
  // current slots, opening the choices as radio rows, with a library Tooltip saying what
  // it does (the cell's own hint stays away while the pointer is on it or its menu is
  // open, so the two never stack). Picking another one pauses and resumes the session at
  // it. Null while the container has no active session; FanoutControls' own concurrency
  // picker only renders while no session runs.
  const slotsPickerFor = (milestone: TaskListItem): ReactNode => {
    const milestoneId = milestone.meta.id;
    const session =
      data.milestoneProgressById.get(milestoneId)?.session ?? null;
    if (session?.state !== 'active') return null;
    const items: MenuEntry[] = concurrencyChoices(
      data.config?.orchestrator.milestoneConcurrency ?? 3,
      data.config?.orchestrator.maxConcurrency
    ).map((choice) => ({
      kind: 'radio',
      id: String(choice),
      label: concurrencyLabel(choice),
      checked: choice === session.concurrency,
      onSelect: () => {
        if (choice !== session.concurrency)
          void setCeiling(milestoneId, choice);
      },
    }));
    const name = `Agent slots for ${milestoneId}: ${slotsText(session.concurrency)}`;
    return (
      <Menu
        label={`Agent slots for ${milestoneId}`}
        items={items}
        align="end"
        trigger={(props) => (
          <Tooltip
            content={`Change the agent slots (${slotsText(session.concurrency)} now)`}
          >
            <Button
              {...props}
              variant="quiet"
              size="sm"
              data-slot="flight-slots-picker"
              aria-label={name}
              icon={<ChevronDown {...ICON} size={12} />}
            />
          </Tooltip>
        )}
      />
    );
  };

  // A live fan-out over the whole plan; one from before plan-wide fan-outs covers
  // only the direct band, so the milestone bands keep their own controls.
  const containerLive =
    liveStarters.has(containerId) && !directOnly.has(containerId);
  // A band's fan-out verbs, in its milestone's inspector: the container's own live
  // fan-out already covers every band, so then none.
  const bandContainers = useMemo(
    () =>
      new Map(
        (scope?.bands ?? []).flatMap((band) =>
          band.container === null ? [] : [[band.key, band.container] as const]
        )
      ),
    [scope]
  );
  const milestoneActions = useCallback(
    (milestoneId: string): ReactNode => {
      const band = bandContainers.get(milestoneId);
      return band === undefined || containerLive ? null : fanoutFor(band, true);
    },
    [bandContainers, containerLive, fanoutFor]
  );

  // The chart's groups: the plan's tasks and the outside blockers they wait on, under
  // their milestones as the Issues list groups them.
  const statuses = data.config?.statuses;
  const groups = useMemo(
    () =>
      groupTasks([...nodes, ...outside.values()], PLAN_DISPLAY, {
        statuses: statuses ?? [],
        milestones: data.milestones,
        model,
      }),
    [nodes, outside, statuses, data.milestones, model]
  );

  // A card opens where the host says: the quick-look slide-over, or its page.
  const openFromChart = useCallback(
    (id: string, tab?: TaskTab) => {
      if (tab !== undefined) onOpenTask(id, tab);
      else if (openIn === 'page' || onPeekTask === undefined) onOpenTask(id);
      else onPeekTask(id);
    },
    [openIn, onOpenTask, onPeekTask]
  );
  // A card the plan says may start now gets Send agent in its inspector, as `d` was.
  const taskActions = useCallback(
    (id: string): ReactNode =>
      dispatchable(id) ? (
        <Button
          size="sm"
          variant="secondary"
          icon={<Zap {...ICON} />}
          onClick={() => {
            dispatchNode(id);
          }}
        >
          Send agent
        </Button>
      ) : null,
    [dispatchable, dispatchNode]
  );
  // Past the chart's draw cap: each band's own plan, largest first.
  const renderTooLarge = useCallback(
    (count: number) => (
      <GraphTooLarge
        tooLarge={{
          message: `${count} tasks is more than the chart draws at once. Hide landed tasks under Display, or open one milestone's plan.`,
          title: 'Open one milestone',
          rows: laneGroups
            .filter((group) => bandContainers.has(group.key))
            .map((group) => ({
              id: group.key,
              label: group.title ?? group.key,
              count: group.tasks.length,
              href: taskHref(group.key),
            }))
            .sort((a, b) => b.count - a.count),
        }}
      />
    ),
    [laneGroups, bandContainers]
  );

  // Focus the chart's canvas once on screen, for a surface where the plan is the page.
  const chartRef = useRef<HTMLDivElement>(null);
  const hasNodes = nodes.length > 0;
  useEffect(() => {
    if (!focusOnMount || !hasNodes) return;
    chartRef.current
      ?.querySelector<HTMLElement>('[data-testid="chart-stage"]')
      ?.focus({ preventScroll: true });
  }, [focusOnMount, hasNodes]);

  if (!data.tasksReady) {
    // A load: the header's strip and a few rows of cards hold the plan's shape.
    return (
      <div
        data-slot="flight-plan"
        className={cx(styles.root, styles.loading, className)}
      >
        {/* One status for the one load: the strip's block is a decorative shape. */}
        <Skeleton height={72} className={styles.headSkeleton} />
        <SkeletonRows rows={4} label="Loading the flight plan" />
      </div>
    );
  }
  if (container === null || scope === null) {
    return (
      <div data-slot="flight-plan" className={cx(styles.root, className)}>
        <div className={styles.empty}>
          <EmptyState label="This plan is no longer available.">
            Its container was archived or deleted.
          </EmptyState>
        </div>
      </div>
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
  // The plan's own session: its spend while it is active or paused (where the controls
  // drew their pill; paused, it leads the strip), its waves while it is active (where
  // they drew their strip).
  const containerProgress = data.milestoneProgressById.get(containerId);
  const containerState = containerProgress?.session?.state;
  const stats: FlightHeaderStats = {
    slots: { used: plan.running, total: concurrency },
    running: plan.running,
    queued: plan.queued,
    done: plan.done,
    total: plan.total,
    critical: { count: path.ids.length, ms: path.ms },
    eta: eta === null ? null : { at: now + eta, ms: eta },
    pace,
    spend:
      containerProgress !== undefined &&
      (containerState === 'active' || containerState === 'paused')
        ? spendCellWords(containerProgress.spend)
        : null,
    paused: containerState === 'paused',
    waves:
      containerProgress !== undefined && containerState === 'active'
        ? waveSteps(containerProgress.waves)
        : null,
  };

  const dialogMilestone =
    dialog === null
      ? null
      : dialog.milestoneId === containerId
        ? container
        : (scope.bands?.find((b) => b.key === dialog.milestoneId)?.container ??
          null);
  // A teammate's task can never start in the fan-out, so the dialog never says it will.
  const dialogSession =
    dialog?.mode === 'raise'
      ? (data.milestoneProgressById.get(dialog.milestoneId)?.session ?? null)
      : null;

  return (
    <div data-slot="flight-plan" className={cx(styles.root, className)}>
      {/* The container's fan-out covers the whole plan, every band included. */}
      <FlightPlanHeader
        stats={stats}
        controls={fanoutFor(container, false)}
        slotsPicker={slotsPickerFor(container)}
      />
      {nodes.length === 0 ? (
        <div className={styles.empty}>
          <EmptyState
            icon={<Waypoints size={22} strokeWidth={1.8} aria-hidden />}
            label="Nothing to plan yet"
          >
            Tasks under this container show up here, with their blockers drawn
            between them.
          </EmptyState>
        </div>
      ) : (
        <div ref={chartRef} className={styles.stage}>
          <MilestoneMapView
            // A plan starts from its own remembered view and display choices.
            key={containerId}
            groups={groups}
            bucketOf={bucketOf}
            asksByTask={asksByTask}
            projectKey={`${projectKey}|plan:${containerId}`}
            views={scope.bands === null ? TASK_VIEW : BANDED_VIEWS}
            defaultPrefs={PLAN_PREFS}
            taskActions={taskActions}
            milestoneActions={milestoneActions}
            inspectorOnSelect
            renderTooLarge={renderTooLarge}
            onOpenTask={openFromChart}
            className={styles.chart}
          />
          {showBranches && (
            <FlightBranchLane
              groups={laneGroups}
              branches={data.branches}
              latestRunByTaskId={data.latestRunByTaskId}
              liveRunStateByTaskId={data.liveRunStateByTaskId}
              refFor={refFor}
              focusedId={null}
              onOpenNode={openFromChart}
            />
          )}
        </div>
      )}
      {dialog !== null && dialogMilestone !== null && (
        <DispatchDialog
          title={`${dialog.mode === 'raise' ? 'Raise ceiling' : 'Send agents'} · ${dialogMilestone.meta.title}`}
          tasks={fanoutScope(
            dialog.milestoneId,
            (id) => children.get(id) ?? []
          ).filter((t) => !containerIds.has(t.meta.id))}
          readyIds={data.readyIds}
          // A teammate's task never starts in a fan-out: the dialog marks it Teammate.
          holderOf={viewerHolder}
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
              await data.handleResumeMilestone(dialog.milestoneId, opts);
            } else {
              await data.handleWorkMilestone(dialog.milestoneId, opts);
            }
            setDialog(null);
          }}
        />
      )}
    </div>
  );
}
