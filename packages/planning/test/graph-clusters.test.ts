// Every item, framed by parent (owner decision 2026-10-23, "the graph shows
// every issue, not only blocking ones"; architecture §2.10 "Clusters"):
// each level draws every item of its container, and the nodes come with
// the labelled clusters the ui frames them in. Also the Mermaid subgraphs
// those clusters become.

import { describe, expect, test } from 'bun:test';

import { mermaidParts, NO_INITIATIVE_ID } from '../src/index';
import type { DependencyGraph, GraphCluster, GraphScope } from '../src/index';
import {
  at,
  blocks,
  graph,
  type GraphParts,
  inM1,
  M1,
  node,
} from './graph-fixtures';
import { day, initiative, milestone, project, STATE } from './helpers';

// Two initiatives, four projects (Pause paused, Lone in no initiative),
// milestones with and without issues, an issue with no milestone and one
// with no project, a done issue, a canceled one and a duplicate.
const TREE: GraphParts = {
  initiatives: [
    initiative('iA', { name: 'Apex', priority: 1 }),
    initiative('iB', { name: 'Beam', priority: 2 }),
  ],
  projects: [
    project('pA', { name: 'Apollo', initiativeIds: ['iA'], sortOrder: 1 }),
    project('pB', { name: 'Bolt', initiativeIds: ['iB'], sortOrder: 2 }),
    project('pP', {
      name: 'Pause',
      statusType: 'paused',
      initiativeIds: ['iA'],
      sortOrder: 3,
    }),
    project('pL', { name: 'Lone', sortOrder: 4 }),
  ],
  milestones: [
    milestone('mA1', 'pA', { name: 'A1 "beta"', targetDate: day(10) }),
    milestone('mA2', 'pA', { name: 'A2', targetDate: day(20) }),
    milestone('mB1', 'pB', { name: 'B1', targetDate: day(15) }),
    milestone('mP1', 'pP', { name: 'P1', targetDate: day(30) }),
    milestone('mL1', 'pL', { name: 'L1', targetDate: day(40) }),
    milestone('mE', 'pA', { name: 'Empty', targetDate: day(50) }),
  ],
  issues: [
    at('a1', 'mA1', 'pA'),
    at('a2', 'mA1', 'pA'),
    at('a3', 'mA2', 'pA', { stateId: STATE.done }),
    inM1('a4', { projectId: 'pA', milestoneId: null }),
    at('a5', 'mA1', 'pA', { stateId: STATE.canceled }),
    at('a6', 'mA2', 'pA', { stateId: STATE.duplicate }),
    at('b1', 'mB1', 'pB'),
    at('b2', 'mB1', 'pB'),
    at('p1', 'mP1', 'pP'),
    at('l1', 'mL1', 'pL'),
    inM1('o1', { projectId: null, milestoneId: null }),
  ],
  relations: blocks(
    ['a1', 'b1'], // across projects and initiatives
    ['a5', 'a2'], // a canceled blocker: never drawn
    ['p1', 'a4']
  ),
};

// A cluster reduced to "id < parent" plus its flags, for compact goldens.
function shape(clusters: readonly GraphCluster[]): string[] {
  return clusters.map(
    (c) =>
      `${c.id}${c.parentId === null ? '' : ` < ${c.parentId}`}${c.active ? '' : ' (inactive)'}${c.external ? ' (external)' : ''}`
  );
}

// Node id → its innermost cluster, in node order.
function homes(g: DependencyGraph): [string, string | null][] {
  return g.nodes.map((n) => [n.id, n.clusterId]);
}

