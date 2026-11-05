import type { GraphScope, Snapshot, WorkspaceData } from '@dispatch/planning';
import { NO_INITIATIVE_ID } from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import { DrillSizes, drillTargets, type GraphSize } from './graphDrill';
import {
  bigWorkspace,
  demoWorkspace,
  fixture,
  TODAY,
} from './graphFixture.test-helper';
import { GRAPH_DRAW_LIMITS, graphHref } from './graphScope';

// Drill down (owner request 2026-10-23): each box's and frame's drill-down
// graph one level down, with the panel's next link when that graph is
// empty or past the draw limits; and the drill-down sizes counted exactly
// as the planning core builds those graphs.

const demo = fixture();

/** Each drawn box's drill-down, by id (absent: none). */
function drills(model: {
  nodes: { id: string; drillHref?: string }[];
}): Record<string, string> {
  return Object.fromEntries(
    model.nodes.flatMap((n) =>
      n.drillHref === undefined ? [] : [[n.id, n.drillHref]]
    )
  );
}

describe('drill down: each box’s own graph, one level down', () => {
  test('an initiative opens its projects', () => {
    expect(drills(demo.page({ level: 'initiative' }))).toEqual({
      'init-platform': '#/graph?initiative=init-platform',
      'init-growth': '#/graph?initiative=init-growth',
      none: '#/graph?initiative=none',
    });
  });

  test('a project opens its milestones', () => {
    const model = demo.page({ level: 'project' });
    const all = drills(model);
    expect(all['proj-atlas']).toBe(
      '#/graph?project=proj-atlas&level=milestone'
    );
    expect(all['proj-garnet']).toBe(
      '#/graph?project=proj-garnet&level=milestone'
    );
    expect(Object.keys(all)).toHaveLength(model.nodes.length);
  });

  test('a milestone opens its issues; one with no issues its project’s milestones', () => {
    const all = drills(demo.page({ level: 'milestone' }));
    expect(all['ms-beacon-1']).toBe('#/graph?milestone=ms-beacon-1');
    expect(all['ms-atlas-2']).toBe('#/graph?milestone=ms-atlas-2');
    // Push notifications has no issue: its panel's next link, with it
    // selected there.
    expect(all['ms-garnet-1']).toBe(
      '#/graph?project=proj-garnet&level=milestone&node=ms-garnet-1'
    );
    // Inside Garnet's own milestone graph that fallback is the page itself:
    // nowhere to go.
    expect(
      drills(demo.page({ level: 'milestone', projectId: 'proj-garnet' }))[
        'ms-garnet-1'
      ]
    ).toBeUndefined();
  });

  test('an issue opens its blocking chain; one on no relation its milestone’s issues', () => {
    const model = demo.page({ level: 'issue' });
    const all = drills(model);
    expect(all['iss-23']).toBe('#/graph?chain=ENG-23');
    expect(all['iss-12']).toBe('#/graph?chain=ENG-12');
    // A done blocker still has a chain (its relation is drawn unblocked).
    expect(all['iss-2']).toBe('#/graph?chain=ENG-2');
    // ENG-11 waits on nothing and blocks nothing.
    expect(all['iss-11']).toBe('#/graph?milestone=ms-atlas-2');
    // An issue in no milestone, on no relation: nowhere to go.
    expect(all['iss-18']).toBeUndefined();
    expect(all['iss-80']).toBeUndefined();
    // Inside its milestone's own graph the fallback is the page itself.
    const own = drills(
      demo.page({ level: 'issue', milestoneId: 'ms-atlas-2' })
    );
    expect(own['iss-10']).toBe('#/graph?chain=ENG-10');
    expect(own['iss-11']).toBeUndefined();
  });

  test('in a chain, the focus opens its milestone’s issues, the rest their own chains', () => {
    const all = drills(demo.page({ level: 'issue', issueId: 'ENG-23' }));
    expect(all['iss-23']).toBe('#/graph?milestone=ms-beacon-1');
    expect(all['iss-12']).toBe('#/graph?chain=ENG-12');
    expect(all['iss-20']).toBe('#/graph?chain=OPS-20');
  });

  test('frame titles open what they stand for at the level drawn', () => {
    const issues = demo.page({ level: 'issue' });
    const frames = Object.fromEntries(
      issues.clusters.map((c) => [c.id, c.drillHref ?? null])
    );
    // A milestone frame: its issues.
    expect(frames['milestone:ms-beacon-1']).toBe(
      '#/graph?milestone=ms-beacon-1'
    );
    // A project frame around issues: the project's issues (the level kept).
    expect(frames['project:proj-atlas']).toBe('#/graph?project=proj-atlas');
    // "No milestone": its project's issues; "No project": nowhere.
    expect(frames['milestone:none:proj-atlas']).toBe(
      '#/graph?project=proj-atlas'
    );
    expect(frames['project:none']).toBeNull();
    // A project frame around milestones: its milestones.
    const milestones = demo.page({ level: 'milestone' });
    expect(
      milestones.clusters.find((c) => c.id === 'project:proj-beacon')?.drillHref
    ).toBe('#/graph?project=proj-beacon&level=milestone');
    // An initiative frame around projects: its projects.
    const projects = demo.page({ level: 'project' });
    expect(
      projects.clusters.find((c) => c.id === 'initiative:init-growth')
        ?.drillHref
    ).toBe('#/graph?initiative=init-growth');
    // The page's own frame opens what its panel's next link opens.
    const growth = demo.page({ level: 'project', initiativeId: 'init-growth' });
    expect(growth.clusters.map((c) => [c.id, c.drillHref])).toEqual([
      [
        'initiative:init-growth',
        '#/graph?initiative=init-growth&level=milestone',
      ],
      ['initiative:init-platform', '#/graph?initiative=init-platform'],
    ]);
  });

  test('nothing is drawn, nothing drills', () => {
    const model = demo.page({ level: 'issue', milestoneId: 'ms-garnet-1' });
    expect(model.nodes).toEqual([]);
    expect(model.clusters).toEqual([]);
  });

  test('the links are written by the href the view passes', () => {
    const graph = demo.graphOf({ level: 'milestone' });
    const { nodes, clusters } = drillTargets({
      snapshot: demo.snapshot,
      nodes: graph.nodes,
      clusters: graph.clusters,
      level: 'milestone',
      pageHref: 'route:',
      graph: (scope, options) =>
        `route:${JSON.stringify(scope)}${options?.node === undefined ? '' : `@${options.node}`}`,
    });
    expect(nodes.get('ms-beacon-1')).toBe(
      'route:{"level":"issue","milestoneId":"ms-beacon-1"}'
    );
    expect(nodes.get('ms-garnet-1')).toBe(
      'route:{"level":"milestone","projectId":"proj-garnet"}@ms-garnet-1'
    );
    expect(clusters.get('project:proj-atlas')).toBe(
      'route:{"level":"milestone","projectId":"proj-atlas"}'
    );
  });
});

