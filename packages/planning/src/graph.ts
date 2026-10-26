// The dependency graph (§2.10, design §7.3, extended by the owner decision
// of 2026-10-22, "graphs at every level"): four zoom levels (initiative,
// project, milestone, issue), each drawn for the whole workspace or inside
// one initiative, project or milestone, plus one issue's blocking chain.
// Every level draws every item of its container (owner decision
// 2026-10-23, "the graph shows every issue, not only blocking ones"),
// framed in labelled clusters by parent; blocking relations are the
// arrows. Above the issue level a box waits on another when an open issue
// in it is blocked by an open issue in the other, and the edge counts how
// many. Risk flags follow open blockers through the whole (viewer's)
// mirror, not just the drawn nodes, so a chain that leaves the scope still
// counts.

import { nextMilestoneId } from './assess';
import { countLabel } from './labels';
import {
  compareInitiatives,
  compareIssues,
  compareMilestones,
  homeInitiativeIds,
  NO_INITIATIVE_ID,
  orderProjects,
} from './ordering';
import { findIssue, isOpenState, issueStateType } from './snapshot';
import type {
  DependencyGraph,
  EvalContext,
  GraphCluster,
  GraphContainer,
  GraphEdge,
  GraphFallback,
  GraphLevel,
  GraphNode,
  GraphReadiness,
  GraphScope,
  Issue,
  MilestoneAssessment,
  MilestoneStatus,
  Project,
  Snapshot,
} from './types';

/** Most issues a chain graph holds: the nearest to its focus (§2.10). */
export const CHAIN_MAX_NODES = 150;

/** Levels a container offers, coarsest first. */
export const GRAPH_LEVELS_WITHIN: Readonly<
  Record<GraphContainer['kind'], readonly GraphLevel[]>
> = {
  workspace: ['initiative', 'project', 'milestone', 'issue'],
  initiative: ['project', 'milestone', 'issue'],
  project: ['milestone', 'issue'],
  milestone: ['issue'],
  chain: ['issue'],
};

/** The level a container opens at (what each existing URL already meant). */
export const DEFAULT_GRAPH_LEVEL: Readonly<
  Record<GraphContainer['kind'], GraphLevel>
> = {
  workspace: 'milestone',
  initiative: 'project',
  project: 'issue',
  milestone: 'issue',
  chain: 'issue',
};

/**
 * The container a (validated) scope names; checks issueId, milestoneId,
 * projectId, initiativeId in that order. Every branch on a scope goes
 * through this, with an exhaustive switch on `kind`.
 */
export function graphContainer(scope: GraphScope): GraphContainer {
  if ('issueId' in scope) return { kind: 'chain', id: scope.issueId };
  if ('milestoneId' in scope) {
    return { kind: 'milestone', id: scope.milestoneId };
  }
  if ('projectId' in scope) return { kind: 'project', id: scope.projectId };
  if ('initiativeId' in scope) {
    return { kind: 'initiative', id: scope.initiativeId };
  }
  return { kind: 'workspace' };
}

/**
 * The scope for a container at `level`; the container's default level
 * when `level` is missing or not offered there (GRAPH_LEVELS_WITHIN).
 */
