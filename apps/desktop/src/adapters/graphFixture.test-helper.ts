// A small workspace for the graph adapters' tests, in @dispatch/planning's
// terms (the shape `buildWorkspaceData` synthesizes from Dispatch's task
// list): two initiatives and a project in none, a paused project, a project
// with no lead, a complete milestone, an empty one, an undated one, an
// overdue one, a cross-project risk chain, an issue cycle, a done blocker, an
// issue with no milestone and one with no project. Every id is a task id, as
// in Dispatch, and every test states only what matters to it.

import type {
  DependencyGraph,
  EvalContext,
  GraphEdge,
  GraphNode,
  GraphScope,
  Initiative,
  Issue,
  Milestone,
  Project,
  User,
  WorkflowState,
  WorkspaceData,
} from '@dispatch/planning';
import {
  addDays,
  assessWorkspace,
  buildDependencyGraph,
  DEFAULT_TUNING,
  indexWorkspace,
  planAllocation,
} from '@dispatch/planning';

import { buildGraphPage, type GraphHrefs, type GraphPageInput } from './graph';
import { graphHref } from './graphScope';

export const TODAY = '2026-10-21';
const NOW = `${TODAY}T12:00:00.000Z`;
const TEAM = 'dispatch';

/** The hrefs the desktop view passes: every box is a task, graph links are
 * the in-memory scope descriptors, the Issues list and the Timeline have no
 * query routes yet. */
export const HREFS: GraphHrefs = {
  task: (id) => `#/task/${id}`,
  graph: graphHref,
  issues: () => '#/issues',
  timeline: () => '#/timeline',
};

/** `TODAY + days` as a calendar date. */
function day(days: number): string {
  return addDays(TODAY, days);
}

function states(): WorkflowState[] {
  return [
    {
      id: 'backlog',
      teamId: TEAM,
      name: 'Backlog',
      type: 'backlog',
      position: 0,
    },
    {
      id: 'ready',
      teamId: TEAM,
      name: 'Ready',
      type: 'unstarted',
      position: 1,
    },
    {
      id: 'working',
      teamId: TEAM,
      name: 'Working',
      type: 'started',
      position: 2,
    },
    { id: 'done', teamId: TEAM, name: 'Done', type: 'completed', position: 3 },
    {
      id: 'dropped',
      teamId: TEAM,
      name: 'Dropped',
      type: 'canceled',
      position: 4,
    },
  ];
}

function user(id: string, name: string): User {
  return {
    id,
    name,
    displayName: name,
    email: null,
    avatarUrl: null,
    active: true,
    app: false,
  };
}

function initiative(
  id: string,
  name: string,
  targetDate: string | null,
  sortOrder: number
): Initiative {
  return { id, name, sortOrder, priority: 0, targetDate };
}

function project(
  id: string,
  name: string,
  overrides: Partial<Project> = {}
): Project {
  return {
    id,
    name,
    url: `#/task/${id}`,
    leadId: 'human:ana',
    priority: 2,
    sortOrder: 0,
    statusType: 'started',
    statusName: 'Working',
    initiativeIds: [],
    teamIds: [TEAM],
    startDate: null,
    targetDate: null,
    ...overrides,
  };
}

/** A milestone that passes the rubric by default (date + done means). */
function milestone(
  id: string,
  projectId: string,
  name: string,
  targetDate: string | null
): Milestone {
  return {
    id,
    projectId,
    name,
    description: 'Done means: it ships',
    targetDate,
    sortOrder: 0,
  };
}

/** An open Ready issue by default, created a month ago and last moved now. */
function issue(
  id: string,
  identifier: string,
  title: string,
  overrides: Partial<Issue> = {}
): Issue {
  return {
    id,
    identifier,
    title,
    url: `#/task/${id}`,
    teamId: TEAM,
    projectId: null,
    milestoneId: null,
    assigneeId: null,
    stateId: 'ready',
    priority: 3,
    createdAt: addDays(TODAY, -30) + 'T10:00:00.000Z',
    updatedAt: NOW,
    startedAt: null,
    completedAt: null,
    canceledAt: null,
    lastStateChangeAt: NOW,
    ...overrides,
  };
}

