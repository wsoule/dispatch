import { describe, expect, test } from 'bun:test';

import {
  CHAIN_MAX_NODES,
  DEFAULT_GRAPH_LEVEL,
  escapeMermaidLabel,
  findCycles,
  GRAPH_LEVELS_WITHIN,
  graphContainer,
  graphScopeFor,
  isOverdueNode,
  isRiskNode,
  MERMAID_HUES,
  mermaidParts,
  resolveGraphScope,
  toMermaid,
} from '../src/index';
import type {
  BlockingRelation,
  DependencyGraph,
  GraphContainer,
  GraphEdge,
  GraphNode,
  GraphScope,
  MermaidChain,
} from '../src/index';
import {
  at,
  blocks,
  CROSS,
  CYCLES,
  edge,
  evaluateParts,
  graph,
  type GraphParts,
  inM1,
  LEVELS,
  M1,
  node,
} from './graph-fixtures';
import { day, initiative, milestone, project, STATE } from './helpers';

// A node reduced to the fields it had before the graph levels change
// (2026-10-22), so the goldens below compare only what existed then.
function todayNode(n: GraphNode): Record<string, unknown> {
  return {
    id: n.id,
    kind: n.kind,
    label: n.label,
    sublabel: n.sublabel,
    url: n.url,
    projectId: n.projectId,
    milestoneId: n.milestoneId,
    ownerId: n.ownerId,
    external: n.external,
    open: n.open,
    unassigned: n.unassigned,
    overdue: n.overdue,
    inCycle: n.inCycle,
    waitsOnUnassigned: n.waitsOnUnassigned,
    waitsOnOverdue: n.waitsOnOverdue,
    status: n.status,
  };
}

// An edge reduced to the fields it had before the graph levels change.
function todayEdge(e: GraphEdge): Record<string, unknown> {
  return {
    from: e.from,
    to: e.to,
    resolved: e.resolved,
    crossProject: e.crossProject,
    crossOwner: e.crossOwner,
    inCycle: e.inCycle,
    onRiskChain: e.onRiskChain,
    weight: e.weight,
  };
}

// Goldens captured on 2026-10-22 from the graph builder as it was before
// the graph levels change (spec §13 commit 1): the milestone level and the
// milestone and project issue levels must keep every field they had. Since
// the owner decision of 2026-10-23 ("the graph shows every issue, not only
// blocking ones") the milestone level also draws the milestones it used to
// leave out (MILESTONES_DRAWN_SINCE) and the arrow between two paused ones
// (EDGE_DRAWN_SINCE); every node and edge it drew before is unchanged.
interface Golden {
  nodes: Record<string, unknown>[];
  edges: Record<string, unknown>[];
  cycles: string[][];
}
// The two LEVELS milestones the workspace milestone level left out before
// 2026-10-23, in their display slots: mDone (no open issue: complete) right
// after the overdue mB, and the paused project's mP2 right after mP (by
// target date). The fields are the ones every golden node keeps.
const MILESTONES_DRAWN_SINCE: Record<string, unknown>[] = [
  {
    id: 'mDone',
    kind: 'milestone',
    label: 'Done',
    sublabel: 'Alpha',
    url: null,
    projectId: 'pA',
    milestoneId: 'mDone',
    ownerId: 'lead',
    external: false,
    open: false,
    unassigned: false,
    overdue: false,
    inCycle: false,
    waitsOnUnassigned: false,
    waitsOnOverdue: false,
    status: 'complete',
  },
  {
    id: 'mP2',
    kind: 'milestone',
    label: 'P2',
    sublabel: 'Paused',
    url: null,
    projectId: 'pP',
    milestoneId: 'mP2',
    ownerId: 'lead',
    external: false,
    open: true,
    unassigned: false,
    overdue: false,
    inCycle: false,
    waitsOnUnassigned: false,
    waitsOnOverdue: false,
    status: 'on_track',
  },
];

// The one LEVELS edge the workspace milestone level left out before
// 2026-10-23: the paused pP's mP blocks its own mP2, a relation with no end
// in an active project. Since every milestone is drawn, both ends are
// drawn boxes, so the arrow is drawn too (the timeline still leaves it
// out: chartDependencies). It sorts between mA → mC and mP → mC.
const EDGE_DRAWN_SINCE: Record<string, unknown> = {
  from: 'mP',
  to: 'mP2',
  resolved: false,
  crossProject: false,
  crossOwner: false,
  inCycle: false,
  onRiskChain: false,
  weight: 1,
};

