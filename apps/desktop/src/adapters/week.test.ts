import type {
  Progress,
  ProjectAllocationPlan,
  TimelineBar,
  TimelineLane,
  TimelineView,
  User,
  WeekIssueRow,
  WeekSection,
  WeekView,
} from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import {
  atRiskInLedProjects,
  buildAttention,
  buildWeekPage,
  resolveWeekUserId,
  weekPeopleOptions,
} from './week';

// Hand-built planning view models (Wed Oct 21, 2026), as projects.test.ts
// builds them: only the fields My week reads are meaningful.

const TODAY = '2026-10-21';
const ME = 'human:chloe';

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
    end: '2026-10-23',
    status: 'on_track',
    reasons: [],
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Both stores agree', source: 'planner' },
    progress: progress(),
    isNext: true,
    daysLeft: 2,
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
    name: 'Atlas',
    url: '#/task/proj-1',
    leadId: ME,
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

function timeline(lanes: TimelineLane[]): TimelineView {
  return {
    today: TODAY,
    windowStart: '2026-10-07',
    windowEnd: '2026-12-30',
    groups: [{ initiativeId: null, name: 'No initiative', lanes }],
    banners: {
      projectsWithoutLead: [],
      milestonesWithoutDate: [],
      issuesWithoutMilestone: { count: 0, byProject: [] },
      blockedProjects: [],
    },
  };
}

function row(id: string, overrides: Partial<WeekIssueRow> = {}): WeekIssueRow {
  return {
    issueId: id,
    identifier: id.toUpperCase(),
    title: `Issue ${id}`,
    url: `#/task/${id}`,
    priority: 2,
    stateName: 'Todo',
    stateType: 'unstarted',
    newBecauseLeadOf: null,
    ...overrides,
  };
}

function section(overrides: Partial<WeekSection> = {}): WeekSection {
  return {
    milestoneId: 'ms-1',
    milestoneName: 'Dual-write',
    projectId: 'proj-1',
    projectName: 'Atlas',
    projectUrl: '#/task/proj-1',
    targetDate: '2026-10-23',
    daysLeft: 2,
    status: 'on_track',
    progress: progress(),
    thisWeek: true,
    rows: [row('t-1')],
    ...overrides,
  };
}

function week(sections: WeekSection[], userId = ME): WeekView {
  let open = 0;
  let thisWeek = 0;
  for (const each of sections) {
    open += each.rows.length;
    if (each.thisWeek) thisWeek += each.rows.length;
  }
  return {
    userId,
    userName: userId === ME ? 'Chloe Diaz' : 'Dev Patel',
    today: TODAY,
    sections,
    totals: { open, thisWeek, overdue: 0, new: 0 },
  };
}

function page(view: WeekView, lanes: TimelineLane[], viewerId = ME) {
  return buildWeekPage({
    week: view,
    timeline: timeline(lanes),
    viewerId,
    hour: 9,
    newBadgeDays: 3,
    issueProjects: new Map(),
  });
}

function user(id: string, name: string, more: Partial<User> = {}): User {
  return {
    id,
    name,
    displayName: name,
    email: null,
    avatarUrl: null,
    active: true,
    app: false,
    ...more,
  };
}