/** The demo workspace. */
export function demoWorkspace(): WorkspaceData {
  const ana = 'human:ana';
  const dev = 'human:dev';
  const grace = 'human:grace';
  const done = {
    stateId: 'done',
    completedAt: addDays(TODAY, -21) + 'T10:00:00.000Z',
  };
  return {
    workspaceId: 'dispatch',
    users: [
      user(ana, 'Ana Moreno'),
      user(dev, 'Dev Patel'),
      user(grace, 'Grace Lin'),
    ],
    teams: [
      {
        id: TEAM,
        key: 'DSP',
        name: 'Dispatch',
        visibility: 'public',
        parentId: null,
        memberIds: [],
      },
    ],
    states: states(),
    initiatives: [
      // Platform ranks first, so Juniper (in both) counts under it.
      initiative('init-platform', 'Platform reliability', day(60), 0),
      initiative('init-growth', 'Customer growth', null, 1),
    ],
    projects: [
      project('proj-atlas', 'Atlas billing migration', {
        initiativeIds: ['init-platform'],
      }),
      project('proj-juniper', 'Juniper design system', {
        leadId: grace,
        initiativeIds: ['init-platform', 'init-growth'],
      }),
      project('proj-fjord', 'Fjord analytics', {
        initiativeIds: ['init-platform'],
        statusType: 'paused',
        statusName: 'Paused',
      }),
      project('proj-delta', 'Delta exports', {
        leadId: null,
        initiativeIds: ['init-platform'],
      }),
      project('proj-beacon', 'Beacon search', {
        leadId: dev,
        initiativeIds: ['init-growth'],
      }),
      project('proj-garnet', 'Garnet mobile app', { leadId: dev }),
    ],
    milestones: [
      milestone('ms-atlas-1', 'proj-atlas', 'Schema cutover', day(-20)),
      milestone('ms-atlas-2', 'proj-atlas', 'Dual-write', day(-3)),
      milestone('ms-atlas-3', 'proj-atlas', 'Read path switch', day(30)),
      milestone('ms-juniper-1', 'proj-juniper', 'Tokens and type', day(14)),
      milestone('ms-fjord-1', 'proj-fjord', 'Dashboards', day(-5)),
      milestone('ms-delta-1', 'proj-delta', 'CSV exports', null),
      milestone('ms-beacon-1', 'proj-beacon', 'Search v2 beta', day(10)),
      milestone('ms-garnet-1', 'proj-garnet', 'Push notifications', day(40)),
    ],
    issues: [
      // Atlas: Schema cutover is complete (two done, one dropped).
      issue('iss-1', 'ENG-1', 'Schema migration', {
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-1',
        assigneeId: ana,
        ...done,
      }),
      issue('iss-2', 'ENG-2', 'Legacy snapshot', {
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-1',
        assigneeId: ana,
        ...done,
      }),
      issue('iss-3', 'ENG-3', 'Drop old tables', {
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-1',
        stateId: 'dropped',
        canceledAt: NOW,
      }),
      // Dual-write is 3 days overdue.
      issue('iss-10', 'ENG-10', 'Dual-write shim', {
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-2',
        assigneeId: ana,
        stateId: 'working',
      }),
      issue('iss-11', 'ENG-11', 'Dual-write payments', {
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-2',
        assigneeId: dev,
      }),
      issue('iss-12', 'ENG-12', 'Reconcile dual-write drift', {
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-2',
        stateId: 'backlog',
      }),
      issue('iss-13', 'ENG-13', 'Backfill orders', {
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-2',
      }),
      issue('iss-16', 'ENG-16', 'Switch reads', {
        projectId: 'proj-atlas',
        milestoneId: 'ms-atlas-3',
        assigneeId: ana,
      }),
      issue('iss-18', 'ENG-18', 'Cleanup scripts', {
        projectId: 'proj-atlas',
        assigneeId: ana,
      }),
      // Beacon.
      issue('iss-23', 'ENG-23', 'Typo tolerance', {
        projectId: 'proj-beacon',
        milestoneId: 'ms-beacon-1',
        assigneeId: dev,
      }),
      issue('iss-24', 'ENG-24', 'Synonyms', {
        projectId: 'proj-beacon',
        milestoneId: 'ms-beacon-1',
        assigneeId: dev,
      }),
      // Juniper: a cycle, and a wait on Beacon.
      issue('iss-20', 'OPS-20', 'Brand review sign-off', {
        projectId: 'proj-juniper',
        milestoneId: 'ms-juniper-1',
        assigneeId: grace,
      }),
      issue('iss-70', 'ENG-70', 'Color tokens', {
        projectId: 'proj-juniper',
        milestoneId: 'ms-juniper-1',
        assigneeId: grace,
      }),
      issue('iss-71', 'ENG-71', 'Type scale', {
        projectId: 'proj-juniper',
        milestoneId: 'ms-juniper-1',
        assigneeId: grace,
      }),
      // Fjord is paused; Delta's milestone is undated; Garnet's is empty.
      issue('iss-8', 'OPS-8', 'Funnel dashboard', {
        projectId: 'proj-fjord',
        milestoneId: 'ms-fjord-1',
      }),
      issue('iss-40', 'ENG-40', 'CSV export job', {
        projectId: 'proj-delta',
        milestoneId: 'ms-delta-1',
      }),
      issue('iss-54', 'ENG-54', 'Push token store', {
        projectId: 'proj-garnet',
        assigneeId: dev,
      }),
      // No project at all.
      issue('iss-80', 'ENG-80', 'Stray task'),
    ],
    relations: [
      { id: 'rel-1', blockerId: 'iss-10', blockedId: 'iss-16' },
      { id: 'rel-2', blockerId: 'iss-2', blockedId: 'iss-16' },
      { id: 'rel-3', blockerId: 'iss-12', blockedId: 'iss-23' },
      { id: 'rel-4', blockerId: 'iss-23', blockedId: 'iss-20' },
      { id: 'rel-5', blockerId: 'iss-70', blockedId: 'iss-71' },
      { id: 'rel-6', blockerId: 'iss-71', blockedId: 'iss-70' },
    ],
  };
}