const GOLDEN_MILESTONE_LEVEL: Golden = {
  nodes: [
    {
      id: 'mB',
      kind: 'milestone',
      label: 'B',
      sublabel: 'Bravo',
      url: null,
      projectId: 'pB',
      milestoneId: 'mB',
      ownerId: 'bob',
      external: false,
      open: true,
      unassigned: true,
      overdue: true,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'overdue',
    },
    {
      id: 'mA',
      kind: 'milestone',
      label: 'A',
      sublabel: 'Alpha',
      url: null,
      projectId: 'pA',
      milestoneId: 'mA',
      ownerId: 'lead',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: true,
      waitsOnOverdue: true,
      status: 'on_track',
    },
    {
      id: 'mP',
      kind: 'milestone',
      label: 'P',
      sublabel: 'Paused',
      url: null,
      projectId: 'pP',
      milestoneId: 'mP',
      ownerId: 'lead',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'on_track',
    },
    {
      id: 'mC',
      kind: 'milestone',
      label: 'C',
      sublabel: 'Charlie',
      url: null,
      projectId: 'pC',
      milestoneId: 'mC',
      ownerId: 'lead',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: true,
      waitsOnOverdue: true,
      status: 'on_track',
    },
    {
      id: 'mA2',
      kind: 'milestone',
      label: 'A2',
      sublabel: 'Alpha',
      url: null,
      projectId: 'pA',
      milestoneId: 'mA2',
      ownerId: 'lead',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'on_track',
    },
  ],
  edges: [
    {
      from: 'mB',
      to: 'mA',
      resolved: false,
      crossProject: true,
      crossOwner: true,
      inCycle: false,
      onRiskChain: true,
      weight: 2,
    },
    {
      from: 'mA',
      to: 'mC',
      resolved: false,
      crossProject: true,
      crossOwner: false,
      inCycle: false,
      onRiskChain: true,
      weight: 1,
    },
    {
      from: 'mP',
      to: 'mC',
      resolved: false,
      crossProject: true,
      crossOwner: false,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
  ],
  cycles: [],
};

const GOLDEN_ISSUES_IN_M1: Golden = {
  nodes: [
    {
      id: 'O-1',
      kind: 'issue',
      label: 'Issue O-1',
      sublabel: 'O-1 · Ana',
      url: 'https://linear.app/acme/issue/O-1',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'O-2',
      kind: 'issue',
      label: 'Issue O-2',
      sublabel: 'O-2 · Ana',
      url: 'https://linear.app/acme/issue/O-2',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'O-3',
      kind: 'issue',
      label: 'Issue O-3',
      sublabel: 'O-3 · Ana',
      url: 'https://linear.app/acme/issue/O-3',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: true,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'H-1',
      kind: 'issue',
      label: 'Issue H-1',
      sublabel: 'H-1 · Bob',
      url: 'https://linear.app/acme/issue/H-1',
      projectId: 'p2',
      milestoneId: 'm2',
      ownerId: 'bob',
      external: true,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'H-2',
      kind: 'issue',
      label: 'Issue H-2',
      sublabel: 'H-2 · Ana',
      url: 'https://linear.app/acme/issue/H-2',
      projectId: 'p2',
      milestoneId: 'm2',
      ownerId: 'ana',
      external: true,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'H-3',
      kind: 'issue',
      label: 'Issue H-3',
      sublabel: 'H-3 · Unassigned',
      url: 'https://linear.app/acme/issue/H-3',
      projectId: 'p2',
      milestoneId: 'm2',
      ownerId: null,
      external: true,
      open: true,
      unassigned: true,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'N-1',
      kind: 'issue',
      label: 'Issue N-1',
      sublabel: 'N-1 · Cy',
      url: 'https://linear.app/acme/issue/N-1',
      projectId: null,
      milestoneId: null,
      ownerId: 'cy',
      external: true,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
  ],
  edges: [
    {
      from: 'O-1',
      to: 'N-1',
      resolved: false,
      crossProject: true,
      crossOwner: true,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'O-2',
      to: 'O-3',
      resolved: false,
      crossProject: false,
      crossOwner: false,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'H-1',
      to: 'O-1',
      resolved: false,
      crossProject: true,
      crossOwner: true,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'H-2',
      to: 'O-2',
      resolved: false,
      crossProject: true,
      crossOwner: false,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'H-3',
      to: 'O-3',
      resolved: false,
      crossProject: true,
      crossOwner: false,
      inCycle: false,
      onRiskChain: true,
      weight: 1,
    },
  ],
  cycles: [],
};

const GOLDEN_CYCLES_IN_M1: Golden = {
  nodes: [
    {
      id: 'C-1',
      kind: 'issue',
      label: 'Issue C-1',
      sublabel: 'C-1 · Ana',
      url: 'https://linear.app/acme/issue/C-1',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: true,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'C-2',
      kind: 'issue',
      label: 'Issue C-2',
      sublabel: 'C-2 · Ana',
      url: 'https://linear.app/acme/issue/C-2',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: true,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'C-3',
      kind: 'issue',
      label: 'Issue C-3',
      sublabel: 'C-3 · Ana',
      url: 'https://linear.app/acme/issue/C-3',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: true,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'D-1',
      kind: 'issue',
      label: 'Issue D-1',
      sublabel: 'D-1 · Ana',
      url: 'https://linear.app/acme/issue/D-1',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'E-1',
      kind: 'issue',
      label: 'Issue E-1',
      sublabel: 'E-1 · Ana',
      url: 'https://linear.app/acme/issue/E-1',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: false,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'completed',
    },
    {
      id: 'E-2',
      kind: 'issue',
      label: 'Issue E-2',
      sublabel: 'E-2 · Ana',
      url: 'https://linear.app/acme/issue/E-2',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'S-1',
      kind: 'issue',
      label: 'Issue S-1',
      sublabel: 'S-1 · Ana',
      url: 'https://linear.app/acme/issue/S-1',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: true,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
  ],
  edges: [
    {
      from: 'C-1',
      to: 'C-2',
      resolved: false,
      crossProject: false,
      crossOwner: false,
      inCycle: true,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'C-2',
      to: 'C-3',
      resolved: false,
      crossProject: false,
      crossOwner: false,
      inCycle: true,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'C-3',
      to: 'C-1',
      resolved: false,
      crossProject: false,
      crossOwner: false,
      inCycle: true,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'C-3',
      to: 'D-1',
      resolved: false,
      crossProject: false,
      crossOwner: false,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'E-1',
      to: 'E-2',
      resolved: true,
      crossProject: false,
      crossOwner: false,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'E-2',
      to: 'E-1',
      resolved: false,
      crossProject: false,
      crossOwner: false,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'S-1',
      to: 'S-1',
      resolved: false,
      crossProject: false,
      crossOwner: false,
      inCycle: true,
      onRiskChain: false,
      weight: 1,
    },
  ],
  cycles: [['C-1', 'C-2', 'C-3'], ['S-1']],
};

const GOLDEN_ISSUES_IN_P2: Golden = {
  nodes: [
    {
      id: 'H-1',
      kind: 'issue',
      label: 'Issue H-1',
      sublabel: 'H-1 · Bob',
      url: 'https://linear.app/acme/issue/H-1',
      projectId: 'p2',
      milestoneId: 'm2',
      ownerId: 'bob',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'H-2',
      kind: 'issue',
      label: 'Issue H-2',
      sublabel: 'H-2 · Ana',
      url: 'https://linear.app/acme/issue/H-2',
      projectId: 'p2',
      milestoneId: 'm2',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'H-3',
      kind: 'issue',
      label: 'Issue H-3',
      sublabel: 'H-3 · Unassigned',
      url: 'https://linear.app/acme/issue/H-3',
      projectId: 'p2',
      milestoneId: 'm2',
      ownerId: null,
      external: false,
      open: true,
      unassigned: true,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'H-4',
      kind: 'issue',
      label: 'Issue H-4',
      sublabel: 'H-4 · Ana',
      url: 'https://linear.app/acme/issue/H-4',
      projectId: 'p2',
      milestoneId: 'm2',
      ownerId: 'ana',
      external: false,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'O-1',
      kind: 'issue',
      label: 'Issue O-1',
      sublabel: 'O-1 · Ana',
      url: 'https://linear.app/acme/issue/O-1',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: true,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'O-2',
      kind: 'issue',
      label: 'Issue O-2',
      sublabel: 'O-2 · Ana',
      url: 'https://linear.app/acme/issue/O-2',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: true,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
      status: 'started',
    },
    {
      id: 'O-3',
      kind: 'issue',
      label: 'Issue O-3',
      sublabel: 'O-3 · Ana',
      url: 'https://linear.app/acme/issue/O-3',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: true,
      open: true,
      unassigned: false,
      overdue: false,
      inCycle: false,
      waitsOnUnassigned: true,
      waitsOnOverdue: false,
      status: 'started',
    },
  ],
  edges: [
    {
      from: 'H-1',
      to: 'O-1',
      resolved: false,
      crossProject: true,
      crossOwner: true,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'H-2',
      to: 'O-2',
      resolved: false,
      crossProject: true,
      crossOwner: false,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
    {
      from: 'H-3',
      to: 'O-3',
      resolved: false,
      crossProject: true,
      crossOwner: false,
      inCycle: false,
      onRiskChain: true,
      weight: 1,
    },
    {
      from: 'H-4',
      to: 'H-1',
      resolved: false,
      crossProject: false,
      crossOwner: true,
      inCycle: false,
      onRiskChain: false,
      weight: 1,
    },
  ],
  cycles: [],
};

describe("today's output is kept", () => {
  test('milestone level: every milestone, the old ones unchanged in order', () => {
    const g = graph(LEVELS, { level: 'milestone' });
    const [mDone, mP2] = MILESTONES_DRAWN_SINCE;
    const [mB, mA, mP, mC, mA2] = GOLDEN_MILESTONE_LEVEL.nodes;
    expect(g.nodes.map(todayNode)).toEqual([mB, mDone, mA, mP, mP2, mC, mA2]);
    const [bToA, aToC, pToC] = GOLDEN_MILESTONE_LEVEL.edges;
    expect(g.edges.map(todayEdge)).toEqual([
      bToA,
      aToC,
      EDGE_DRAWN_SINCE,
      pToC,
    ]);
    expect(g.cycles).toEqual(GOLDEN_MILESTONE_LEVEL.cycles);
  });

  test.each([
    ['issue level in a milestone', CROSS, M1, GOLDEN_ISSUES_IN_M1],
    [
      'issue level with cycles and a closed blocker',
      CYCLES,
      M1,
      GOLDEN_CYCLES_IN_M1,
    ],
    [
      'issue level in a project',
      CROSS,
      { level: 'issue', projectId: 'p2' },
      GOLDEN_ISSUES_IN_P2,
    ],
  ] as [string, GraphParts, GraphScope, Golden][])(
    '%s',
    (_name, parts, scope, golden) => {
      const g = graph(parts, scope);
      expect(g.nodes.map(todayNode)).toEqual(golden.nodes);
      expect(g.edges.map(todayEdge)).toEqual(golden.edges);
      expect(g.cycles).toEqual(golden.cycles);
    }
  );
});

describe('issue level: transitive waits over open blockers', () => {
  const g = graph(
    {
      issues: [
        inM1('A-1', { assigneeId: null }), // unassigned root
        inM1('A-2'),
        inM1('A-3'),
        inM1('B-1', { assigneeId: null }), // unassigned root of a broken chain
        inM1('B-2', { stateId: STATE.done }), // closed middle
        inM1('B-3'),
        inM1('C-1', { assigneeId: null, stateId: STATE.done }), // closed and unassigned
        inM1('C-2'),
      ],
      relations: blocks(
        ['A-1', 'A-2'],
        ['A-2', 'A-3'],
        ['B-1', 'B-2'],
        ['B-2', 'B-3'],
        ['C-1', 'C-2']
      ),
    },
    M1
  );

  test.each([
    ['A-1', true, false],
    ['A-2', false, true],
    ['A-3', false, true],
    ['B-1', true, false],
    ['B-2', false, false], // closed issues never wait
    ['B-3', false, false], // its only blocker is closed
    ['C-1', false, false], // closed, so not "unassigned"
    ['C-2', false, false],
  ])('%s: unassigned %s, waitsOnUnassigned %s', (id, unassigned, waits) => {
    expect(node(g, id).unassigned).toBe(unassigned);
    expect(node(g, id).waitsOnUnassigned).toBe(waits);
  });

  test('closed blockers make edges resolved and off the risk chain', () => {
    expect(edge(g, 'B-2', 'B-3')).toMatchObject({
      resolved: true,
      onRiskChain: false,
    });
    expect(edge(g, 'C-1', 'C-2')).toMatchObject({
      resolved: true,
      onRiskChain: false,
    });
    expect(edge(g, 'A-1', 'A-2')).toMatchObject({
      resolved: false,
      onRiskChain: true,
    });
    // A-2 is assigned but waits on A-1, so its edge is on the chain too.
    expect(edge(g, 'A-2', 'A-3')).toMatchObject({
      resolved: false,
      onRiskChain: true,
    });
    expect(edge(g, 'B-1', 'B-2')).toMatchObject({
      resolved: false,
      onRiskChain: true,
    });
  });

  test('nodes come in issue order and carry issue fields', () => {
    expect(g.nodes.map((n) => n.id)).toEqual([
      'A-1',
      'A-2',
      'A-3',
      'B-1',
      'B-2',
      'B-3',
      'C-1',
      'C-2',
    ]);
    expect(node(g, 'A-2')).toMatchObject({
      kind: 'issue',
      label: 'Issue A-2',
      sublabel: 'A-2 · Ana',
      url: 'https://linear.app/acme/issue/A-2',
      projectId: 'p1',
      milestoneId: 'm1',
      ownerId: 'ana',
      external: false,
      open: true,
      status: 'started',
    });
    expect(node(g, 'A-1').sublabel).toBe('A-1 · Unassigned');
  });
});

describe('issue level: overdue chains', () => {
  test('an issue in an overdue milestone flags everything that waits on it', () => {
    const g = graph(
      {
        milestones: [
          milestone('late', 'p1', { targetDate: day(-3) }),
          milestone('m1', 'p1', { targetDate: day(30) }),
        ],
        issues: [
          inM1('L-1', { milestoneId: 'late' }),
          inM1('M-1'),
          inM1('M-2'),
        ],
        relations: blocks(['L-1', 'M-1'], ['M-1', 'M-2']),
      },
      M1
    );
    expect(node(g, 'L-1')).toMatchObject({
      external: true,
      overdue: true,
      waitsOnOverdue: false,
    });
    expect(node(g, 'M-1')).toMatchObject({
      overdue: false,
      waitsOnOverdue: true,
      waitsOnUnassigned: false,
    });
    expect(node(g, 'M-2').waitsOnOverdue).toBe(true);
    expect(edge(g, 'L-1', 'M-1').onRiskChain).toBe(true);
  });

  test('waits follow chains that leave the scope', () => {
    // M-1 waits on X-1 (outside), which waits on unassigned X-2 (two hops).
    const g = graph(
      {
        milestones: [milestone('m1', 'p1'), milestone('mx', 'p1')],
        issues: [
          inM1('M-1'),
          inM1('X-1', { milestoneId: 'mx' }),
          inM1('X-2', { milestoneId: 'mx', assigneeId: null }),
        ],
        relations: blocks(['X-2', 'X-1'], ['X-1', 'M-1']),
      },
      M1
    );
    expect(g.nodes.map((n) => [n.id, n.external])).toEqual([
      ['M-1', false],
      ['X-1', true],
    ]);
    expect(node(g, 'M-1').waitsOnUnassigned).toBe(true);
    expect(node(g, 'X-1').waitsOnUnassigned).toBe(true);
    // Only one hop is drawn.
    expect(g.edges.map((e) => [e.from, e.to])).toEqual([['X-1', 'M-1']]);
  });
});

describe('issue level: cycles (Tarjan SCC)', () => {
  const g = graph(CYCLES, M1);

  test('finds the three-cycle and the self-loop, in walk order', () => {
    expect(g.cycles).toEqual([['C-1', 'C-2', 'C-3'], ['S-1']]);
  });

  test('flags nodes and edges on cycles only', () => {
    expect(g.nodes.filter((n) => n.inCycle).map((n) => n.id)).toEqual([
      'C-1',
      'C-2',
      'C-3',
      'S-1',
    ]);
    expect(
      g.edges.filter((e) => e.inCycle).map((e) => `${e.from}>${e.to}`)
    ).toEqual(['C-1>C-2', 'C-2>C-3', 'C-3>C-1', 'S-1>S-1']);
    expect(edge(g, 'C-3', 'D-1').inCycle).toBe(false);
  });

  test('findCycles handles long chains without recursion limits', () => {
    const n = 50_000;
    const successors = Array.from({ length: n }, (_, i) =>
      i + 1 < n ? [i + 1] : [0]
    );
    const cycles = findCycles(n, successors);
    expect(cycles).toHaveLength(1);
    expect(cycles[0]).toHaveLength(n);
    expect(cycles[0]?.slice(0, 3)).toEqual([0, 1, 2]);
  });
});

describe('issue level: cross-project and cross-owner edges, external nodes', () => {
  const { projects, milestones, issues, relations } = CROSS;

  test('milestone scope adds one hop of outside issues as externals', () => {
    const g = graph({ projects, milestones, issues, relations }, M1);
    expect(g.nodes.map((n) => [n.id, n.external])).toEqual([
      ['O-1', false],
      ['O-2', false],
      ['O-3', false],
      ['H-1', true],
      ['H-2', true],
      ['H-3', true],
      ['N-1', true],
    ]);
    expect(
      g.edges.map((e) => [e.from, e.to, e.crossProject, e.crossOwner])
    ).toEqual([
      ['O-1', 'N-1', true, true],
      ['O-2', 'O-3', false, false],
      ['H-1', 'O-1', true, true],
      ['H-2', 'O-2', true, false],
      ['H-3', 'O-3', true, false],
    ]);
  });

  test('project scope covers every issue in the project', () => {
    const g = graph(
      { projects, milestones, issues, relations },
      { level: 'issue', projectId: 'p2' }
    );
    expect(g.scope).toEqual({ level: 'issue', projectId: 'p2' });
    expect(g.nodes.filter((n) => !n.external).map((n) => n.id)).toEqual([
      'H-1',
      'H-2',
      'H-3',
      'H-4',
    ]);
    expect(g.nodes.filter((n) => n.external).map((n) => n.id)).toEqual([
      'O-1',
      'O-2',
      'O-3',
    ]);
  });

  test('an unknown scope gives an empty graph', () => {
    const g = graph(
      { projects, milestones, issues, relations },
      { level: 'issue', milestoneId: 'nope' }
    );
    expect(g).toEqual({
      scope: { level: 'issue', milestoneId: 'nope' },
      nodes: [],
      edges: [],
      cycles: [],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    });
  });
});

describe('milestone level', () => {
  const { projects, milestones, issues, relations } = LEVELS;
  const g = graph(
    { projects, milestones, issues, relations },
    { level: 'milestone' }
  );

  test('nodes: every milestone, done and paused ones too, in display order', () => {
    // mDone has no open issue and mP2 is in the paused project with no
    // drawn edge: both are drawn since 2026-10-23 (every item of the
    // level), quiet, in their compareMilestones slots.
    expect(g.nodes.map((n) => n.id)).toEqual([
      'mB',
      'mDone',
      'mA',
      'mP',
      'mP2',
      'mC',
      'mA2',
    ]);
    expect(node(g, 'mDone')).toMatchObject({ open: false, readiness: 'done' });
    expect(node(g, 'mP2')).toMatchObject({ active: false, open: true });
    expect(node(g, 'mB')).toMatchObject({
      kind: 'milestone',
      label: 'B',
      sublabel: 'Bravo',
      url: null,
      projectId: 'pB',
      milestoneId: 'mB',
      ownerId: 'bob',
      external: false,
      open: true,
      unassigned: true,
      overdue: true,
      status: 'overdue',
    });
  });

  test('edges aggregate open relations into weights', () => {
    // mP → mP2 joins two milestones of the paused pP: both are drawn, so
    // their arrow is too (2026-10-23).
    expect(g.edges.map((e) => [e.from, e.to, e.weight])).toEqual([
      ['mB', 'mA', 2],
      ['mA', 'mC', 1],
      ['mP', 'mP2', 1],
      ['mP', 'mC', 1],
    ]);
  });

  test('cross-project and cross-owner use projects and leads', () => {
    expect(edge(g, 'mB', 'mA')).toMatchObject({
      crossProject: true,
      crossOwner: true,
      resolved: false,
    });
    expect(edge(g, 'mA', 'mC')).toMatchObject({
      crossProject: true,
      crossOwner: false,
    });
  });

  test('waits flags aggregate the issue-level chains', () => {
    expect(node(g, 'mA')).toMatchObject({
      waitsOnUnassigned: true,
      waitsOnOverdue: true,
      unassigned: false,
      overdue: false,
    });
    expect(node(g, 'mC')).toMatchObject({
      waitsOnUnassigned: true,
      waitsOnOverdue: true,
    });
    expect(node(g, 'mP')).toMatchObject({
      waitsOnUnassigned: false,
      waitsOnOverdue: false,
    });
    expect(edge(g, 'mB', 'mA').onRiskChain).toBe(true);
    expect(edge(g, 'mA', 'mC').onRiskChain).toBe(true);
    expect(edge(g, 'mP', 'mC').onRiskChain).toBe(false);
  });

  test('milestone-level cycles', () => {
    const cyclic = graph(
      {
        projects,
        milestones,
        issues,
        relations: [...relations, ...blocks(['c1', 'b2'])].map((r, i) => ({
          ...r,
          id: `x${i}`,
        })),
      },
      { level: 'milestone' }
    );
    expect(cyclic.cycles).toEqual([['mB', 'mA', 'mC']]);
    expect(cyclic.nodes.filter((n) => n.inCycle).map((n) => n.id)).toEqual([
      'mB',
      'mA',
      'mC',
    ]);
    expect(edge(cyclic, 'mP', 'mC').inCycle).toBe(false);
  });
});

describe('toMermaid', () => {
  // Built by the real builder, so readiness, blocking and risk are core's
  // own: ENG-1 (unassigned) waits on the external OPS-1, ENG-2 waits on
  // ENG-1 and on the closed ENG-3.
  function orion(): DependencyGraph {
    return graph(
      {
        projects: [
          project('p1', { name: 'Orion' }),
          project('p2', { name: 'Halo' }),
        ],
        milestones: [milestone('m1', 'p1'), milestone('m2', 'p2')],
        issues: [
          inM1('ENG-1', { title: 'Ship "beta" [v2]', assigneeId: null }),
          inM1('ENG-2', { title: 'Docs <draft> #1' }),
          inM1('ENG-3', { title: 'Old work', stateId: STATE.done }),
          inM1('OPS-1', {
            title: 'Infra (prod)\nsetup',
            projectId: 'p2',
            milestoneId: 'm2',
          }),
        ],
        relations: blocks(
          ['ENG-1', 'ENG-2'],
          ['ENG-3', 'ENG-2'],
          ['OPS-1', 'ENG-1']
        ),
      },
      M1
    );
  }
  // OPS-1 → ENG-1 → ENG-2, as the ui's longestChain would give it.
  const ORION_CHAIN: MermaidChain = {
    nodeIds: ['OPS-1', 'ENG-1', 'ENG-2'],
    edges: [
      { from: 'OPS-1', to: 'ENG-1' },
      { from: 'ENG-1', to: 'ENG-2' },
    ],
  };

  test('the body: positional ids, readiness words, subgraphs, arrows and weights', () => {
    // m1's issues and the external OPS-1 span two projects, so each
    // milestone's subgraph sits inside its project's.
    expect(mermaidParts(orion()).body).toBe(
      [
        'flowchart LR',
        '  subgraph c0["Orion"]',
        '    subgraph c1["Milestone m1"]',
        '      n0["Ship #34;beta#34; #91;v2#93;<br/>ENG-1 · Unassigned · Blocked by 1"]',
        '      n1["Docs #60;draft#62; #35;1<br/>ENG-2 · Ana · Blocked by 1"]',
        '      n2["Old work<br/>ENG-3 · Ana"]',
        '    end',
        '  end',
        '  subgraph c2["Halo"]',
        '    subgraph c3["Milestone m2"]',
        '      n3["Infra #40;prod#41; setup<br/>OPS-1 · Ana · Ready"]',
        '    end',
        '  end',
        '  n0 --> n1',
        '  n2 -.-> n1',
        '  n3 --> n0',
        '',
      ].join('\n')
    );
  });

  test('status is the default: readiness classes, unblocked links in green', () => {
    const g = orion();
    const { body, styles } = mermaidParts(g);
    expect(styles.status).toBe(
      [
        '  classDef ready stroke:#16853c',
        '  classDef blocked stroke:#bd790a,stroke-width:2px',
        '  classDef stuck stroke:#d92d20,stroke-width:2px,stroke-dasharray:5 3',
        '  classDef quiet opacity:0.6',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '  class n3 ready',
        '  class n0,n1 blocked',
        '  class n2 quiet',
        '  class n3 external',
        '  linkStyle 1 stroke:#16853c',
        '',
      ].join('\n')
    );
    expect(toMermaid(g)).toBe(body + styles.status);
    expect(toMermaid(g, { highlight: 'status' })).toBe(toMermaid(g));
  });

  test('risk writes the earlier export: overdue, risk, cycle, risk-chain links', () => {
    const g = orion();
    expect(toMermaid(g, { highlight: 'risk' })).toBe(
      mermaidParts(g).body +
        [
          '  classDef overdue stroke:#d92d20,stroke-width:2px',
          '  classDef risk stroke:#bd790a,stroke-width:2px',
          '  classDef cycle stroke:#d92d20,stroke-dasharray:5 3',
          '  classDef external stroke-dasharray:3 3,opacity:0.7',
          '  class n0,n1 risk',
          '  class n3 external',
          '  linkStyle 0 stroke:#bd790a',
          '',
        ].join('\n')
    );
  });

  test('critical: the given chain named, classed and widened, with no hue', () => {
    const g = orion();
    const critical = mermaidParts(g, { critical: ORION_CHAIN }).styles.critical;
    expect(critical).toBe(
      [
        '  %% Critical path: n3 → n0 → n1 (3 issues)',
        '  classDef critical stroke-width:3px',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '  class n0,n1,n3 critical',
        '  class n3 external',
        '  linkStyle 0,2 stroke-width:3px',
        '',
      ].join('\n')
    );
    expect(critical).not.toMatch(/stroke:|#[0-9a-f]{6}/i);
    expect(toMermaid(g, { highlight: 'critical', critical: ORION_CHAIN })).toBe(
      mermaidParts(g).body + critical
    );
  });

  test('critical with no chain, or none of it drawn: only the frame classes', () => {
    const g = orion();
    const frame = [
      '  classDef external stroke-dasharray:3 3,opacity:0.7',
      '  class n3 external',
      '',
    ].join('\n');
    expect(mermaidParts(g).styles.critical).toBe(frame);
    expect(mermaidParts(g, { critical: null }).styles.critical).toBe(frame);
    expect(
      mermaidParts(g, {
        critical: {
          nodeIds: ['gone', 'away'],
          edges: [{ from: 'gone', to: 'away' }],
        },
      }).styles.critical
    ).toBe(frame);
  });

  test('the body is the same in every highlight; the chain only reaches critical', () => {
    const g = orion();
    const plain = mermaidParts(g);
    const withChain = mermaidParts(g, { critical: ORION_CHAIN });
    expect(withChain.body).toBe(plain.body);
    expect(withChain.styles.status).toBe(plain.styles.status);
    expect(withChain.styles.risk).toBe(plain.styles.risk);
    for (const highlight of ['status', 'risk', 'critical'] as const) {
      expect(toMermaid(g, { highlight, critical: ORION_CHAIN })).toBe(
        plain.body + withChain.styles[highlight]
      );
    }
  });

  test('an edge into a closed issue no longer blocks: dotted, green in status', () => {
    const g = graph(
      {
        issues: [inM1('A-1'), inM1('A-2', { stateId: STATE.done })],
        relations: blocks(['A-1', 'A-2']),
      },
      M1
    );
    expect(g.edges.map((e) => [e.resolved, e.blocking])).toEqual([
      [false, false],
    ]);
    const { body, styles } = mermaidParts(g);
    expect(body).toContain('  n0 -.-> n1\n');
    expect(styles.status).toContain('  linkStyle 0 stroke:#16853c\n');
    expect(styles.risk).not.toContain('linkStyle');
  });

  test('box words: the readiness word is the second line without a sublabel', () => {
    const g: DependencyGraph = {
      scope: { level: 'milestone' },
      nodes: [
        {
          ...baseNode('a'),
          label: 'Alpha',
          sublabel: 'P1',
          inCycle: true,
          readiness: 'blocked',
          blockedBy: 1,
        },
        {
          ...baseNode('b'),
          label: 'Beta',
          sublabel: '',
          inCycle: true,
          holdsCycle: true,
          readiness: 'blocked',
          blockedBy: 1,
          readyIssues: 0,
        },
        { ...baseNode('c'), label: 'Gamma', sublabel: '' },
        {
          ...baseNode('d'),
          label: 'Delta',
          sublabel: 'P2',
          readiness: 'done',
          openIssues: 0,
          readyIssues: 0,
        },
      ],
      edges: [
        { ...baseEdge('a', 'b'), weight: 3, inCycle: true },
        { ...baseEdge('b', 'a'), inCycle: true },
      ],
      cycles: [['a', 'b']],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    };
    const { body, styles } = mermaidParts(g);
    expect(body).toBe(
      [
        'flowchart LR',
        '  n0["Alpha<br/>P1 · Waiting on 1"]',
        '  n1["Beta<br/>Waiting on 1"]',
        '  n2["Gamma<br/>Clear"]',
        '  n3["Delta<br/>P2"]',
        '  n0 -->|3| n1',
        '  n1 --> n0',
        '',
      ].join('\n')
    );
    // Beta: none of its issues can start and a cycle inside holds them.
    expect(styles.status).toContain(
      [
        '  class n2 ready',
        '  class n0 blocked',
        '  class n1 stuck',
        '  class n3 quiet',
        '',
      ].join('\n')
    );
    expect(styles.status).not.toContain('linkStyle');
    // Risk keeps the drawn cycle's dashed red class.
    expect(styles.risk).toContain('  class n0,n1 cycle\n');
  });

  test('a cycle on the critical path is one step; the noun is the node kind', () => {
    const issues = (ids: string[]): GraphNode[] =>
      ids.map((id) => ({ ...baseNode(id), kind: 'issue', label: id }));
    const looped: DependencyGraph = {
      scope: { level: 'issue', milestoneId: 'm1' },
      nodes: issues(['a', 'b', 'c', 's']),
      edges: [
        baseEdge('a', 'b'),
        baseEdge('b', 'a'),
        baseEdge('b', 'c'),
        baseEdge('s', 's'),
        baseEdge('s', 'a'),
      ],
      cycles: [['a', 'b'], ['s']],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    };
    const critical = mermaidParts(looped, {
      critical: {
        nodeIds: ['s', 'a', 'b', 'c'],
        edges: [
          { from: 's', to: 'a' },
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' },
          { from: 'b', to: 'c' },
        ],
      },
    }).styles.critical;
    // s blocks itself, but a step of one member needs no "+".
    expect(critical).toContain(
      '  %% Critical path: n3 → n0 + n1 → n2 (4 issues)\n'
    );
    expect(critical).toContain('  linkStyle 0,1,2,4 stroke-width:3px\n');

    const boxes: DependencyGraph = {
      scope: { level: 'milestone' },
      nodes: [baseNode('mA'), baseNode('mB')],
      edges: [baseEdge('mA', 'mB')],
      cycles: [],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    };
    expect(
      mermaidParts(boxes, {
        critical: { nodeIds: ['mA', 'mB'], edges: [{ from: 'mA', to: 'mB' }] },
      }).styles.critical
    ).toContain('  %% Critical path: n0 → n1 (2 milestones)\n');
  });

  test('an empty graph is still valid Mermaid in every highlight', () => {
    const empty: DependencyGraph = {
      scope: { level: 'milestone' },
      nodes: [],
      edges: [],
      cycles: [],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    };
    expect(mermaidParts(empty)).toEqual({
      body: 'flowchart LR\n',
      styles: {
        status: [
          '  classDef ready stroke:#16853c',
          '  classDef blocked stroke:#bd790a,stroke-width:2px',
          '  classDef stuck stroke:#d92d20,stroke-width:2px,stroke-dasharray:5 3',
          '  classDef quiet opacity:0.6',
          '  classDef external stroke-dasharray:3 3,opacity:0.7',
          '',
        ].join('\n'),
        risk: [
          '  classDef overdue stroke:#d92d20,stroke-width:2px',
          '  classDef risk stroke:#bd790a,stroke-width:2px',
          '  classDef cycle stroke:#d92d20,stroke-dasharray:5 3',
          '  classDef external stroke-dasharray:3 3,opacity:0.7',
          '',
        ].join('\n'),
        critical: '  classDef external stroke-dasharray:3 3,opacity:0.7\n',
      },
    });
  });

  test('the purple accent is never written: it is not a status', () => {
    const g = orion();
    for (const highlight of ['status', 'risk', 'critical'] as const) {
      const text = toMermaid(g, { highlight, critical: ORION_CHAIN });
      expect(text.toLowerCase()).not.toContain('#9747ff');
      for (const hex of text.match(/#[0-9a-f]{6}\b/gi) ?? []) {
        expect(Object.values(MERMAID_HUES)).toContain(hex);
      }
    }
  });

  test.each([
    ['"quoted"', '#34;quoted#34;'],
    ['a[b]c', 'a#91;b#93;c'],
    ['f(x) {y} |z|', 'f#40;x#41; #123;y#125; #124;z#124;'],
    ['<script>&', '#60;script#62;#38;'],
    ['#34; already', '#35;34; already'],
    ['line\r\nbreak\nhere', 'line break here'],
    ['100% `code`', '100#37; #96;code#96;'],
    ['plain · text', 'plain · text'],
  ])('escapes %j', (input, expected) => {
    expect(escapeMermaidLabel(input)).toBe(expected);
  });
});

function baseNode(id: string): GraphNode {
  return {
    id,
    kind: 'milestone',
    label: id,
    sublabel: '',
    url: null,
    initiativeId: null,
    projectId: null,
    milestoneId: id,
    ownerId: null,
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
    status: 'on_track',
    readiness: 'ready',
    blockedBy: 0,
    unplacedBlockers: 0,
    unblocks: 0,
    openIssues: 1,
    readyIssues: 1,
  };
}

function baseEdge(from: string, to: string): GraphEdge {
  return {
    from,
    to,
    resolved: false,
    blocking: true,
    crossProject: false,
    crossInitiative: false,
    crossOwner: false,
    inCycle: false,
    onRiskChain: false,
    weight: 1,
  };
}

// ---------------------------------------------------------------------------
// Graphs at every level (owner decision 2026-10-22)
// ---------------------------------------------------------------------------

// A workspace for the levels above the issue: three initiatives and nine
// projects, chosen so each rule has a case.
//
//   project  initiatives (first)  status   lead    milestones
//   pA       iA                   started  lead    mA (day 10), mA2 (day 40)
//   pC       iA                   started  lead    mC (day 20)
//   pS       iB, iA (iA ranks 1st) started cy      mS (day 30)
//   pP       iA                   paused   ana     mP (no date)
//   pB       iB                   started  bob     mB (day -2, overdue)
//   pQ       iB                   paused   none    mQ (day 15)
//   pR       iC                   paused   ana     mR (day 3)
//   pN       none                 started  none    none
//   pX       iZ (unmirrored)      started  ghost   mX (day 25)
//
// Issues are open and assigned to ana unless noted: b1, q2 and r1 unassigned,
// b3, d1 and d2 done, a3 and n1 without a milestone, o1 without a project.
// The relations (blocker → blocked) and why each is there:
//   b1 → a1, b2 → a2  Bolt blocks Apollo twice (weight 2); b1 unassigned
//   b3 → a1           a closed blocker: counted only at the issue level
//   a1 → a2           inside one milestone: no aggregate edge
//   a1 → a4           Apollo's mA blocks its mA2
//   a3 → c1           no milestone: unplaced at the milestone level
//   c1 → b2           Comet blocks Bolt: cycles at project and initiative level
//   c2 → c3 → c2      an issue loop inside mC (holdsCycle)
//   p1 → c1           paused Parked blocks active Comet: kept everywhere
//   p1 → q1           paused → paused: dropped in the workspace only
//   o1 → a2           no project: unplaced at every aggregate level
//   s1 → x1           Shared (first in iA) blocks Xeno (no mirrored initiative)
//   r1 → a1           paused Rest (iC, unassigned) blocks Apollo
//   q1 → b2           both outside iA: never an edge inside iA
//   d1 → d2           closed → closed: history, dropped at the issue level
const ORG: GraphParts = {
  initiatives: [
    initiative('iA', { name: 'Apex', priority: 1, sortOrder: 1 }),
    initiative('iB', { name: 'Beam', priority: 2, sortOrder: 2 }),
    initiative('iC', { name: 'Core', priority: 3, sortOrder: 3 }),
  ],
  projects: [
    project('pA', { name: 'Apollo', initiativeIds: ['iA'], sortOrder: 1 }),
    project('pC', { name: 'Comet', initiativeIds: ['iA'], sortOrder: 2 }),
    project('pS', {
      name: 'Shared',
      leadId: 'cy',
      initiativeIds: ['iB', 'iA'],
      sortOrder: 3,
    }),
    project('pP', {
      name: 'Parked',
      leadId: 'ana',
      statusType: 'paused',
      initiativeIds: ['iA'],
      sortOrder: 4,
    }),
    project('pB', {
      name: 'Bolt',
      leadId: 'bob',
      initiativeIds: ['iB'],
      sortOrder: 5,
    }),
    project('pQ', {
      name: 'Quiet',
      leadId: null,
      statusType: 'paused',
      initiativeIds: ['iB'],
      sortOrder: 6,
    }),
    project('pR', {
      name: 'Rest',
      leadId: 'ana',
      statusType: 'paused',
      initiativeIds: ['iC'],
      sortOrder: 7,
    }),
    project('pN', { name: 'Nomad', leadId: null, sortOrder: 8 }),
    project('pX', {
      name: 'Xeno',
      leadId: 'ghost',
      initiativeIds: ['iZ'],
      sortOrder: 9,
    }),
  ],
  milestones: [
    milestone('mA', 'pA', { name: 'A', targetDate: day(10) }),
    milestone('mA2', 'pA', { name: 'A2', targetDate: day(40) }),
    milestone('mC', 'pC', { name: 'C', targetDate: day(20) }),
    milestone('mS', 'pS', { name: 'S', targetDate: day(30) }),
    milestone('mP', 'pP', { name: 'P', targetDate: null }),
    milestone('mB', 'pB', { name: 'B', targetDate: day(-2) }),
    milestone('mQ', 'pQ', { name: 'Q', targetDate: day(15) }),
    milestone('mR', 'pR', { name: 'R', targetDate: day(3) }),
    milestone('mX', 'pX', { name: 'X', targetDate: day(25) }),
  ],
  issues: [
    at('a1', 'mA', 'pA'),
    at('a2', 'mA', 'pA'),
    inM1('a3', { projectId: 'pA', milestoneId: null }),
    at('a4', 'mA2', 'pA'),
    at('a5', 'mA', 'pA'),
    at('d1', 'mA', 'pA', { stateId: STATE.done }),
    at('d2', 'mA', 'pA', { stateId: STATE.done }),
    at('c1', 'mC', 'pC'),
    at('c2', 'mC', 'pC'),
    at('c3', 'mC', 'pC'),
    at('s1', 'mS', 'pS'),
    at('p1', 'mP', 'pP'),
    at('b1', 'mB', 'pB', { assigneeId: null }),
    at('b2', 'mB', 'pB'),
    at('b3', 'mB', 'pB', { stateId: STATE.done }),
    at('q1', 'mQ', 'pQ'),
    at('q2', 'mQ', 'pQ', { assigneeId: null }),
    at('r1', 'mR', 'pR', { assigneeId: null }),
    inM1('n1', { projectId: 'pN', milestoneId: null }),
    at('x1', 'mX', 'pX'),
    inM1('o1', { projectId: null, milestoneId: null }),
  ],
  relations: blocks(
    ['b1', 'a1'],
    ['b2', 'a2'],
    ['b3', 'a1'],
    ['a1', 'a2'],
    ['a1', 'a4'],
    ['a3', 'c1'],
    ['c1', 'b2'],
    ['c2', 'c3'],
    ['c3', 'c2'],
    ['p1', 'c1'],
    ['p1', 'q1'],
    ['o1', 'a2'],
    ['s1', 'x1'],
    ['r1', 'a1'],
    ['q1', 'b2'],
    ['d1', 'd2']
  ),
};

// [from, to, weight] of every edge, in edge order.
function edgeList(g: DependencyGraph): [string, string, number][] {
  return g.edges.map((e) => [e.from, e.to, e.weight]);
}

// [id, external] of every node, in node order.
function nodeList(g: DependencyGraph): [string, boolean][] {
  return g.nodes.map((n) => [n.id, n.external]);
}

describe('resolveGraphScope', () => {
  const org = evaluateParts(ORG).snapshot;
  // No initiatives at all, as a guest's mirror.
  const bare = evaluateParts({
    issues: [inM1('Z-1', { identifier: 'ZED-7' })],
    relations: [],
  }).snapshot;

  test.each([
    { level: 'initiative' },
    { level: 'project' },
    { level: 'milestone' },
    { level: 'issue' },
    { level: 'project', initiativeId: 'iA' },
    { level: 'milestone', initiativeId: 'iA' },
    { level: 'issue', initiativeId: 'iA' },
    { level: 'milestone', projectId: 'pA' },
    { level: 'issue', projectId: 'pA' },
    { level: 'issue', milestoneId: 'mA' },
    { level: 'issue', issueId: 'a1' },
  ] as GraphScope[])('%j is allowed', (scope) => {
    expect(resolveGraphScope(org, scope)).toEqual({
      ok: true,
      scope,
      fallback: null,
    });
  });

  const INITIATIVE =
    "An initiative's graph shows its projects, milestones or issues.";
  const PROJECT = "A project's graph shows its milestones or issues.";
  const MILESTONE = "A milestone's graph shows its issues.";
  const CHAIN = "An issue's graph is its blocking chain, drawn issue by issue.";
  test.each([
    [{ level: 'initiative', initiativeId: 'iA' }, INITIATIVE],
    [{ level: 'initiative', projectId: 'pA' }, PROJECT],
    [{ level: 'project', projectId: 'pA' }, PROJECT],
    [{ level: 'initiative', milestoneId: 'mA' }, MILESTONE],
    [{ level: 'project', milestoneId: 'mA' }, MILESTONE],
    [{ level: 'milestone', milestoneId: 'mA' }, MILESTONE],
    [{ level: 'initiative', issueId: 'a1' }, CHAIN],
    [{ level: 'project', issueId: 'a1' }, CHAIN],
    [{ level: 'milestone', issueId: 'a1' }, CHAIN],
  ])('%j is refused', (scope, message) => {
    expect(resolveGraphScope(org, scope)).toEqual({
      ok: false,
      problem: 'invalid',
      message,
    });
  });

  test.each([
    [null, 'A graph scope is required.'],
    ['milestone', 'A graph scope is required.'],
    [{}, 'Graph level must be initiative, project, milestone or issue.'],
    [
      { level: 'team' },
      'Graph level must be initiative, project, milestone or issue.',
    ],
    [{ level: 'issue', milestoneId: 7 }, 'Graph ids must be strings.'],
    [
      { level: 'issue', milestoneId: 'mA', projectId: 'pA' },
      'A graph scope names at most one of initiativeId, projectId, milestoneId and issueId.',
    ],
  ])('%j is malformed', (raw, message) => {
    expect(resolveGraphScope(org, raw)).toEqual({
      ok: false,
      problem: 'invalid',
      message,
    });
  });

  test.each([
    [
      { level: 'project', initiativeId: 'iZ' },
      'That initiative is not in the mirror.',
    ],
    [
      { level: 'milestone', projectId: 'pZ' },
      'That project is not in the mirror.',
    ],
    [
      { level: 'issue', milestoneId: 'mZ' },
      'That milestone is not in the mirror.',
    ],
    [
      { level: 'issue', issueId: 'ENG-404' },
      'That issue is not in the planner (it may be in a closed project, or in a team the app cannot see).',
    ],
  ])('%j is not found', (scope, message) => {
    expect(resolveGraphScope(org, scope)).toEqual({
      ok: false,
      problem: 'not_found',
      message,
    });
  });

  test("'none' (the projects with no initiative) is always a container", () => {
    const allInInitiatives = evaluateParts({
      initiatives: [initiative('iA')],
      projects: [project('p1', { initiativeIds: ['iA'] })],
      issues: [],
      relations: [],
    }).snapshot;
    for (const snapshot of [org, allInInitiatives]) {
      expect(
        resolveGraphScope(snapshot, { level: 'issue', initiativeId: 'none' })
      ).toEqual({
        ok: true,
        scope: { level: 'issue', initiativeId: 'none' },
        fallback: null,
      });
    }
  });

  test('a chain names its issue by id or by identifier in any case', () => {
    for (const key of ['Z-1', 'ZED-7', 'zed-7']) {
      expect(resolveGraphScope(bare, { level: 'issue', issueId: key })).toEqual(
        {
          ok: true,
          scope: { level: 'issue', issueId: 'Z-1' },
          fallback: null,
        }
      );
    }
  });

  test('without initiatives, a scope naming them covers the workspace', () => {
    expect(resolveGraphScope(bare, { level: 'initiative' })).toEqual({
      ok: true,
      scope: { level: 'project' },
      fallback: {
        reason: 'no_initiatives',
        requested: { level: 'initiative' },
      },
    });
    // Any id, 'none' included, gets the same answer: nothing is checked.
    for (const id of ['anything', 'none', 'iA']) {
      expect(
        resolveGraphScope(bare, { level: 'milestone', initiativeId: id })
      ).toEqual({
        ok: true,
        scope: { level: 'milestone' },
        fallback: {
          reason: 'no_initiatives',
          requested: { level: 'milestone', initiativeId: id },
        },
      });
    }
    // Other scopes are untouched.
    expect(resolveGraphScope(bare, { level: 'project' })).toEqual({
      ok: true,
      scope: { level: 'project' },
      fallback: null,
    });
  });

  test('an invalid pair stays invalid without initiatives', () => {
    expect(
      resolveGraphScope(bare, { level: 'initiative', initiativeId: 'x' })
    ).toEqual({ ok: false, problem: 'invalid', message: INITIATIVE });
  });

  test('the builder draws the wider scope and reports the fallback', () => {
    const g = graph(
      { issues: [inM1('Z-1')], relations: [] },
      { level: 'issue', initiativeId: 'iA' }
    );
    expect(g.scope).toEqual({ level: 'issue' });
    expect(g.fallback).toEqual({
      reason: 'no_initiatives',
      requested: { level: 'issue', initiativeId: 'iA' },
    });
  });

  test('the builder resolves a chain to its issue id', () => {
    const g = graph(
      { issues: [inM1('Z-1', { identifier: 'ZED-7' })], relations: [] },
      { level: 'issue', issueId: 'zed-7' }
    );
    expect(g.scope).toEqual({ level: 'issue', issueId: 'Z-1' });
    expect(g.fallback).toBeNull();
  });
});

describe('graphContainer and graphScopeFor', () => {
  test.each([
    [{ level: 'milestone' }, { kind: 'workspace' }],
    [{ level: 'initiative' }, { kind: 'workspace' }],
    [
      { level: 'project', initiativeId: 'iA' },
      { kind: 'initiative', id: 'iA' },
    ],
    [
      { level: 'issue', initiativeId: 'none' },
      { kind: 'initiative', id: 'none' },
    ],
    [
      { level: 'milestone', projectId: 'pA' },
      { kind: 'project', id: 'pA' },
    ],
    [
      { level: 'issue', milestoneId: 'mA' },
      { kind: 'milestone', id: 'mA' },
    ],
    [
      { level: 'issue', issueId: 'a1' },
      { kind: 'chain', id: 'a1' },
    ],
  ] as [GraphScope, GraphContainer][])('%j ⇄ %j', (scope, container) => {
    expect(graphContainer(scope)).toEqual(container);
    expect(graphScopeFor(container, scope.level)).toEqual(scope);
  });

  test("a level the container does not offer gives the container's default", () => {
    expect(graphScopeFor({ kind: 'workspace' })).toEqual({
      level: 'milestone',
    });
    expect(
      graphScopeFor({ kind: 'initiative', id: 'iA' }, 'initiative')
    ).toEqual({ level: 'project', initiativeId: 'iA' });
    expect(graphScopeFor({ kind: 'project', id: 'pA' }, 'project')).toEqual({
      level: 'issue',
      projectId: 'pA',
    });
    expect(graphScopeFor({ kind: 'milestone', id: 'mA' }, 'milestone')).toEqual(
      { level: 'issue', milestoneId: 'mA' }
    );
    expect(graphScopeFor({ kind: 'chain', id: 'a1' })).toEqual({
      level: 'issue',
      issueId: 'a1',
    });
  });

  test('each container offers the levels finer than itself', () => {
    expect(GRAPH_LEVELS_WITHIN).toEqual({
      workspace: ['initiative', 'project', 'milestone', 'issue'],
      initiative: ['project', 'milestone', 'issue'],
      project: ['milestone', 'issue'],
      milestone: ['issue'],
      chain: ['issue'],
    });
    expect(DEFAULT_GRAPH_LEVEL).toEqual({
      workspace: 'milestone',
      initiative: 'project',
      project: 'issue',
      milestone: 'issue',
      chain: 'issue',
    });
  });
});

describe('project level in the workspace', () => {
  const g = graph(ORG, { level: 'project' });

  test('every project is drawn, paused ones (pP, pQ, pR) too', () => {
    expect(nodeList(g)).toEqual([
      ['pA', false],
      ['pC', false],
      ['pS', false],
      ['pP', false],
      ['pB', false],
      ['pQ', false],
      ['pR', false],
      ['pN', false],
      ['pX', false],
    ]);
    expect(g.nodes.filter((n) => !n.active).map((n) => n.id)).toEqual([
      'pP',
      'pQ',
      'pR',
    ]);
  });

  test('edges count open relations between projects', () => {
    // Bolt → Apollo twice (b3 is closed); Apollo's own a1 → a2 makes no
    // edge; a3 has no milestone but counts here. The paused p1 → q1 is an
    // edge between two drawn (paused) projects since 2026-10-23.
    expect(edgeList(g)).toEqual([
      ['pA', 'pC', 1],
      ['pC', 'pB', 1],
      ['pS', 'pX', 1],
      ['pP', 'pC', 1],
      ['pP', 'pQ', 1],
      ['pB', 'pA', 2],
      ['pQ', 'pB', 1],
      ['pR', 'pA', 1],
    ]);
    expect(g.cycles).toEqual([['pA', 'pC', 'pB']]);
    // o1 has no project, so o1 → a2 cannot be placed.
    expect(g.unplacedRelations).toBe(1);
    // Every issue is drawn now, so nothing is only counted.
    expect('unrelatedIssues' in g).toBe(false);
    expect(g.chain).toBeNull();
  });

  test('cross-initiative by first initiative, cross-owner by leads, risk per relation', () => {
    expect(
      g.edges.map((e) => [
        `${e.from}>${e.to}`,
        e.crossProject,
        e.crossInitiative,
        e.crossOwner,
        e.onRiskChain,
        e.resolved,
      ])
    ).toEqual([
      ['pA>pC', true, false, false, false, false],
      ['pC>pB', true, true, true, false, false],
      ['pS>pX', true, true, true, false, false],
      ['pP>pC', true, false, true, false, false],
      // Paused and Quiet are in different initiatives; neither has a lead
      // that differs from the other's.
      ['pP>pQ', true, true, false, false, false],
      ['pB>pA', true, true, true, true, false],
      // Quiet and Bolt are both in Beam; Quiet has no lead.
      ['pQ>pB', true, false, false, false, false],
      ['pR>pA', true, true, true, true, false],
    ]);
  });

  test('labels, links and owners come from the project', () => {
    expect(node(g, 'pA')).toMatchObject({
      kind: 'project',
      label: 'Apollo',
      sublabel: 'Lead',
      url: 'https://linear.app/acme/project/pA',
      initiativeId: 'iA',
      projectId: 'pA',
      milestoneId: null,
      ownerId: 'lead',
      external: false,
    });
    expect(node(g, 'pN')).toMatchObject({ sublabel: 'No lead', ownerId: null });
    expect(node(g, 'pX')).toMatchObject({
      sublabel: 'Unknown user',
      ownerId: 'ghost',
      // iZ is not mirrored, so Xeno has no initiative.
      initiativeId: 'none',
    });
    // Shared is in Beam and Apex; Apex ranks first.
    expect(node(g, 'pS').initiativeId).toBe('iA');
  });

  test('status is the next milestone’s; empty without one', () => {
    expect(g.nodes.map((n) => [n.id, n.status])).toEqual([
      ['pA', 'on_track'],
      ['pC', 'on_track'],
      ['pS', 'on_track'],
      ['pP', 'unscheduled'],
      ['pB', 'overdue'],
      ['pQ', 'on_track'],
      ['pR', 'at_risk'],
      ['pN', 'empty'],
      ['pX', 'on_track'],
    ]);
  });

  test('flags fold over each project’s open issues', () => {
    expect(node(g, 'pA')).toMatchObject({
      open: true,
      unassigned: false,
      overdue: false,
      waitsOnUnassigned: true,
      waitsOnOverdue: true,
      holdsCycle: false,
      inCycle: true,
    });
    expect(node(g, 'pB')).toMatchObject({
      unassigned: true,
      overdue: true,
      waitsOnUnassigned: false,
      holdsCycle: false,
    });
    // c2 ⇄ c3 deadlock each other inside Comet.
    expect(node(g, 'pC').holdsCycle).toBe(true);
  });
});

describe('initiative level in the workspace', () => {
  const g = graph(ORG, { level: 'initiative' });

  test('one node per first initiative, "No initiative" last', () => {
    expect(
      g.nodes.map((n) => [n.id, n.label, n.sublabel, n.active, n.external])
    ).toEqual([
      ['iA', 'Apex', '4 projects', true, false],
      ['iB', 'Beam', '2 projects', true, false],
      // Only Rest (paused) is in Core: an edge end, quiet.
      ['iC', 'Core', '1 project', false, false],
      // Nomad has none, and Xeno's iZ is not mirrored.
      ['none', 'No initiative', '2 projects', true, false],
    ]);
    expect(node(g, 'iA')).toMatchObject({
      kind: 'initiative',
      url: null,
      initiativeId: 'iA',
      projectId: null,
      milestoneId: null,
      ownerId: null,
    });
  });

  test('edges sum the relations between initiatives; a mutual pair is a cycle', () => {
    // iA → iB counts the paused p1 → q1 too (pP in iA, pQ in iB): both
    // initiatives are drawn, so the relation is on their arrow.
    expect(edgeList(g)).toEqual([
      ['iA', 'iB', 2],
      ['iA', 'none', 1],
      ['iB', 'iA', 2],
      ['iC', 'iA', 1],
    ]);
    expect(g.cycles).toEqual([['iA', 'iB']]);
    expect(
      g.edges.every((e) => e.crossProject && e.crossInitiative && !e.crossOwner)
    ).toBe(true);
    expect(g.edges.map((e) => e.onRiskChain)).toEqual([
      false,
      false,
      true,
      true,
    ]);
    expect(g.unplacedRelations).toBe(1);
  });

  test('status rolls up the active projects, or all of them when none is active', () => {
    expect(g.nodes.map((n) => [n.id, n.status])).toEqual([
      // Parked's undated milestone is ignored: Parked is paused.
      ['iA', 'on_track'],
      ['iB', 'overdue'],
      ['iC', 'at_risk'],
      ['none', 'empty'],
    ]);
  });

  test('flags fold over the initiative’s open issues', () => {
    expect(node(g, 'iA')).toMatchObject({
      unassigned: false,
      waitsOnUnassigned: true,
      holdsCycle: true,
    });
    expect(node(g, 'iB')).toMatchObject({
      unassigned: true,
      overdue: true,
      holdsCycle: false,
    });
  });

  test('a project in two initiatives counts once, so there is no false cycle', () => {
    const shared = graph(
      {
        initiatives: [
          initiative('iA', { name: 'Apex', priority: 1 }),
          initiative('iB', { name: 'Beam', priority: 2 }),
        ],
        projects: [
          project('pA', { initiativeIds: ['iA'] }),
          project('pS', { initiativeIds: ['iB', 'iA'] }),
          project('pB', { initiativeIds: ['iB'] }),
        ],
        milestones: [],
        issues: [
          inM1('a', { projectId: 'pA', milestoneId: null }),
          inM1('s', { projectId: 'pS', milestoneId: null }),
          inM1('b', { projectId: 'pB', milestoneId: null }),
        ],
        // Counted in both of its initiatives, Shared would make Beam wait
        // on Apex and Apex on Beam.
        relations: blocks(['a', 's'], ['s', 'a']),
      },
      { level: 'initiative' }
    );
    expect(shared.nodes.map((n) => [n.id, n.sublabel])).toEqual([
      ['iA', '2 projects'],
      ['iB', '1 project'],
    ]);
    expect(shared.edges).toEqual([]);
    expect(shared.cycles).toEqual([]);
  });
});

describe('aggregate levels inside a container', () => {
  test('an initiative’s projects, plus the ones outside that touch them', () => {
    const g = graph(ORG, { level: 'project', initiativeId: 'iA' });
    expect(nodeList(g)).toEqual([
      ['pA', false],
      ['pC', false],
      ['pS', false],
      // Paused, but inside the container asked for: listed.
      ['pP', false],
      ['pB', true],
      ['pQ', true],
      ['pR', true],
      ['pX', true],
    ]);
    // Parked → Quiet counts here (no activity filter inside a container);
    // Quiet → Bolt joins two outside projects, so it is no edge here.
    expect(edgeList(g)).toEqual([
      ['pA', 'pC', 1],
      ['pC', 'pB', 1],
      ['pS', 'pX', 1],
      ['pP', 'pC', 1],
      ['pP', 'pQ', 1],
      ['pB', 'pA', 2],
      ['pR', 'pA', 1],
    ]);
    expect(g.unplacedRelations).toBe(1);
    // An external's flags fold over all its open issues: q2 is unassigned
    // although it blocks nothing.
    expect(node(g, 'pQ')).toMatchObject({ unassigned: true, active: false });
  });

  test('an initiative’s milestones', () => {
    const g = graph(ORG, { level: 'milestone', initiativeId: 'iA' });
    expect(nodeList(g)).toEqual([
      ['mA', false],
      ['mC', false],
      ['mS', false],
      ['mA2', false],
      ['mP', false],
      ['mB', true],
      ['mR', true],
      ['mQ', true],
      ['mX', true],
    ]);
    expect(edgeList(g)).toEqual([
      ['mA', 'mA2', 1],
      ['mC', 'mB', 1],
      ['mS', 'mX', 1],
      ['mP', 'mC', 1],
      ['mP', 'mQ', 1],
      ['mB', 'mA', 2],
      ['mR', 'mA', 1],
    ]);
    // a3 has no milestone and o1 no project.
    expect(g.unplacedRelations).toBe(2);
    expect(node(g, 'mC').holdsCycle).toBe(true);
  });

  test('a project’s milestones', () => {
    const g = graph(ORG, { level: 'milestone', projectId: 'pA' });
    expect(nodeList(g)).toEqual([
      ['mA', false],
      ['mA2', false],
      ['mB', true],
      ['mR', true],
    ]);
    expect(edgeList(g)).toEqual([
      ['mA', 'mA2', 1],
      ['mB', 'mA', 2],
      ['mR', 'mA', 1],
    ]);
    expect(g.unplacedRelations).toBe(2);
    expect(node(g, 'mB')).toMatchObject({
      external: true,
      unassigned: true,
      overdue: true,
      initiativeId: 'iB',
      active: true,
    });
    expect(edge(g, 'mB', 'mA')).toMatchObject({
      crossProject: true,
      crossInitiative: true,
      crossOwner: true,
      onRiskChain: true,
    });
  });

  test('a container with no open work draws nothing', () => {
    const g = graph(ORG, { level: 'project', initiativeId: 'none' });
    expect(nodeList(g)).toEqual([
      ['pN', false],
      ['pX', false],
      ['pS', true],
    ]);
    expect(edgeList(g)).toEqual([['pS', 'pX', 1]]);
  });
});

describe('workspace milestone level: new facts', () => {
  const g = graph(ORG, { level: 'milestone' });

  test('paused projects’ milestones appear only on edges, quiet', () => {
    expect(g.nodes.map((n) => [n.id, n.active])).toEqual([
      ['mB', true],
      ['mR', false],
      ['mA', true],
      ['mQ', false],
      ['mC', true],
      ['mX', true],
      ['mS', true],
      ['mA2', true],
      ['mP', false],
    ]);
    expect(g.unplacedRelations).toBe(2);
  });

  test('cross-initiative compares the milestones’ projects', () => {
    expect(edge(g, 'mA', 'mA2').crossInitiative).toBe(false);
    expect(edge(g, 'mP', 'mC').crossInitiative).toBe(false);
    expect(edge(g, 'mC', 'mB').crossInitiative).toBe(true);
    expect(edge(g, 'mS', 'mX').crossInitiative).toBe(true);
  });
});

describe('issue level inside an initiative and the workspace', () => {
  test('an initiative: every issue in it, one hop of externals', () => {
    const g = graph(ORG, { level: 'issue', initiativeId: 'iA' });
    // Since 2026-10-23 every issue of Apollo, Comet, Shared and Parked is
    // drawn: a5 (on no relation) and the closed d1, d2 too.
    expect(nodeList(g)).toEqual([
      ['a1', false],
      ['a2', false],
      ['a3', false],
      ['a4', false],
      ['a5', false],
      ['c1', false],
      ['c2', false],
      ['c3', false],
      ['d1', false],
      ['d2', false],
      ['p1', false],
      ['s1', false],
      ['b1', true],
      ['b2', true],
      ['b3', true],
      // No project: in no initiative, so outside every one.
      ['o1', true],
      ['q1', true],
      ['r1', true],
      ['x1', true],
    ]);
    // d1 → d2 is closed on both ends: drawn as an arrow that no longer
    // blocks, like b3 → a1. q1 → b2 touches no issue of Apex.
    expect(edge(g, 'd1', 'd2')).toMatchObject({
      resolved: true,
      blocking: false,
    });
    expect(edge(g, 'b3', 'a1').resolved).toBe(true);
    expect(g.edges.some((e) => e.from === 'q1')).toBe(false);
    // a5 is open in Apollo and on no relation: drawn, with no dependencies.
    expect(node(g, 'a5')).toMatchObject({
      readiness: 'independent',
      blockedBy: 0,
      unblocks: 0,
    });
    expect(node(g, 'd2').readiness).toBe('done');
    expect(g.unplacedRelations).toBe(0);
    expect(node(g, 'o1').initiativeId).toBeNull();
    expect(node(g, 'p1')).toMatchObject({ active: false, initiativeId: 'iA' });
    expect(node(g, 'c2')).toMatchObject({ holdsCycle: true, inCycle: true });
    expect(edge(g, 'c1', 'b2').crossInitiative).toBe(true);
    expect(edge(g, 'a3', 'c1').crossInitiative).toBe(false);
  });

  test('“No initiative”: a project-less issue is outside it, never in it', () => {
    // o2 (no project) blocks n1 (Nomad, no initiative); o3 (no project)
    // is on no relation. o1 → a2 never touches the container.
    const parts: GraphParts = {
      ...ORG,
      issues: [
        ...ORG.issues,
        inM1('o2', { projectId: null, milestoneId: null }),
        inM1('o3', { projectId: null, milestoneId: null }),
      ],
      relations: [...ORG.relations, ...blocks(['o2', 'n1'])],
    };
    const issues = graph(parts, { level: 'issue', initiativeId: 'none' });
    expect(nodeList(issues)).toEqual([
      ['n1', false],
      ['x1', false],
      ['o2', true],
      ['s1', true],
    ]);
    // Nomad and Xeno hold no other issue; o3 is in no container and on no
    // relation, so it is not drawn here.
    expect(issues.nodes.some((n) => n.id === 'o3')).toBe(false);
    const projects = graph(parts, { level: 'project', initiativeId: 'none' });
    // Only o2 → n1 touches the container and has an end with no project.
    expect(projects.unplacedRelations).toBe(1);
  });

  test('the workspace: every issue and every relation, no externals', () => {
    const g = graph(ORG, { level: 'issue' });
    // Every issue of the mirror, open and closed, active and paused alike
    // (owner decision 2026-10-23).
    expect(g.nodes.map((n) => n.id)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'a5',
      'b1',
      'b2',
      'b3',
      'c1',
      'c2',
      'c3',
      'd1',
      'd2',
      'n1',
      'o1',
      'p1',
      'q1',
      'q2',
      'r1',
      's1',
      'x1',
    ]);
    expect(g.nodes.every((n) => !n.external)).toBe(true);
    // All 16 relations are arrows: p1 → q1 joins two paused projects and
    // d1 → d2 two closed issues, both drawn now that both ends are.
    expect(g.edges).toHaveLength(ORG.relations.length);
    expect(edge(g, 'p1', 'q1').blocking).toBe(true);
    expect(edge(g, 'd1', 'd2').blocking).toBe(false);
    expect(edge(g, 'q1', 'b2').onRiskChain).toBe(false);
    // a5, n1 and the paused q2 are on no relation.
    expect(
      g.nodes.filter((n) => n.readiness === 'independent').map((n) => n.id)
    ).toEqual(['a5', 'n1', 'q2']);
    expect(g.cycles).toEqual([['c2', 'c3']]);
  });
});

describe('aggregate risk is per relation', () => {
  const parts = (relations: BlockingRelation[]): GraphParts => ({
    milestones: [milestone('m1', 'p1'), milestone('m2', 'p1')],
    issues: [
      inM1('U-1', { assigneeId: null }),
      inM1('K-1'),
      inM1('W-1', { milestoneId: 'm2' }),
    ],
    relations,
  });

  test('a blocker milestone that merely holds an unassigned issue is no risk chain', () => {
    const g = graph(parts(blocks(['K-1', 'W-1'])), { level: 'milestone' });
    expect(node(g, 'm1').unassigned).toBe(true);
    expect(edge(g, 'm1', 'm2')).toMatchObject({
      weight: 1,
      onRiskChain: false,
    });
  });

  test('an unassigned blocker puts the edge on a risk chain', () => {
    const g = graph(parts(blocks(['K-1', 'W-1'], ['U-1', 'W-1'])), {
      level: 'milestone',
    });
    expect(edge(g, 'm1', 'm2')).toMatchObject({
      weight: 2,
      onRiskChain: true,
    });
  });
});

describe('holdsCycle', () => {
  test('a loop through a closed issue holds nothing', () => {
    const parts: GraphParts = {
      milestones: [milestone('m1', 'p1'), milestone('m2', 'p1')],
      issues: [
        inM1('E-1', { stateId: STATE.done }),
        inM1('E-2'),
        inM1('F-1', { milestoneId: 'm2' }),
      ],
      relations: blocks(['E-1', 'E-2'], ['E-2', 'E-1'], ['E-2', 'F-1']),
    };
    expect(node(graph(parts, { level: 'milestone' }), 'm1').holdsCycle).toBe(
      false
    );
    expect(node(graph(parts, M1), 'E-2').holdsCycle).toBe(false);
  });

  test('an open loop is held by its milestone, project and initiative', () => {
    expect(node(graph(ORG, { level: 'milestone' }), 'mC').holdsCycle).toBe(
      true
    );
    expect(node(graph(ORG, { level: 'project' }), 'pC').holdsCycle).toBe(true);
    expect(node(graph(ORG, { level: 'initiative' }), 'iA').holdsCycle).toBe(
      true
    );
    expect(node(graph(ORG, { level: 'milestone' }), 'mA').holdsCycle).toBe(
      false
    );
  });
});

// One focus F in m1 with a chain each way, plus every case the walk must
// leave out:
//   U-2 → U-1 → F → D-1 → D-2   open, transitive both ways
//   CB → F                       closed direct blocker: a resolved leaf
//   CB2 → U-1                    closed blocker two hops away: not walked
//   F → CW → CW2                 closed waiting issue: shown, not expanded
//   SB → D-1                     a side blocker of a downstream issue
const CHAIN_PARTS: GraphParts = {
  issues: [
    inM1('F'),
    inM1('U-1'),
    inM1('U-2'),
    inM1('D-1'),
    inM1('D-2'),
    inM1('CB', { stateId: STATE.done }),
    inM1('CB2', { stateId: STATE.done }),
    inM1('CW', { stateId: STATE.done }),
    inM1('CW2'),
    inM1('SB'),
    // A closed focus with an open blocker and an open blocked issue.
    inM1('G', { stateId: STATE.done }),
    inM1('GB'),
    inM1('GBB'),
    inM1('GW'),
    inM1('GWW'),
    // A focus on a three-issue loop.
    inM1('H'),
    inM1('K-1'),
    inM1('K-2'),
    // A focus with no relation.
    inM1('L'),
    // A focus on a two-issue loop, with one plain issue waiting on it.
    inM1('T'),
    inM1('TA'),
    inM1('TD'),
  ],
  relations: blocks(
    ['U-2', 'U-1'],
    ['U-1', 'F'],
    ['F', 'D-1'],
    ['D-1', 'D-2'],
    ['CB', 'F'],
    ['CB2', 'U-1'],
    ['F', 'CW'],
    ['CW', 'CW2'],
    ['SB', 'D-1'],
    ['GBB', 'GB'],
    ['GB', 'G'],
    ['G', 'GW'],
    ['GW', 'GWW'],
    ['H', 'K-1'],
    ['K-1', 'K-2'],
    ['K-2', 'H'],
    ['T', 'TA'],
    ['TA', 'T'],
    ['T', 'TD']
  ),
};

function chain(issueId: string): DependencyGraph {
  return graph(CHAIN_PARTS, { level: 'issue', issueId });
}

describe('one issue’s chain', () => {
  test('transitive through open issues, nearest first, upstream before downstream', () => {
    const g = chain('F');
    expect(g.nodes.map((n) => [n.id, n.distance])).toEqual([
      ['F', 0],
      ['CB', -1],
      ['U-1', -1],
      ['CW', 1],
      ['D-1', 1],
      ['U-2', -2],
      ['D-2', 2],
    ]);
    expect(g.chain).toEqual({
      focusId: 'F',
      upstream: 3,
      downstream: 3,
      hidden: 0,
    });
    expect(g.nodes.every((n) => !n.external)).toBe(true);
    expect(g.nodes.some((n) => n.hiddenNeighbours !== undefined)).toBe(false);
  });

  test('the induced edges: closed neighbours are resolved leaves', () => {
    const g = chain('F');
    expect(g.edges.map((e) => [e.from, e.to, e.resolved])).toEqual([
      ['F', 'CW', false],
      ['F', 'D-1', false],
      ['CB', 'F', true],
      ['U-1', 'F', false],
      ['D-1', 'D-2', false],
      ['U-2', 'U-1', false],
    ]);
    expect(g.cycles).toEqual([]);
  });

  test('a closed focus is one hop', () => {
    const g = chain('G');
    expect(g.nodes.map((n) => [n.id, n.distance])).toEqual([
      ['G', 0],
      ['GB', -1],
      ['GW', 1],
    ]);
    expect(g.chain).toEqual({
      focusId: 'G',
      upstream: 1,
      downstream: 1,
      hidden: 0,
    });
  });

  test('a loop through the focus is both upstream and downstream', () => {
    const g = chain('H');
    expect(g.nodes.map((n) => [n.id, n.distance, n.inCycle])).toEqual([
      ['H', 0, true],
      ['K-2', -1, true],
      ['K-1', 1, true],
    ]);
    expect(g.chain).toEqual({
      focusId: 'H',
      upstream: 2,
      downstream: 2,
      hidden: 0,
    });
    expect(g.cycles).toEqual([['H', 'K-1', 'K-2']]);
  });

  test('a node as far upstream as downstream counts as upstream', () => {
    // TA blocks T and waits on it: one hop either way, so -1, sorted with
    // the upstream issues before TD at +1.
    const g = chain('T');
    expect(g.nodes.map((n) => [n.id, n.distance, n.inCycle])).toEqual([
      ['T', 0, true],
      ['TA', -1, true],
      ['TD', 1, false],
    ]);
    expect(g.chain).toEqual({
      focusId: 'T',
      upstream: 1,
      downstream: 2,
      hidden: 0,
    });
    expect(g.cycles).toEqual([['T', 'TA']]);
  });

  test('a lone focus is still a node', () => {
    const g = chain('L');
    expect(g.nodes.map((n) => [n.id, n.distance])).toEqual([['L', 0]]);
    expect(g.edges).toEqual([]);
    expect(g.chain).toEqual({
      focusId: 'L',
      upstream: 0,
      downstream: 0,
      hidden: 0,
    });
  });

  test(`a long chain keeps the nearest ${CHAIN_MAX_NODES}`, () => {
    // L0 → L1 → … → L199, focus L100: 100 upstream, 99 downstream.
    const line = Array.from({ length: 200 }, (_, i) =>
      inM1(`L${i}`, { identifier: `L-${i}` })
    );
    const g = graph(
      {
        issues: line,
        relations: blocks(
          ...line
            .slice(1)
            .map((issue, i): [string, string] => [`L${i}`, issue.id])
        ),
      },
      { level: 'issue', issueId: 'L-100' }
    );
    expect(g.nodes).toHaveLength(150);
    expect(g.nodes[0]?.id).toBe('L100');
    expect(g.chain).toEqual({
      focusId: 'L100',
      upstream: 100,
      downstream: 99,
      hidden: 50,
    });
    const kept = new Set(g.nodes.map((n) => n.id));
    // 74 hops each way, then the 75th upstream one fills the cap.
    expect(['L25', 'L174'].every((id) => kept.has(id))).toBe(true);
    expect(['L24', 'L175'].some((id) => kept.has(id))).toBe(false);
    expect(
      g.nodes.flatMap((n) =>
        n.hiddenNeighbours === undefined ? [] : [[n.id, n.hiddenNeighbours]]
      )
    ).toEqual([
      ['L174', 1],
      ['L25', 1],
    ]);
    expect(g.edges).toHaveLength(149);
  });
});

function riskNode(overrides: Partial<GraphNode>): GraphNode {
  return { ...baseNode('n'), ...overrides };
}

describe('isRiskNode per kind', () => {
  test.each([
    [
      'an issue, unassigned',
      riskNode({ kind: 'issue', unassigned: true }),
      true,
    ],
    [
      'an issue waiting on an overdue one',
      riskNode({ kind: 'issue', waitsOnOverdue: true }),
      true,
    ],
    ['an issue, plain', riskNode({ kind: 'issue' }), false],
    [
      'a milestone holding unassigned work',
      riskNode({ unassigned: true }),
      true,
    ],
    ['a milestone, plain', riskNode({}), false],
    [
      'a project at risk',
      riskNode({ kind: 'project', status: 'at_risk' }),
      true,
    ],
    ['a project, overdue', riskNode({ kind: 'project', overdue: true }), true],
    [
      'a paused project at risk',
      riskNode({ kind: 'project', status: 'at_risk', active: false }),
      false,
    ],
    [
      'a project waiting on unassigned work',
      riskNode({ kind: 'project', unassigned: true, waitsOnUnassigned: true }),
      false,
    ],
    // A paused project's work is never loud (§2.8), as isOverdueNode says.
    [
      'an issue of a paused project, unassigned',
      riskNode({ kind: 'issue', unassigned: true, active: false }),
      false,
    ],
    [
      'a milestone of a paused project, overdue',
      riskNode({ overdue: true, active: false }),
      false,
    ],
    [
      'an initiative, overdue',
      riskNode({ kind: 'initiative', overdue: true }),
      true,
    ],
    [
      'an inactive initiative, overdue',
      riskNode({ kind: 'initiative', overdue: true, active: false }),
      false,
    ],
  ])('%s: %s', (_name, n, expected) => {
    expect(isRiskNode(n)).toBe(expected);
  });
});

describe('isOverdueNode per kind', () => {
  test.each([
    [
      'an issue in an overdue milestone',
      riskNode({ kind: 'issue', overdue: true }),
      true,
    ],
    [
      'an issue in an overdue milestone of a paused project',
      riskNode({ kind: 'issue', overdue: true, active: false }),
      false,
    ],
    [
      'an issue waiting on an overdue one',
      riskNode({ kind: 'issue', waitsOnOverdue: true }),
      false,
    ],
    ['a milestone, overdue', riskNode({ overdue: true }), true],
    [
      'a project whose status is overdue',
      riskNode({ kind: 'project', status: 'overdue' }),
      true,
    ],
    [
      'a project at risk',
      riskNode({ kind: 'project', status: 'at_risk' }),
      false,
    ],
    [
      'an inactive initiative, overdue',
      riskNode({ kind: 'initiative', overdue: true, active: false }),
      false,
    ],
  ])('%s: %s', (_name, n, expected) => {
    expect(isOverdueNode(n)).toBe(expected);
  });
});

describe('toMermaid overdue nodes', () => {
  // The risk highlight: the canvas floods an overdue node red (planner
  // nodeTone's danger); the export classes it red too, never amber risk.
  // What waits on it stays amber, and a cycle stays dashed red.
  test('overdue is red, what waits on it amber, a cycle dashed red', () => {
    const g: DependencyGraph = {
      scope: { level: 'issue', milestoneId: 'm1' },
      nodes: [
        {
          ...baseNode('late'),
          kind: 'issue',
          label: 'Late',
          sublabel: 'ENG-1 · Ana',
          overdue: true,
          unassigned: true,
        },
        {
          ...baseNode('wait'),
          kind: 'issue',
          label: 'Waits',
          sublabel: 'ENG-2 · Bo',
          waitsOnOverdue: true,
        },
        {
          ...baseNode('loop'),
          kind: 'issue',
          label: 'Loop',
          sublabel: 'ENG-3 · Cy',
          overdue: true,
          inCycle: true,
        },
      ],
      edges: [{ ...baseEdge('late', 'wait'), onRiskChain: true }],
      cycles: [],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    };
    expect(toMermaid(g, { highlight: 'risk' })).toBe(
      [
        'flowchart LR',
        '  n0["Late<br/>ENG-1 · Ana · Ready"]',
        '  n1["Waits<br/>ENG-2 · Bo · Ready"]',
        '  n2["Loop<br/>ENG-3 · Cy · Ready"]',
        '  n0 --> n1',
        '  classDef overdue stroke:#d92d20,stroke-width:2px',
        '  classDef risk stroke:#bd790a,stroke-width:2px',
        '  classDef cycle stroke:#d92d20,stroke-dasharray:5 3',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '  class n0,n2 overdue',
        '  class n1 risk',
        '  class n2 cycle',
        '  linkStyle 0 stroke:#bd790a',
        '',
      ].join('\n')
    );
  });

  // The canvas mutes a paused project's boxes (no status hue, §8.2), so
  // the export gives them neither the red overdue nor the amber risk.
  test('an inactive overdue milestone and an inactive unassigned issue get no status class', () => {
    const g: DependencyGraph = {
      scope: { level: 'milestone', projectId: 'p1' },
      nodes: [
        {
          ...baseNode('late'),
          label: 'Paused cutover',
          overdue: true,
          unassigned: true,
          active: false,
        },
        {
          ...baseNode('task'),
          kind: 'issue',
          label: 'Paused task',
          unassigned: true,
          waitsOnOverdue: true,
          active: false,
        },
      ],
      edges: [baseEdge('late', 'task')],
      cycles: [],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    };
    const text = toMermaid(g, { highlight: 'risk' });
    expect(text).not.toMatch(/^ {2}class .* (overdue|risk)$/m);
    // Status fades them instead (readinessClass's quiet).
    expect(toMermaid(g)).toContain('  class n0,n1 quiet\n');
    expect(g.nodes.map((n) => [isOverdueNode(n), isRiskNode(n)])).toEqual([
      [false, false],
      [false, false],
    ]);
  });
});

describe('toMermaid at every level', () => {
  test('project and initiative labels with weights; risk only on active, late aggregates', () => {
    const g: DependencyGraph = {
      scope: { level: 'project' },
      nodes: [
        {
          ...baseNode('pa'),
          kind: 'project',
          label: 'Atlas billing migration',
          sublabel: 'Chloe Diaz',
          status: 'at_risk',
        },
        {
          ...baseNode('pb'),
          kind: 'project',
          label: 'Fjord',
          sublabel: 'No lead',
          status: 'overdue',
          overdue: true,
          active: false,
        },
        {
          ...baseNode('ip'),
          kind: 'initiative',
          label: 'Platform reliability',
          sublabel: '5 projects',
          unassigned: true,
        },
      ],
      edges: [
        { ...baseEdge('pa', 'pb'), weight: 3, onRiskChain: true },
        { ...baseEdge('pb', 'ip'), weight: 2 },
      ],
      cycles: [],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: null,
    };
    expect(toMermaid(g, { highlight: 'risk' })).toBe(
      [
        'flowchart LR',
        '  n0["Atlas billing migration<br/>Chloe Diaz · Clear"]',
        '  n1["Fjord<br/>No lead · Clear"]',
        '  n2["Platform reliability<br/>5 projects · Clear"]',
        '  n0 -->|3| n1',
        '  n1 -->|2| n2',
        '  classDef overdue stroke:#d92d20,stroke-width:2px',
        '  classDef risk stroke:#bd790a,stroke-width:2px',
        '  classDef cycle stroke:#d92d20,stroke-dasharray:5 3',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '  class n0 risk',
        '  linkStyle 0 stroke:#bd790a',
        '',
      ].join('\n')
    );
  });

  test('a chain marks its focus in every highlight; a cut chain says how much is shown', () => {
    const cut: DependencyGraph = {
      scope: { level: 'issue', issueId: 'f' },
      nodes: [
        {
          ...baseNode('f'),
          kind: 'issue',
          label: 'Focus',
          sublabel: 'ENG-1 · Ana',
        },
        {
          ...baseNode('u'),
          kind: 'issue',
          label: 'Up',
          sublabel: 'ENG-2 · Bo',
        },
      ],
      edges: [baseEdge('u', 'f')],
      cycles: [],
      clusters: [],
      fallback: null,
      unplacedRelations: 0,
      chain: { focusId: 'f', upstream: 3, downstream: 0, hidden: 2 },
    };
    expect(toMermaid(cut)).toBe(
      [
        'flowchart LR',
        '  n0["Focus<br/>ENG-1 · Ana · Ready"]',
        '  n1["Up<br/>ENG-2 · Bo · Ready"]',
        '  n1 --> n0',
        '  %% Showing the nearest 2 of 4 issues on this chain',
        '  classDef ready stroke:#16853c',
        '  classDef blocked stroke:#bd790a,stroke-width:2px',
        '  classDef stuck stroke:#d92d20,stroke-width:2px,stroke-dasharray:5 3',
        '  classDef quiet opacity:0.6',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '  classDef focus stroke-width:3px',
        '  class n0,n1 ready',
        '  class n0 focus',
        '',
      ].join('\n')
    );
    const parts = mermaidParts(cut, {
      critical: { nodeIds: ['u', 'f'], edges: [{ from: 'u', to: 'f' }] },
    });
    expect(parts.body).toContain(
      '  %% Showing the nearest 2 of 4 issues on this chain\n'
    );
    for (const styles of Object.values(parts.styles)) {
      expect(styles).toContain('  classDef focus stroke-width:3px\n');
      expect(styles).toContain('  class n0 focus\n');
    }
    expect(parts.styles.critical).toBe(
      [
        '  %% Critical path: n1 → n0 (2 issues)',
        '  classDef critical stroke-width:3px',
        '  classDef external stroke-dasharray:3 3,opacity:0.7',
        '  classDef focus stroke-width:3px',
        '  class n0,n1 critical',
        '  class n0 focus',
        '  linkStyle 0 stroke-width:3px',
        '',
      ].join('\n')
    );
    const whole = toMermaid(chain('F'));
    expect(whole).not.toContain('%%');
    expect(whole).toContain('  classDef focus stroke-width:3px\n');
    expect(whole).toContain('  class n0 focus\n');
  });
});
