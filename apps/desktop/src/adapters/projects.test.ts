import type { RunMeta } from '@dispatch/client';
import type {
  Progress,
  ProjectAllocationPlan,
  TimelineBar,
  TimelineLane,
  TimelineView,
} from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import {
  agentsWorking,
  allocationCell,
  buildProjectsPage,
  countProjectRows,
  filterProjectGroups,
  type LiveRunsByContainer,
  parseProjectFilter,
} from './projects';
import { noProjectId } from './workspaceData';

// Hand-built planning view models, as adapters/timeline.test.ts builds them:
// only the fields the register reads are meaningful; the rest are plausible
// defaults (Wed Oct 21, 2026). Ported from the planner's
// test/adapters-projects.test.ts, less the cases that left with the port (the
// Linear status names and URL, the Issues link, the ?q=/?filter= URL state).

const TODAY = '2026-10-21';

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
    isNext: true,
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
    url: '#/task/proj-1',
    leadId: 'human:chloe',
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

/** Groups in timeline order; the last one is "No initiative". */
function timeline(lanes: TimelineLane[][]): TimelineView {
  return {
    today: TODAY,
    windowStart: '2026-10-07',
    windowEnd: '2026-12-30',
    groups: lanes.map((group, i) => ({
      initiativeId: i === lanes.length - 1 ? null : `init-${i}`,
      name: i === lanes.length - 1 ? 'No initiative' : `Initiative ${i}`,
      lanes: group,
    })),
    banners: {
      projectsWithoutLead: [],
      milestonesWithoutDate: [],
      issuesWithoutMilestone: { count: 0, byProject: [] },
      blockedProjects: [],
    },
  };
}

function run(id: string): RunMeta {
  return { id } as RunMeta;
}

function liveRuns(
  entries: [containerId: string, runIds: string[]][]
): LiveRunsByContainer {
  return new Map(
    entries.map(([containerId, ids]) => [
      containerId,
      { liveRuns: ids.map(run) },
    ])
  );
}

const NO_RUNS: LiveRunsByContainer = new Map();

function page(
  view: TimelineView,
  options: {
    projects?: [string, string][];
    epicProgressById?: LiveRunsByContainer;
  } = {}
) {
  return buildProjectsPage({
    timeline: view,
    projects: new Map(
      (options.projects ?? []).map(([id, statusName]) => [id, { statusName }])
    ),
    epicProgressById: options.epicProgressById ?? NO_RUNS,
  });
}

describe('agentsWorking', () => {
  test('counts the distinct live runs under the project and its milestones', () => {
    const one = lane({
      bars: [bar(), bar({ milestoneId: 'ms-2', isNext: false })],
      undated: [bar({ milestoneId: 'ms-3', end: null, isNext: false })],
    });
    expect(agentsWorking(one, NO_RUNS)).toBe(0);
    // A plan-wide session lists a milestone's run under the project too:
    // r-1 is counted once.
    expect(
      agentsWorking(
        one,
        liveRuns([
          ['proj-1', ['r-1', 'r-2']],
          ['ms-1', ['r-1']],
          ['ms-3', ['r-3']],
          ['elsewhere', ['r-9']],
        ])
      )
    ).toBe(3);
  });
});

