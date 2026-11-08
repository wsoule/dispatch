import { describe, expect, test } from 'bun:test';

import {
  addDays,
  buildDigests,
  planAllocation,
  planWarnings,
  withWorkspaceParam,
} from '../src/index';
import type {
  IsoDate,
  Issue,
  Notice,
  WarningMemory,
  WarningPlan,
  WorkspaceData,
} from '../src/index';
import {
  ago,
  day,
  evaluate,
  issue,
  milestone,
  project,
  STATE,
  TODAY,
  user,
  workspace,
} from './helpers';

const WATCHERS = ['wyat', 'shanzer'];

// Runs the warning planner for `data` as of `today` with remembered `memory`.
function warn(
  data: WorkspaceData,
  memory: readonly WarningMemory[] = [],
  options: {
    today?: IsoDate;
    overdueRepeatDays?: number;
    watchers?: string[];
  } = {}
): WarningPlan {
  const today = options.today ?? TODAY;
  const evaluated = evaluate(data, {
    today,
    now: `${today}T15:00:00.000Z`,
    tuning:
      options.overdueRepeatDays === undefined
        ? {}
        : { overdueRepeatDays: options.overdueRepeatDays },
  });
  return planWarnings({
    ...evaluated,
    allocationPlan: planAllocation(
      evaluated.snapshot,
      evaluated.ctx,
      evaluated.assessments
    ),
    memory,
    watcherUserIds: options.watchers ?? WATCHERS,
  });
}

function milestoneNotices(result: WarningPlan): Notice[] {
  return result.notices.filter((n) => n.subjectKind === 'milestone');
}

function memoryFor(
  result: WarningPlan,
  subjectId: string
): WarningMemory | undefined {
  return result.memory.find((m) => m.subjectId === subjectId);
}

// One project (lead "lead") with milestone m1 due `targetDate` and issues.
function oneMilestone(
  targetDate: IsoDate | null,
  issues: Issue[],
  options: { description?: string | null; leadId?: string | null } = {}
): WorkspaceData {
  return workspace({
    users: [user('lead'), user('wyat'), user('shanzer'), user('ana')],
    projects: [
      project('p1', {
        name: 'Orion',
        leadId: options.leadId === undefined ? 'lead' : options.leadId,
      }),
    ],
    milestones: [
      milestone('m1', 'p1', {
        name: 'Beta',
        targetDate,
        description:
          options.description === undefined
            ? 'Done means: shipped'
            : options.description,
      }),
    ],
    issues: issues.map((i) => ({ ...i, projectId: 'p1', milestoneId: 'm1' })),
  });
}

// Due in 3 days with one unassigned issue: at risk.
const atRisk = (targetDate: IsoDate = day(3)): WorkspaceData =>
  oneMilestone(targetDate, [
    issue('a', { assigneeId: 'ana', stateId: STATE.done, identifier: 'ENG-1' }),
    issue('b', { assigneeId: 'ana', stateId: STATE.done, identifier: 'ENG-2' }),
    issue('c', { assigneeId: 'ana', stateId: STATE.done, identifier: 'ENG-3' }),
    issue('u', { identifier: 'ENG-4' }),
  ]);

