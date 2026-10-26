import type { GraphScope } from '@dispatch/planning';
import { indexWorkspace } from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import { demoWorkspace } from './graphFixture.test-helper';
import {
  chainHref,
  DEFAULT_GRAPH_HIGHLIGHT,
  GRAPH_DRAW_LIMITS,
  GRAPH_HIGHLIGHT_LABEL,
  GRAPH_HIGHLIGHTS,
  GRAPH_LEVEL_LABEL,
  GRAPH_PATH,
  graphHref,
  type GraphScopeHref,
  graphTrail,
  initiativeName,
  levelTabs,
  MAX_ID_LENGTH,
  NARROW_MAX_ROWS,
  parseGraphParams,
  parseGraphScope,
  parseHighlight,
  serialiseGraphScope,
} from './graphScope';

// The graph's scope vocabulary: writing a scope as a link and reading it
// back (the view parses the in-memory descriptors until Phase 6's route),
// the drill-up trail, the level tabs and the highlight words. The trail
// reads the demo workspace, with and without initiatives.

/** "a=1&b=2" as a router would hand parameters to the view. */
function query(search: string): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {};
  for (const [key, value] of new URLSearchParams(search)) {
    const seen = params[key];
    if (seen === undefined) params[key] = value;
    else params[key] = [...(Array.isArray(seen) ? seen : [seen]), value];
  }
  return params;
}

describe('serialiseGraphScope ↔ parseGraphScope', () => {
  const urls: [string, GraphScope, string | null][] = [
    ['#/graph', { level: 'milestone' }, null],
    ['#/graph?level=initiative', { level: 'initiative' }, null],
    ['#/graph?level=project', { level: 'project' }, null],
    ['#/graph?level=issue', { level: 'issue' }, null],
    [
      '#/graph?initiative=init-growth',
      { level: 'project', initiativeId: 'init-growth' },
      null,
    ],
    [
      '#/graph?initiative=init-growth&level=milestone',
      { level: 'milestone', initiativeId: 'init-growth' },
      null,
    ],
    [
      '#/graph?initiative=init-growth&level=issue',
      { level: 'issue', initiativeId: 'init-growth' },
      null,
    ],
    [
      '#/graph?initiative=none',
      { level: 'project', initiativeId: 'none' },
      null,
    ],
    [
      '#/graph?project=proj-atlas',
      { level: 'issue', projectId: 'proj-atlas' },
      null,
    ],
    [
      '#/graph?project=proj-atlas&level=milestone',
      { level: 'milestone', projectId: 'proj-atlas' },
      null,
    ],
    [
      '#/graph?milestone=ms-atlas-2',
      { level: 'issue', milestoneId: 'ms-atlas-2' },
      null,
    ],
    ['#/graph?chain=ENG-24', { level: 'issue', issueId: 'ENG-24' }, null],
    ['#/graph?node=ms-atlas-2', { level: 'milestone' }, 'ms-atlas-2'],
    [
      '#/graph?project=proj-atlas&level=milestone&node=ms-atlas-2',
      { level: 'milestone', projectId: 'proj-atlas' },
      'ms-atlas-2',
    ],
  ];

  test.each(urls)('%s', (href, scope, nodeId) => {
    expect(graphHref(scope, { node: nodeId })).toBe(href);
    expect(parseGraphScope(href)).toEqual({ scope, nodeId });
    // The query alone, as a router hands it over, reads the same.
    const at = href.indexOf('?');
    const search = at === -1 ? '' : href.slice(at + 1);
    expect(serialiseGraphScope(scope, { node: nodeId })).toBe(search);
    expect(parseGraphScope(search)).toEqual({ scope, nodeId });
    expect(parseGraphParams(query(search))).toEqual({ scope, nodeId });
  });

  test('the path is GRAPH_PATH; a chain link is written with the identifier', () => {
    expect(GRAPH_PATH).toBe('#/graph');
    expect(chainHref('ENG-24')).toBe('#/graph?chain=ENG-24');
    expect(chainHref('a b')).toBe('#/graph?chain=a%20b');
    const graph: GraphScopeHref = graphHref;
    expect(graph({ level: 'issue', issueId: 'ENG-24' })).toBe(
      chainHref('ENG-24')
    );
  });

  test('hrefs encode ids, and the reader decodes them', () => {
    expect(graphHref({ level: 'issue', milestoneId: 'a b&c' })).toBe(
      '#/graph?milestone=a%20b%26c'
    );
    expect(
      graphHref({ level: 'milestone', initiativeId: 'i/1' }, { node: 'm&1' })
    ).toBe('#/graph?initiative=i%2F1&level=milestone&node=m%261');
    expect(parseGraphScope('#/graph?milestone=a%20b%26c')).toEqual({
      scope: { level: 'issue', milestoneId: 'a b&c' },
      nodeId: null,
    });
    // A link with another path before the "?" still reads its query; a
    // bare path reads as the default scope.
    expect(parseGraphScope('/graph?chain=ENG-1').scope).toEqual({
      level: 'issue',
      issueId: 'ENG-1',
    });
    expect(parseGraphScope('#/graph').scope).toEqual({ level: 'milestone' });
    expect(parseGraphScope('').scope).toEqual({ level: 'milestone' });
  });
});

