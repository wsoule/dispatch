import type {
  DependencyGraph,
  GraphEdge,
  MilestoneAssessment,
  MilestoneDetail,
  Progress,
  ProjectAllocationPlan,
  TimelineBar,
  TimelineLane,
  TimelineView,
} from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import { daysLeftPhrase, dueLabel, formatDate, plural } from './planningFormat';
import {
  barTags,
  buildMilestoneSection,
  buildTimelineBanners,
  chartDependencies,
  filterTimelineGroups,
  laneNeedsAction,
  laneSublabel,
  NO_INITIATIVE_ID,
  parseTimelineShow,
  rubricChecklist,
  SHOW_OPTIONS,
  type TimelineHrefs,
  timelineReceipts,
  timelineWindow,
  toChartBar,
  toChartGroups,
  visibleDependencies,
  weightTag,
} from './timeline';

// Hand-built planning view models: only the fields the timeline reads are
// meaningful; the rest are plausible defaults (Wed Oct 21, 2026).

const TODAY = '2026-10-21';

/** The hrefs the desktop view passes: every row is a task; the Issues list
 * has no query routes yet. */
const HREFS: TimelineHrefs = {
  task: (id) => `#/task/${id}`,
  issues: () => '#/issues',
};
const EDITOR = { canEdit: true, hrefs: HREFS };
const READER = { canEdit: false, hrefs: HREFS };

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    total: 4,
    completed: 1,
    canceled: 0,
    scope: 4,
    open: 3,
    openUnassigned: 0,
    openTriage: 0,
    ...overrides,
  };
}

function bar(overrides: Partial<TimelineBar> = {}): TimelineBar {
  return {
    milestoneId: 'ms-1',
    name: 'Dual-write',
    projectId: 'proj-1',
    start: '2026-10-01',
    end: '2026-10-28',
    status: 'on_track',
    reasons: [],
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Both stores agree', source: 'planner' },
    progress: progress(),
    isNext: false,
    daysLeft: 7,
    weight: null,
    ...overrides,
  };
}

function plan(
  overrides: Partial<ProjectAllocationPlan> = {}
): ProjectAllocationPlan {
  return {
    projectId: 'proj-1',
    outcome: 'nothing_to_do',
    nextMilestoneId: 'ms-1',
    blockReason: null,
    gaps: [],
    actions: [],
    skipped: [],
    ...overrides,
  };
}

function lane(overrides: Partial<TimelineLane> = {}): TimelineLane {
  return {
    projectId: 'proj-1',
    name: 'Atlas billing migration',
    url: '',
    leadId: 'user-chloe',
    leadName: 'Chloe Diaz',
    priority: 1,
    statusType: 'started',
    active: true,
    bars: [bar()],
    undated: [],
    unplannedIssueIds: [],
    allocation: plan(),
    ...overrides,
  };
}

function view(
  groups: { id: string | null; name: string; lanes: TimelineLane[] }[],
  banners: Partial<TimelineView['banners']> = {}
): TimelineView {
  return {
    today: TODAY,
    windowStart: '2026-10-07',
    windowEnd: '2026-12-30',
    groups: groups.map((g) => ({
      initiativeId: g.id,
      name: g.name,
      lanes: g.lanes,
    })),
    banners: {
      projectsWithoutLead: [],
      milestonesWithoutDate: [],
      issuesWithoutMilestone: { count: 0, byProject: [] },
      blockedProjects: [],
      ...banners,
    },
  };
}

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    from: 'ms-a',
    to: 'ms-b',
    resolved: false,
    blocking: true,
    crossProject: true,
    crossInitiative: false,
    crossOwner: true,
    inCycle: false,
    onRiskChain: false,
    weight: 1,
    ...overrides,
  };
}

/** A workspace-wide milestone graph with the given nodes and edges. */
function graph(
  edges: GraphEdge[],
  overrides: Partial<DependencyGraph> = {}
): DependencyGraph {
  return {
    scope: { level: 'milestone' },
    nodes: [],
    edges,
    cycles: [],
    clusters: [],
    fallback: null,
    unplacedRelations: 0,
    chain: null,
    ...overrides,
  };
}

