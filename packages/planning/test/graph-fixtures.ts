// Graph fixtures shared by graph.test.ts and graph-readiness.test.ts: small
// workspaces, each built to give one rule of §2.10 a case, and the helpers
// that build and read their graphs.

import { buildDependencyGraph } from '../src/index';
import type {
  BlockingRelation,
  DependencyGraph,
  GraphEdge,
  GraphNode,
  GraphScope,
  Initiative,
  Issue,
  Milestone,
  Project,
} from '../src/index';
import {
  day,
  evaluate,
  type Evaluated,
  issue,
  milestone,
  project,
  STATE,
  user,
  workspace,
} from './helpers';

// Builds `blocks` relations from `[blocker, blocked]` pairs.
export function blocks(...pairs: [string, string][]): BlockingRelation[] {
  return pairs.map(([blockerId, blockedId], i) => ({
    id: `r${i}`,
    blockerId,
    blockedId,
  }));
}

// Indexes and assesses a test workspace with the users lead, bob, ana, cy
// (Orion's p1/m1 unless the parts name projects and milestones).
export function evaluateParts(parts: GraphParts): Evaluated {
  return evaluate(
    workspace({
      users: [user('lead'), user('bob'), user('ana'), user('cy')],
      initiatives: parts.initiatives ?? [],
      projects: parts.projects ?? [project('p1', { name: 'Orion' })],
      milestones: parts.milestones ?? [
        milestone('m1', 'p1', { targetDate: day(30), name: 'Beta' }),
      ],
      issues: parts.issues,
      relations: parts.relations,
    })
  );
}

// The graph of `scope` over a test workspace, as the viewer sees everything.
export function graph(parts: GraphParts, scope: GraphScope): DependencyGraph {
  const evaluated = evaluateParts(parts);
  return buildDependencyGraph(
    evaluated.snapshot,
    evaluated.ctx,
    evaluated.assessments,
    scope
  );
}

// A node of `g` by id; throws when it is not drawn.
export function node(g: DependencyGraph, id: string): GraphNode {
  const found = g.nodes.find((n) => n.id === id);
  if (found === undefined) throw new Error(`no node ${id}`);
  return found;
}

// An edge of `g` by its ends; throws when it is not drawn.
export function edge(g: DependencyGraph, from: string, to: string): GraphEdge {
  const found = g.edges.find((e) => e.from === from && e.to === to);
  if (found === undefined) throw new Error(`no edge ${from} → ${to}`);
  return found;
}

// Open, assigned issues in p1/m1 with predictable order (identifier = id).
export function inM1(id: string, overrides: Partial<Issue> = {}): Issue {
  return issue(id, {
    identifier: id,
    projectId: 'p1',
    milestoneId: 'm1',
    assigneeId: 'ana',
    stateId: STATE.started,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });
}

export const M1: GraphScope = { level: 'issue', milestoneId: 'm1' };

/** The parts of one test workspace that graph() takes. */
export interface GraphParts {
  initiatives?: Initiative[];
  projects?: Project[];
  milestones?: Milestone[];
  issues: Issue[];
  relations: BlockingRelation[];
}

// A three-cycle, a self-loop and a two-cycle through a closed blocker (not
// a deadlock), all in m1. Shared by the cycle, golden and readiness tests.
export const CYCLES: GraphParts = {
  issues: [
    inM1('C-1'),
    inM1('C-2'),
    inM1('C-3'),
    inM1('D-1'),
    inM1('S-1'),
    inM1('E-1', { stateId: STATE.done }),
    inM1('E-2'),
  ],
  relations: blocks(
    ['C-1', 'C-2'],
    ['C-2', 'C-3'],
    ['C-3', 'C-1'],
    ['C-3', 'D-1'],
    ['S-1', 'S-1'],
    // A "cycle" through a closed blocker is not a deadlock.
    ['E-1', 'E-2'],
    ['E-2', 'E-1']
  ),
};