describe('parseGraphParams', () => {
  test('the narrowest container wins: chain > milestone > project > initiative', () => {
    const all = {
      chain: 'ENG-1',
      milestone: 'm',
      project: 'p',
      initiative: 'i',
    };
    expect(parseGraphParams(all).scope).toEqual({
      level: 'issue',
      issueId: 'ENG-1',
    });
    expect(parseGraphParams({ ...all, chain: undefined }).scope).toEqual({
      level: 'issue',
      milestoneId: 'm',
    });
    expect(
      parseGraphParams({ project: 'p', initiative: 'i', level: 'milestone' })
        .scope
    ).toEqual({ level: 'milestone', projectId: 'p' });
    expect(parseGraphParams({ initiative: 'i', level: 'issue' }).scope).toEqual(
      { level: 'issue', initiativeId: 'i' }
    );
  });

  test('levels: any case, plurals, and the default when not offered', () => {
    const scope = (params: Record<string, string | string[] | undefined>) =>
      parseGraphParams(params).scope;
    expect(scope({ level: 'Initiatives' })).toEqual({ level: 'initiative' });
    expect(scope({ level: 'ISSUES', project: 'p' })).toEqual({
      level: 'issue',
      projectId: 'p',
    });
    // Unknown, or not offered by the container: its default level.
    expect(scope({ level: 'teams' })).toEqual({ level: 'milestone' });
    // Object.prototype's names are no levels either.
    for (const level of ['constructors', '__proto__', 'toStrings']) {
      expect(scope({ level, project: 'p' })).toEqual({
        level: 'issue',
        projectId: 'p',
      });
    }
    expect(scope({ level: 'initiative', initiative: 'i' })).toEqual({
      level: 'project',
      initiativeId: 'i',
    });
    expect(scope({ level: 'project', project: 'p' })).toEqual({
      level: 'issue',
      projectId: 'p',
    });
    expect(scope({ level: 'milestone', milestone: 'm' })).toEqual({
      level: 'issue',
      milestoneId: 'm',
    });
    expect(scope({ level: 'project', chain: 'ENG-1' })).toEqual({
      level: 'issue',
      issueId: 'ENG-1',
    });
  });

  test('first value of a list, trimmed; blank or oversized values are ignored', () => {
    expect(MAX_ID_LENGTH).toBe(200);
    expect(
      parseGraphParams({ milestone: ' ms-1 ', project: 'p-1' }).scope
    ).toEqual({ level: 'issue', milestoneId: 'ms-1' });
    expect(parseGraphParams({ project: ['p-1', 'p-2'] }).scope).toEqual({
      level: 'issue',
      projectId: 'p-1',
    });
    expect(
      parseGraphParams({ chain: '  ', initiative: 'x'.repeat(201) }).scope
    ).toEqual({ level: 'milestone' });
    expect(parseGraphParams({ node: ' ' }).nodeId).toBeNull();
    expect(parseGraphParams({ node: 'x'.repeat(201) }).nodeId).toBeNull();
    expect(parseGraphParams({ node: [' ms-1 ', 'ms-2'] }).nodeId).toBe('ms-1');
    // A repeated parameter in a link keeps its first value too.
    expect(parseGraphScope('#/graph?project=p-1&project=p-2').scope).toEqual({
      level: 'issue',
      projectId: 'p-1',
    });
  });

  test('the draw limits are 700 boxes and 1,000 arrows; 50 narrow rows', () => {
    expect(GRAPH_DRAW_LIMITS).toEqual({ nodes: 700, edges: 1000 });
    expect(NARROW_MAX_ROWS).toBe(50);
    expect(GRAPH_LEVEL_LABEL).toEqual({
      initiative: 'Initiatives',
      project: 'Projects',
      milestone: 'Milestones',
      issue: 'Issues',
    });
  });
});