describe('planWarnings: the send rule', () => {
  test('first notice for an at-risk milestone', () => {
    const result = warn(atRisk());
    expect(milestoneNotices(result)).toEqual([
      {
        kind: 'at_risk',
        subjectKind: 'milestone',
        subjectId: 'm1',
        projectId: 'p1',
        milestoneId: 'm1',
        key: `at_risk:${day(3)}`,
        targetDate: day(3),
        daysLeft: 3,
        reasons: ['unassigned_open'],
        gaps: [],
        blockReason: null,
        openIssueIds: ['u'],
        unassignedIssueIds: ['u'],
        recipientIds: ['lead', 'wyat', 'shanzer'],
        occurrence: 1,
      },
    ]);
    expect(memoryFor(result, 'm1')).toEqual({
      subjectKind: 'milestone',
      subjectId: 'm1',
      lastKey: `at_risk:${day(3)}`,
      lastNotifiedOn: TODAY,
      occurrence: 1,
    });
  });

  test('no repeat for the same key on later days', () => {
    const first = warn(atRisk());
    const second = warn(atRisk(), first.memory, { today: day(1) });
    expect(milestoneNotices(second)).toEqual([]);
    expect(memoryFor(second, 'm1')).toEqual({
      subjectKind: 'milestone',
      subjectId: 'm1',
      lastKey: `at_risk:${day(3)}`,
      lastNotifiedOn: TODAY,
      occurrence: 1,
    });
  });

  test('a re-dated milestone is announced again', () => {
    const first = warn(atRisk(day(3)));
    const second = warn(atRisk(day(5)), first.memory, { today: day(1) });
    expect(milestoneNotices(second).map((n) => [n.key, n.occurrence])).toEqual([
      [`at_risk:${day(5)}`, 1],
    ]);
  });

  test('a status change (at risk → overdue) is announced again', () => {
    const first = warn(atRisk(day(3)));
    const second = warn(atRisk(day(3)), first.memory, { today: day(4) });
    expect(
      milestoneNotices(second).map((n) => [n.kind, n.key, n.daysLeft])
    ).toEqual([['overdue', `overdue:${day(3)}`, -1]]);
  });

  test.each([
    // [overdueRepeatDays, days on which a notice goes out (0 = first overdue day)]
    [1, [0, 1, 2, 3, 4]],
    [3, [0, 3]],
    [2, [0, 2, 4]],
  ])(
    'overdue repeats every %d day(s) with a running occurrence count',
    (repeat, sendDays) => {
      const data = atRisk(day(-1));
      let memory: WarningMemory[] = [];
      const sent: [number, number][] = [];
      for (let offset = 0; offset <= 4; offset++) {
        const result = warn(data, memory, {
          today: addDays(TODAY, offset),
          overdueRepeatDays: repeat,
        });
        for (const notice of milestoneNotices(result))
          sent.push([offset, notice.occurrence]);
        memory = result.memory;
      }
      expect(sent).toEqual(sendDays.map((d, i) => [d, i + 1]));
    }
  );

  test('recovery then re-slip is announced again', () => {
    const slipping = atRisk();
    const first = warn(slipping);
    expect(milestoneNotices(first)).toHaveLength(1);

    const recovered = oneMilestone(day(3), [
      ...slipping.issues.filter((i) => i.id !== 'u'),
      issue('u', {
        assigneeId: 'ana',
        identifier: 'ENG-4',
        stateId: STATE.started,
      }),
    ]);
    const second = warn(recovered, first.memory, { today: day(1) });
    expect(milestoneNotices(second)).toEqual([]);
    expect(memoryFor(second, 'm1')).toMatchObject({
      lastKey: 'ok:on_track',
      occurrence: 0,
      lastNotifiedOn: TODAY,
    });

    const third = warn(atRisk(), second.memory, { today: day(2) });
    expect(milestoneNotices(third).map((n) => [n.key, n.occurrence])).toEqual([
      [`at_risk:${day(3)}`, 1],
    ]);
  });

  test('quiet states are remembered as ok:<status> and never notified', () => {
    const result = warn(
      workspace({
        projects: [project('p1')],
        milestones: [
          milestone('done', 'p1', { targetDate: day(2) }),
          milestone('fine', 'p1', { targetDate: day(30) }),
          milestone('undated', 'p1', { targetDate: null }),
        ],
        issues: [
          issue('d', {
            projectId: 'p1',
            milestoneId: 'done',
            stateId: STATE.done,
            assigneeId: 'lead',
          }),
          issue('f', {
            projectId: 'p1',
            milestoneId: 'fine',
            assigneeId: 'lead',
          }),
          issue('x', {
            projectId: 'p1',
            milestoneId: 'undated',
            assigneeId: 'lead',
          }),
        ],
      })
    );
    expect(result.notices).toEqual([]);
    expect(
      result.memory.map((m) => [
        m.subjectKind,
        m.subjectId,
        m.lastKey,
        m.lastNotifiedOn,
      ])
    ).toEqual([
      ['milestone', 'done', 'ok:complete', null],
      ['milestone', 'fine', 'ok:on_track', null],
      ['milestone', 'undated', 'ok:unscheduled', null],
      ['project', 'p1', 'ok', null],
    ]);
  });

  test('inactive projects are not evaluated at all', () => {
    const data = atRisk();
    data.projects = [project('p1', { statusType: 'paused', leadId: null })];
    const result = warn(data);
    expect(result).toEqual({ notices: [], memory: [] });
  });
});