describe('drill down past the draw limits', () => {
  /** The demo with `extra` more open issues in Dual-write (ms-atlas-2). */
  function crowded(extra: number) {
    const data = demoWorkspace();
    const model = data.issues.find((issue) => issue.id === 'iss-13');
    if (model === undefined) throw new Error('iss-13');
    for (let i = 0; i < extra; i++) {
      data.issues.push({
        ...model,
        id: `iss-extra-${i}`,
        identifier: `XTR-${i}`,
        title: `Extra ${i}`,
      });
    }
    return fixture(data);
  }

  test('a milestone too big to draw opens its project’s milestones instead', () => {
    const big = crowded(GRAPH_DRAW_LIMITS.nodes);
    const all = drills(big.page({ level: 'milestone' }));
    expect(all['ms-atlas-2']).toBe(
      '#/graph?project=proj-atlas&level=milestone&node=ms-atlas-2'
    );
    expect(all['ms-atlas-1']).toBe('#/graph?milestone=ms-atlas-1');
  });

  test('with no other way that draws, the too-large page itself (it lists narrower graphs)', () => {
    const big = crowded(GRAPH_DRAW_LIMITS.nodes);
    // In Atlas's own milestone graph the fallback would be this page.
    const all = drills(
      big.page({ level: 'milestone', projectId: 'proj-atlas' })
    );
    expect(all['ms-atlas-2']).toBe('#/graph?milestone=ms-atlas-2');
  });
});