describe('every item is drawn', () => {
  test('the workspace issue level: every issue but canceled and duplicate ones', () => {
    const g = graph(TREE, { level: 'issue' });
    expect(g.nodes.map((n) => n.id)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'b1',
      'b2',
      'l1',
      'o1',
      'p1',
    ]);
    // The done a3 is drawn (muted by the host); a5 and a6 never are, nor is
    // the canceled a5's relation, so a2 has no dependencies.
    expect(node(g, 'a3').readiness).toBe('done');
    expect(g.edges.map((e) => `${e.from}>${e.to}`)).toEqual(['a1>b1', 'p1>a4']);
    expect(node(g, 'a2').readiness).toBe('independent');
    expect(node(g, 'b2').readiness).toBe('independent');
    expect(node(g, 'a1').readiness).toBe('ready');
    expect(node(g, 'b1').readiness).toBe('blocked');
  });

  test('aggregate levels draw every unit, with no open work too', () => {
    const milestones = graph(TREE, { level: 'milestone' });
    expect(milestones.nodes.map((n) => n.id).sort()).toEqual([
      'mA1',
      'mA2',
      'mB1',
      'mE',
      'mL1',
      'mP1',
    ]);
    // mA2 holds only the done a3 and the duplicate a6: done. mE holds
    // nothing: empty ("No issues yet"), never "Complete".
    expect(node(milestones, 'mA2').readiness).toBe('done');
    expect(node(milestones, 'mE')).toMatchObject({
      readiness: 'empty',
      openIssues: 0,
      status: 'empty',
    });
    const projects = graph(TREE, { level: 'project' });
    expect(projects.nodes.map((n) => n.id)).toEqual(['pA', 'pP', 'pB', 'pL']);
    const initiatives = graph(TREE, { level: 'initiative' });
    expect(initiatives.nodes.map((n) => n.id)).toEqual([
      'iA',
      'iB',
      NO_INITIATIVE_ID,
    ]);
  });

  test('an initiative with no project of its own is still drawn', () => {
    const parts: GraphParts = {
      ...TREE,
      initiatives: [
        ...(TREE.initiatives ?? []),
        initiative('iC', { name: 'Cold', priority: 3 }),
      ],
    };
    const g = graph(parts, { level: 'initiative' });
    expect(g.nodes.map((n) => [n.id, n.sublabel, n.readiness])).toEqual([
      ['iA', '2 projects', 'ready'],
      ['iB', '1 project', 'blocked'],
      // No issue counts toward Cold: empty, not done.
      ['iC', '0 projects', 'empty'],
      [NO_INITIATIVE_ID, '1 project', 'independent'],
    ]);
  });
});