describe('planWarnings: invalid_due_soon', () => {
  test('a milestone failing the rubric within the warning window', () => {
    const data = oneMilestone(
      day(5),
      [
        issue('a', { assigneeId: 'ana', stateId: STATE.done }),
        issue('b', { assigneeId: 'ana', stateId: STATE.done }),
        issue('c', { assigneeId: 'ana', stateId: STATE.done }),
        issue('o', { assigneeId: 'ana' }),
      ],
      {
        description: null,
      }
    );
    const [notice] = milestoneNotices(warn(data));
    expect(notice).toMatchObject({
      kind: 'invalid_due_soon',
      key: `invalid:${day(5)}:no_done_means`,
      gaps: ['no_done_means'],
      reasons: [],
    });
  });

  test('invalid wins over at_risk and keeps the risk reasons', () => {
    const data = oneMilestone(day(3), [issue('u')], { description: null });
    const [notice] = milestoneNotices(warn(data));
    expect(notice).toMatchObject({
      kind: 'invalid_due_soon',
      key: `invalid:${day(3)}:no_done_means`,
      reasons: ['unassigned_open', 'behind_pace'],
    });
  });

  test('overdue wins over invalid', () => {
    const data = oneMilestone(day(-1), [issue('u')], { description: null });
    const [notice] = milestoneNotices(warn(data));
    expect(notice).toMatchObject({
      kind: 'overdue',
      key: `overdue:${day(-1)}`,
      gaps: ['no_done_means'],
    });
  });

  test.each([
    ['due today', 0, true],
    ['due at the end of the window', 7, true],
    ['due after the window', 8, false],
  ])('%s → notified: %s', (_name, daysLeft, notified) => {
    const data = oneMilestone(
      day(daysLeft),
      [issue('a', { assigneeId: 'ana' })],
      { description: null }
    );
    const kinds = milestoneNotices(warn(data)).map((n) => n.kind);
    expect(kinds.includes('invalid_due_soon')).toBe(notified);
  });

  test('a complete milestone is never reported as invalid', () => {
    const data = oneMilestone(
      day(3),
      [
        issue('a', { assigneeId: 'ana', stateId: STATE.done }),
        issue('b', { assigneeId: 'ana', stateId: STATE.done }),
      ],
      { description: null }
    );
    expect(milestoneNotices(warn(data))).toEqual([]);
  });

  test('an empty milestone due soon is invalid (no issues)', () => {
    const [notice] = milestoneNotices(warn(oneMilestone(day(2), [])));
    expect(notice).toMatchObject({
      kind: 'invalid_due_soon',
      key: `invalid:${day(2)}:no_issues`,
    });
  });

  test('the gaps are part of the key: filling one re-notifies', () => {
    const missingBoth = oneMilestone(
      day(4),
      [issue('a', { assigneeId: 'ana' })],
      { description: null, leadId: null }
    );
    const first = warn(missingBoth);
    expect(milestoneNotices(first).map((n) => n.key)).toEqual([
      `invalid:${day(4)}:no_done_means,no_project_lead`,
    ]);
    const missingLead = oneMilestone(
      day(4),
      [issue('a', { assigneeId: 'ana' })],
      { leadId: null }
    );
    const second = warn(missingLead, first.memory, { today: TODAY });
    expect(milestoneNotices(second).map((n) => n.key)).toEqual([
      `invalid:${day(4)}:no_project_lead`,
    ]);
  });
});

