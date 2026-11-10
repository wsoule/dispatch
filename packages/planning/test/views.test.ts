import { describe, expect, test } from 'bun:test';

import {
  buildMilestoneDetail,
  buildTimelineView,
  buildWeekView,
  planAllocation,
} from '../src/index';
import type { Issue, RecentAllocation, WorkspaceData } from '../src/index';
import {
  ago,
  day,
  evaluate,
  initiative,
  issue,
  meta,
  milestone,
  project,
  STATE,
  TODAY,
  user,
  workspace,
} from './helpers';

describe('buildWeekView', () => {
  const ana = (id: string, overrides: Partial<Issue> = {}): Issue =>
    issue(id, {
      identifier: id,
      assigneeId: 'ana',
      stateId: STATE.started,
      createdAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    });
  const data: WorkspaceData = workspace({
    users: [user('lead'), user('ana'), user('bob')],
    projects: [
      project('pA', { name: 'Alpha', priority: 1 }),
      project('pB', { name: 'Bravo', leadId: 'bob', priority: 1 }),
    ],
    milestones: [
      milestone('mUndated', 'pA', { name: 'Someday', targetDate: null }),
      milestone('mLater', 'pB', { name: 'Later', targetDate: day(30) }),
      milestone('mSeven', 'pB', { name: 'Seven', targetDate: day(7) }),
      milestone('mSix', 'pA', { name: 'Six', targetDate: day(6) }),
      milestone('mOver', 'pA', { name: 'Late', targetDate: day(-1) }),
      milestone('mOther', 'pA', { name: 'Not hers', targetDate: day(2) }),
    ],
    issues: [
      ana('U-1', { projectId: 'pA', milestoneId: 'mUndated' }),
      ana('L-1', { projectId: 'pB', milestoneId: 'mLater' }),
      ana('V-1', { projectId: 'pB', milestoneId: 'mSeven' }),
      ana('S-2', { projectId: 'pA', milestoneId: 'mSix', priority: 3 }),
      ana('S-1', { projectId: 'pA', milestoneId: 'mSix', priority: 1 }),
      ana('S-3', { projectId: 'pA', milestoneId: 'mSix', stateId: STATE.done }),
      ana('O-1', {
        projectId: 'pA',
        milestoneId: 'mOver',
        stateId: STATE.todo,
      }),
      ana('N-1', { projectId: 'pA' }),
      ana('N-2'),
      ana('G-1', { projectId: 'pA', milestoneId: 'ghost' }),
      issue('X-1', {
        identifier: 'X-1',
        projectId: 'pA',
        milestoneId: 'mOther',
        assigneeId: 'lead',
      }),
    ],
  });
  const recent: RecentAllocation[] = [
    {
      issueId: 'S-1',
      assigneeId: 'ana',
      projectId: 'pA',
      milestoneId: 'mSix',
      at: ago(2),
    },
    {
      issueId: 'O-1',
      assigneeId: 'ana',
      projectId: 'pA',
      milestoneId: 'mOver',
      at: ago(7),
    },
    {
      issueId: 'V-1',
      assigneeId: 'ana',
      projectId: 'pB',
      milestoneId: 'mSeven',
      at: ago(7.01),
    },
    {
      issueId: 'L-1',
      assigneeId: 'bob',
      projectId: 'pB',
      milestoneId: 'mLater',
      at: ago(1),
    },
    {
      issueId: 'X-1',
      assigneeId: 'ana',
      projectId: 'pA',
      milestoneId: 'mOther',
      at: ago(1),
    },
  ];

  function week(userId: string, weights: Record<string, number> = {}) {
    const evaluated = evaluate(data, {
      meta: Object.entries(weights).map(([id, weight]) => meta(id, { weight })),
    });
    return buildWeekView({ ...evaluated, userId, recentAllocations: recent });
  }

  test('sections in display order, "No milestone" last, rows in issue order', () => {
    const view = week('ana');
    expect(view.userName).toBe('Ana');
    expect(view.today).toBe(TODAY);
    expect(
      view.sections.map((s) => [s.milestoneId, s.rows.map((r) => r.identifier)])
    ).toEqual([
      ['mOver', ['O-1']],
      ['mSix', ['S-1', 'S-2']],
      ['mSeven', ['V-1']],
      ['mLater', ['L-1']],
      ['mUndated', ['U-1']],
      [null, ['G-1', 'N-1', 'N-2']],
    ]);
  });

  test('thisWeek boundary: overdue or daysLeft <= 6', () => {
    const view = week('ana');
    expect(
      view.sections.map((s) => [s.milestoneName, s.daysLeft, s.thisWeek])
    ).toEqual([
      ['Late', -1, true],
      ['Six', 6, true],
      ['Seven', 7, false],
      ['Later', 30, false],
      ['Someday', null, false],
      [null, null, false],
    ]);
  });

  test('section headers carry project, date, status and progress', () => {
    const [late, six] = week('ana').sections;
    expect(late).toMatchObject({
      projectId: 'pA',
      projectName: 'Alpha',
      projectUrl: 'https://linear.app/acme/project/pA',
      targetDate: day(-1),
      status: 'overdue',
    });
    expect(six?.progress).toMatchObject({ completed: 1, scope: 3, open: 2 });
    const none = week('ana').sections.at(-1);
    expect(none).toMatchObject({
      projectId: null,
      status: null,
      progress: null,
      targetDate: null,
    });
  });

  test('"new" only for this user\'s recent allocations that are still theirs', () => {
    const rows = week('ana').sections.flatMap((s) => s.rows);
    expect(
      Object.fromEntries(rows.map((r) => [r.identifier, r.newBecauseLeadOf]))
    ).toEqual({
      'O-1': 'Alpha', // exactly newBadgeDays old still counts
      'S-1': 'Alpha',
      'S-2': null,
      'V-1': null, // older than newBadgeDays
      'L-1': null, // allocated to someone else
      'U-1': null,
      'G-1': null,
      'N-1': null,
      'N-2': null,
    });
    // X-1 was allocated to ana but now belongs to lead: no mark for anyone.
    const leadRows = week('lead').sections.flatMap((s) => s.rows);
    expect(leadRows.map((r) => [r.identifier, r.newBecauseLeadOf])).toEqual([
      ['X-1', null],
    ]);
  });

  test('rows carry state, priority and link', () => {
    const row = week('ana').sections[0]?.rows[0];
    expect(row).toEqual({
      issueId: 'O-1',
      identifier: 'O-1',
      title: 'Issue O-1',
      url: 'https://linear.app/acme/issue/O-1',
      priority: 0,
      stateName: 'Todo',
      stateType: 'unstarted',
      newBecauseLeadOf: 'Alpha',
    });
  });

  test('totals', () => {
    expect(week('ana').totals).toEqual({
      open: 9,
      thisWeek: 3,
      overdue: 1,
      new: 2,
    });
  });

  test('overdue counts milestones, not the issues in them (§8.4)', () => {
    const evaluated = evaluate(
      workspace({
        users: [user('lead'), user('ana')],
        projects: [project('pA')],
        milestones: [
          milestone('late1', 'pA', { targetDate: day(-3) }),
          milestone('late2', 'pA', { targetDate: day(-1) }),
        ],
        issues: [
          ana('a', { projectId: 'pA', milestoneId: 'late1' }),
          ana('b', { projectId: 'pA', milestoneId: 'late1' }),
          ana('c', { projectId: 'pA', milestoneId: 'late1' }),
          ana('d', { projectId: 'pA', milestoneId: 'late2' }),
        ],
      })
    );
    const view = buildWeekView({
      ...evaluated,
      userId: 'ana',
      recentAllocations: [],
    });
    expect(view.totals).toEqual({ open: 4, thisWeek: 4, overdue: 2, new: 0 });
  });

  test('an inactive project is never due this week or counted overdue (§2.8)', () => {
    const evaluated = evaluate(
      workspace({
        users: [user('lead'), user('ana')],
        projects: [
          project('pA'),
          project('pPaused', { statusType: 'paused', statusName: 'Paused' }),
        ],
        milestones: [
          milestone('late', 'pA', { targetDate: day(-2) }),
          milestone('pausedLate', 'pPaused', { targetDate: day(-5) }),
          milestone('pausedSoon', 'pPaused', { targetDate: day(3) }),
        ],
        issues: [
          ana('a', { projectId: 'pA', milestoneId: 'late' }),
          ana('p1', { projectId: 'pPaused', milestoneId: 'pausedLate' }),
          ana('p2', { projectId: 'pPaused', milestoneId: 'pausedSoon' }),
        ],
      })
    );
    const view = buildWeekView({
      ...evaluated,
      userId: 'ana',
      recentAllocations: [],
    });
    // Still listed with their real status; just not this week.
    expect(
      view.sections.map((s) => [s.milestoneId, s.status, s.thisWeek])
    ).toEqual([
      ['pausedLate', 'overdue', false],
      ['late', 'overdue', true],
      ['pausedSoon', 'at_risk', false],
    ]);
    expect(view.totals).toEqual({ open: 3, thisWeek: 1, overdue: 1, new: 0 });
  });

  test('a weight override reorders sections but overdue stays on top', () => {
    const view = week('ana', { mLater: 3 });
    expect(view.sections.map((s) => s.milestoneId)).toEqual([
      'mOver',
      'mLater',
      'mSix',
      'mSeven',
      'mUndated',
      null,
    ]);
  });

  test('a user with nothing open gets an empty view', () => {
    const view = week('bob');
    expect(view.sections).toEqual([]);
    expect(view.totals).toEqual({ open: 0, thisWeek: 0, overdue: 0, new: 0 });
  });
});