describe('format helpers', () => {
  test('formatDate drops the year only when it matches today', () => {
    expect(formatDate('2026-10-28', TODAY)).toBe('Oct 28');
    expect(formatDate('2027-01-04', TODAY)).toBe('Jan 4, 2027');
    expect(formatDate('2026-10-28')).toBe('Oct 28, 2026');
  });

  test('daysLeftPhrase covers today, tomorrow, future and overdue', () => {
    expect(daysLeftPhrase(0)).toBe('due today');
    expect(daysLeftPhrase(1)).toBe('due tomorrow');
    expect(daysLeftPhrase(3)).toBe('in 3 days');
    expect(daysLeftPhrase(-1)).toBe('1 day overdue');
    expect(daysLeftPhrase(-3)).toBe('3 days overdue');
  });

  test('dueLabel combines date and phrase, with no countdown once complete', () => {
    expect(dueLabel('2026-10-24', 3, TODAY)).toBe('Oct 24 · in 3 days');
    expect(dueLabel(null, null, TODAY)).toBe('No target date');
    // Done work is never overdue, whatever its date.
    expect(dueLabel('2026-10-01', -20, TODAY, 'complete')).toBe(
      'Oct 1 · complete'
    );
    expect(dueLabel('2026-10-01', -20, TODAY, 'overdue')).toBe(
      'Oct 1 · 20 days overdue'
    );
    expect(dueLabel('2026-10-24', null, TODAY)).toBe('Oct 24');
    expect(dueLabel(null, null, TODAY, 'complete')).toBe('No target date');
  });

  test('rejects malformed dates loudly', () => {
    expect(() => formatDate('10/28/2026')).toThrow(/YYYY-MM-DD/);
  });

  test('plural', () => {
    expect(plural(1, 'issue')).toBe('1 issue');
    expect(plural(2, 'issue')).toBe('2 issues');
    expect(plural(2, 'person', 'people')).toBe('2 people');
  });
});

describe('chart bars', () => {
  test('a rubric-invalid on-track bar is a missing input with its gaps', () => {
    const out = toChartBar(
      bar({ rubric: { valid: false, gaps: ['no_done_means', 'no_issues'] } }),
      true
    );
    expect(out.status).toBe('missing');
    expect(out.statusLabel).toBe('Missing input');
    expect(out.missing).toBe('Missing: done means…, issues');
  });

  test('overdue and at-risk keep their marks and still say what is missing', () => {
    const overdue = toChartBar(
      bar({
        status: 'overdue',
        daysLeft: -3,
        rubric: { valid: false, gaps: ['no_project_lead'] },
      }),
      true
    );
    expect(overdue.status).toBe('overdue');
    expect(overdue.missing).toBe('Missing: project lead');
    const atRisk = toChartBar(bar({ status: 'at_risk' }), true);
    expect(atRisk.status).toBe('at_risk');
    expect(atRisk.missing).toBeUndefined();
  });

  test('Next and the weight override are tags; progress is completed/scope', () => {
    const out = toChartBar(
      bar({
        isNext: true,
        weight: 2,
        progress: progress({ completed: 3, scope: 7 }),
      }),
      false
    );
    expect(out.tags).toEqual(['Next', '↑2']);
    expect(out.progressLabel).toBe('3/7');
    expect(barTags(bar({ weight: -3 }))).toEqual(['↓3']);
    expect(barTags(bar({ weight: 0 }))).toEqual([]);
    expect(weightTag(null)).toBeNull();
  });

  test('only open bars get the re-date handle, and only when editing is allowed', () => {
    expect(toChartBar(bar(), true).editable).toBe(true);
    expect(toChartBar(bar(), false).editable).toBeUndefined();
    const done = toChartBar(
      bar({
        status: 'complete',
        rubric: { valid: false, gaps: ['no_done_means'] },
      }),
      true
    );
    expect(done.editable).toBeUndefined();
    expect(done.status).toBe('done');
    // A finished milestone needs no action, so no missing line either.
    expect(done.missing).toBeUndefined();
  });

  test('drag handles follow the one canEdit flag', () => {
    const v = view([{ id: 'init-1', name: 'Platform', lanes: [lane()] }]);
    const editable = (opts: typeof EDITOR) =>
      toChartGroups(v, opts)[0]?.lanes[0]?.bars[0]?.editable === true;
    expect(editable(EDITOR)).toBe(true);
    expect(editable(READER)).toBe(false);
  });
});