describe('planWarnings: allocation_blocked', () => {
  test.each([
    [
      'no lead',
      { leadId: null },
      [user('wyat'), user('shanzer')],
      'blocked:no_lead:m1:',
      ['wyat', 'shanzer'],
    ],
    [
      'deactivated lead',
      {},
      [user('lead', { active: false }), user('wyat'), user('shanzer')],
      'blocked:lead_inactive:m1:',
      ['wyat', 'shanzer'],
    ],
    [
      'invalid next milestone',
      { description: null },
      [user('lead'), user('wyat'), user('shanzer')],
      'blocked:next_milestone_invalid:m1:no_done_means',
      ['wyat', 'shanzer', 'lead'],
    ],
  ] as const)('%s', (_name, options, users, key, recipients) => {
    const data = oneMilestone(day(20), [issue('u')], options);
    data.users = [...users];
    const notices = warn(data).notices.filter(
      (n) => n.kind === 'allocation_blocked'
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      subjectKind: 'project',
      subjectId: 'p1',
      projectId: 'p1',
      milestoneId: 'm1',
      key,
      targetDate: day(20),
      daysLeft: 20,
      openIssueIds: ['u'],
      unassignedIssueIds: ['u'],
      recipientIds: recipients,
      occurrence: 1,
    });
  });

  test('a project without a lead and no open milestone reaches the digest', () => {
    const data = workspace({
      projects: [project('p1', { name: 'Delta', leadId: null })],
      milestones: [milestone('m1', 'p1', { targetDate: day(-3) })],
      issues: [
        issue('d', { projectId: 'p1', milestoneId: 'm1', stateId: STATE.done }),
      ],
    });
    const result = warn(data);
    const notices = result.notices.filter(
      (n) => n.kind === 'allocation_blocked'
    );
    expect(notices).toEqual([
      expect.objectContaining({
        subjectId: 'p1',
        milestoneId: null,
        key: 'blocked:no_lead::',
        blockReason: 'no_lead',
        recipientIds: ['wyat', 'shanzer'],
      }),
    ]);
    const evaluated = evaluate(data);
    const digests = buildDigests({
      ...evaluated,
      notices: result.notices,
      appUrl: 'https://x.test',
      workspaceId: 'org-1',
    });
    expect(digests.map((d) => d.recipientId).sort()).toEqual([
      'shanzer',
      'wyat',
    ]);
    expect(digests[0]?.items[0]).toMatchObject({
      projectName: 'Delta',
      milestoneName: null,
      lines: ['no project lead, so nothing is being assigned'],
      url: 'https://x.test/timeline?project=p1&ws=org-1',
    });
  });

  test('a blocked project is told once until the reason changes', () => {
    const data = oneMilestone(day(20), [issue('u')], { leadId: null });
    const first = warn(data);
    const second = warn(data, first.memory, { today: day(1) });
    expect(
      second.notices.filter((n) => n.kind === 'allocation_blocked')
    ).toEqual([]);
    expect(memoryFor(second, 'p1')).toMatchObject({
      lastKey: 'blocked:no_lead:m1:',
      occurrence: 1,
      lastNotifiedOn: TODAY,
    });
  });
});

describe('planWarnings: recipients', () => {
  test('lead + watchers, deduplicated, inactive and unknown users dropped', () => {
    const data = atRisk();
    data.users = [
      user('lead'),
      user('wyat'),
      user('shanzer', { active: false }),
      user('ana'),
    ];
    const [notice] = milestoneNotices(
      warn(data, [], { watchers: ['wyat', 'lead', 'shanzer', 'ghost', 'wyat'] })
    );
    expect(notice?.recipientIds).toEqual(['lead', 'wyat']);
  });

  test('a deactivated lead is dropped from milestone notices', () => {
    const data = atRisk();
    data.users = [
      user('lead', { active: false }),
      user('wyat'),
      user('shanzer'),
      user('ana'),
    ];
    const [notice] = milestoneNotices(warn(data));
    expect(notice?.recipientIds).toEqual(['wyat', 'shanzer']);
  });
});