describe('graphTrail', () => {
  const member = indexWorkspace(demoWorkspace());
  const trail = (scope: GraphScope, snapshot = member) =>
    graphTrail(snapshot, scope, graphHref);

  test('the workspace levels have no trail', () => {
    for (const level of [
      'initiative',
      'project',
      'milestone',
      'issue',
    ] as const) {
      expect(trail({ level })).toEqual([]);
    }
  });

  test('an initiative, and the projects with none', () => {
    expect(
      trail({ level: 'milestone', initiativeId: 'init-platform' })
    ).toEqual([
      { label: 'Workspace', href: '#/graph?level=initiative' },
      { label: 'Platform reliability' },
    ]);
    expect(trail({ level: 'project', initiativeId: 'none' })).toEqual([
      { label: 'Workspace', href: '#/graph?level=initiative' },
      { label: 'No initiative' },
    ]);
    expect(initiativeName(member, 'none')).toBe('No initiative');
    expect(initiativeName(member, 'init-growth')).toBe('Customer growth');
    expect(initiativeName(member, 'nope')).toBe('Unknown initiative');
  });

  test('a project and a milestone link up at their natural levels', () => {
    expect(trail({ level: 'issue', projectId: 'proj-garnet' })).toEqual([
      { label: 'Workspace', href: '#/graph?level=initiative' },
      { label: 'No initiative', href: '#/graph?initiative=none' },
      { label: 'Garnet mobile app' },
    ]);
    expect(trail({ level: 'issue', milestoneId: 'ms-juniper-1' })).toEqual([
      { label: 'Workspace', href: '#/graph?level=initiative' },
      // Juniper is in both initiatives: its first one, as on the timeline.
      {
        label: 'Platform reliability',
        href: '#/graph?initiative=init-platform',
      },
      {
        label: 'Juniper design system',
        href: '#/graph?project=proj-juniper&level=milestone',
      },
      { label: 'Tokens and type' },
    ]);
  });

  test('a chain skips the levels its issue lacks', () => {
    // ENG-18: Atlas, no milestone.
    expect(trail({ level: 'issue', issueId: 'iss-18' })).toEqual([
      { label: 'Workspace', href: '#/graph?level=initiative' },
      {
        label: 'Platform reliability',
        href: '#/graph?initiative=init-platform',
      },
      {
        label: 'Atlas billing migration',
        href: '#/graph?project=proj-atlas&level=milestone',
      },
      { label: 'ENG-18' },
    ]);
    // ENG-80: no project at all; the identifier may be in any case.
    expect(trail({ level: 'issue', issueId: 'eng-80' })).toEqual([
      { label: 'Workspace', href: '#/graph?level=initiative' },
      { label: 'ENG-80' },
    ]);
    // An unknown issue is named as given, with nothing above it.
    expect(trail({ level: 'issue', issueId: 'nope' })).toEqual([
      { label: 'Workspace', href: '#/graph?level=initiative' },
      { label: 'nope' },
    ]);
  });

  test('a workspace without initiatives: no initiative crumb, Workspace opens projects', () => {
    const data = demoWorkspace();
    const bare = indexWorkspace({
      ...data,
      initiatives: [],
      projects: data.projects.map((p) => ({ ...p, initiativeIds: [] })),
    });
    expect(bare.initiatives.size).toBe(0);
    expect(trail({ level: 'issue', projectId: 'proj-delta' }, bare)).toEqual([
      { label: 'Workspace', href: '#/graph?level=project' },
      { label: 'Delta exports' },
    ]);
    expect(trail({ level: 'issue', milestoneId: 'ms-delta-1' }, bare)).toEqual([
      { label: 'Workspace', href: '#/graph?level=project' },
      {
        label: 'Delta exports',
        href: '#/graph?project=proj-delta&level=milestone',
      },
      { label: 'CSV exports' },
    ]);
  });

  test('the trail is written by the href the view passes', () => {
    const graph: GraphScopeHref = (scope) =>
      `route:${serialiseGraphScope(scope)}`;
    expect(
      graphTrail(member, { level: 'issue', projectId: 'proj-atlas' }, graph)
    ).toEqual([
      { label: 'Workspace', href: 'route:level=initiative' },
      { label: 'Platform reliability', href: 'route:initiative=init-platform' },
      { label: 'Atlas billing migration' },
    ]);
  });
});