describe('allocationCell', () => {
  test('agents working beats what the plan would do', () => {
    expect(
      allocationCell(1, plan({ outcome: 'blocked', blockReason: 'no_lead' }))
    ).toEqual({ label: '1 agent working', tone: 'info' });
    expect(allocationCell(3, null)).toEqual({
      label: '3 agents working',
      tone: 'info',
    });
  });

  test('says what the plan would do', () => {
    expect(
      allocationCell(
        0,
        plan({
          outcome: 'allocate',
          actions: [
            {
              issueId: 'i1',
              identifier: 'ENG-1',
              title: 'One',
              projectId: 'proj-1',
              milestoneId: 'ms-1',
              assigneeId: 'agent',
              fromStateId: 's1',
              toStateId: null,
            },
            {
              issueId: 'i2',
              identifier: 'ENG-2',
              title: 'Two',
              projectId: 'proj-1',
              milestoneId: 'ms-1',
              assigneeId: 'agent',
              fromStateId: 's1',
              toStateId: 's2',
            },
          ],
        })
      )
    ).toEqual({ label: 'Allocating 2', tone: 'info' });
    expect(allocationCell(0, plan())).toEqual({
      label: 'Nothing to do',
      tone: 'default',
      plain: true,
    });
    expect(allocationCell(0, plan({ outcome: 'no_open_milestone' }))).toEqual({
      label: 'No open milestone',
      tone: 'muted',
    });
    expect(allocationCell(0, plan({ outcome: 'inactive' }))).toEqual({
      label: 'Inactive',
      tone: 'muted',
    });
    // No plan for the project: nothing to do, in plain words.
    expect(allocationCell(0, null)).toEqual({
      label: 'Nothing to do',
      tone: 'default',
      plain: true,
    });
  });

  test('blocked is a short chip; the reason and missing items go under it', () => {
    expect(
      allocationCell(0, plan({ outcome: 'blocked', blockReason: 'no_lead' }))
    ).toEqual({
      label: 'Blocked',
      detail: 'Project has no lead',
      tone: 'warning',
      filled: true,
      toneDetail: true,
    });
    expect(
      allocationCell(
        0,
        plan({
          outcome: 'blocked',
          blockReason: 'next_milestone_invalid',
          gaps: ['no_done_means', 'no_issues'],
        })
      )
    ).toEqual({
      label: 'Blocked',
      detail: 'Next milestone is missing: done means…, issues',
      tone: 'warning',
      filled: true,
      toneDetail: true,
    });
    // Without a recorded reason the chip still says Blocked.
    expect(
      allocationCell(0, plan({ outcome: 'blocked', blockReason: null }))
    ).toEqual({ label: 'Blocked', tone: 'warning', filled: true });
  });
});