describe('buildDigests', () => {
  // Four projects, each producing a different kind of notice.
  const data = workspace({
    users: [
      user('lead'),
      user('bob'),
      user('wyat'),
      user('shanzer'),
      user('ana'),
    ],
    projects: [
      project('pA', { name: 'Alpha', leadId: 'lead', priority: 1 }),
      project('pB', { name: 'Bravo', leadId: 'bob', priority: 1 }),
      project('pC', { name: 'Charlie', leadId: null, priority: 1 }),
      project('pD', { name: 'Delta', leadId: 'lead', priority: 1 }),
    ],
    milestones: [
      milestone('mA', 'pA', { name: 'Late', targetDate: day(-2) }),
      milestone('mB', 'pB', { name: 'Close', targetDate: day(3) }),
      milestone('mC', 'pC', { name: 'Leaderless', targetDate: day(5) }),
      milestone('mD', 'pD', { name: 'Stuck', targetDate: day(1) }),
    ],
    issues: [
      issue('a1', {
        projectId: 'pA',
        milestoneId: 'mA',
        stateId: STATE.done,
        assigneeId: 'ana',
      }),
      issue('a2', { projectId: 'pA', milestoneId: 'mA' }),
      ...Array.from({ length: 5 }, (_, i) =>
        issue(`b-done-${i}`, {
          projectId: 'pB',
          milestoneId: 'mB',
          stateId: STATE.done,
          assigneeId: 'ana',
        })
      ),
      issue('b-open-1', { projectId: 'pB', milestoneId: 'mB' }),
      issue('b-open-2', { projectId: 'pB', milestoneId: 'mB' }),
      issue('c1', { projectId: 'pC', milestoneId: 'mC', assigneeId: 'ana' }),
      issue('d1', {
        projectId: 'pD',
        milestoneId: 'mD',
        stateId: STATE.done,
        assigneeId: 'ana',
        lastStateChangeAt: ago(9),
      }),
      issue('d2', {
        projectId: 'pD',
        milestoneId: 'mD',
        stateId: STATE.done,
        assigneeId: 'ana',
        lastStateChangeAt: ago(9),
      }),
      issue('d3', {
        projectId: 'pD',
        milestoneId: 'mD',
        assigneeId: 'ana',
        lastStateChangeAt: ago(9.5),
      }),
    ],
  });
  const evaluated = evaluate(data);
  const allocationPlan = planAllocation(
    evaluated.snapshot,
    evaluated.ctx,
    evaluated.assessments
  );
  const { notices } = planWarnings({
    ...evaluated,
    allocationPlan,
    memory: [],
    watcherUserIds: WATCHERS,
  });
  const digests = buildDigests({
    ...evaluated,
    notices,
    appUrl: 'https://planner.example.com/',
    workspaceId: 'org-1',
  });

  test('one digest per recipient, ordered by name', () => {
    expect(
      digests.map((d) => [
        d.recipientId,
        d.recipientName,
        d.recipientEmail,
        d.day,
      ])
    ).toEqual([
      ['bob', 'Bob', 'bob@example.com', TODAY],
      ['lead', 'Lead', 'lead@example.com', TODAY],
      ['shanzer', 'Shanzer', 'shanzer@example.com', TODAY],
      ['wyat', 'Wyat', 'wyat@example.com', TODAY],
    ]);
  });

  test('items: overdue → at_risk → invalid_due_soon → allocation_blocked, then milestone order', () => {
    const wyat = digests.find((d) => d.recipientId === 'wyat');
    expect(wyat?.items.map((i) => [i.notice.kind, i.notice.subjectId])).toEqual(
      [
        ['overdue', 'mA'],
        ['at_risk', 'mD'],
        ['at_risk', 'mB'],
        ['invalid_due_soon', 'mC'],
        ['allocation_blocked', 'pC'],
      ]
    );
    expect(
      digests
        .find((d) => d.recipientId === 'lead')
        ?.items.map((i) => i.notice.subjectId)
    ).toEqual(['mA', 'mD']);
    expect(
      digests
        .find((d) => d.recipientId === 'bob')
        ?.items.map((i) => i.notice.subjectId)
    ).toEqual(['mB']);
  });

  test('each item carries names, counts, plain lines and a deep link', () => {
    const items = digests.find((d) => d.recipientId === 'wyat')?.items ?? [];
    expect(
      items.map((i) => ({
        project: i.projectName,
        milestone: i.milestoneName,
        lead: i.leadName,
        open: i.openCount,
        unassigned: i.unassignedCount,
        lines: i.lines,
        url: i.url,
      }))
    ).toEqual([
      {
        project: 'Alpha',
        milestone: 'Late',
        lead: 'Lead',
        open: 1,
        unassigned: 1,
        lines: ['1 open issue unassigned', '1/2 done, 2 days overdue'],
        url: 'https://planner.example.com/timeline?milestone=mA&ws=org-1',
      },
      {
        project: 'Delta',
        milestone: 'Stuck',
        lead: 'Lead',
        open: 1,
        unassigned: 0,
        lines: ['no state change in 9 days', '2/3 done with 1 day left'],
        url: 'https://planner.example.com/timeline?milestone=mD&ws=org-1',
      },
      {
        project: 'Bravo',
        milestone: 'Close',
        lead: 'Bob',
        open: 2,
        unassigned: 2,
        lines: ['2 open issues unassigned'],
        url: 'https://planner.example.com/timeline?milestone=mB&ws=org-1',
      },
      {
        project: 'Charlie',
        milestone: 'Leaderless',
        lead: null,
        open: 1,
        unassigned: 0,
        lines: ['0/1 done with 5 days left', 'missing: project lead'],
        url: 'https://planner.example.com/timeline?milestone=mC&ws=org-1',
      },
      {
        project: 'Charlie',
        milestone: 'Leaderless',
        lead: null,
        open: 1,
        unassigned: 0,
        lines: ['no project lead, so nothing is being assigned'],
        url: 'https://planner.example.com/timeline?project=pC&ws=org-1',
      },
    ]);
  });

  test('each item names its open issues, flags the unassigned and links them', () => {
    const named = oneMilestone(day(3), [
      issue('done1', {
        assigneeId: 'ana',
        stateId: STATE.done,
        identifier: 'ENG-1',
      }),
      issue('done2', {
        assigneeId: 'ana',
        stateId: STATE.done,
        identifier: 'ENG-2',
      }),
      issue('mine', {
        assigneeId: 'ana',
        identifier: 'ENG-7',
        title: 'Write the docs',
        priority: 2,
      }),
      issue('free', {
        identifier: 'OPS-3',
        title: 'Provision the sandbox',
        priority: 1,
      }),
    ]);
    const ev = evaluate(named);
    const plan = planWarnings({
      ...ev,
      allocationPlan: planAllocation(ev.snapshot, ev.ctx, ev.assessments),
      memory: [],
      watcherUserIds: ['wyat'],
    });
    const [digest] = buildDigests({
      ...ev,
      notices: plan.notices,
      appUrl: 'https://x.test/',
      workspaceId: 'org-1',
    });
    expect(digest?.items.map((i) => i.notice.kind)).toEqual(['at_risk']);
    // Display order (priority first); done issues are not listed.
    expect(digest?.items[0]?.openIssues).toEqual([
      {
        id: 'free',
        identifier: 'OPS-3',
        title: 'Provision the sandbox',
        unassigned: true,
        url: 'https://x.test/issues/OPS-3?ws=org-1',
      },
      {
        id: 'mine',
        identifier: 'ENG-7',
        title: 'Write the docs',
        unassigned: false,
        url: 'https://x.test/issues/ENG-7?ws=org-1',
      },
    ]);
  });

  test('blocked-project lines name the reason', () => {
    const blockedData = oneMilestone(day(20), [issue('u'), issue('v')], {
      description: null,
    });
    const ev = evaluate(blockedData);
    const allocation = planAllocation(ev.snapshot, ev.ctx, ev.assessments);
    const plan = planWarnings({
      ...ev,
      allocationPlan: allocation,
      memory: [],
      watcherUserIds: ['wyat'],
    });
    const [digest] = buildDigests({
      ...ev,
      notices: plan.notices,
      appUrl: 'https://x.test',
      workspaceId: 'org-1',
    });
    expect(digest?.items.map((i) => i.lines)).toEqual([
      [
        'next milestone Beta is missing: done means…',
        '2 open issues unassigned',
      ],
    ]);

    const inactiveLead = oneMilestone(day(20), [issue('u')]);
    inactiveLead.users = [user('lead', { active: false }), user('wyat')];
    const ev2 = evaluate(inactiveLead);
    const plan2 = planWarnings({
      ...ev2,
      allocationPlan: planAllocation(ev2.snapshot, ev2.ctx, ev2.assessments),
      memory: [],
      watcherUserIds: ['wyat'],
    });
    const [digest2] = buildDigests({
      ...ev2,
      notices: plan2.notices,
      appUrl: 'https://x.test',
      workspaceId: 'org-1',
    });
    expect(digest2?.items[0]?.lines).toEqual([
      'project lead Lead is deactivated in Linear, so nothing is being assigned',
      '1 open issue unassigned',
    ]);
  });

  test('recipients that are unknown or deactivated get no digest', () => {
    const [first] = notices;
    if (first === undefined) throw new Error('expected a notice');
    const result = buildDigests({
      ...evaluated,
      notices: [{ ...first, recipientIds: ['ghost', 'ana', 'ana'] }],
      appUrl: 'https://x.test',
      workspaceId: 'org-1',
    });
    expect(result.map((d) => [d.recipientId, d.items.length])).toEqual([
      ['ana', 1],
    ]);
    const deactivated = evaluate({
      ...data,
      users: data.users.map((u) =>
        u.id === 'ana' ? { ...u, active: false } : u
      ),
    });
    expect(
      buildDigests({
        ...deactivated,
        notices: [{ ...first, recipientIds: ['ana'] }],
        appUrl: 'https://x.test',
        workspaceId: 'org-1',
      })
    ).toEqual([]);
  });
});

describe('withWorkspaceParam (links that leave the app)', () => {
  test('appends ws with ? or &, before any fragment, encoded', () => {
    expect(withWorkspaceParam('https://x.test/issues/ENG-1', 'org-1')).toBe(
      'https://x.test/issues/ENG-1?ws=org-1'
    );
    expect(
      withWorkspaceParam('https://x.test/timeline?milestone=m1', 'org-1')
    ).toBe('https://x.test/timeline?milestone=m1&ws=org-1');
    expect(withWorkspaceParam('https://x.test/runs#top', 'a b')).toBe(
      'https://x.test/runs?ws=a%20b#top'
    );
  });
});