describe('lanes', () => {
  test('sublabel: lead, No lead and a deactivated lead as warnings, inactive quiet', () => {
    expect(laneSublabel(lane())).toEqual({
      sublabel: 'Chloe Diaz',
      tone: 'default',
    });
    expect(laneSublabel(lane({ leadId: null, leadName: null }))).toEqual({
      sublabel: 'No lead',
      tone: 'warning',
    });
    // A lead the view knows no name for is still a lead.
    expect(laneSublabel(lane({ leadName: null }))).toEqual({
      sublabel: 'Unknown lead',
      tone: 'default',
    });
    expect(
      laneSublabel(
        lane({
          allocation: plan({
            outcome: 'blocked',
            blockReason: 'lead_inactive',
          }),
        })
      )
    ).toEqual({ sublabel: 'Chloe Diaz · deactivated', tone: 'warning' });
    expect(laneSublabel(lane({ active: false }))).toEqual({
      sublabel: 'Inactive · Chloe Diaz',
      tone: 'default',
    });
    expect(
      laneSublabel(lane({ active: false, leadId: null, leadName: null }))
    ).toEqual({ sublabel: 'Inactive · no lead', tone: 'default' });
  });

  test('groups map initiatives (and none) with muted inactive lanes and undated chips', () => {
    const groups = toChartGroups(
      view([
        { id: 'init-1', name: 'Platform', lanes: [lane()] },
        {
          id: null,
          name: 'No initiative',
          lanes: [
            lane({
              projectId: 'proj-2',
              active: false,
              bars: [],
              undated: [
                bar({
                  milestoneId: 'ms-u',
                  name: 'Localization',
                  end: null,
                  status: 'unscheduled',
                  rubric: { valid: false, gaps: ['no_target_date'] },
                }),
              ],
            }),
          ],
        },
      ]),
      EDITOR
    );
    expect(groups.map((g) => [g.id, g.label])).toEqual([
      ['init-1', 'Platform'],
      [NO_INITIATIVE_ID, 'No initiative'],
    ]);
    const inactive = groups[1]?.lanes[0];
    expect(inactive?.muted).toBe(true);
    expect(inactive?.undated).toEqual([
      {
        id: 'ms-u',
        label: 'Localization',
        status: 'missing',
        statusLabel: 'No target date',
      },
    ]);
    expect(groups[0]?.lanes[0]?.muted).toBeUndefined();
    // No graph yet, so a group carries no link.
    expect(groups[0]?.link).toBeUndefined();
  });

  test('a lane name opens the project (a task), through the given hrefs', () => {
    const groups = toChartGroups(
      view([{ id: 'init-1', name: 'Platform', lanes: [lane()] }]),
      EDITOR
    );
    expect(groups[0]?.lanes[0]).toMatchObject({
      id: 'proj-1',
      label: 'Atlas billing migration',
      href: '#/task/proj-1',
      sublabel: 'Chloe Diaz',
      sublabelTone: 'default',
    });
    // A dated bar with no end is never drawn (the core puts those in
    // `undated`, but the chart is defensive).
    const odd = toChartGroups(
      view([
        {
          id: null,
          name: 'N',
          lanes: [
            lane({ bars: [bar(), bar({ milestoneId: 'x', end: null })] }),
          ],
        },
      ]),
      EDITOR
    );
    expect(odd[0]?.lanes[0]?.bars.map((b) => b.id)).toEqual(['ms-1']);
  });

  test("timelineWindow is the chart's calendar", () => {
    expect(timelineWindow(view([]))).toEqual({
      today: TODAY,
      windowStart: '2026-10-07',
      windowEnd: '2026-12-30',
    });
  });
});

