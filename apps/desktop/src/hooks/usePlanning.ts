import type { EpicProgress, RunMeta } from '@dispatch/client';
import type {
  AllocationPlan,
  DependencyGraph,
  EvalContext,
  GraphScope,
  MilestoneAssessment,
  MilestoneDetail,
  Snapshot,
  TimelineView,
  WorkspaceData,
} from '@dispatch/planning';
import {
  assessWorkspace,
  buildDependencyGraph,
  buildMilestoneDetail,
  buildTimelineView,
  graphContainer,
  indexWorkspace,
  planAllocation,
} from '@dispatch/planning';
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  buildEvalContext,
  buildWorkspaceData,
} from '../adapters/workspaceData';
import { taskHref } from '../lib/shellRoutes';
import { useStatusModelOf } from '../lib/statusModel';
import type { DispatchProjectData } from './useDispatchProject';

// The planning chain over the open project, in the renderer: Dispatch's task
// list synthesized into @dispatch/planning's WorkspaceData (adapters/
// workspaceData), indexed, every milestone assessed, allocation planned, the
// timeline built and the dependency graph of any scope drawn on demand (the
// milestone level of the whole workspace is the timeline's connectors; the
// Graph destination asks for the scope on screen). One useMemo runs the whole chain, keyed
// on the inputs that can change its answer: the task list's identity
// (useDispatchProject keeps it stable while nothing changed), the status
// model, the people and executors, who I am, the Linear links, each task's
// latest run start, the fan-out sessions, and a clock that moves once a
// minute (runs and fan-out progress are first reduced to the facts the
// synthesis reads, so their progress never recomputes the plan). Everything a
// Timeline view or a milestone section reads comes from
// here, so they never recompute an assessment of their own: App runs the hook
// once and hands the result down through PlanningContext to the timeline, the
// graph, the sidebar's project marks and the task drawer's Milestone section.

/** What the planning reads from `useDispatchProject`'s data. */
export type PlanningInput = Pick<
  DispatchProjectData,
  | 'tasks'
  | 'config'
  | 'people'
  | 'executors'
  | 'me'
  | 'linearLinks'
  | 'latestRunByTaskId'
  | 'epicProgressById'
>;

/** The chain's results, one object per computation (stable between). */
export interface Planning {
  workspace: WorkspaceData;
  snapshot: Snapshot;
  ctx: EvalContext;
  assessments: Map<string, MilestoneAssessment>;
  allocation: AllocationPlan;
  timeline: TimelineView;
  /** The milestone level of the whole workspace: the timeline's connectors
   * (`graph({ level: 'milestone' })`, the same object). */
  milestoneGraph: DependencyGraph;
  /**
   * The dependency graph of a scope (a level inside the workspace, an
   * initiative, a project, a milestone or one issue's chain), built on the
   * first ask and kept for this planning: the Graph destination asks for
   * the same scope on every render (the drawer opening, a highlight
   * switch), and only a recompute of the chain (a task changed, the minute
   * moved) starts the graphs over. Two scopes that mean the same graph
   * (`{ level, projectId }` written in either key order) share one entry.
   */
  graph(scope: GraphScope): DependencyGraph;
}

/**
 * The cache key of a scope: its level and its container, so the key does not
 * depend on the order a scope object's keys were written in.
 */
function scopeKey(scope: GraphScope): string {
  const container = graphContainer(scope);
  return container.kind === 'workspace'
    ? `${scope.level}@workspace`
    : `${scope.level}@${container.kind}:${container.id}`;
}

/** How often the clock the planning reads may move. */
const CLOCK_TICK_MS = 60_000;

/** Now, truncated to the minute. */
function currentMinute(): number {
  return Math.floor(Date.now() / CLOCK_TICK_MS) * CLOCK_TICK_MS;
}

/**
 * The clock "today", "days left" and "stalled" are read against: the current
 * minute, advanced by a 60 s ticker. A primitive, so the chain below
 * recomputes at most once a minute (the ticker re-renders only when the
 * minute moved) rather than on every render.
 */
function useMinuteClock(): number {
  const [minute, setMinute] = useState(currentMinute);
  useEffect(() => {
    const id = setInterval(() => setMinute(currentMinute()), CLOCK_TICK_MS);
    return () => clearInterval(id);
  }, []);
  return minute;
}

type RunStarts = ReadonlyMap<string, Pick<RunMeta, 'createdAt'>>;

// Whether every task's latest run started at the same instant in both maps.
function sameRunStarts(
  prev: RunStarts,
  next: ReadonlyMap<string, RunMeta>
): boolean {
  if (prev.size !== next.size) return false;
  for (const [id, run] of next) {
    if (prev.get(id)?.createdAt !== run.createdAt) return false;
  }
  return true;
}

/**
 * Each task's latest run's start, the one fact about runs the synthesis
 * reads (an issue's startedAt). `latestRunByTaskId` is rebuilt on every run
 * event (a turn, a cost update), so it is reduced to the starts and kept the
 * same Map while none changed: a run's progress never recomputes the plan.
 */