// Two projects (Orion led by `lead`, Halo by `bob`) and an issue with no
// project: cross-project and cross-owner relations, one of them two hops
// away from m1. Shared by the issue-level, golden and readiness tests.
export const CROSS: GraphParts = {
  projects: [
    project('p1', { name: 'Orion' }),
    project('p2', { name: 'Halo', leadId: 'bob' }),
  ],
  milestones: [milestone('m1', 'p1'), milestone('m2', 'p2')],
  issues: [
    inM1('O-1'),
    inM1('O-2'),
    inM1('O-3'),
    inM1('H-1', { projectId: 'p2', milestoneId: 'm2', assigneeId: 'bob' }),
    inM1('H-2', { projectId: 'p2', milestoneId: 'm2', assigneeId: 'ana' }),
    inM1('H-3', { projectId: 'p2', milestoneId: 'm2', assigneeId: null }),
    inM1('H-4', { projectId: 'p2', milestoneId: 'm2' }),
    inM1('N-1', { projectId: null, milestoneId: null, assigneeId: 'cy' }),
  ],
  relations: blocks(
    ['H-1', 'O-1'], // other project, other owner
    ['H-2', 'O-2'], // other project, same owner
    ['H-3', 'O-3'], // other project, blocker unassigned
    ['O-1', 'N-1'], // blocks an issue with no project
    ['H-4', 'H-1'], // two hops away: not drawn
    ['O-2', 'O-3'] // same project, same owner
  ),
};

// An open issue in `milestoneId` of `projectId` (see inM1).
export function at(
  id: string,
  milestoneId: string,
  projectId: string,
  overrides: Partial<Issue> = {}
): Issue {
  return inM1(id, { milestoneId, projectId, ...overrides });
}

// Four projects (pP paused) with seven milestones: weighted, closed,
// same-milestone and paused relations at the milestone level. Shared by
// the milestone-level, golden and readiness tests.
export const LEVELS: GraphParts = {
  projects: [
    project('pA', { name: 'Alpha', leadId: 'lead', priority: 1 }),
    project('pB', { name: 'Bravo', leadId: 'bob', priority: 1 }),
    project('pC', { name: 'Charlie', leadId: 'lead', priority: 1 }),
    project('pP', {
      name: 'Paused',
      leadId: 'lead',
      statusType: 'paused',
      priority: 1,
    }),
  ],
  milestones: [
    milestone('mA', 'pA', { name: 'A', targetDate: day(10) }),
    milestone('mB', 'pB', { name: 'B', targetDate: day(-2) }),
    milestone('mC', 'pC', { name: 'C', targetDate: day(20) }),
    milestone('mA2', 'pA', { name: 'A2', targetDate: day(40) }),
    milestone('mDone', 'pA', { name: 'Done', targetDate: day(5) }),
    milestone('mP', 'pP', { name: 'P', targetDate: day(15) }),
    milestone('mP2', 'pP', { name: 'P2', targetDate: day(16) }),
  ],
  issues: [
    at('a1', 'mA', 'pA'),
    at('a2', 'mA', 'pA'),
    at('a3', 'mA', 'pA'),
    at('b1', 'mB', 'pB', { assigneeId: null }),
    at('b2', 'mB', 'pB'),
    at('b3', 'mB', 'pB', { stateId: STATE.done }),
    at('c1', 'mC', 'pC'),
    at('a2-1', 'mA2', 'pA'),
    at('d1', 'mDone', 'pA', { stateId: STATE.done }),
    at('p1', 'mP', 'pP'),
    at('p2', 'mP2', 'pP'),
  ],
  relations: blocks(
    ['b1', 'a1'], // B → A
    ['b2', 'a2'], // B → A again: weight 2
    ['b3', 'a3'], // closed blocker: not counted
    ['a1', 'a2'], // same milestone: no edge
    ['a1', 'c1'], // A → C (same lead, other project)
    ['p1', 'c1'], // paused P → active C: shown
    ['p1', 'p2'], // paused → paused: not shown
    ['d1', 'a2-1'] // closed blocker
  ),
};