describe('dependencies', () => {
  test('milestone edges become connectors, one per pair', () => {
    const g = graph([
      edge(),
      edge({ onRiskChain: true }),
      edge({ from: 'ms-c', to: 'ms-c' }),
      edge({ from: 'ms-c', to: 'ms-b' }),
    ]);
    expect(chartDependencies(g)).toEqual([
      { from: 'ms-a', to: 'ms-b', onRiskChain: true },
      { from: 'ms-c', to: 'ms-b', onRiskChain: false },
    ]);
    expect(
      chartDependencies({
        ...g,
        scope: { level: 'issue', milestoneId: 'ms-a' },
      })
    ).toEqual([]);
    // Only the whole workspace's milestones are the chart's connectors: one
    // initiative's or one project's milestone graph gives none.
    expect(
      chartDependencies({
        ...g,
        scope: { level: 'milestone', initiativeId: 'init-1' },
      })
    ).toEqual([]);
    expect(
      chartDependencies({
        ...g,
        scope: { level: 'milestone', projectId: 'proj-1' },
      })
    ).toEqual([]);
    expect(chartDependencies({ ...g, scope: { level: 'project' } })).toEqual(
      []
    );
  });

  test("an edge between two inactive projects' milestones is no connector", () => {
    // The graph draws every milestone, so it draws the arrow between two
    // paused ones too; the chart keeps paused work quiet and leaves it out.
    // Only `id` and `active` of a node are read here.
    const nodes = [
      { id: 'ms-p1', active: false },
      { id: 'ms-p2', active: false },
      { id: 'ms-a', active: true },
    ] as unknown as DependencyGraph['nodes'];
    const g = graph(
      [
        edge({ from: 'ms-p1', to: 'ms-p2' }),
        edge({ from: 'ms-p2', to: 'ms-a' }),
      ],
      { nodes }
    );
    expect(chartDependencies(g)).toEqual([
      { from: 'ms-p2', to: 'ms-a', onRiskChain: false },
    ]);
  });

  test('connectors whose ends are filtered out are dropped', () => {
    const groups = toChartGroups(
      view([
        {
          id: 'i',
          name: 'I',
          lanes: [
            lane({
              bars: [
                bar({ milestoneId: 'ms-a' }),
                bar({ milestoneId: 'ms-b' }),
              ],
            }),
          ],
        },
      ]),
      EDITOR
    );
    const deps = [
      { from: 'ms-a', to: 'ms-b', onRiskChain: false },
      { from: 'ms-x', to: 'ms-b', onRiskChain: true },
    ];
    expect(visibleDependencies(deps, groups)).toEqual([deps[0]]);
  });
});

describe('filters', () => {
  const groups = toChartGroups(
    view([
      {
        id: 'init-1',
        name: 'Platform',
        lanes: [
          lane({ projectId: 'p-atlas', name: 'Atlas billing migration' }),
          lane({
            projectId: 'p-harbor',
            name: 'Harbor API',
            bars: [bar({ milestoneId: 'ms-h', status: 'at_risk' })],
          }),
        ],
      },
      {
        id: null,
        name: 'No initiative',
        lanes: [
          lane({
            projectId: 'p-fjord',
            name: 'Fjord analytics',
            active: false,
            bars: [bar({ milestoneId: 'ms-f', status: 'overdue' })],
          }),
        ],
      },
    ]),
    EDITOR
  );
  const ids = (out: ReturnType<typeof filterTimelineGroups>) =>
    out.flatMap((g) => g.lanes.map((l) => l.id));

  test('show all, only active, only at risk / overdue, and a name search', () => {
    expect(ids(filterTimelineGroups(groups, 'all'))).toEqual([
      'p-atlas',
      'p-harbor',
      'p-fjord',
    ]);
    expect(ids(filterTimelineGroups(groups, 'all', ' HARBOR '))).toEqual([
      'p-harbor',
    ]);
    expect(ids(filterTimelineGroups(groups, 'active'))).toEqual([
      'p-atlas',
      'p-harbor',
    ]);
    // An inactive lane is never "at risk / overdue", whatever its
    // milestones' status: Fjord's overdue bar does not count.
    expect(ids(filterTimelineGroups(groups, 'risk'))).toEqual(['p-harbor']);
    expect(ids(filterTimelineGroups(groups, 'risk', 'atlas'))).toEqual([]);
    // Empty groups are dropped; kept groups are new objects over the same
    // lanes.
    const atlas = filterTimelineGroups(groups, 'all', 'atlas');
    expect(atlas.map((g) => g.id)).toEqual(['init-1']);
    expect(atlas[0]?.lanes[0]).toBe(groups[0]?.lanes[0]);
  });

  test('laneNeedsAction: an at-risk or overdue bar in an active lane only', () => {
    const lanes = groups.flatMap((g) => g.lanes);
    expect(lanes.map((l) => [l.id, laneNeedsAction(l)])).toEqual([
      ['p-atlas', false],
      ['p-harbor', true],
      ['p-fjord', false],
    ]);
  });

  test('Show is one choice, read back from a segmented control', () => {
    expect(SHOW_OPTIONS.map((o) => [o.id, o.label])).toEqual([
      ['all', 'All'],
      ['active', 'Active'],
      ['risk', 'At risk'],
    ]);
    expect(parseTimelineShow('risk')).toBe('risk');
    expect(parseTimelineShow('active')).toBe('active');
    expect(parseTimelineShow('all')).toBe('all');
    expect(parseTimelineShow('nonsense')).toBe('all');
  });

  test('receipts count lanes, milestones, overdue and at risk', () => {
    const v = view([
      {
        id: null,
        name: 'N',
        lanes: [
          lane({
            bars: [bar({ status: 'overdue' }), bar({ status: 'at_risk' })],
            undated: [bar({ end: null, status: 'unscheduled' })],
          }),
        ],
      },
    ]);
    expect(timelineReceipts(v)).toBe(
      '1 project · 3 milestones · 1 overdue · 1 at risk · Oct 7 – Dec 30'
    );
    // An inactive lane's milestones are listed but never counted overdue or
    // at risk; the project count says how many lanes are inactive.
    const withInactive = view([
      {
        id: null,
        name: 'N',
        lanes: [
          lane({
            bars: [bar({ status: 'overdue' }), bar({ status: 'at_risk' })],
          }),
          lane({
            projectId: 'p-fjord',
            active: false,
            bars: [bar({ status: 'overdue' }), bar({ status: 'at_risk' })],
          }),
        ],
      },
    ]);
    expect(timelineReceipts(withInactive)).toBe(
      '2 projects (1 inactive) · 4 milestones · 1 overdue · 1 at risk · Oct 7 – Dec 30'
    );
  });
});