describe('buildProjectsPage', () => {
  const view = timeline([
    [
      lane(),
      lane({
        projectId: 'proj-2',
        name: 'Harbor API v3',
        leadId: 'human:elena',
        leadName: 'Elena Hart',
        bars: [
          bar({
            milestoneId: 'ms-h1',
            projectId: 'proj-2',
            name: 'Public beta',
            status: 'at_risk',
            reasons: ['unassigned_open', 'behind_pace'],
            rubric: { valid: false, gaps: ['no_done_means'] },
            end: '2026-10-25',
            daysLeft: 4,
            progress: progress({ completed: 0, scope: 3, openUnassigned: 1 }),
          }),
        ],
        allocation: plan({
          projectId: 'proj-2',
          outcome: 'blocked',
          blockReason: 'next_milestone_invalid',
          nextMilestoneId: 'ms-h1',
          gaps: ['no_done_means'],
        }),
      }),
    ],
    [
      lane({
        projectId: 'proj-3',
        name: 'Delta exports',
        leadId: null,
        leadName: null,
        bars: [],
        undated: [
          bar({
            milestoneId: 'ms-d1',
            projectId: 'proj-3',
            name: 'CSV exports',
            end: null,
            daysLeft: null,
            status: 'unscheduled',
          }),
        ],
        allocation: plan({
          projectId: 'proj-3',
          outcome: 'blocked',
          blockReason: 'no_lead',
          nextMilestoneId: 'ms-d1',
        }),
      }),
      lane({
        projectId: 'proj-4',
        name: 'Fjord analytics',
        statusType: 'paused',
        active: false,
        bars: [
          bar({
            milestoneId: 'ms-f1',
            projectId: 'proj-4',
            name: 'Dashboards',
            status: 'overdue',
            end: '2026-10-16',
            daysLeft: -5,
          }),
        ],
        allocation: plan({ projectId: 'proj-4', outcome: 'inactive' }),
      }),
      lane({
        projectId: 'proj-5',
        name: 'Juniper design system',
        bars: [
          bar({ milestoneId: 'ms-j1', isNext: false, status: 'complete' }),
        ],
        allocation: plan({
          projectId: 'proj-5',
          outcome: 'no_open_milestone',
          nextMilestoneId: null,
        }),
      }),
      // The synthetic lane for loose milestones is not a project.
      lane({
        projectId: noProjectId(null),
        name: 'No project',
        leadId: null,
        leadName: null,
        allocation: null,
      }),
    ],
  ]);
  const built = page(view, {
    projects: [
      ['proj-1', 'Working'],
      ['proj-4', 'Working'],
    ],
    epicProgressById: liveRuns([['ms-1', ['r-1', 'r-2']]]),
  });
  const rows = built.groups.flatMap((g) => g.rows);
  const row = (id: string) => {
    const found = rows.find((r) => r.id === id);
    if (found === undefined) throw new Error(`no row ${id}`);
    return found;
  };

  test('groups rows by initiative in timeline order, the synthetic lane left out', () => {
    expect(built.groups.map((g) => [g.id, g.name, g.rows.length])).toEqual([
      ['init-0', 'Initiative 0', 2],
      ['none', 'No initiative', 3],
    ]);
    expect(row('proj-3').initiative).toBe('No initiative');
    expect(rows.map((r) => r.id)).not.toContain(noProjectId(null));
  });

  test('each group links to its initiative’s graph', () => {
    expect(built.groups.map((g) => g.graphHref)).toEqual([
      '#/graph?initiative=init-0',
      '#/graph?initiative=none',
    ]);
    // Without initiatives the only group is "No initiative" and its graph
    // is the workspace's projects.
    const flat = page(timeline([[lane({ projectId: 'proj-9' })]]));
    expect(flat.groups.map((g) => [g.id, g.graphHref])).toEqual([
      ['none', '#/graph?level=project'],
    ]);
  });

  test('a group left with no project is dropped', () => {
    const loose = page(
      timeline([
        [lane({ projectId: noProjectId('init-0'), name: 'No project' })],
        [lane()],
      ])
    );
    expect(loose.groups.map((g) => g.id)).toEqual(['none']);
    expect(loose.receipts).toBe('1 project · 0 at risk');
  });

  test("uses the project's own status name, falling back to the type's", () => {
    expect(row('proj-1').status).toBe('Working');
    expect(row('proj-2').status).toBe('In progress');
    expect(row('proj-5').status).toBe('In progress');
    // The status chip: started is info.
    expect(row('proj-1').statusTone).toBe('info');
    // An inactive project's row carries no status colour: paused is grey,
    // not amber, even with a status name of its own.
    expect(row('proj-4').status).toBe('Working');
    expect(row('proj-4').statusTone).toBe('muted');
  });

  test('a paused project the workspace counts as active keeps its amber', () => {
    const active = page(
      timeline([
        [lane({ projectId: 'proj-p', statusType: 'paused', active: true })],
      ])
    );
    expect(active.groups[0]?.rows[0]?.statusTone).toBe('warning');
  });

  test('an active project not started yet keeps the neutral chip, not the grey', () => {
    const early = page(
      timeline([
        [
          lane({ projectId: 'proj-b', statusType: 'backlog' }),
          lane({ projectId: 'proj-q', statusType: 'planned' }),
        ],
      ])
    );
    expect(early.groups[0]?.rows.map((r) => [r.id, r.statusTone])).toEqual([
      ['proj-b', 'default'],
      ['proj-q', 'default'],
    ]);
  });

  test('describes the next milestone with the planning wording', () => {
    expect(row('proj-1').next).toEqual({
      id: 'ms-1',
      name: 'Dual-write',
      dueLabel: 'Oct 28 · in 7 days',
      dueTone: 'default',
      status: 'on_track',
      statusLabel: 'On track',
      done: 1,
      total: 4,
      progressTone: 'default',
      muted: false,
    });
    // Behind pace: the progress is a warning; the invalid rubric keeps the
    // at-risk mark (more urgent than a missing input).
    expect(row('proj-2').next?.progressTone).toBe('warning');
    expect(row('proj-2').next?.status).toBe('at_risk');
    expect(row('proj-3').next?.dueLabel).toBe('No target date');
    // Undated: the missing date is a warning.
    expect(row('proj-3').next?.dueTone).toBe('warning');
    expect(row('proj-3').next?.status).toBe('missing');
    expect(row('proj-5').next).toBeNull();
  });

  test("an inactive project's overdue next milestone is drawn in greys", () => {
    expect(row('proj-4').next).toMatchObject({
      dueLabel: 'Oct 16 · 5 days overdue',
      dueTone: 'muted',
      status: 'overdue',
      statusLabel: 'Overdue · inactive project',
      progressTone: 'muted',
      muted: true,
    });
  });

  test('marks leads, tones and filter tags', () => {
    expect(row('proj-1').lead).toBe('Chloe Diaz');
    expect(row('proj-3').lead).toBeNull();
    expect(row('proj-3').rowTone).toBe('warning');
    expect(row('proj-4').rowTone).toBe('muted');
    expect(row('proj-1').rowTone).toBe('default');
    expect(row('proj-2').tags).toEqual(['blocked', 'at_risk']);
    expect(row('proj-3').tags).toEqual(['blocked']);
    // Overdue, but inactive: never counted as at risk.
    expect(row('proj-4').tags).toEqual(['inactive']);
    expect(row('proj-1').tags).toEqual([]);
  });

  test('the allocation cell: agents working, else the plan', () => {
    // Two runs live under proj-1's next milestone.
    expect(row('proj-1').allocation).toEqual({
      label: '2 agents working',
      tone: 'info',
    });
    expect(row('proj-3').allocation.label).toBe('Blocked');
    expect(row('proj-3').allocation.detail).toBe('Project has no lead');
    expect(row('proj-2').allocation.detail).toBe(
      'Next milestone is missing: done means…'
    );
    expect(row('proj-5').allocation.label).toBe('No open milestone');
  });

  test('links each row to its timeline lane, its graph and its page', () => {
    expect(row('proj-2').timelineHref).toBe('#/timeline?project=proj-2');
    expect(row('proj-2').graphHref).toBe('#/graph?project=proj-2');
    expect(row('proj-2').openHref).toBe('#/task/proj-2');
  });

  test('counts every filter and writes the receipts line', () => {
    expect(built.filters).toEqual([
      { id: 'all', label: 'All', count: 5 },
      { id: 'blocked', label: 'Blocked', count: 2 },
      { id: 'at_risk', label: 'At risk', count: 1 },
      { id: 'inactive', label: 'Inactive', count: 1 },
    ]);
    expect(built.total).toBe(5);
    expect(built.receipts).toBe('5 projects in 1 initiative · 1 at risk');
  });

  test('filterProjectGroups narrows by tag and by every search word', () => {
    const ids = (groups: ReturnType<typeof filterProjectGroups>) =>
      groups.flatMap((g) => g.rows.map((r) => r.id));
    expect(ids(filterProjectGroups(built.groups, '', 'all'))).toEqual([
      'proj-1',
      'proj-2',
      'proj-3',
      'proj-4',
      'proj-5',
    ]);
    expect(ids(filterProjectGroups(built.groups, '', 'blocked'))).toEqual([
      'proj-2',
      'proj-3',
    ]);
    expect(ids(filterProjectGroups(built.groups, '', 'inactive'))).toEqual([
      'proj-4',
    ]);
    // Name, initiative, lead, next milestone and "no lead" are searchable.
    expect(ids(filterProjectGroups(built.groups, 'HARBOR', 'all'))).toEqual([
      'proj-2',
    ]);
    expect(
      ids(filterProjectGroups(built.groups, 'initiative 0', 'all'))
    ).toEqual(['proj-1', 'proj-2']);
    expect(ids(filterProjectGroups(built.groups, 'elena beta', 'all'))).toEqual(
      ['proj-2']
    );
    expect(ids(filterProjectGroups(built.groups, 'no lead', 'all'))).toEqual([
      'proj-3',
    ]);
    // The blocked reason under the chip is searchable too.
    expect(
      ids(filterProjectGroups(built.groups, 'missing: done', 'all'))
    ).toEqual(['proj-2']);
    // Groups left empty are dropped.
    const onlyInactive = filterProjectGroups(built.groups, '', 'inactive');
    expect(onlyInactive.map((g) => g.id)).toEqual(['none']);
    expect(countProjectRows(onlyInactive)).toBe(1);
    expect(filterProjectGroups(built.groups, 'nothing-matches', 'all')).toEqual(
      []
    );
  });

  test('parseProjectFilter accepts known ids only', () => {
    expect(parseProjectFilter('blocked')).toBe('blocked');
    expect(parseProjectFilter('at_risk')).toBe('at_risk');
    expect(parseProjectFilter('nope')).toBe('all');
    expect(parseProjectFilter(undefined)).toBe('all');
  });
});