function useRunStarts(latest: ReadonlyMap<string, RunMeta>): RunStarts {
  const kept = useRef<RunStarts | null>(null);
  return useMemo(() => {
    const prev = kept.current;
    if (prev !== null && sameRunStarts(prev, latest)) return prev;
    const next = new Map<string, Pick<RunMeta, 'createdAt'>>();
    for (const [id, run] of latest) next.set(id, { createdAt: run.createdAt });
    kept.current = next;
    return next;
  }, [latest]);
}

type SessionStates = ReadonlyMap<string, Pick<EpicProgress, 'session'>>;

// Whether every container's fan-out session is in the same state in both maps.
function sameSessionStates(
  prev: SessionStates,
  next: ReadonlyMap<string, EpicProgress>
): boolean {
  if (prev.size !== next.size) return false;
  for (const [id, progress] of next) {
    const kept = prev.get(id);
    if (kept === undefined || kept.session?.state !== progress.session?.state) {
      return false;
    }
  }
  return true;
}

/**
 * Each container's fan-out session, the one fact about fan-out progress the
 * synthesis reads (a paused session pauses the project). `epicProgressById`
 * is refetched after every task event and rebuilt whenever a count moved,
 * so it is reduced to the sessions and kept the same Map while no session
 * changed state: a task.changed patch recomputes the plan once, for the
 * task list, not again for the progress refetch that follows it.
 */
function useSessionStates(
  progress: ReadonlyMap<string, EpicProgress>
): SessionStates {
  const kept = useRef<SessionStates | null>(null);
  return useMemo(() => {
    const prev = kept.current;
    if (prev !== null && sameSessionStates(prev, progress)) return prev;
    const next = new Map<string, Pick<EpicProgress, 'session'>>();
    for (const [id, each] of progress) next.set(id, { session: each.session });
    kept.current = next;
    return next;
  }, [progress]);
}

/**
 * The planning chain over the open project, memoized on its inputs (see the
 * file comment). For 500 tasks the whole chain takes well under 50 ms
 * (adapters/workspaceData.test.ts times it), so a recompute on a task change
 * is cheaper than a frame.
 */
export function usePlanning(data: PlanningInput): Planning {
  const model = useStatusModelOf(data.config);
  const minute = useMinuteClock();
  const runStarts = useRunStarts(data.latestRunByTaskId);
  const sessions = useSessionStates(data.epicProgressById);
  const executors = useMemo(
    () => data.executors?.executors.map((executor) => executor.name) ?? [],
    [data.executors]
  );
  const { tasks, people, me, linearLinks } = data;
  return useMemo(() => {
    const workspace = buildWorkspaceData({
      tasks,
      model,
      people,
      executors,
      me,
      linearLinks,
      latestRunByTaskId: runStarts,
      epicProgressById: sessions,
      hrefFor: taskHref,
    });
    const ctx = buildEvalContext(new Date(minute));
    const snapshot = indexWorkspace(workspace);
    const assessments = assessWorkspace(snapshot, ctx);
    const allocation = planAllocation(snapshot, ctx, assessments);
    const timeline = buildTimelineView({
      snapshot,
      ctx,
      assessments,
      allocationPlan: allocation,
    });
    // One graph per scope asked for, for the life of this planning.
    const graphs = new Map<string, DependencyGraph>();
    const graph = (scope: GraphScope): DependencyGraph => {
      const key = scopeKey(scope);
      const kept = graphs.get(key);
      if (kept !== undefined) return kept;
      const built = buildDependencyGraph(snapshot, ctx, assessments, scope);
      graphs.set(key, built);
      return built;
    };
    return {
      workspace,
      snapshot,
      ctx,
      assessments,
      allocation,
      timeline,
      milestoneGraph: graph({ level: 'milestone' }),
      graph,
    };
  }, [
    tasks,
    model,
    people,
    executors,
    me,
    linearLinks,
    runStarts,
    sessions,
    minute,
  ]);
}

/**
 * One milestone's detail (its issues with their blockers, what it waits on,
 * its lead) from a computed planning; null for an id the planning does not
 * know as a milestone (an issue, a project, a task gone from the window).
 */
export function milestoneDetailOf(
  planning: Planning,
  milestoneId: string
): MilestoneDetail | null {
  return buildMilestoneDetail({
    snapshot: planning.snapshot,
    ctx: planning.ctx,
    assessments: planning.assessments,
    milestoneId,
  });
}

/** The planning App computed, for every surface under it; null outside App
 * (a test, the gallery), where the surfaces leave their planning pieces out. */
export const PlanningContext = createContext<Planning | null>(null);

export function usePlanningContext(): Planning | null {
  return useContext(PlanningContext);
}

/** Runs the chain over `data` and provides it: what App mounts once, and what
 * a test wraps a planning surface in to feed it a fixture. */
export function PlanningProvider({
  data,
  children,
}: {
  data: PlanningInput;
  children: ReactNode;
}) {
  const planning = usePlanning(data);
  return createElement(PlanningContext.Provider, { value: planning }, children);
}