describe('levelTabs', () => {
  const tabs = (scope: GraphScope, hasInitiatives = true) =>
    levelTabs(scope, { hasInitiatives, graph: graphHref }).map((tab) => [
      tab.label,
      tab.href,
      tab.current,
    ]);

  test('the workspace offers every level, Initiatives only with initiatives', () => {
    expect(tabs({ level: 'milestone' })).toEqual([
      ['Initiatives', '#/graph?level=initiative', false],
      ['Projects', '#/graph?level=project', false],
      ['Milestones', '#/graph', true],
      ['Issues', '#/graph?level=issue', false],
    ]);
    expect(tabs({ level: 'project' }, false)).toEqual([
      ['Projects', '#/graph?level=project', true],
      ['Milestones', '#/graph', false],
      ['Issues', '#/graph?level=issue', false],
    ]);
  });

  test('an initiative and a project offer the levels finer than themselves', () => {
    expect(tabs({ level: 'issue', initiativeId: 'none' })).toEqual([
      ['Projects', '#/graph?initiative=none', false],
      ['Milestones', '#/graph?initiative=none&level=milestone', false],
      ['Issues', '#/graph?initiative=none&level=issue', true],
    ]);
    expect(tabs({ level: 'issue', projectId: 'proj-atlas' }, false)).toEqual([
      ['Milestones', '#/graph?project=proj-atlas&level=milestone', false],
      ['Issues', '#/graph?project=proj-atlas', true],
    ]);
  });

  test('a milestone and a chain offer one level: no tabs', () => {
    expect(tabs({ level: 'issue', milestoneId: 'ms-atlas-2' })).toEqual([]);
    expect(tabs({ level: 'issue', issueId: 'ENG-24' })).toEqual([]);
  });

  test('the tabs are written by the href the view passes, with their ids', () => {
    const items = levelTabs(
      { level: 'issue', projectId: 'p' },
      { hasInitiatives: true, graph: (scope) => JSON.stringify(scope) }
    );
    expect(items).toEqual([
      {
        id: 'milestone',
        label: 'Milestones',
        href: '{"level":"milestone","projectId":"p"}',
        current: false,
      },
      {
        id: 'issue',
        label: 'Issues',
        href: '{"level":"issue","projectId":"p"}',
        current: true,
      },
    ]);
  });
});

describe('the highlight', () => {
  test('three modes in switch order, Risk by default', () => {
    expect(GRAPH_HIGHLIGHTS).toEqual(['status', 'risk', 'critical']);
    expect(GRAPH_HIGHLIGHTS.map((id) => GRAPH_HIGHLIGHT_LABEL[id])).toEqual([
      'Status',
      'Risk',
      'Critical path',
    ]);
    expect(DEFAULT_GRAPH_HIGHLIGHT).toBe('risk');
  });

  test('a highlight is read leniently: any case, trimmed, critical-path, the first value', () => {
    expect(parseHighlight('Status')).toBe('status');
    expect(parseHighlight('RISK')).toBe('risk');
    expect(parseHighlight(' critical-path ')).toBe('critical');
    expect(parseHighlight('CriticalPath')).toBe('critical');
    expect(parseHighlight('critical')).toBe('critical');
    expect(parseHighlight(['risk', 'status'])).toBe('risk');
    expect(parseHighlight(query('highlight=Risk&highlight=x').highlight)).toBe(
      'risk'
    );
  });

  test('anything else is null, never an error: junk, blanks, prototype names', () => {
    for (const value of [
      'junk',
      '',
      '   ',
      'critical path',
      'constructor',
      '__proto__',
      'toString',
      'hasOwnProperty',
      'r'.repeat(500),
    ]) {
      expect(parseHighlight(value)).toBeNull();
    }
    expect(parseHighlight(undefined)).toBeNull();
    expect(parseHighlight(null)).toBeNull();
  });

  test('a graph link never carries the highlight: it is the view’s state', () => {
    for (const scope of [
      { level: 'issue' },
      { level: 'issue', issueId: 'ENG-23' },
      { level: 'milestone', projectId: 'proj-atlas' },
    ] as GraphScope[]) {
      expect(graphHref(scope, { node: 'ms-atlas-2' })).not.toContain(
        'highlight'
      );
    }
  });
});