describe('buildWeekPage', () => {
  test('greets by the email local part when the registry name is an address', () => {
    const view = { ...week([section()]), userName: 'wsoule679@gmail.com' };
    expect(page(view, [lane()]).heading).toBe('Good morning, wsoule679');
  });

  test('greets the viewer and splits This week from Later', () => {
    const model = page(
      week([
        section(),
        section({
          milestoneId: 'ms-2',
          milestoneName: 'Cutover',
          targetDate: '2026-11-20',
          daysLeft: 30,
          thisWeek: false,
          rows: [row('t-2')],
        }),
      ]),
      [lane({ bars: [bar(), bar({ milestoneId: 'ms-2', name: 'Cutover' })] })]
    );
    expect(model.heading).toBe('Good morning, Chloe');
    expect(model.receipts).toBe(
      'Wednesday, October 21 · 1 issue due this week'
    );
    expect(model.sections.map((each) => each.id)).toEqual([
      'this-week',
      'later',
    ]);
    expect(model.sections[0]?.groups[0]?.rows[0]?.href).toBe('#/task/t-1');
    expect(model.sections[0]?.groups[0]?.href).toBe('#/task/ms-1');
  });

  test("names the person on someone else's week", () => {
    const model = page(week([section()], 'human:dev'), [], ME);
    expect(model.isSelf).toBe(false);
    expect(model.heading).toBe("Dev Patel's week");
    expect(model.issuesTitle).toBe("Dev Patel's issues");
  });

  test('groups unplanned issues under their project lane', () => {
    const model = page(
      week([
        section({
          milestoneId: null,
          milestoneName: null,
          projectId: null,
          projectName: null,
          projectUrl: null,
          targetDate: null,
          daysLeft: null,
          status: null,
          progress: null,
          thisWeek: false,
          rows: [row('t-3'), row('t-4')],
        }),
      ]),
      [lane({ unplannedIssueIds: ['t-3'] })]
    );
    const noMilestone = model.sections.find(
      (each) => each.id === 'no-milestone'
    );
    expect(noMilestone?.groups.map((group) => group.title)).toEqual([
      'Issues without a milestone',
      'Issues without a project or milestone',
    ]);
    expect(noMilestone?.groups[0]?.href).toBe('#/timeline?project=proj-1');
  });

  test('puts a milestone due in two days under This week deadlines', () => {
    const model = page(week([section()]), [lane()]);
    const thisWeek = model.deadlines.find((group) => group.id === 'this-week');
    expect(thisWeek?.items.map((item) => item.label)).toEqual(['Dual-write']);
    expect(thisWeek?.items[0]?.sublabel).toBe('3 open · Atlas');
  });

  test('counts overdue milestones in active projects only', () => {
    const overdue = section({ status: 'overdue', daysLeft: -2 });
    const quiet = section({
      milestoneId: 'ms-9',
      status: 'overdue',
      daysLeft: -5,
      thisWeek: false,
    });
    const model = page(week([overdue, quiet]), [
      lane({ bars: [bar({ status: 'overdue', daysLeft: -2 })] }),
      lane({
        projectId: 'proj-9',
        active: false,
        bars: [bar({ milestoneId: 'ms-9', projectId: 'proj-9' })],
      }),
    ]);
    const stat = model.stats.find((cell) => cell.id === 'overdue');
    expect(stat?.value).toBe(1);
    expect(stat?.note).toBe('Atlas · Dual-write · +1 in an inactive project');
    expect(stat?.tone).toBe('danger');
  });
});

describe('buildAttention', () => {
  test('lists blocked projects before ones with unassigned work', () => {
    const items = buildAttention(
      timeline([
        lane({
          projectId: 'p-a',
          name: 'Alpha',
          bars: [bar({ progress: progress({ openUnassigned: 2 }) })],
        }),
        lane({
          projectId: 'p-b',
          name: 'Beta',
          allocation: plan({ outcome: 'blocked', blockReason: 'no_lead' }),
        }),
      ]),
      ME
    );
    expect(items.map((item) => [item.projectName, item.flag])).toEqual([
      ['Beta', 'Blocked'],
      ['Alpha', '2 unassigned'],
    ]);
  });

  test('ignores projects someone else leads, and inactive ones', () => {
    const items = buildAttention(
      timeline([
        lane({ leadId: 'human:dev' }),
        lane({
          active: false,
          allocation: plan({ outcome: 'blocked', blockReason: 'no_lead' }),
        }),
      ]),
      ME
    );
    expect(items).toEqual([]);
  });
});

describe('atRiskInLedProjects', () => {
  test('lists overdue before at risk', () => {
    const list = atRiskInLedProjects(
      timeline([
        lane({
          bars: [
            bar({ milestoneId: 'a', name: 'A', status: 'at_risk' }),
            bar({ milestoneId: 'b', name: 'B', status: 'overdue' }),
          ],
        }),
      ]),
      ME
    );
    expect(list.map((item) => item.milestone)).toEqual(['B', 'A']);
  });
});

describe('people', () => {
  test('lists people only, the viewer marked, inactive last', () => {
    const options = weekPeopleOptions(
      [
        user('human:zed', 'Zed', { active: false }),
        user('agent', 'claude', { app: true }),
        user(ME, 'Chloe Diaz'),
        user('human:ann', 'Ann'),
      ],
      ME
    );
    expect(options.map((option) => option.label)).toEqual([
      'Ann',
      'Chloe Diaz (you)',
      'Zed (inactive)',
    ]);
  });

  test('falls back from an unknown person to the viewer, then anyone', () => {
    const known = new Set(['human:ann', ME]);
    expect(
      resolveWeekUserId({
        requested: 'gone',
        viewerId: ME,
        knownUserIds: known,
      })
    ).toBe(ME);
    expect(
      resolveWeekUserId({
        requested: null,
        viewerId: null,
        knownUserIds: known,
      })
    ).toBe('human:ann');
    expect(
      resolveWeekUserId({
        requested: null,
        viewerId: null,
        knownUserIds: new Set(),
      })
    ).toBeNull();
  });
});