describe('banners', () => {
  test('nothing missing → no banners', () => {
    expect(
      buildTimelineBanners(
        view([{ id: null, name: 'N', lanes: [lane()] }]),
        [],
        HREFS
      )
    ).toEqual([]);
  });

  test('counts expand to lists of rows, each opening its task', () => {
    const v = view([{ id: null, name: 'N', lanes: [lane()] }], {
      projectsWithoutLead: [
        { projectId: 'p-delta', name: 'Delta exports' },
        { projectId: 'p-echo', name: 'Echo' },
      ],
      milestonesWithoutDate: [
        {
          milestoneId: 'ms-loc',
          name: 'Localization',
          projectId: 'p-compass',
          projectName: 'Compass onboarding',
        },
      ],
      issuesWithoutMilestone: {
        count: 3,
        byProject: [
          { projectId: 'p-atlas', name: 'Atlas', issueIds: ['i1', 'i2'] },
          { projectId: 'p-beacon', name: 'Beacon', issueIds: ['i3'] },
        ],
      },
    });
    const banners = buildTimelineBanners(
      v,
      [
        { id: 'i3', title: 'Pricing page' },
        { id: 'i1', title: 'Write both ledgers' },
        { id: 'i2', title: 'Shadow reads' },
      ],
      HREFS
    );
    expect(banners.map((b) => [b.id, b.label, b.count])).toEqual([
      ['no_lead', 'No lead', 2],
      ['no_date', 'No date', 1],
      ['unplanned', 'Unplanned', 3],
    ]);
    // Every banner is a warning (amber): a missing input, or open issues no
    // milestone counts.
    expect(banners.every((b) => b.tone === 'warning')).toBe(true);
    expect(banners[0]?.text).toBe(
      '2 active projects have no lead, so their milestones fail the rubric.'
    );
    expect(banners[0]?.items).toEqual([
      { id: 'p-delta', label: 'Delta exports', href: '#/task/p-delta' },
      { id: 'p-echo', label: 'Echo', href: '#/task/p-echo' },
    ]);
    expect(banners[0]?.action).toBeUndefined();
    expect(banners[1]?.text).toBe(
      '1 milestone has no target date, so it fails the rubric and sits undated at the end of its lane.'
    );
    expect(banners[1]?.items).toEqual([
      {
        id: 'ms-loc',
        label: 'Compass onboarding › Localization',
        href: '#/task/ms-loc',
      },
    ]);
    expect(banners[2]?.text).toBe(
      '3 open issues in 2 projects have no milestone, so no milestone counts them. Move them into one, or cancel them.'
    );
    // Rows follow the core's order (by project, then issue), not the list's.
    expect(banners[2]?.items).toEqual([
      { id: 'i1', label: 'Atlas › Write both ledgers', href: '#/task/i1' },
      { id: 'i2', label: 'Atlas › Shadow reads', href: '#/task/i2' },
      { id: 'i3', label: 'Beacon › Pricing page', href: '#/task/i3' },
    ]);
    // The unplanned rows can be planned from the Issues list.
    expect(banners[2]?.action).toEqual({
      label: 'Plan in Issues',
      href: '#/issues',
    });
  });

  test('one of a kind reads in the singular', () => {
    const banners = buildTimelineBanners(
      view([{ id: null, name: 'N', lanes: [lane()] }], {
        projectsWithoutLead: [{ projectId: 'p-a', name: 'Atlas' }],
        milestonesWithoutDate: [
          {
            milestoneId: 'ms-loc',
            name: 'Localization',
            projectId: 'p-compass',
            projectName: 'Compass onboarding',
          },
        ],
        issuesWithoutMilestone: {
          count: 1,
          byProject: [{ projectId: 'p-a', name: 'Atlas', issueIds: ['gone'] }],
        },
      }),
      [],
      HREFS
    );
    expect(banners.map((b) => b.text)).toEqual([
      '1 active project has no lead, so its milestones fail the rubric.',
      '1 milestone has no target date, so it fails the rubric and sits undated at the end of its lane.',
      '1 open issue has no milestone, so no milestone counts it. Move it into one, or cancel it.',
    ]);
    // An issue the list does not know is counted but not listed.
    expect(banners[2]?.count).toBe(1);
    expect(banners[2]?.items).toEqual([]);
  });
});