describe('clusters', () => {
  test('issue level across projects: milestones nested in projects, "No …" last', () => {
    const g = graph(TREE, { level: 'issue' });
    expect(shape(g.clusters)).toEqual([
      'project:pA',
      'milestone:mA1 < project:pA',
      'milestone:mA2 < project:pA',
      'milestone:none:pA < project:pA',
      'project:pP (inactive)',
      'milestone:mP1 < project:pP (inactive)',
      'project:pB',
      'milestone:mB1 < project:pB',
      'project:pL',
      'milestone:mL1 < project:pL',
      'project:none',
    ]);
    expect(homes(g)).toEqual([
      ['a1', 'milestone:mA1'],
      ['a2', 'milestone:mA1'],
      ['a3', 'milestone:mA2'],
      ['a4', 'milestone:none:pA'],
      ['b1', 'milestone:mB1'],
      ['b2', 'milestone:mB1'],
      ['l1', 'milestone:mL1'],
      ['o1', 'project:none'],
      ['p1', 'milestone:mP1'],
    ]);
    const byId = new Map(g.clusters.map((c) => [c.id, c]));
    expect(byId.get('milestone:mA1')).toEqual({
      id: 'milestone:mA1',
      kind: 'milestone',
      refId: 'mA1',
      label: 'A1 "beta"',
      parentId: 'project:pA',
      projectId: 'pA',
      active: true,
      external: false,
    });
    expect(byId.get('milestone:none:pA')).toMatchObject({
      kind: 'milestone',
      refId: null,
      label: 'No milestone',
      projectId: 'pA',
    });
    expect(byId.get('project:none')).toMatchObject({
      kind: 'project',
      refId: null,
      label: 'No project',
      parentId: null,
      projectId: null,
      active: true,
    });
    // An empty milestone (mE) has no drawn issue, so no frame.
    expect(byId.has('milestone:mE')).toBe(false);
  });

  test('one project: milestone clusters only, no project frame', () => {
    const g = graph(TREE, { level: 'issue', projectId: 'pB' });
    // b1 waits on a1 (Apollo), an external, so the drawing spans two
    // projects and nests; Bolt's own frames come first.
    expect(shape(g.clusters)).toEqual([
      'project:pB',
      'milestone:mB1 < project:pB',
      'project:pA (external)',
      'milestone:mA1 < project:pA (external)',
    ]);
    const alone = graph(TREE, { level: 'issue', milestoneId: 'mL1' });
    expect(shape(alone.clusters)).toEqual(['milestone:mL1']);
    expect(homes(alone)).toEqual([['l1', 'milestone:mL1']]);
  });

  test('a milestone container with externals: in-container frames first', () => {
    const g = graph(TREE, M1Of('mA1'));
    expect(g.nodes.map((n) => [n.id, n.external])).toEqual([
      ['a1', false],
      ['a2', false],
      ['b1', true],
    ]);
    expect(shape(g.clusters)).toEqual([
      'project:pA',
      'milestone:mA1 < project:pA',
      'project:pB (external)',
      'milestone:mB1 < project:pB (external)',
    ]);
  });

  test('milestone level: one cluster per project, paused ones inactive', () => {
    const g = graph(TREE, { level: 'milestone' });
    expect(shape(g.clusters)).toEqual([
      'project:pA',
      'project:pP (inactive)',
      'project:pB',
      'project:pL',
    ]);
    expect(node(g, 'mE').clusterId).toBe('project:pA');
    expect(node(g, 'mP1').clusterId).toBe('project:pP');
  });

  test('project level: one cluster per first initiative, "No initiative" last', () => {
    const g = graph(TREE, { level: 'project' });
    expect(shape(g.clusters)).toEqual([
      'initiative:iA',
      'initiative:iB',
      `initiative:${NO_INITIATIVE_ID}`,
    ]);
    expect(homes(g)).toEqual([
      ['pA', 'initiative:iA'],
      ['pP', 'initiative:iA'],
      ['pB', 'initiative:iB'],
      ['pL', `initiative:${NO_INITIATIVE_ID}`],
    ]);
    expect(g.clusters.at(-1)).toMatchObject({
      refId: NO_INITIATIVE_ID,
      label: 'No initiative',
    });
  });

  test('a mirror without initiatives frames no project', () => {
    const g = graph({ ...TREE, initiatives: [] }, { level: 'project' });
    expect(g.nodes).toHaveLength(4);
    expect(g.clusters).toEqual([]);
    expect(g.nodes.every((n) => n.clusterId === null)).toBe(true);
  });

  test('the initiative level and a chain have no clusters', () => {
    for (const scope of [
      { level: 'initiative' },
      { level: 'issue', issueId: 'a1' },
    ] as GraphScope[]) {
      const g = graph(TREE, scope);
      expect(g.nodes.length).toBeGreaterThan(0);
      expect(g.clusters).toEqual([]);
      expect(g.nodes.every((n) => n.clusterId === null)).toBe(true);
    }
  });

  test('every node sits in a known cluster; parents come before children', () => {
    for (const scope of [
      { level: 'issue' },
      { level: 'issue', initiativeId: 'iA' },
      { level: 'issue', projectId: 'pA' },
      { level: 'milestone' },
      { level: 'milestone', initiativeId: 'iA' },
      { level: 'project' },
    ] as GraphScope[]) {
      const g = graph(TREE, scope);
      const seen = new Set<string>();
      for (const cluster of g.clusters) {
        expect(seen.has(cluster.id)).toBe(false);
        if (cluster.parentId !== null) {
          expect(seen.has(cluster.parentId)).toBe(true);
        }
        seen.add(cluster.id);
      }
      for (const n of g.nodes) {
        expect(n.clusterId === null ? false : seen.has(n.clusterId)).toBe(true);
      }
      // No empty frame: each cluster holds a node, itself or below.
      const filled = new Set<string>();
      for (const n of g.nodes) {
        let id: string | null = n.clusterId;
        while (id !== null) {
          filled.add(id);
          id = g.clusters.find((c) => c.id === id)?.parentId ?? null;
        }
      }
      expect([...seen].every((id) => filled.has(id))).toBe(true);
    }
  });

  test('the same mirror gives the same graph, whatever the input order', () => {
    const shuffled: GraphParts = {
      ...TREE,
      projects: [...(TREE.projects ?? [])].reverse(),
      milestones: [...(TREE.milestones ?? [])].reverse(),
      issues: [...TREE.issues].reverse(),
      relations: [...TREE.relations].reverse(),
    };
    for (const scope of [
      { level: 'issue' },
      { level: 'milestone' },
      { level: 'project' },
    ] as GraphScope[]) {
      const once = graph(TREE, scope);
      expect(graph(TREE, scope)).toEqual(once);
      const other = graph(shuffled, scope);
      expect(other.nodes.map((n) => [n.id, n.clusterId])).toEqual(
        once.nodes.map((n) => [n.id, n.clusterId])
      );
      expect(other.clusters).toEqual(once.clusters);
      expect(other.edges.map((e) => [e.from, e.to])).toEqual(
        once.edges.map((e) => [e.from, e.to])
      );
    }
  });
});