/** Every graph a drill-down can open in `snapshot`, with its scope. */
function drillScopes(snapshot: Snapshot): GraphScope[] {
  const scopes: GraphScope[] = [];
  for (const id of snapshot.milestones.keys()) {
    scopes.push({ level: 'issue', milestoneId: id });
  }
  for (const id of snapshot.projects.keys()) {
    scopes.push({ level: 'issue', projectId: id });
    scopes.push({ level: 'milestone', projectId: id });
  }
  for (const id of [...snapshot.initiatives.keys(), NO_INITIATIVE_ID]) {
    for (const level of ['issue', 'milestone', 'project'] as const) {
      scopes.push({ level, initiativeId: id });
    }
  }
  return scopes;
}

describe('drill-down sizes count what the core draws', () => {
  for (const [name, data] of [
    ['the demo', demoWorkspace()],
    ['the big workspace', bigWorkspace()],
  ] as [string, WorkspaceData][]) {
    test(`${name}: every container's boxes and arrows, and every chain`, () => {
      const { snapshot, graphOf } = fixture(data);
      const sizes = new DrillSizes(snapshot);
      const wrong: string[] = [];
      for (const scope of drillScopes(snapshot)) {
        const graph = graphOf(scope);
        const want: GraphSize = {
          nodes: graph.nodes.length,
          edges: graph.edges.length,
        };
        const got = sizes.sizeOf(scope);
        if (got?.nodes !== want.nodes || got.edges !== want.edges) {
          wrong.push(
            `${JSON.stringify(scope)}: ${JSON.stringify(got)} ≠ ${JSON.stringify(want)}`
          );
        }
      }
      for (const issue of snapshot.issues.values()) {
        const draws =
          graphOf({ level: 'issue', issueId: issue.id }).edges.length > 0;
        if (sizes.hasChain(issue.id) !== draws) {
          wrong.push(`chain ${issue.identifier}: ${!draws}`);
        }
      }
      expect(wrong).toEqual([]);
    });
  }

  test('the workspace and a chain have no size; an unknown container is empty', () => {
    const sizes = new DrillSizes(demo.snapshot);
    expect(sizes.sizeOf({ level: 'issue' })).toBeNull();
    expect(sizes.sizeOf({ level: 'issue', issueId: 'ENG-23' })).toBeNull();
    expect(sizes.sizeOf({ level: 'issue', milestoneId: 'nope' })).toEqual({
      nodes: 0,
      edges: 0,
    });
    // Dual-write: its 4 issues plus the 2 outside ends, 2 relations.
    expect(sizes.sizeOf({ level: 'issue', milestoneId: 'ms-atlas-2' })).toEqual(
      { nodes: 6, edges: 2 }
    );
    // Atlas's milestones: 3 plus Beacon's, joined by 2 distinct pairs.
    expect(
      sizes.sizeOf({ level: 'milestone', projectId: 'proj-atlas' })
    ).toEqual({ nodes: 4, edges: 2 });
    expect(sizes.hasChain('iss-11')).toBe(false);
    expect(sizes.hasChain('iss-2')).toBe(true);
  });

  test('drillTargets never offers the page itself', () => {
    const { snapshot, graphOf } = fixture(bigWorkspace());
    for (const scope of [
      { level: 'milestone' } as GraphScope,
      { level: 'project' } as GraphScope,
      { level: 'initiative' } as GraphScope,
    ]) {
      const graph = graphOf(scope);
      const page = graphHref(scope);
      const { nodes, clusters } = drillTargets({
        snapshot,
        nodes: graph.nodes,
        clusters: graph.clusters,
        level: scope.level,
        pageHref: page,
        graph: graphHref,
      });
      expect([...nodes.values(), ...clusters.values()]).not.toContain(page);
      expect(nodes.size).toBeGreaterThan(0);
    }
    expect(TODAY).toBe('2026-10-21');
  });
});