/* ---- the Milestone section ------------------------------------------------ */

function assessment(
  overrides: Partial<MilestoneAssessment> = {}
): MilestoneAssessment {
  return {
    milestoneId: 'ms-1',
    projectId: 'proj-1',
    status: 'overdue',
    daysLeft: -3,
    reasons: ['unassigned_open', 'behind_pace'],
    progress: progress({
      completed: 0,
      canceled: 1,
      total: 5,
      scope: 4,
      open: 4,
    }),
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Both ledgers agree', source: 'linear_description' },
    isNext: true,
    lastStateChangeAt: '2026-10-10T00:00:00.000Z',
    ...overrides,
  };
}

function detail(overrides: Partial<MilestoneDetail> = {}): MilestoneDetail {
  return {
    milestone: {
      id: 'ms-1',
      projectId: 'proj-1',
      name: 'Dual-write',
      description: 'Done means: Both ledgers agree',
      targetDate: '2026-10-18',
      sortOrder: 1,
    },
    project: {
      id: 'proj-1',
      name: 'Atlas billing migration',
      url: '',
      leadId: 'user-chloe',
      priority: 1,
      sortOrder: 1,
      statusType: 'started',
      statusName: 'In Progress',
      initiativeIds: [],
      teamIds: [],
      startDate: null,
      targetDate: null,
    },
    leadName: 'Chloe Diaz',
    assessment: assessment(),
    meta: null,
    issues: [
      {
        issueId: 'i1',
        identifier: 'ENG-1',
        title: 'Write both ledgers',
        url: '',
        priority: 2,
        stateName: 'In Progress',
        stateType: 'started',
        assigneeId: null,
        assigneeName: null,
        blockedByIds: ['i2', 'x9'],
      },
      {
        issueId: 'i3',
        identifier: 'ENG-3',
        title: 'Reconcile nightly',
        url: '',
        priority: 3,
        stateName: 'Todo',
        stateType: 'unstarted',
        assigneeId: 'user-chloe',
        assigneeName: 'Chloe Diaz',
        blockedByIds: [],
      },
      {
        issueId: 'i2',
        identifier: 'ENG-2',
        title: 'Shadow reads',
        url: '',
        priority: 3,
        stateName: 'Done',
        stateType: 'completed',
        assigneeId: 'user-chloe',
        assigneeName: 'Chloe Diaz',
        blockedByIds: [],
      },
    ],
    waitsOn: [
      {
        milestoneId: 'ms-schema',
        name: 'Schema cutover',
        projectName: 'Atlas',
      },
    ],
    ...overrides,
  };
}

/** The section of a detail, from its own assessment. */
function section(
  d: MilestoneDetail = detail(),
  opts: Parameters<typeof buildMilestoneSection>[3] = {}
): ReturnType<typeof buildMilestoneSection> {
  return buildMilestoneSection(d, d.assessment, TODAY, opts);
}