describe('buildTimelineView', () => {
  const data = workspace({
    users: [user('lead'), user('ana')],
    initiatives: [
      initiative('iLow', { name: 'Later bets', priority: 4 }),
      initiative('iUrgent', { name: 'Migration', priority: 1 }),
    ],
    projects: [
      project('pX', {
        name: 'X',
        initiativeIds: ['iUrgent'],
        priority: 2,
        sortOrder: 1,
        startDate: day(-30),
      }),
      project('pY', {
        name: 'Y',
        initiativeIds: ['iLow', 'iUrgent'],
        priority: 2,
        sortOrder: 0,
        leadId: null,
      }),
      project('pUrgentLow', {
        name: 'U',
        initiativeIds: ['iUrgent'],
        priority: 0,
      }),
      project('pZ', {
        name: 'Z',
        initiativeIds: ['iLow'],
        statusType: 'paused',
        leadId: null,
      }),
      project('pDone', {
        name: 'Done',
        initiativeIds: ['iLow'],
        statusType: 'completed',
      }),
      project('pLoose', { name: 'Loose', startDate: day(20) }),
    ],
    milestones: [
      milestone('x2', 'pX', { targetDate: day(10), sortOrder: 1 }),
      milestone('x3', 'pX', { targetDate: day(10), sortOrder: 2 }),
      milestone('xU', 'pX', { targetDate: null, name: 'Someday' }),
      milestone('x1', 'pX', { targetDate: day(-20) }),
      milestone('y1', 'pY', { targetDate: day(5), description: null }),
      milestone('l1', 'pLoose', { targetDate: day(3) }),
      milestone('done1', 'pDone', { targetDate: null }),
      milestone('zU', 'pZ', { targetDate: null, name: 'Paused someday' }),
    ],
    issues: [
      issue('x1-i', {
        projectId: 'pX',
        milestoneId: 'x1',
        stateId: STATE.done,
        assigneeId: 'ana',
      }),
      issue('x2-i', { projectId: 'pX', milestoneId: 'x2', assigneeId: 'ana' }),
      issue('x3-i', { projectId: 'pX', milestoneId: 'x3', assigneeId: 'ana' }),
      issue('y1-i', { projectId: 'pY', milestoneId: 'y1' }),
      issue('l1-i', {
        projectId: 'pLoose',
        milestoneId: 'l1',
        assigneeId: 'ana',
      }),
      issue('x-unplanned-2', {
        projectId: 'pX',
        identifier: 'ENG-902',
        priority: 2,
      }),
      issue('x-unplanned-1', {
        projectId: 'pX',
        identifier: 'ENG-901',
        priority: 1,
      }),
      issue('x-unplanned-done', { projectId: 'pX', stateId: STATE.done }),
      issue('y-ghost', { projectId: 'pY', milestoneId: 'ghost' }),
      issue('no-project', {}),
      issue('z-unplanned', { projectId: 'pZ', identifier: 'ENG-990' }),
    ],
  });
  const evaluated = evaluate(data, { meta: [meta('x2', { weight: 4 })] });
  const allocationPlan = planAllocation(
    evaluated.snapshot,
    evaluated.ctx,
    evaluated.assessments
  );
  const view = buildTimelineView({ ...evaluated, allocationPlan });

  test('window from timelineDaysBack to timelineDaysAhead', () => {
    expect([view.today, view.windowStart, view.windowEnd]).toEqual([
      TODAY,
      day(-14),
      day(70),
    ]);
  });

  test('groups by initiative rank, first initiative wins, No initiative last; completed projects have no lane', () => {
    expect(
      view.groups.map((g) => [
        g.initiativeId,
        g.name,
        g.lanes.map((l) => l.projectId),
      ])
    ).toEqual([
      ['iUrgent', 'Migration', ['pY', 'pX', 'pUrgentLow']],
      ['iLow', 'Later bets', ['pZ']],
      [null, 'No initiative', ['pLoose']],
    ]);
  });

  test('lanes carry lead, status and allocation', () => {
    const lanes = view.groups.flatMap((g) => g.lanes);
    const byId = new Map(lanes.map((l) => [l.projectId, l]));
    expect(byId.get('pX')).toMatchObject({
      leadId: 'lead',
      leadName: 'Lead',
      active: true,
      statusType: 'started',
    });
    expect(byId.get('pZ')).toMatchObject({
      leadId: null,
      leadName: null,
      active: false,
    });
    expect(byId.get('pX')?.allocation?.outcome).toBe('nothing_to_do');
    expect(byId.get('pY')?.allocation).toMatchObject({
      outcome: 'blocked',
      blockReason: 'no_lead',
    });
  });

  test('bar starts: previous dated milestone, else project start, else window start; never after end', () => {
    const lanes = new Map(
      view.groups.flatMap((g) => g.lanes).map((l) => [l.projectId, l])
    );
    expect(
      lanes.get('pX')?.bars.map((b) => [b.milestoneId, b.start, b.end])
    ).toEqual([
      ['x1', day(-30), day(-20)],
      ['x2', day(-20), day(10)],
      ['x3', day(10), day(10)],
    ]);
    expect(
      lanes.get('pX')?.undated.map((b) => [b.milestoneId, b.start, b.end])
    ).toEqual([['xU', day(-30), null]]);
    expect(lanes.get('pY')?.bars.map((b) => [b.start, b.end])).toEqual([
      [day(-14), day(5)],
    ]);
    expect(lanes.get('pLoose')?.bars.map((b) => [b.start, b.end])).toEqual([
      [day(3), day(3)],
    ]);
  });

  test('a malformed project start date falls back to the window start', () => {
    const ev = evaluate(
      workspace({
        projects: [project('pBad', { startDate: '2026-02-30' })],
        milestones: [
          milestone('undated', 'pBad', { targetDate: null }),
          milestone('dated', 'pBad', { targetDate: day(5) }),
        ],
        issues: [
          issue('i', {
            projectId: 'pBad',
            milestoneId: 'dated',
            assigneeId: 'lead',
          }),
        ],
      })
    );
    const timeline = buildTimelineView({
      ...ev,
      allocationPlan: planAllocation(ev.snapshot, ev.ctx, ev.assessments),
    });
    const lane = timeline.groups[0]?.lanes[0];
    expect(lane?.bars.map((b) => [b.start, b.end])).toEqual([
      [day(-14), day(5)],
    ]);
    expect(lane?.undated.map((b) => [b.start, b.end])).toEqual([
      [day(-14), null],
    ]);
  });

  test('bars carry assessment, weight and next flag', () => {
    const lanes = new Map(
      view.groups.flatMap((g) => g.lanes).map((l) => [l.projectId, l])
    );
    const [x1, x2] = lanes.get('pX')?.bars ?? [];
    expect(x1).toMatchObject({
      status: 'complete',
      isNext: false,
      weight: null,
    });
    expect(x2).toMatchObject({
      status: 'on_track',
      isNext: true,
      weight: 4,
      daysLeft: 10,
    });
    expect(lanes.get('pY')?.bars[0]).toMatchObject({
      rubric: { valid: false, gaps: ['no_done_means', 'no_project_lead'] },
      doneMeans: { text: null, source: null },
    });
  });

  test('unplanned issues per lane: open, no (mirrored) milestone, in issue order', () => {
    const lanes = new Map(
      view.groups.flatMap((g) => g.lanes).map((l) => [l.projectId, l])
    );
    expect(lanes.get('pX')?.unplannedIssueIds).toEqual([
      'x-unplanned-1',
      'x-unplanned-2',
    ]);
    expect(lanes.get('pY')?.unplannedIssueIds).toEqual(['y-ghost']);
    expect(lanes.get('pLoose')?.unplannedIssueIds).toEqual([]);
  });

  test('banners', () => {
    expect(view.banners).toEqual({
      projectsWithoutLead: [{ projectId: 'pY', name: 'Y' }],
      milestonesWithoutDate: [
        {
          milestoneId: 'xU',
          name: 'Someday',
          projectId: 'pX',
          projectName: 'X',
        },
      ],
      issuesWithoutMilestone: {
        count: 3,
        byProject: [
          { projectId: 'pY', name: 'Y', issueIds: ['y-ghost'] },
          {
            projectId: 'pX',
            name: 'X',
            issueIds: ['x-unplanned-1', 'x-unplanned-2'],
          },
        ],
      },
      blockedProjects: [
        { projectId: 'pY', name: 'Y', reason: 'no_lead', gaps: [] },
      ],
    });
  });

  test('an inactive project keeps its undated and unplanned work on its lane, out of the banners', () => {
    const lanes = new Map(
      view.groups.flatMap((g) => g.lanes).map((l) => [l.projectId, l])
    );
    expect(lanes.get('pZ')?.undated.map((b) => b.milestoneId)).toEqual(['zU']);
    expect(lanes.get('pZ')?.unplannedIssueIds).toEqual(['z-unplanned']);
    const bannerProjects = [
      ...view.banners.projectsWithoutLead.map((p) => p.projectId),
      ...view.banners.milestonesWithoutDate.map((m) => m.projectId),
      ...view.banners.issuesWithoutMilestone.byProject.map((p) => p.projectId),
      ...view.banners.blockedProjects.map((p) => p.projectId),
    ];
    expect(bannerProjects).not.toContain('pZ');
  });
});