describe('Mermaid subgraphs', () => {
  test('nodes sit in nested subgraphs with positional ids; edges follow', () => {
    const { body } = mermaidParts(graph(TREE, { level: 'issue' }));
    expect(body).toBe(
      [
        'flowchart LR',
        '  subgraph c0["Apollo"]',
        '    subgraph c1["A1 #34;beta#34;"]',
        '      n0["Issue a1<br/>a1 · Ana · Ready"]',
        '      n1["Issue a2<br/>a2 · Ana"]',
        '    end',
        '    subgraph c2["A2"]',
        '      n2["Issue a3<br/>a3 · Ana"]',
        '    end',
        '    subgraph c3["No milestone"]',
        '      n3["Issue a4<br/>a4 · Ana · Blocked by 1"]',
        '    end',
        '  end',
        '  subgraph c4["Pause"]',
        '    subgraph c5["P1"]',
        '      n8["Issue p1<br/>p1 · Ana · Ready"]',
        '    end',
        '  end',
        '  subgraph c6["Bolt"]',
        '    subgraph c7["B1"]',
        '      n4["Issue b1<br/>b1 · Ana · Blocked by 1"]',
        '      n5["Issue b2<br/>b2 · Ana"]',
        '    end',
        '  end',
        '  subgraph c8["Lone"]',
        '    subgraph c9["L1"]',
        '      n6["Issue l1<br/>l1 · Ana"]',
        '    end',
        '  end',
        '  subgraph c10["No project"]',
        '    n7["Issue o1<br/>o1 · Ana"]',
        '  end',
        '  n0 --> n4',
        '  n8 --> n3',
        '',
      ].join('\n')
    );
  });

  test('a host passing fewer nodes drops the empty subgraphs; loose nodes lead', () => {
    const g = graph(TREE, { level: 'issue' });
    const kept = g.nodes.filter((n) => n.id === 'b1' || n.id === 'a1');
    const loose = { ...node(g, 'a2'), clusterId: 'cluster:unknown' };
    const { body } = mermaidParts({ ...g, nodes: [loose, ...kept] });
    expect(body).toBe(
      [
        'flowchart LR',
        '  n0["Issue a2<br/>a2 · Ana"]',
        '  subgraph c0["Apollo"]',
        '    subgraph c1["A1 #34;beta#34;"]',
        '      n1["Issue a1<br/>a1 · Ana · Ready"]',
        '    end',
        '  end',
        '  subgraph c6["Bolt"]',
        '    subgraph c7["B1"]',
        '      n2["Issue b1<br/>b1 · Ana · Blocked by 1"]',
        '    end',
        '  end',
        '  n1 --> n2',
        '',
      ].join('\n')
    );
  });

  test('an independent node carries no word and no status class', () => {
    const g = graph(
      {
        issues: [inM1('A'), inM1('B'), inM1('C')],
        relations: blocks(['A', 'B']),
      },
      M1
    );
    const { body, styles } = mermaidParts(g);
    // One milestone, one project: a single frame, nodes one level in.
    expect(body).toContain('    n2["Issue C<br/>C · Ana"]\n');
    expect(body).toContain('n0["Issue A<br/>A · Ana · Ready"]');
    expect(styles.status).toContain('  class n0 ready\n');
    expect(styles.status).toContain('  class n1 blocked\n');
    expect(styles.status).not.toMatch(/n2/);
  });

  test('cluster labels are escaped and the export is stable', () => {
    const g = graph(TREE, { level: 'milestone' });
    const once = mermaidParts(g);
    expect(mermaidParts(graph(TREE, { level: 'milestone' }))).toEqual(once);
    expect(once.body).toContain('  subgraph c0["Apollo"]\n');
    expect(once.body).toContain('    n0["A1 #34;beta#34;<br/>Apollo · ');
  });
});

// The issue level of one milestone of TREE.
function M1Of(milestoneId: string): GraphScope {
  return { level: 'issue', milestoneId };
}