describe('milestone section', () => {
  test('status lines, due label and progress follow the status table', () => {
    const m = section();
    expect(m.status).toEqual({
      status: 'overdue',
      label: 'Overdue',
      lines: ['Open issues unassigned', 'More work left than time left'],
    });
    // Overdue is danger (red), in the due date and the progress.
    expect(m.due).toEqual({
      value: '2026-10-18',
      label: 'Oct 18 · 3 days overdue',
      tone: 'danger',
    });
    expect(m.progress).toEqual({ done: 0, total: 4, tone: 'danger' });
    expect(m.isNext).toBe(true);
    expect(m.muted).toBe(false);
    // Without a view the lane is unknown: nothing to name as next.
    expect(m.next).toBeNull();
  });

  test('a missing input joins the status lines, capitalised', () => {
    const m = section(
      detail({
        assessment: assessment({
          status: 'on_track',
          daysLeft: 3,
          reasons: [],
          rubric: { valid: false, gaps: ['no_done_means', 'no_issues'] },
        }),
      })
    );
    expect(m.status).toEqual({
      status: 'missing',
      label: 'Missing input',
      lines: ['Missing: done means…, issues'],
    });
    // A complete milestone's gaps are nothing to act on.
    const done = section(
      detail({
        assessment: assessment({
          status: 'complete',
          daysLeft: -20,
          reasons: [],
          rubric: { valid: false, gaps: ['no_done_means'] },
        }),
      })
    );
    expect(done.status.lines).toEqual([]);
  });

  test("what it waits on carries the other milestone's mark when known", () => {
    const assessments = new Map([
      [
        'ms-schema',
        assessment({
          milestoneId: 'ms-schema',
          status: 'at_risk',
          daysLeft: 2,
          reasons: ['behind_pace'],
        }),
      ],
    ]);
    expect(section(detail(), { assessments }).waitsOn).toEqual([
      {
        id: 'ms-schema',
        name: 'Schema cutover',
        project: 'Atlas',
        status: 'at_risk',
        label: 'At risk',
      },
    ]);
    // Unknown to the map (or no map): the plain open mark, named so.
    expect(section().waitsOn).toEqual([
      {
        id: 'ms-schema',
        name: 'Schema cutover',
        project: 'Atlas',
        status: 'open',
        label: 'Status unknown',
      },
    ]);
    expect(section(detail({ waitsOn: [] })).waitsOn).toEqual([]);
  });

  test('open issues keep the issue marks: owned is open, unowned is missing', () => {
    expect(section().openIssues).toEqual([
      {
        id: 'i1',
        title: 'Write both ledgers',
        status: 'missing',
        label: 'In Progress, unassigned',
      },
      { id: 'i3', title: 'Reconcile nightly', status: 'open', label: 'Todo' },
    ]);
  });

  test('the rubric is four items worded with the gap labels when missing', () => {
    const met = section().rubric;
    expect(met.map((i) => [i.id, i.label, i.met, i.note])).toEqual([
      ['no_target_date', 'Target date', true, 'Oct 18'],
      ['no_done_means', '"Done means…"', true, 'From the description'],
      ['no_project_lead', 'Project lead', true, 'Chloe Diaz'],
      ['no_issues', 'At least one issue', true, '5 issues'],
    ]);
    const empty = detail({
      milestone: { ...detail().milestone, targetDate: null },
      leadName: null,
      project: { ...detail().project, leadId: null },
      assessment: assessment({
        status: 'empty',
        daysLeft: null,
        reasons: [],
        doneMeans: { text: null, source: null },
        rubric: {
          valid: false,
          gaps: [
            'no_target_date',
            'no_done_means',
            'no_project_lead',
            'no_issues',
          ],
        },
      }),
    });
    expect(rubricChecklist(empty, TODAY).map((i) => [i.met, i.note])).toEqual([
      [false, 'Missing a target date. Set a due date on the milestone.'],
      [
        false,
        'Missing "done means…". Start a line of the milestone\'s description with "Done means:".',
      ],
      [false, 'Project has no lead. Assign the project to someone.'],
      [false, 'No issues yet. Move issues into this milestone.'],
    ]);
    // "Done means…" set on the milestone itself says so.
    const own = section(
      detail({
        assessment: assessment({
          doneMeans: { text: 'Zero drift for a week', source: 'planner' },
        }),
      })
    );
    expect(own.rubric[1]?.note).toBe('Set on the milestone');
  });

  test('"next" names the lane\'s next milestone when this is not it', () => {
    const next = bar({ milestoneId: 'ms-1', name: 'Dual-write', isNext: true });
    const later = bar({ milestoneId: 'ms-2', name: 'Read path switch' });
    const v = view([
      {
        id: null,
        name: 'No initiative',
        lanes: [lane({ bars: [next, later] })],
      },
    ]);
    // The next milestone itself: nothing else to name.
    expect(section(detail(), { view: v })).toMatchObject({
      isNext: true,
      next: null,
    });
    const notNext = detail({
      milestone: {
        ...detail().milestone,
        id: 'ms-2',
        name: 'Read path switch',
      },
      assessment: assessment({ milestoneId: 'ms-2', isNext: false }),
    });
    expect(section(notNext, { view: v })).toMatchObject({
      isNext: false,
      next: { id: 'ms-1', name: 'Dual-write' },
    });
    // An undated next milestone is found too; a lane with no next gives null.
    const undatedNext = view([
      {
        id: null,
        name: 'No initiative',
        lanes: [
          lane({
            bars: [later],
            undated: [bar({ ...next, end: null, status: 'unscheduled' })],
          }),
        ],
      },
    ]);
    expect(section(notNext, { view: undatedNext }).next).toEqual({
      id: 'ms-1',
      name: 'Dual-write',
    });
    const noNext = view([
      { id: null, name: 'No initiative', lanes: [lane({ bars: [later] })] },
    ]);
    expect(section(notNext, { view: noNext }).next).toBeNull();
    // A view that does not draw the project is as good as none.
    const elsewhere = view([
      {
        id: null,
        name: 'No initiative',
        lanes: [lane({ projectId: 'other' })],
      },
    ]);
    expect(section(notNext, { view: elsewhere }).next).toBeNull();
  });

  test('a complete milestone is never overdue: its date has no countdown', () => {
    const m = section(
      detail({
        milestone: { ...detail().milestone, targetDate: '2026-10-01' },
        assessment: assessment({
          status: 'complete',
          daysLeft: -20,
          reasons: [],
        }),
      })
    );
    expect(m.due).toEqual({
      value: '2026-10-01',
      label: 'Oct 1 · complete',
      tone: 'default',
    });
    expect(m.status.status).toBe('done');
    // Its progress reads as done: the success (green) fill.
    expect(m.progress.tone).toBe('success');
  });

  test('due-date and progress tones follow the status table', () => {
    // No target date is a missing input: warning.
    const undated = section(
      detail({
        milestone: { ...detail().milestone, targetDate: null },
        assessment: assessment({
          status: 'unscheduled',
          daysLeft: null,
          reasons: [],
        }),
      })
    );
    expect(undated.due).toEqual({
      value: null,
      label: 'No target date',
      tone: 'warning',
    });
    expect(undated.progress.tone).toBe('default');
    // Due today or tomorrow is close: warning; later is plain.
    const tomorrow = section(
      detail({
        milestone: { ...detail().milestone, targetDate: '2026-10-22' },
        assessment: assessment({
          status: 'on_track',
          daysLeft: 1,
          reasons: [],
        }),
      })
    );
    expect(tomorrow.due.tone).toBe('warning');
    expect(tomorrow.progress.tone).toBe('default');
    const later = section(
      detail({
        milestone: { ...detail().milestone, targetDate: '2026-10-30' },
        assessment: assessment({
          status: 'at_risk',
          daysLeft: 9,
          reasons: ['behind_pace'],
        }),
      })
    );
    expect(later.due.tone).toBe('default');
    // Behind pace: the progress is a warning (amber).
    expect(later.progress.tone).toBe('warning');
  });

  test("an inactive project's milestone is drawn quietly", () => {
    const paused = view([
      {
        id: null,
        name: 'No initiative',
        lanes: [
          lane({
            bars: [bar({ isNext: true, status: 'overdue' })],
            active: false,
            statusType: 'paused',
            allocation: plan({ outcome: 'inactive' }),
          }),
        ],
      },
    ]);
    const m = section(detail(), { view: paused });
    // Same facts, never loud: a grey mark still named with its status, a
    // plain due date and the muted (grey) progress.
    expect(m.muted).toBe(true);
    expect(m.status).toEqual({
      status: 'overdue',
      label: 'Overdue · inactive project',
      lines: ['Open issues unassigned', 'More work left than time left'],
    });
    expect(m.due).toEqual({
      value: '2026-10-18',
      label: 'Oct 18 · 3 days overdue',
      tone: 'default',
    });
    expect(m.progress.tone).toBe('muted');
    // An active lane (or no view) keeps it loud.
    expect(section().muted).toBe(false);
    expect(section().due.tone).toBe('danger');
  });
});