export function graphScopeFor(
  container: GraphContainer,
  level?: GraphLevel
): GraphScope {
  const chosen =
    level !== undefined && GRAPH_LEVELS_WITHIN[container.kind].includes(level)
      ? level
      : DEFAULT_GRAPH_LEVEL[container.kind];
  switch (container.kind) {
    case 'workspace':
      return { level: chosen };
    case 'initiative':
      // GRAPH_LEVELS_WITHIN.initiative holds no 'initiative'.
      return {
        level: chosen as 'project' | 'milestone' | 'issue',
        initiativeId: container.id,
      };
    case 'project':
      // GRAPH_LEVELS_WITHIN.project is milestone and issue only.
      return {
        level: chosen as 'milestone' | 'issue',
        projectId: container.id,
      };
    case 'milestone':
      return { level: 'issue', milestoneId: container.id };
    case 'chain':
      return { level: 'issue', issueId: container.id };
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/** A raw scope checked against the viewer's mirror (resolveGraphScope). */
export type GraphScopeResolution =
  | { ok: true; scope: GraphScope; fallback: GraphFallback | null }
  | { ok: false; problem: 'invalid' | 'not_found'; message: string };

const GRAPH_LEVEL_NAMES: readonly string[] = [
  'initiative',
  'project',
  'milestone',
  'issue',
];

// The scope keys that name a container, with the container each names.
const CONTAINER_KEYS: readonly (readonly [
  string,
  Exclude<GraphContainer['kind'], 'workspace'>,
])[] = [
  ['issueId', 'chain'],
  ['milestoneId', 'milestone'],
  ['projectId', 'project'],
  ['initiativeId', 'initiative'],
];

// Why a level is refused inside a container (the workspace offers all).
const LEVEL_NOT_OFFERED: Readonly<
  Record<Exclude<GraphContainer['kind'], 'workspace'>, string>
> = {
  initiative: "An initiative's graph shows its projects, milestones or issues.",
  project: "A project's graph shows its milestones or issues.",
  milestone: "A milestone's graph shows its issues.",
  chain: "An issue's graph is its blocking chain, drawn issue by issue.",
};

function isGraphLevel(value: unknown): value is GraphLevel {
  return typeof value === 'string' && GRAPH_LEVEL_NAMES.includes(value);
}

function refused(
  problem: 'invalid' | 'not_found',
  message: string
): GraphScopeResolution {
  return { ok: false, problem, message };
}

/**
 * Validates a raw scope (from a URL or a caller) against the viewer's
 * snapshot (§2.10): the shape, the level offered by the container, then
 * the container's existence. A scope naming initiatives (the initiative
 * level, or `initiativeId`) in a mirror with none, as a guest's, falls back
 * to the same level for the whole workspace (the initiative level to the
 * project level) with `fallback` set; no id is checked then, so every id
 * gets the same answer and nothing leaks. A chain may name its issue by id
 * or by identifier in any case; the resolved scope carries the id.
 */
export function resolveGraphScope(
  snapshot: Snapshot,
  raw: unknown
): GraphScopeResolution {
  if (raw === null || typeof raw !== 'object') {
    return refused('invalid', 'A graph scope is required.');
  }
  const fields = raw as Record<string, unknown>;
  const level = fields['level'];
  if (!isGraphLevel(level)) {
    return refused(
      'invalid',
      'Graph level must be initiative, project, milestone or issue.'
    );
  }
  let container: GraphContainer = { kind: 'workspace' };
  let named = 0;
  for (const [key, kind] of CONTAINER_KEYS) {
    const value = fields[key];
    if (value === undefined) continue;
    if (typeof value !== 'string') {
      return refused('invalid', 'Graph ids must be strings.');
    }
    named += 1;
    container = { kind, id: value };
  }
  if (named > 1) {
    return refused(
      'invalid',
      'A graph scope names at most one of initiativeId, projectId, milestoneId and issueId.'
    );
  }
  if (
    container.kind !== 'workspace' &&
    !GRAPH_LEVELS_WITHIN[container.kind].includes(level)
  ) {
    return refused('invalid', LEVEL_NOT_OFFERED[container.kind]);
  }
  const requested = graphScopeFor(container, level);
  if (
    (level === 'initiative' || container.kind === 'initiative') &&
    snapshot.initiatives.size === 0
  ) {
    return {
      ok: true,
      scope: { level: level === 'initiative' ? 'project' : level },
      fallback: { reason: 'no_initiatives', requested },
    };
  }
  switch (container.kind) {
    case 'workspace':
      break;
    case 'initiative':
      if (
        container.id !== NO_INITIATIVE_ID &&
        !snapshot.initiatives.has(container.id)
      ) {
        return refused('not_found', 'That initiative is not in the mirror.');
      }
      break;
    case 'project':
      if (!snapshot.projects.has(container.id)) {
        return refused('not_found', 'That project is not in the mirror.');
      }
      break;
    case 'milestone':
      if (!snapshot.milestones.has(container.id)) {
        return refused('not_found', 'That milestone is not in the mirror.');
      }
      break;
    case 'chain': {
      const issue = findIssue(snapshot.issues, container.id);
      if (issue === undefined) {
        return refused(
          'not_found',
          'That issue is not in the planner (it may be in a closed project, or in a team the app cannot see).'
        );
      }
      return {
        ok: true,
        scope: { level: 'issue', issueId: issue.id },
        fallback: null,
      };
    }
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
  return { ok: true, scope: requested, fallback: null };
}

/**
 * Tarjan's strongly connected components over nodes `0..count-1`, written
 * iteratively so long blocker chains cannot overflow the call stack. Each
 * component lists its node indexes; components come out in Tarjan's
 * completion order.
 */
export function stronglyConnectedComponents(
  count: number,
  successors: readonly (readonly number[])[]
): number[][] {
  const index = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const onStack = new Uint8Array(count);
  const stack: number[] = [];
  const components: number[][] = [];
  // Explicit call stack: the node being visited and its next successor slot.
  const callNodes: number[] = [];
  const callNext: number[] = [];
  let counter = 0;

  const visit = (v: number): void => {
    index[v] = counter;
    low[v] = counter;
    counter += 1;
    stack.push(v);
    onStack[v] = 1;
    callNodes.push(v);
    callNext.push(0);
  };

  for (let start = 0; start < count; start++) {
    if (index[start] !== -1) continue;
    visit(start);
    while (callNodes.length > 0) {
      const top = callNodes.length - 1;
      const v = callNodes[top] ?? 0;
      const next = successors[v] ?? [];
      const slot = callNext[top] ?? 0;
      if (slot < next.length) {
        callNext[top] = slot + 1;
        const w = next[slot] ?? 0;
        if (index[w] === -1) visit(w);
        else if (onStack[w] === 1)
          low[v] = Math.min(low[v] ?? 0, index[w] ?? 0);
        continue;
      }
      callNodes.pop();
      callNext.pop();
      const parent = callNodes[callNodes.length - 1];
      if (parent !== undefined) {
        low[parent] = Math.min(low[parent] ?? 0, low[v] ?? 0);
      }
      if (low[v] === index[v]) {
        const component: number[] = [];
        let w: number | undefined;
        do {
          w = stack.pop();
          if (w === undefined) break;
          onStack[w] = 0;
          component.push(w);
        } while (w !== v);
        components.push(component);
      }
    }
  }
  return components;
}

/**
 * Cycles among `count` nodes: components with more than one node, or a
 * single node with an edge to itself. Each cycle is returned in walk order,
 * starting from its lowest index and following edges inside the component
 * (lowest unvisited successor first); members the walk misses are appended
 * in index order. Cycles are sorted by their first node.
 */
export function findCycles(
  count: number,
  successors: readonly (readonly number[])[]
): number[][] {
  const cycles: number[][] = [];
  for (const component of stronglyConnectedComponents(count, successors)) {
    const first = component[0];
    if (first === undefined) continue;
    const selfLoop =
      component.length === 1 && (successors[first] ?? []).includes(first);
    if (component.length < 2 && !selfLoop) continue;
    const members = new Set(component);
    const ordered = [...component].sort((a, b) => a - b);
    const walk: number[] = [];
    const seen = new Set<number>();
    let current: number | undefined = ordered[0];
    while (current !== undefined && !seen.has(current)) {
      walk.push(current);
      seen.add(current);
      let nextNode: number | undefined;
      for (const w of successors[current] ?? []) {
        if (
          members.has(w) &&
          !seen.has(w) &&
          (nextNode === undefined || w < nextNode)
        ) {
          nextNode = w;
        }
      }
      current = nextNode;
    }
    for (const node of ordered) if (!seen.has(node)) walk.push(node);
    cycles.push(walk);
  }
  return cycles.sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
}

/**
 * Every open issue that transitively waits on an issue matching `isBase`,
 * following only `blocks` edges whose blocker is open (a closed blocker no
 * longer holds anything up). A forward walk from the base issues: O(issues
 * + relations). Base issues themselves are included only when they wait on
 * another base issue (or on themselves through a cycle).
 */
export function waitingIssues(
  snapshot: Snapshot,
  isBase: (issue: Issue) => boolean
): Set<string> {
  const waiting = new Set<string>();
  const queue: string[] = [];
  for (const issue of snapshot.issues.values()) {
    if (isOpenState(issueStateType(snapshot, issue)) && isBase(issue)) {
      queue.push(issue.id);
    }
  }
  const expanded = new Set<string>();
  for (let head = 0; head < queue.length; head++) {
    const id = queue[head] ?? '';
    if (expanded.has(id)) continue;
    expanded.add(id);
    for (const blockedId of snapshot.blocking.get(id) ?? []) {
      if (waiting.has(blockedId)) continue;
      const blocked = snapshot.issues.get(blockedId);
      if (blocked === undefined) continue;
      if (!isOpenState(issueStateType(snapshot, blocked))) continue;
      waiting.add(blockedId);
      queue.push(blockedId);
    }
  }
  return waiting;
}

// Marks nodes and edges that sit on a cycle and fills `graph.cycles`. Only
// edges whose blocker is still open take part: a resolved edge cannot
// deadlock anything.
function markCycles(nodes: GraphNode[], edges: GraphEdge[]): string[][] {
  const indexOf = new Map<string, number>();
  nodes.forEach((node, i) => indexOf.set(node.id, i));
  const successors: number[][] = nodes.map(() => []);
  for (const edge of edges) {
    if (edge.resolved) continue;
    const from = indexOf.get(edge.from);
    const to = indexOf.get(edge.to);
    if (from !== undefined && to !== undefined) successors[from]?.push(to);
  }
  const cycles = findCycles(nodes.length, successors);
  const cycleOf = new Map<string, number>();
  cycles.forEach((cycle, c) => {
    for (const i of cycle) {
      const node = nodes[i];
      if (node === undefined) continue;
      node.inCycle = true;
      cycleOf.set(node.id, c);
    }
  });
  for (const edge of edges) {
    const c = cycleOf.get(edge.from);
    edge.inCycle =
      !edge.resolved && c !== undefined && cycleOf.get(edge.to) === c;
  }
  return cycles.map((cycle) =>
    cycle.flatMap((i) => {
      const node = nodes[i];
      return node === undefined ? [] : [node.id];
    })
  );
}

// Orders edges by their endpoints' node order so output is stable.
function sortEdges(nodes: readonly GraphNode[], edges: GraphEdge[]): void {
  const indexOf = new Map<string, number>();
  nodes.forEach((node, i) => indexOf.set(node.id, i));
  edges.sort((a, b) => {
    const byFrom = (indexOf.get(a.from) ?? 0) - (indexOf.get(b.from) ?? 0);
    if (byFrom !== 0) return byFrom;
    return (indexOf.get(a.to) ?? 0) - (indexOf.get(b.to) ?? 0);
  });
}

// Per-issue facts every level uses, computed once per graph build over the
// viewer's snapshot (§2.10): the risk predicates and transitive waits sets,
// the blocking cycles among open issues, each project's first initiative
// and project activity.
interface GraphFacts {
  isOpen: (issue: Issue) => boolean;
  /** Canceled (Linear's Duplicate maps here): never drawn as a node. */
  isCanceled: (issue: Issue) => boolean;
  /**
   * It has a blocks relation, either way (a self-loop counts), with a
   * mirrored issue that is not canceled: it is in the blocking flow. An
   * open issue without one is `independent` ("No dependencies").
   */
  related: (issue: Issue) => boolean;
  isUnassigned: (issue: Issue) => boolean;
  isOverdue: (issue: Issue) => boolean;
  waitsOnUnassigned: ReadonlySet<string>;
  waitsOnOverdue: ReadonlySet<string>;
  /** Unassigned or overdue itself, or waits on such an issue. */
  risky: (issue: Issue) => boolean;
  /** Open issues on a blocking cycle among open issues. */
  cycleIssues: ReadonlySet<string>;
  /**
   * An open issue's distinct open blockers (its own id when it blocks
   * itself). A missing entry means none: the issue is ready (or closed).
   */
  openBlockers: ReadonlyMap<string, ReadonlySet<string>>;
  /**
   * Per open blocker b: how many open issues other than b have b as their
   * only open blocker (what finishing b alone would free).
   */
  soleBlockerOf: ReadonlyMap<string, number>;
  /** A mirrored project's first initiative, NO_INITIATIVE_ID when none. */
  homeOf: (projectId: string) => string;
  activeProject: (project: Project) => boolean;
  /** The issue's project is active; no (mirrored) project counts as active. */
  active: (issue: Issue) => boolean;
}

/**
 * The open issues on a blocking cycle among open issues: one Tarjan pass
 * over the open issues with an edge blocker → blocked for every relation
 * whose two ends are open. Members of components with more than one issue,
 * plus self-loops. O(issues + relations).
 */
function openCycleIssues(
  snapshot: Snapshot,
  isOpen: (issue: Issue) => boolean
): Set<string> {
  const open: Issue[] = [];
  const indexOf = new Map<string, number>();
  for (const issue of snapshot.issues.values()) {
    if (!isOpen(issue)) continue;
    indexOf.set(issue.id, open.length);
    open.push(issue);
  }
  const successors = open.map((issue) => {
    const next: number[] = [];
    for (const blockedId of snapshot.blocking.get(issue.id) ?? []) {
      const index = indexOf.get(blockedId);
      if (index !== undefined) next.push(index);
    }
    return next;
  });
  const members = new Set<string>();
  for (const component of stronglyConnectedComponents(
    open.length,
    successors
  )) {
    const first = component[0];
    if (first === undefined) continue;
    const selfLoop =
      component.length === 1 && (successors[first] ?? []).includes(first);
    if (component.length < 2 && !selfLoop) continue;
    for (const index of component) {
      const id = open[index]?.id;
      if (id !== undefined) members.add(id);
    }
  }
  return members;
}

/**
 * Who still holds each open issue up (§2.10 "Readiness"): one pass over the
 * open issues and their blockers gives every open issue's set of distinct
 * open blockers (a self-loop keeps its own id; closed blockers no longer
 * count) and, per blocker, how many open issues other than itself it alone
 * blocks. O(issues + relations).
 */
function openBlockerFacts(
  snapshot: Snapshot,
  isOpen: (issue: Issue) => boolean
): Pick<GraphFacts, 'openBlockers' | 'soleBlockerOf'> {
  const openBlockers = new Map<string, Set<string>>();
  const soleBlockerOf = new Map<string, number>();
  for (const issue of snapshot.issues.values()) {
    if (!isOpen(issue)) continue;
    let blockers: Set<string> | undefined;
    for (const blockerId of snapshot.blockersOf.get(issue.id) ?? []) {
      const blocker = snapshot.issues.get(blockerId);
      if (blocker === undefined || !isOpen(blocker)) continue;
      blockers ??= new Set();
      blockers.add(blockerId);
    }
    if (blockers === undefined) continue;
    openBlockers.set(issue.id, blockers);
    if (blockers.size !== 1) continue;
    const [only] = blockers;
    if (only !== undefined && only !== issue.id) {
      soleBlockerOf.set(only, (soleBlockerOf.get(only) ?? 0) + 1);
    }
  }
  return { openBlockers, soleBlockerOf };
}

// Computes the facts shared by every level once per graph build.
function graphFacts(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): GraphFacts {
  const isOpen = (issue: Issue): boolean =>
    isOpenState(issueStateType(snapshot, issue));
  const isCanceled = (issue: Issue): boolean =>
    issueStateType(snapshot, issue) === 'canceled';
  const related = (issue: Issue): boolean => {
    for (const ids of [
      snapshot.blockersOf.get(issue.id),
      snapshot.blocking.get(issue.id),
    ]) {
      for (const id of ids ?? []) {
        const other = snapshot.issues.get(id);
        if (other !== undefined && !isCanceled(other)) return true;
      }
    }
    return false;
  };
  const isUnassigned = (issue: Issue): boolean =>
    isOpen(issue) && issue.assigneeId === null;
  const isOverdue = (issue: Issue): boolean =>
    isOpen(issue) &&
    issue.milestoneId !== null &&
    assessments.get(issue.milestoneId)?.status === 'overdue';
  const waitsOnUnassigned = waitingIssues(snapshot, isUnassigned);
  const waitsOnOverdue = waitingIssues(snapshot, isOverdue);
  const home = homeInitiativeIds(snapshot);
  const activeStatuses = new Set(ctx.tuning.activeProjectStatuses);
  const activeProject = (project: Project): boolean =>
    activeStatuses.has(project.statusType);
  return {
    isOpen,
    isCanceled,
    related,
    isUnassigned,
    isOverdue,
    waitsOnUnassigned,
    waitsOnOverdue,
    risky: (issue) =>
      isUnassigned(issue) ||
      isOverdue(issue) ||
      waitsOnUnassigned.has(issue.id) ||
      waitsOnOverdue.has(issue.id),
    cycleIssues: openCycleIssues(snapshot, isOpen),
    ...openBlockerFacts(snapshot, isOpen),
    homeOf: (projectId) => home.get(projectId) ?? NO_INITIATIVE_ID,
    activeProject,
    active: (issue) => {
      const project =
        issue.projectId === null
          ? undefined
          : snapshot.projects.get(issue.projectId);
      return project === undefined || activeProject(project);
    },
  };
}

// The parts of a graph each level builder fills (the dispatcher adds the
// resolved scope, the fallback and the clusters).
type GraphBody = Omit<DependencyGraph, 'scope' | 'fallback' | 'clusters'>;

// The containers an aggregate level or a container issue level is drawn
// inside (a chain has its own builder).
type MemberContainer = Exclude<GraphContainer, { kind: 'chain' }>;

// The first initiative of an issue's mirrored project, or null.
function issueHome(
  snapshot: Snapshot,
  facts: GraphFacts,
  issue: Issue
): string | null {
  return issue.projectId !== null && snapshot.projects.has(issue.projectId)
    ? facts.homeOf(issue.projectId)
    : null;
}

/**
 * `under(i, C)` (§2.10): whether an issue belongs to the container. An
 * issue with no (mirrored) project is in no initiative container.
 */
function issueUnder(
  snapshot: Snapshot,
  facts: GraphFacts,
  container: MemberContainer
): (issue: Issue) => boolean {
  switch (container.kind) {
    case 'workspace':
      return () => true;
    case 'initiative':
      return (issue) => issueHome(snapshot, facts, issue) === container.id;
    case 'project':
      return (issue) => issue.projectId === container.id;
    case 'milestone':
      return (issue) => issue.milestoneId === container.id;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

// An issue as an issue-level node: today's fields plus its first
// initiative, its project's activity, whether it sits on a cycle and its
// readiness (open blockers anywhere in the viewer's mirror; independent
// when it has no relation to an issue that is not canceled). The cluster
// is filled in by graphClusters.
function issueNode(
  snapshot: Snapshot,
  facts: GraphFacts,
  issue: Issue,
  external: boolean
): GraphNode {
  const assignee =
    issue.assigneeId === null
      ? undefined
      : snapshot.users.get(issue.assigneeId);
  const who =
    issue.assigneeId === null
      ? 'Unassigned'
      : (assignee?.name ?? 'Unknown user');
  const open = facts.isOpen(issue);
  // Only open issues have an entry, so a closed one reads 0 here.
  const blockedBy = facts.openBlockers.get(issue.id)?.size ?? 0;
  return {
    id: issue.id,
    kind: 'issue',
    label: issue.title,
    sublabel: `${issue.identifier} · ${who}`,
    url: issue.url,
    initiativeId: issueHome(snapshot, facts, issue),
    projectId: issue.projectId,
    milestoneId: issue.milestoneId,
    ownerId: issue.assigneeId,
    external,
    clusterId: null,
    active: facts.active(issue),
    open,
    unassigned: facts.isUnassigned(issue),
    overdue: facts.isOverdue(issue),
    inCycle: false,
    holdsCycle: facts.cycleIssues.has(issue.id),
    waitsOnUnassigned: facts.waitsOnUnassigned.has(issue.id),
    waitsOnOverdue: facts.waitsOnOverdue.has(issue.id),
    status: issueStateType(snapshot, issue),
    readiness: !open
      ? 'done'
      : blockedBy > 0
        ? 'blocked'
        : facts.related(issue)
          ? 'ready'
          : 'independent',
    blockedBy,
    unplacedBlockers: 0,
    // Only open blockers are counted, so a closed issue frees nothing.
    unblocks: facts.soleBlockerOf.get(issue.id) ?? 0,
    openIssues: open ? 1 : 0,
    readyIssues: open && blockedBy === 0 ? 1 : 0,
  };
}

// One blocks relation as an issue-level edge (weight 1).
function issueEdge(
  snapshot: Snapshot,
  facts: GraphFacts,
  blocker: Issue,
  blocked: Issue
): GraphEdge {
  const fromHome = issueHome(snapshot, facts, blocker);
  const toHome = issueHome(snapshot, facts, blocked);
  return {
    from: blocker.id,
    to: blocked.id,
    resolved: !facts.isOpen(blocker),
    blocking: facts.isOpen(blocker) && facts.isOpen(blocked),
    crossProject: blocker.projectId !== blocked.projectId,
    crossInitiative:
      fromHome !== null && toHome !== null && fromHome !== toHome,
    crossOwner:
      blocker.assigneeId !== null &&
      blocked.assigneeId !== null &&
      blocker.assigneeId !== blocked.assigneeId,
    inCycle: false,
    onRiskChain: facts.risky(blocker),
    weight: 1,
  };
}

// Sorts in-container nodes, then externals, each with `compare`, keeping
// the two groups apart (§2.10 "under C, then externals").
function containerOrder<T>(
  items: readonly T[],
  isExternal: (item: T) => boolean,
  compare: (a: T, b: T) => number
): T[] {
  const inside = items.filter((item) => !isExternal(item)).sort(compare);
  const outside = items.filter((item) => isExternal(item)).sort(compare);
  return [...inside, ...outside];
}

/**
 * Issue level inside a container (§2.10; owner decision 2026-10-23, "the
 * graph shows every issue, not only blocking ones"): every issue under
 * the container that is not canceled (open and done alike; a canceled or
 * duplicate issue is never drawn), every relation touching one whose two
 * ends are not canceled, and the outside end of such a relation as an
 * external, one hop away (never in the workspace, which holds every
 * issue). Nodes in the container come first, then externals, each in
 * issue order. O(issues + relations) plus sorting.
 */
function containerIssueGraph(
  snapshot: Snapshot,
  facts: GraphFacts,
  container: MemberContainer
): GraphBody {
  const under = issueUnder(snapshot, facts, container);
  const drawn = new Map<string, Issue>();
  for (const issue of snapshot.issues.values()) {
    if (!facts.isCanceled(issue) && under(issue)) drawn.set(issue.id, issue);
  }
  const relationPairs: { blocker: Issue; blocked: Issue }[] = [];
  const externals = new Map<string, Issue>();
  for (const [blockedId, blockerIds] of snapshot.blockersOf) {
    const blocked = snapshot.issues.get(blockedId);
    if (blocked === undefined || facts.isCanceled(blocked)) continue;
    for (const blockerId of blockerIds) {
      const blocker = snapshot.issues.get(blockerId);
      if (blocker === undefined || facts.isCanceled(blocker)) continue;
      if (!drawn.has(blocker.id) && !drawn.has(blocked.id)) continue;
      relationPairs.push({ blocker, blocked });
      for (const end of [blocker, blocked]) {
        if (!drawn.has(end.id)) externals.set(end.id, end);
      }
    }
  }

  const nodes = containerOrder(
    [...drawn.values(), ...externals.values()],
    (issue) => !drawn.has(issue.id),
    compareIssues
  ).map((issue) => issueNode(snapshot, facts, issue, !drawn.has(issue.id)));
  const edges = relationPairs.map(({ blocker, blocked }) =>
    issueEdge(snapshot, facts, blocker, blocked)
  );
  sortEdges(nodes, edges);
  const cycles = markCycles(nodes, edges);
  return { nodes, edges, cycles, unplacedRelations: 0, chain: null };
}

type AggregateLevel = Exclude<GraphLevel, 'issue'>;

// What a node above the issue level folds over its open member issues.
interface UnitFacts {
  open: number;
  unassigned: boolean;
  overdue: boolean;
  waitsOnUnassigned: boolean;
  waitsOnOverdue: boolean;
  holdsCycle: boolean;
}

const NO_UNIT_FACTS: UnitFacts = {
  open: 0,
  unassigned: false,
  overdue: false,
  waitsOnUnassigned: false,
  waitsOnOverdue: false,
  holdsCycle: false,
};

// The readiness fields of a graph node (§2.10 "Readiness").
type NodeReadiness = Pick<
  GraphNode,
  | 'readiness'
  | 'blockedBy'
  | 'unplacedBlockers'
  | 'unblocks'
  | 'openIssues'
  | 'readyIssues'
>;

// Who holds a unit's open issues up, folded over all of them (kept apart
// from UnitFacts so the sets are never shared through NO_UNIT_FACTS).
interface UnitFlow {
  /** Its open issues with no open blocker anywhere in the mirror. */
  ready: number;
  /** The other units holding an open blocker of one of its open issues. */
  blockers: Set<string>;
  /** Open blockers of its open issues that count toward no unit. */
  unplaced: Set<string>;
}

/**
 * The readiness of every unit from its folded flow (§2.10 "Readiness"):
 * one O(units) pass counts, per unit u, the units whose only blocker
 * (units and unplaced blockers alike) is u, so `unblocks` is exact. A unit
 * no issue counts toward (`counted` says which have one) is empty; one
 * with issues but no open one is done; one with a blocker unit or an unplaced
 * blocker waits; one that also holds up no other unit's (or unplaced) open
 * issue, with something in it that can start, is independent ("No
 * dependencies"); otherwise it is clear, even with blocked issues inside.
 * `blocking` holds the units with an open issue that is an open blocker
 * of another unit's or an unplaced open issue.
 */
function unitReadiness(
  flows: ReadonlyMap<string, UnitFlow>,
  blocking: ReadonlySet<string>,
  counted: ReadonlySet<string>
): (unit: string, open: number) => NodeReadiness {
  const unblocks = new Map<string, number>();
  for (const flow of flows.values()) {
    if (flow.blockers.size !== 1 || flow.unplaced.size > 0) continue;
    const [only] = flow.blockers;
    if (only !== undefined) unblocks.set(only, (unblocks.get(only) ?? 0) + 1);
  }
  return (unit, open) => {
    const flow = flows.get(unit);
    const blockedBy =
      flow === undefined ? 0 : flow.blockers.size + flow.unplaced.size;
    const readyIssues = flow?.ready ?? 0;
    // A clear unit with nothing ready is stuck behind a cycle inside: it
    // keeps "None ready", never "No dependencies".
    const independent = !blocking.has(unit) && readyIssues > 0;
    let readiness: GraphReadiness;
    if (open === 0) readiness = counted.has(unit) ? 'done' : 'empty';
    else if (blockedBy > 0) readiness = 'blocked';
    else readiness = independent ? 'independent' : 'ready';
    return {
      readiness,
      blockedBy,
      unplacedBlockers: flow?.unplaced.size ?? 0,
      unblocks: unblocks.get(unit) ?? 0,
      openIssues: open,
      readyIssues,
    };
  };
}

// Status severity for an initiative's roll-up, most severe first.
const STATUS_SEVERITY: readonly MilestoneStatus[] = [
  'overdue',
  'at_risk',
  'unscheduled',
  'empty',
  'on_track',
  'complete',
];

/**
 * `unit_L(i)` (§2.10): the node an issue counts toward at an aggregate
 * level, or null when it has none there (no mirrored milestone at the
 * milestone level; no mirrored project at the project and initiative
 * levels).
 */
function unitMapper(
  snapshot: Snapshot,
  facts: GraphFacts,
  level: AggregateLevel
): (issue: Issue) => string | null {
  switch (level) {
    case 'milestone':
      return (issue) =>
        issue.milestoneId !== null && snapshot.milestones.has(issue.milestoneId)
          ? issue.milestoneId
          : null;
    case 'project':
      return (issue) =>
        issue.projectId !== null && snapshot.projects.has(issue.projectId)
          ? issue.projectId
          : null;
    case 'initiative':
      return (issue) => issueHome(snapshot, facts, issue);
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/**
 * Every unit of an aggregate level the mirror holds, in mirror order: its
 * milestones, its projects, or its initiatives plus NO_INITIATIVE_ID when
 * a project has no initiative. The graph draws each one under the
 * container (owner decision 2026-10-23).
 */
function levelUnits(
  snapshot: Snapshot,
  facts: GraphFacts,
  level: AggregateLevel
): string[] {
  switch (level) {
    case 'milestone':
      return [...snapshot.milestones.keys()];
    case 'project':
      return [...snapshot.projects.keys()];
    case 'initiative': {
      const units = [...snapshot.initiatives.keys()];
      if (
        [...snapshot.projects.keys()].some(
          (id) => facts.homeOf(id) === NO_INITIATIVE_ID
        )
      ) {
        units.push(NO_INITIATIVE_ID);
      }
      return units;
    }
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/**
 * Whether a node (a unit) lies inside the container, from the unit itself:
 * its first initiative for an initiative container, its project for a
 * project container. A node outside is an external, one hop away.
 */
function unitUnderMapper(
  snapshot: Snapshot,
  facts: GraphFacts,
  level: AggregateLevel,
  container: MemberContainer
): (unit: string) => boolean {
  const projectOf = (unit: string): string | null => {
    if (level === 'project') return unit;
    if (level === 'milestone') {
      return snapshot.milestones.get(unit)?.projectId ?? null;
    }
    return null;
  };
  switch (container.kind) {
    case 'workspace':
      return () => true;
    case 'initiative':
      return (unit) => {
        if (level === 'initiative') return unit === container.id;
        const projectId = projectOf(unit);
        return projectId !== null && facts.homeOf(projectId) === container.id;
      };
    case 'project':
      return (unit) => projectOf(unit) === container.id;
    case 'milestone':
      return (unit) => level === 'milestone' && unit === container.id;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
}

/**
 * An aggregate level (initiative, project or milestone) inside the
 * workspace, an initiative or a project (§2.10): one fold over the issue
 * relations with a unit mapper per level. A relation b blocks w counts
 * when both ends are open and one end is under the container (paused work
 * included: since every unit is drawn, a relation between two paused
 * projects is an arrow between two drawn boxes, 2026-10-23; the timeline
 * leaves those out itself); it becomes the edge
 * unit(b) → unit(w) (none inside one unit), whose weight counts relations
 * and which is on a risk chain when one counted blocker is risky. Nodes are
 * every unit under the container, open, done, empty or inactive alike
 * (owner decision 2026-10-23), plus every edge end; node facts fold over
 * all of a unit's open issues.
 */
function aggregateGraph(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  facts: GraphFacts,
  level: AggregateLevel,
  container: MemberContainer
): GraphBody {
  const under = issueUnder(snapshot, facts, container);
  const unitOf = unitMapper(snapshot, facts, level);
  const unitUnder = unitUnderMapper(snapshot, facts, level, container);

  // Node facts and readiness flow of every unit (over all of its open
  // issues, with no container filter), and the units that hold up another
  // unit's (or an unplaced) open issue.
  const unitFacts = new Map<string, UnitFacts>();
  const flows = new Map<string, UnitFlow>();
  const blocking = new Set<string>();
  // Units some issue (in any state, as milestone progress counts them)
  // counts toward: a unit with none is empty, not done.
  const counted = new Set<string>();
  for (const issue of snapshot.issues.values()) {
    if (!facts.isOpen(issue)) {
      const unit = unitOf(issue);
      if (unit !== null) counted.add(unit);
      continue;
    }
    const unit = unitOf(issue);
    if (unit !== null) counted.add(unit);
    if (unit === null) {
      for (const blockerId of facts.openBlockers.get(issue.id) ?? []) {
        const blocker = snapshot.issues.get(blockerId);
        const from = blocker === undefined ? null : unitOf(blocker);
        if (from !== null) blocking.add(from);
      }
      continue;
    }
    const current = unitFacts.get(unit) ?? { ...NO_UNIT_FACTS };
    current.open += 1;
    current.unassigned ||= facts.isUnassigned(issue);
    current.overdue ||= facts.isOverdue(issue);
    current.waitsOnUnassigned ||= facts.waitsOnUnassigned.has(issue.id);
    current.waitsOnOverdue ||= facts.waitsOnOverdue.has(issue.id);
    current.holdsCycle ||= facts.cycleIssues.has(issue.id);
    unitFacts.set(unit, current);
    let flow = flows.get(unit);
    if (flow === undefined) {
      flow = { ready: 0, blockers: new Set(), unplaced: new Set() };
      flows.set(unit, flow);
    }
    const blockers = facts.openBlockers.get(issue.id);
    if (blockers === undefined) flow.ready += 1;
    for (const blockerId of blockers ?? []) {
      const blocker = snapshot.issues.get(blockerId);
      if (blocker === undefined) continue;
      // A blocker in the same unit is the unit's own business.
      const from = unitOf(blocker);
      if (from === null) {
        flow.unplaced.add(blockerId);
      } else if (from !== unit) {
        flow.blockers.add(from);
        blocking.add(from);
      }
    }
  }

  const summaries = new Map<
    string,
    { from: string; to: string; weight: number; onRiskChain: boolean }
  >();
  let unplacedRelations = 0;
  for (const blocked of snapshot.issues.values()) {
    const blockers = snapshot.blockersOf.get(blocked.id);
    if (blockers === undefined || !facts.isOpen(blocked)) continue;
    const blockedUnder = under(blocked);
    const to = unitOf(blocked);
    for (const blockerId of blockers) {
      const blocker = snapshot.issues.get(blockerId);
      if (blocker === undefined || !facts.isOpen(blocker)) continue;
      if (!blockedUnder && !under(blocker)) continue;
      const from = unitOf(blocker);
      if (from === null || to === null) {
        unplacedRelations += 1;
        continue;
      }
      if (from === to) continue;
      const pair = `${from}\u0000${to}`;
      const summary = summaries.get(pair);
      if (summary === undefined) {
        summaries.set(pair, {
          from,
          to,
          weight: 1,
          onRiskChain: facts.risky(blocker),
        });
      } else {
        summary.weight += 1;
        summary.onRiskChain ||= facts.risky(blocker);
      }
    }
  }

  const unitIds = new Set(
    levelUnits(snapshot, facts, level).filter((unit) => unitUnder(unit))
  );
  for (const { from, to } of summaries.values()) {
    unitIds.add(from);
    unitIds.add(to);
  }
  const describe = describeUnit(snapshot, assessments, facts, level);
  const readinessOf = unitReadiness(flows, blocking, counted);
  const nodes = containerOrder(
    [...unitIds],
    (unit) => !unitUnder(unit),
    unitComparator(snapshot, ctx, assessments, level)
  ).map((unit) => {
    const folded = unitFacts.get(unit) ?? NO_UNIT_FACTS;
    return describe(
      unit,
      folded,
      readinessOf(unit, folded.open),
      !unitUnder(unit)
    );
  });
  const edgeFacts = describeAggregateEdge(snapshot, facts, level);
  const edges: GraphEdge[] = [...summaries.values()].map((summary) => ({
    from: summary.from,
    to: summary.to,
    resolved: false,
    // Only open→open relations are summarised.
    blocking: true,
    ...edgeFacts(summary.from, summary.to),
    inCycle: false,
    onRiskChain: summary.onRiskChain,
    weight: summary.weight,
  }));
  sortEdges(nodes, edges);
  const cycles = markCycles(nodes, edges);
  return { nodes, edges, cycles, unplacedRelations, chain: null };
}

// Display order of one aggregate level's units: milestones in milestone
// order, projects in timeline order, initiatives in initiative order with
// "No initiative" last.
function unitComparator(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  level: AggregateLevel
): (a: string, b: string) => number {
  switch (level) {
    case 'milestone': {
      const compare = compareMilestones(snapshot, ctx, assessments);
      return (a, b) => {
        const ma = snapshot.milestones.get(a);
        const mb = snapshot.milestones.get(b);
        if (ma === undefined || mb === undefined) return 0;
        return compare(ma, mb);
      };
    }
    case 'project': {
      const rank = new Map<string, number>();
      orderProjects(snapshot).forEach((project, i) => rank.set(project.id, i));
      return (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0);
    }
    case 'initiative':
      return (a, b) => {
        const ia = snapshot.initiatives.get(a);
        const ib = snapshot.initiatives.get(b);
        if (ia === undefined || ib === undefined) {
          // "No initiative" (the only unit with no Initiative) goes last.
          return (ia === undefined ? 1 : 0) - (ib === undefined ? 1 : 0);
        }
        return compareInitiatives(ia, ib);
      };
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

// The status of a project as a graph node: its next milestone's
// assessment status, `empty` when it has none.
function projectStatus(
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  projectId: string
): MilestoneStatus {
  const nextId = nextMilestoneId(snapshot, projectId, assessments);
  return nextId === null
    ? 'empty'
    : (assessments.get(nextId)?.status ?? 'empty');
}

/**
 * The node describer of one aggregate level (§2.10 node table): labels,
 * owner, activity and status from the mirror; open, unassigned, overdue,
 * waits and holdsCycle from the unit's folded open issues; the readiness
 * fields as unitReadiness gives them. The milestone describer keeps its
 * assessment-based fields.
 */
function describeUnit(
  snapshot: Snapshot,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  facts: GraphFacts,
  level: AggregateLevel
): (
  unit: string,
  folded: UnitFacts,
  readiness: NodeReadiness,
  external: boolean
) => GraphNode {
  // Projects per first initiative, for the initiative level's counts.
  const projectsByHome = new Map<string, Project[]>();
  if (level === 'initiative') {
    for (const project of snapshot.data.projects) {
      const home = facts.homeOf(project.id);
      const list = projectsByHome.get(home);
      if (list === undefined) projectsByHome.set(home, [project]);
      else list.push(project);
    }
  }
  const common = (
    folded: UnitFacts,
    readiness: NodeReadiness,
    external: boolean
  ) => ({
    external,
    clusterId: null,
    open: folded.open > 0,
    unassigned: folded.unassigned,
    overdue: folded.overdue,
    inCycle: false,
    holdsCycle: folded.holdsCycle,
    waitsOnUnassigned: folded.waitsOnUnassigned,
    waitsOnOverdue: folded.waitsOnOverdue,
    ...readiness,
  });
  switch (level) {
    case 'milestone':
      return (unit, folded, readiness, external) => {
        const milestone = snapshot.milestones.get(unit);
        const projectId = milestone?.projectId ?? null;
        const project =
          projectId === null ? undefined : snapshot.projects.get(projectId);
        const assessment = assessments.get(unit);
        return {
          id: unit,
          kind: 'milestone',
          label: milestone?.name ?? unit,
          sublabel: project?.name ?? '',
          url: null,
          initiativeId: projectId === null ? null : facts.homeOf(projectId),
          projectId,
          milestoneId: unit,
          ownerId: project?.leadId ?? null,
          active: project !== undefined && facts.activeProject(project),
          ...common(folded, readiness, external),
          open: (assessment?.progress.open ?? 0) > 0,
          unassigned: (assessment?.progress.openUnassigned ?? 0) > 0,
          overdue: assessment?.status === 'overdue',
          status: assessment?.status ?? 'empty',
        };
      };
    case 'project':
      return (unit, folded, readiness, external) => {
        const project = snapshot.projects.get(unit);
        const leadId = project?.leadId ?? null;
        return {
          id: unit,
          kind: 'project',
          label: project?.name ?? unit,
          sublabel:
            leadId === null
              ? 'No lead'
              : (snapshot.users.get(leadId)?.name ?? 'Unknown user'),
          url: project?.url ?? null,
          initiativeId: facts.homeOf(unit),
          projectId: unit,
          milestoneId: null,
          ownerId: leadId,
          active: project !== undefined && facts.activeProject(project),
          ...common(folded, readiness, external),
          status: projectStatus(snapshot, assessments, unit),
        };
      };
    case 'initiative':
      return (unit, folded, readiness, external) => {
        const projects = projectsByHome.get(unit) ?? [];
        const active = projects.filter((p) => facts.activeProject(p));
        const statuses = new Set(
          (active.length > 0 ? active : projects).map((p) =>
            projectStatus(snapshot, assessments, p.id)
          )
        );
        return {
          id: unit,
          kind: 'initiative',
          label: snapshot.initiatives.get(unit)?.name ?? 'No initiative',
          sublabel: countLabel(projects.length, 'project'),
          url: null,
          initiativeId: unit,
          projectId: null,
          milestoneId: null,
          ownerId: null,
          active: active.length > 0,
          ...common(folded, readiness, external),
          status:
            STATUS_SEVERITY.find((status) => statuses.has(status)) ?? 'empty',
        };
      };
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/**
 * The boundary facts of an aggregate edge between two units (§2.10 edge
 * table): projects, first initiatives and leads compared per level.
 */
function describeAggregateEdge(
  snapshot: Snapshot,
  facts: GraphFacts,
  level: AggregateLevel
): (
  from: string,
  to: string
) => Pick<GraphEdge, 'crossProject' | 'crossInitiative' | 'crossOwner'> {
  const leadOf = (projectId: string | null): string | null =>
    projectId === null
      ? null
      : (snapshot.projects.get(projectId)?.leadId ?? null);
  const crossLeads = (a: string | null, b: string | null): boolean => {
    const leadA = leadOf(a);
    const leadB = leadOf(b);
    return leadA !== null && leadB !== null && leadA !== leadB;
  };
  switch (level) {
    case 'milestone':
      return (from, to) => {
        const fromProject = snapshot.milestones.get(from)?.projectId ?? null;
        const toProject = snapshot.milestones.get(to)?.projectId ?? null;
        return {
          crossProject: fromProject !== toProject,
          crossInitiative:
            fromProject !== null &&
            toProject !== null &&
            facts.homeOf(fromProject) !== facts.homeOf(toProject),
          crossOwner: crossLeads(fromProject, toProject),
        };
      };
    case 'project':
      return (from, to) => ({
        crossProject: true,
        crossInitiative: facts.homeOf(from) !== facts.homeOf(to),
        crossOwner: crossLeads(from, to),
      });
    case 'initiative':
      return () => ({
        crossProject: true,
        crossInitiative: true,
        crossOwner: false,
      });
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }
}

/**
 * Breadth-first hops from the focus over `next` (blockersOf for upstream,
 * blocking for downstream), §2.10 "one issue's chain": the focus's direct
 * neighbours are always reached, in any state; past the focus the walk goes
 * through open issues only (a closed issue holds nothing up and waits on
 * nothing), and a closed focus is one hop. The focus maps to 0.
 */
function chainHops(
  snapshot: Snapshot,
  facts: GraphFacts,
  focus: Issue,
  next: ReadonlyMap<string, readonly string[]>
): Map<string, number> {
  const hops = new Map<string, number>([[focus.id, 0]]);
  const focusOpen = facts.isOpen(focus);
  const queue: Issue[] = [focus];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head];
    if (current === undefined) continue;
    const isFocus = current.id === focus.id;
    if (!isFocus && !(focusOpen && facts.isOpen(current))) continue;
    const depth = (hops.get(current.id) ?? 0) + 1;
    for (const id of next.get(current.id) ?? []) {
      if (hops.has(id)) continue;
      const neighbour = snapshot.issues.get(id);
      if (neighbour === undefined) continue;
      if (!isFocus && !facts.isOpen(neighbour)) continue;
      hops.set(id, depth);
      queue.push(neighbour);
    }
  }
  return hops;
}

/**
 * One issue's blocking chain (§2.10): everything it waits on and everything
 * waiting on it, transitively through open issues, as the induced issue
 * graph. Past CHAIN_MAX_NODES walk issues only the nearest are kept
 * (|distance|, then upstream first, then issue order); kept issues next to
 * a left-out one carry `hiddenNeighbours`. The focus comes first.
 * O(the chain's component) plus sorting.
 */
function chainGraph(
  snapshot: Snapshot,
  facts: GraphFacts,
  focus: Issue
): GraphBody {
  const up = chainHops(snapshot, facts, focus, snapshot.blockersOf);
  const down = chainHops(snapshot, facts, focus, snapshot.blocking);
  const walk = new Map<string, Issue>([[focus.id, focus]]);
  for (const id of [...up.keys(), ...down.keys()]) {
    const issue = snapshot.issues.get(id);
    if (issue !== undefined) walk.set(id, issue);
  }
  const distance = new Map<string, number>();
  for (const id of walk.keys()) {
    const upHops = up.get(id) ?? Number.POSITIVE_INFINITY;
    const downHops = down.get(id) ?? Number.POSITIVE_INFINITY;
    distance.set(
      id,
      id === focus.id ? 0 : upHops <= downHops ? -upHops : downHops
    );
  }
  const byNearness = (a: Issue, b: Issue): number => {
    const da = distance.get(a.id) ?? 0;
    const db = distance.get(b.id) ?? 0;
    const byHops = Math.abs(da) - Math.abs(db);
    if (byHops !== 0) return byHops;
    // Upstream (negative) before downstream at the same distance.
    if (da !== db) return da - db;
    return compareIssues(a, b);
  };
  const kept = [...walk.values()].sort(byNearness).slice(0, CHAIN_MAX_NODES);
  const keptIds = new Set(kept.map((issue) => issue.id));

  const nodes = kept.map((issue) => {
    const node = issueNode(snapshot, facts, issue, false);
    node.distance = distance.get(issue.id) ?? 0;
    let hidden = 0;
    for (const map of [snapshot.blockersOf, snapshot.blocking]) {
      for (const id of map.get(issue.id) ?? []) {
        if (walk.has(id) && !keptIds.has(id)) hidden += 1;
      }
    }
    if (hidden > 0) node.hiddenNeighbours = hidden;
    return node;
  });
  const edges: GraphEdge[] = [];
  for (const blocker of kept) {
    for (const blockedId of snapshot.blocking.get(blocker.id) ?? []) {
      const blocked = keptIds.has(blockedId)
        ? snapshot.issues.get(blockedId)
        : undefined;
      if (blocked !== undefined) {
        edges.push(issueEdge(snapshot, facts, blocker, blocked));
      }
    }
  }
  sortEdges(nodes, edges);
  const cycles = markCycles(nodes, edges);
  return {
    nodes,
    edges,
    cycles,
    unplacedRelations: 0,
    chain: {
      focusId: focus.id,
      upstream: up.size - 1,
      downstream: down.size - 1,
      hidden: walk.size - kept.length,
    },
  };
}

// A cluster as graphClusters builds it, before its members are counted.
interface ClusterSpec {
  id: string;
  kind: GraphCluster['kind'];
  refId: string | null;
  label: string;
  projectId: string | null;
  /** Display rank, compared item by item (an outer rank comes first). */
  rank: readonly number[];
}

/**
 * The labelled frames of a graph (§2.10 "Clusters", owner decision
 * 2026-10-23), so unconnected boxes sit with their parent rather than in
 * one long column: per node, the chain of clusters it is drawn in, outer
 * first. Issue level: its milestone ("No milestone" for an issue of a
 * project in none, "No project" for an issue with no mirrored project),
 * nested in its project when the drawn issues span more than one project
 * (a milestone name alone would be ambiguous there). Milestone level: its
 * project. Project level: its first initiative ("No initiative"), and no
 * cluster in a mirror without initiatives, where all would share one. The
 * initiative level has none. Sets each node's `clusterId` to its innermost
 * cluster and returns only the clusters with a node in them, parents
 * before children; siblings with a node in the container come first, then
 * the ones holding only externals, each in display order (projects in
 * timeline order, milestones by compareMilestones, initiatives by
 * compareInitiatives, every "No …" last). O(nodes) plus sorting.
 */
function graphClusters(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  level: GraphLevel,
  nodes: GraphNode[]
): GraphCluster[] {
  const last = Number.MAX_SAFE_INTEGER;
  const projectRank = new Map<string, number>();
  orderProjects(snapshot).forEach((project, i) =>
    projectRank.set(project.id, i)
  );
  const milestoneRank = new Map<string, number>();
  [...snapshot.milestones.values()]
    .sort(compareMilestones(snapshot, ctx, assessments))
    .forEach((milestone, i) => milestoneRank.set(milestone.id, i));
  const initiativeRank = new Map<string, number>();
  [...snapshot.initiatives.values()]
    .sort(compareInitiatives)
    .forEach((initiative, i) => initiativeRank.set(initiative.id, i));

  const mirroredProject = (id: string | null): string | null =>
    id !== null && snapshot.projects.has(id) ? id : null;
  const projectSpec = (id: string | null): ClusterSpec =>
    id === null
      ? {
          id: 'project:none',
          kind: 'project',
          refId: null,
          label: 'No project',
          projectId: null,
          rank: [last],
        }
      : {
          id: `project:${id}`,
          kind: 'project',
          refId: id,
          label: snapshot.projects.get(id)?.name ?? id,
          projectId: id,
          rank: [projectRank.get(id) ?? last - 1],
        };
  // A milestone of `projectId`, or its "No milestone".
  const milestoneSpec = (
    projectId: string,
    milestoneId: string | null
  ): ClusterSpec => {
    const outer = projectRank.get(projectId) ?? last - 1;
    const milestone =
      milestoneId === null ? undefined : snapshot.milestones.get(milestoneId);
    return milestone === undefined || milestone.projectId !== projectId
      ? {
          id: `milestone:none:${projectId}`,
          kind: 'milestone',
          refId: null,
          label: 'No milestone',
          projectId,
          rank: [outer, last],
        }
      : {
          id: `milestone:${milestone.id}`,
          kind: 'milestone',
          refId: milestone.id,
          label: milestone.name,
          projectId,
          rank: [outer, milestoneRank.get(milestone.id) ?? last - 1],
        };
  };
  const initiativeSpec = (id: string): ClusterSpec => ({
    id: `initiative:${id}`,
    kind: 'initiative',
    refId: id,
    label: snapshot.initiatives.get(id)?.name ?? 'No initiative',
    projectId: null,
    rank: [initiativeRank.get(id) ?? last],
  });

  let pathOf: (node: GraphNode) => ClusterSpec[];
  switch (level) {
    case 'issue': {
      const nest =
        new Set(nodes.map((node) => mirroredProject(node.projectId))).size > 1;
      pathOf = (node) => {
        const projectId = mirroredProject(node.projectId);
        if (projectId === null) return [projectSpec(null)];
        const milestone = milestoneSpec(projectId, node.milestoneId);
        return nest ? [projectSpec(projectId), milestone] : [milestone];
      };
      break;
    }
    case 'milestone':
      pathOf = (node) => [projectSpec(mirroredProject(node.projectId))];
      break;
    case 'project':
      pathOf =
        snapshot.initiatives.size === 0
          ? () => []
          : (node) => [initiativeSpec(node.initiativeId ?? NO_INITIATIVE_ID)];
      break;
    case 'initiative':
      pathOf = () => [];
      break;
    default: {
      const unreachable: never = level;
      return unreachable;
    }
  }

  // Each cluster once, with its parent and whether its nodes are active
  // or external (folded over the whole subtree).
  const found = new Map<
    string,
    {
      spec: ClusterSpec;
      parentId: string | null;
      active: boolean;
      external: boolean;
    }
  >();
  for (const node of nodes) {
    const path = pathOf(node);
    let parentId: string | null = null;
    for (const spec of path) {
      const entry = found.get(spec.id);
      if (entry === undefined) {
        found.set(spec.id, {
          spec,
          parentId,
          active: node.active,
          external: node.external,
        });
      } else {
        entry.active ||= node.active;
        entry.external &&= node.external;
      }
      parentId = spec.id;
    }
    node.clusterId = parentId;
  }

  // Parents before children: a depth-first walk over siblings in order.
  const children = new Map<string | null, string[]>();
  for (const [id, entry] of found) {
    const list = children.get(entry.parentId);
    if (list === undefined) children.set(entry.parentId, [id]);
    else list.push(id);
  }
  const compare = (a: string, b: string): number => {
    const ea = found.get(a);
    const eb = found.get(b);
    if (ea === undefined || eb === undefined) return 0;
    if (ea.external !== eb.external) return ea.external ? 1 : -1;
    const length = Math.max(ea.spec.rank.length, eb.spec.rank.length);
    for (let i = 0; i < length; i++) {
      const byRank = (ea.spec.rank[i] ?? 0) - (eb.spec.rank[i] ?? 0);
      if (byRank !== 0) return byRank;
    }
    return a < b ? -1 : a > b ? 1 : 0;
  };
  const clusters: GraphCluster[] = [];
  const visit = (parentId: string | null): void => {
    for (const id of [...(children.get(parentId) ?? [])].sort(compare)) {
      const entry = found.get(id);
      if (entry === undefined) continue;
      const { spec } = entry;
      clusters.push({
        id,
        kind: spec.kind,
        refId: spec.refId,
        label: spec.label,
        parentId: entry.parentId,
        projectId: spec.projectId,
        active: entry.active,
        external: entry.external,
      });
      visit(id);
    }
  };
  visit(null);
  return clusters;
}

/**
 * Builds the dependency graph for a scope (§2.10). The scope is resolved
 * first (resolveGraphScope): an invalid scope or an unknown id gives an
 * empty graph for the scope as given; a scope naming initiatives in a
 * mirror without any is drawn for the whole workspace, with `fallback`
 * set. Then: the issue level inside any container (every issue that is
 * not canceled, and one hop of externals), an aggregate level (one node
 * per initiative, project or milestone under the container, edges
 * counting the issue relations between them), or one issue's chain; and
 * the clusters the nodes are framed in (graphClusters). Nodes come in
 * display order (in the container first, then externals) and edges in
 * node order, so the output is stable.
 */
export function buildDependencyGraph(
  snapshot: Snapshot,
  ctx: EvalContext,
  assessments: ReadonlyMap<string, MilestoneAssessment>,
  scope: GraphScope
): DependencyGraph {
  const resolution = resolveGraphScope(snapshot, scope);
  if (!resolution.ok) {
    return {
      scope,
      nodes: [],
      edges: [],
      cycles: [],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    };
  }
  const resolved = resolution.scope;
  const facts = graphFacts(snapshot, ctx, assessments);
  const container = graphContainer(resolved);
  const level = resolved.level;
  let body: GraphBody;
  switch (container.kind) {
    case 'chain': {
      const focus = snapshot.issues.get(container.id);
      body =
        focus === undefined
          ? {
              nodes: [],
              edges: [],
              cycles: [],
              unplacedRelations: 0,
              chain: null,
            }
          : chainGraph(snapshot, facts, focus);
      break;
    }
    case 'milestone':
    case 'project':
    case 'initiative':
    case 'workspace':
      body =
        level === 'issue'
          ? containerIssueGraph(snapshot, facts, container)
          : aggregateGraph(snapshot, ctx, assessments, facts, level, container);
      break;
    default: {
      const unreachable: never = container;
      return unreachable;
    }
  }
  const clusters =
    container.kind === 'chain'
      ? []
      : graphClusters(snapshot, ctx, assessments, level, body.nodes);
  return {
    scope: resolved,
    ...body,
    clusters,
    fallback: resolution.fallback,
  };
}