describe('buildMilestoneDetail', () => {
  const data = workspace({
    users: [user('lead'), user('ana')],
    projects: [
      project('p1', { name: 'Orion' }),
      project('p2', { name: 'Halo' }),
    ],
    milestones: [
      milestone('m1', 'p1', { name: 'Beta', targetDate: day(4) }),
      milestone('m2', 'p2', { name: 'Infra', targetDate: day(2) }),
      milestone('m3', 'p1', { name: 'Gamma', targetDate: day(-1) }),
    ],
    issues: [
      issue('done', {
        projectId: 'p1',
        milestoneId: 'm1',
        stateId: STATE.done,
        identifier: 'ENG-1',
        priority: 1,
      }),
      issue('open-low', {
        projectId: 'p1',
        milestoneId: 'm1',
        identifier: 'ENG-2',
        priority: 4,
        assigneeId: 'ana',
      }),
      issue('open-urgent', {
        projectId: 'p1',
        milestoneId: 'm1',
        identifier: 'ENG-3',
        priority: 1,
      }),
      issue('infra', {
        projectId: 'p2',
        milestoneId: 'm2',
        identifier: 'OPS-1',
      }),
      issue('gamma', {
        projectId: 'p1',
        milestoneId: 'm3',
        identifier: 'ENG-4',
      }),
      issue('closed-blocker', {
        projectId: 'p2',
        milestoneId: 'm2',
        identifier: 'OPS-2',
        stateId: STATE.done,
      }),
      issue('loose', { identifier: 'ENG-5' }),
    ],
    relations: [
      { id: 'r1', blockerId: 'infra', blockedId: 'open-urgent' },
      { id: 'r2', blockerId: 'closed-blocker', blockedId: 'open-urgent' },
      { id: 'r3', blockerId: 'gamma', blockedId: 'open-low' },
      { id: 'r4', blockerId: 'loose', blockedId: 'open-low' },
      // A closed issue's blockers do not make the milestone wait.
      { id: 'r5', blockerId: 'infra', blockedId: 'done' },
    ],
  });
  const evaluated = evaluate(data, {
    meta: [meta('m1', { weight: 2, doneMeans: 'Beta is live' })],
  });

  test('milestone, project, assessment and meta', () => {
    const detail = buildMilestoneDetail({ ...evaluated, milestoneId: 'm1' });
    expect(detail?.milestone.id).toBe('m1');
    expect(detail?.project.id).toBe('p1');
    expect(detail?.leadName).toBe('Lead');
    expect(detail?.assessment.doneMeans).toEqual({
      text: 'Beta is live',
      source: 'planner',
    });
    expect(detail?.meta).toMatchObject({
      weight: 2,
      doneMeans: 'Beta is live',
    });
  });

  test('issues: open first in issue order, with open blockers only', () => {
    const detail = buildMilestoneDetail({ ...evaluated, milestoneId: 'm1' });
    expect(
      detail?.issues.map((r) => [
        r.identifier,
        r.stateType,
        r.assigneeName,
        r.blockedByIds,
      ])
    ).toEqual([
      ['ENG-3', 'backlog', null, ['infra']],
      ['ENG-2', 'backlog', 'Ana', ['gamma', 'loose']],
      ['ENG-1', 'completed', null, ['infra']],
    ]);
    expect(detail?.issues[0]).toMatchObject({
      stateName: 'Backlog',
      url: 'https://linear.app/acme/issue/open-urgent',
    });
  });

  test('waitsOn lists the milestones of open blockers, in display order', () => {
    const detail = buildMilestoneDetail({ ...evaluated, milestoneId: 'm1' });
    expect(detail?.waitsOn).toEqual([
      { milestoneId: 'm3', name: 'Gamma', projectName: 'Orion' },
      { milestoneId: 'm2', name: 'Infra', projectName: 'Halo' },
    ]);
  });

  test('null for an unknown milestone or a missing assessment', () => {
    expect(
      buildMilestoneDetail({ ...evaluated, milestoneId: 'nope' })
    ).toBeNull();
    expect(
      buildMilestoneDetail({
        ...evaluated,
        assessments: new Map(),
        milestoneId: 'm1',
      })
    ).toBeNull();
  });
});