/** buildGraphPage's options beside the graph and the snapshot. */
export type PageOptions = Pick<GraphPageInput, 'nodeId' | 'overlay'>;

/**
 * The demo workspace (or `data`) through the planning chain, with
 * `page(scope)` building the page through the core's graph builder and
 * `pageOf(graph)` building it from a hand-made graph.
 */
export function fixture(data: WorkspaceData = demoWorkspace()) {
  const snapshot = indexWorkspace(data);
  const ctx: EvalContext = {
    today: TODAY,
    now: NOW,
    tuning: DEFAULT_TUNING,
    meta: new Map(),
  };
  const assessments = assessWorkspace(snapshot, ctx);
  const allocationPlan = planAllocation(snapshot, ctx, assessments);
  const graphOf = (scope: GraphScope) =>
    buildDependencyGraph(snapshot, ctx, assessments, scope);
  const pageOf = (graph: DependencyGraph, options: PageOptions = {}) =>
    buildGraphPage({
      graph,
      snapshot,
      assessments,
      allocationPlan,
      today: TODAY,
      hrefs: HREFS,
      ...options,
    });
  const page = (scope: GraphScope, options: PageOptions = {}) =>
    pageOf(graphOf(scope), options);
  return { snapshot, ctx, assessments, allocationPlan, graphOf, page, pageOf };
}

/** A hand-made graph node: an open, owned, ready issue by default. */
export function node(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: 'n1',
    kind: 'issue',
    label: 'Backfill orders',
    sublabel: 'ENG-1 · Ana Moreno',
    url: '#/task/n1',
    initiativeId: 'i1',
    projectId: 'p1',
    milestoneId: 'm1',
    ownerId: 'u1',
    external: false,
    clusterId: null,
    active: true,
    open: true,
    unassigned: false,
    overdue: false,
    inCycle: false,
    holdsCycle: false,
    waitsOnUnassigned: false,
    waitsOnOverdue: false,
    status: 'started',
    readiness: 'ready',
    blockedBy: 0,
    unplacedBlockers: 0,
    unblocks: 0,
    openIssues: 1,
    readyIssues: 1,
    ...overrides,
  };
}

/** A hand-made blocking edge, plain by default. */
export function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    from: 'a',
    to: 'b',
    resolved: false,
    blocking: true,
    crossProject: false,
    crossInitiative: false,
    crossOwner: false,
    inCycle: false,
    onRiskChain: false,
    weight: 1,
    ...overrides,
  };
}

/** A hand-made graph for the cases the demo is too small for. */
export function synthetic(
  scope: GraphScope,
  nodes: GraphNode[],
  edges: GraphEdge[]
): DependencyGraph {
  return {
    scope,
    nodes,
    edges,
    cycles: [],
    clusters: [],
    fallback: null,
    unplacedRelations: 0,
    chain: null,
  };
}

/**
 * A workspace at the draw limits: 700 issues in 7 projects × 10 milestones
 * (two initiatives, one project in none, one paused), joined by exactly
 * 1,000 blocking relations that all point forward (no cycle): a chain of 9
 * inside each milestone, then arrows between neighbouring milestones.
 * Every 7th issue is unassigned, every 11th done (so some arrows no longer
 * block) and every 13th started. Deterministic, for the timing test and
 * the drill-size check.
 */
export function bigWorkspace(): WorkspaceData {
  const base = demoWorkspace();
  const projects: Project[] = [];
  const milestones: Milestone[] = [];
  const issues: Issue[] = [];
  for (let p = 0; p < 7; p += 1) {
    const id = `big-p${p}`;
    projects.push(
      project(id, `Big project ${p}`, {
        initiativeIds: p < 3 ? ['init-platform'] : p < 6 ? ['init-growth'] : [],
        leadId: p === 2 ? null : 'human:ana',
        ...(p === 5
          ? { statusType: 'paused' as const, statusName: 'Paused' }
          : {}),
      })
    );
    for (let k = 0; k < 10; k += 1) {
      const mid = `big-m${p}-${k}`;
      milestones.push(
        milestone(mid, id, `Big milestone ${p}.${k}`, day(-10 + k * 7))
      );
      for (let j = 0; j < 10; j += 1) {
        const n = (p * 10 + k) * 10 + j;
        issues.push(
          issue(`big-i${n}`, `BIG-${n}`, `Big issue ${n}`, {
            projectId: id,
            milestoneId: mid,
            assigneeId: n % 7 === 0 ? null : 'human:dev',
            stateId: n % 11 === 0 ? 'done' : n % 13 === 0 ? 'working' : 'ready',
            completedAt: n % 11 === 0 ? NOW : null,
          })
        );
      }
    }
  }
  const relations: WorkspaceData['relations'] = [];
  const relate = (from: number, to: number) => {
    relations.push({
      id: `big-r${relations.length}`,
      blockerId: `big-i${from}`,
      blockedId: `big-i${to}`,
    });
  };
  for (let m = 0; m < 70; m += 1) {
    for (let j = 0; j < 9; j += 1) relate(m * 10 + j, m * 10 + j + 1);
  }
  for (let m = 0; m < 69; m += 1) {
    relate(m * 10 + 9, (m + 1) * 10);
    relate(m * 10 + 4, (m + 1) * 10 + 4);
    relate(m * 10 + 2, (m + 1) * 10 + 7);
    relate(m * 10 + 6, (m + 1) * 10 + 1);
  }
  for (let m = 0; m < 47; m += 1) {
    relate(m * 10, (m + 2) * 10 + 3);
    relate(m * 10 + 8, (m + 2) * 10 + 5);
  }
  return {
    ...base,
    projects,
    milestones,
    issues,
    relations,
  };
}
