import { describe, expect, test } from 'bun:test';

import {
  allocationComment,
  assessWorkspace,
  indexWorkspace,
  planAllocation,
  resolveTodoState,
} from '../src/index';
import type {
  AllocationPlan,
  Issue,
  ProjectAllocationOutcome,
  ProjectStatusType,
  WorkflowState,
  WorkspaceData,
} from '../src/index';
import {
  context,
  day,
  evaluate,
  initiative,
  issue,
  meta,
  milestone,
  project,
  STATE,
  teamStates,
  user,
  workspace,
} from './helpers';

function plan(
  data: WorkspaceData,
  ctxOverrides: Parameters<typeof evaluate>[1] = {}
): AllocationPlan {
  const { snapshot, ctx, assessments } = evaluate(data, ctxOverrides);
  return planAllocation(snapshot, ctx, assessments);
}

function projectPlan(result: AllocationPlan, projectId: string) {
  const found = result.projects.find((p) => p.projectId === projectId);
  if (found === undefined) throw new Error(`no plan for ${projectId}`);
  return found;
}

// p1 with a valid next milestone m1 (due in 10 days) and a later m2.
function standard(m1Issues: Issue[], overrides: Partial<WorkspaceData> = {}) {
  return workspace({
    users: [user('lead'), user('ana')],
    projects: [project('p1', { name: 'Orion' })],
    milestones: [
      milestone('m1', 'p1', { targetDate: day(10), name: 'Beta' }),
      milestone('m2', 'p1', { targetDate: day(40) }),
    ],
    issues: [
      ...m1Issues.map((i) => ({ ...i, projectId: 'p1', milestoneId: 'm1' })),
      issue('later', { projectId: 'p1', milestoneId: 'm2' }),
    ],
    ...overrides,
  });
}

describe('planAllocation: the happy path', () => {
  const result = plan(
    standard([
      issue('backlog', { priority: 2, identifier: 'ENG-1' }),
      issue('todo', { stateId: STATE.todo, priority: 1, identifier: 'ENG-2' }),
      issue('started', {
        stateId: STATE.started,
        priority: 3,
        identifier: 'ENG-3',
      }),
      issue('triage', {
        stateId: STATE.triage,
        priority: 1,
        identifier: 'ENG-4',
      }),
      issue('assigned', {
        assigneeId: 'ana',
        priority: 2,
        identifier: 'ENG-5',
      }),
      issue('assigned-triage', {
        assigneeId: 'ana',
        stateId: STATE.triage,
        priority: 4,
        identifier: 'ENG-6',
      }),
      issue('done', { stateId: STATE.done, identifier: 'ENG-7' }),
      issue('canceled', { stateId: STATE.canceled, identifier: 'ENG-8' }),
    ])
  );
  const p1 = projectPlan(result, 'p1');

  test('allocates the next milestone only, in issue display order', () => {
    expect(p1.outcome).toBe('allocate');
    expect(p1.nextMilestoneId).toBe('m1');
    expect(p1.blockReason).toBeNull();
    expect(p1.actions.map((a) => a.issueId)).toEqual([
      'todo',
      'backlog',
      'started',
    ]);
    expect(
      p1.actions.every((a) => a.assigneeId === 'lead' && a.milestoneId === 'm1')
    ).toBe(true);
  });

  test('backlog moves to Todo; unstarted and started keep their state', () => {
    expect(
      p1.actions.map((a) => [a.issueId, a.fromStateId, a.toStateId])
    ).toEqual([
      ['todo', STATE.todo, null],
      ['backlog', STATE.backlog, STATE.todo],
      ['started', STATE.started, null],
    ]);
  });

  test('skips triage and already-assigned issues with reasons; ignores closed ones', () => {
    expect(p1.skipped).toEqual([
      { issueId: 'triage', identifier: 'ENG-4', reason: 'triage' },
      { issueId: 'assigned', identifier: 'ENG-5', reason: 'already_assigned' },
      {
        issueId: 'assigned-triage',
        identifier: 'ENG-6',
        reason: 'already_assigned',
      },
    ]);
  });

  test('totals and day', () => {
    expect(result.today).toBe('2026-10-21');
    expect(result.totals).toEqual({
      actions: 3,
      blockedProjects: 0,
      skippedIssues: 3,
    });
  });

  test('the later milestone is untouched', () => {
    expect(p1.actions.some((a) => a.issueId === 'later')).toBe(false);
  });
});

describe('planAllocation: blocked and quiet outcomes', () => {
  test('no lead → blocked/no_lead', () => {
    const p1 = projectPlan(
      plan(
        standard([issue('a')], { projects: [project('p1', { leadId: null })] })
      ),
      'p1'
    );
    expect(p1).toMatchObject({
      outcome: 'blocked',
      blockReason: 'no_lead',
      nextMilestoneId: 'm1',
      actions: [],
    });
  });

  test.each([
    ['deactivated', [user('lead', { active: false })]],
    ['not mirrored', [user('ana')]],
  ])('lead %s → blocked/lead_inactive', (_name, users) => {
    const p1 = projectPlan(plan(standard([issue('a')], { users })), 'p1');
    expect(p1).toMatchObject({
      outcome: 'blocked',
      blockReason: 'lead_inactive',
      actions: [],
    });
  });

  test('an invalid next milestone blocks and never skips ahead', () => {
    const data = standard([issue('a')]);
    data.milestones = [
      milestone('m1', 'p1', {
        targetDate: day(10),
        description: 'No outcome yet',
      }),
      milestone('m2', 'p1', { targetDate: day(40) }),
    ];
    const result = plan(data);
    const p1 = projectPlan(result, 'p1');
    expect(p1).toMatchObject({
      outcome: 'blocked',
      blockReason: 'next_milestone_invalid',
      nextMilestoneId: 'm1',
      gaps: ['no_done_means'],
      actions: [],
    });
    expect(result.totals.blockedProjects).toBe(1);
  });

  test('an empty next milestone blocks its project', () => {
    const data = standard([]);
    const p1 = projectPlan(plan(data), 'p1');
    expect(p1).toMatchObject({
      outcome: 'blocked',
      blockReason: 'next_milestone_invalid',
      nextMilestoneId: 'm1',
      gaps: ['no_issues'],
    });
  });

  test('an overdue (but valid) next milestone still allocates', () => {
    const data = standard([issue('a')]);
    data.milestones = [
      milestone('m1', 'p1', { targetDate: day(-4) }),
      milestone('m2', 'p1', { targetDate: day(40) }),
    ];
    const p1 = projectPlan(plan(data), 'p1');
    expect(p1.outcome).toBe('allocate');
    expect(p1.actions.map((a) => a.issueId)).toEqual(['a']);
  });

  test('a weight override does not change what is allocated', () => {
    const p1 = projectPlan(
      plan(standard([issue('a')]), { meta: [meta('m2', { weight: 50 })] }),
      'p1'
    );
    expect(p1.nextMilestoneId).toBe('m1');
    expect(p1.actions.map((a) => a.issueId)).toEqual(['a']);
  });

  test('valid next milestone with everything assigned → nothing_to_do', () => {
    const p1 = projectPlan(
      plan(standard([issue('a', { assigneeId: 'ana' })])),
      'p1'
    );
    expect(p1.outcome).toBe('nothing_to_do');
    expect(p1.skipped.map((s) => s.reason)).toEqual(['already_assigned']);
  });

  test.each([
    [
      'every milestone complete',
      [milestone('m1', 'p1')],
      [issue('d', { projectId: 'p1', milestoneId: 'm1', stateId: STATE.done })],
    ],
    ['no milestones at all', [], []],
  ])('%s → no_open_milestone', (_name, milestones, issues) => {
    const p1 = projectPlan(
      plan(workspace({ projects: [project('p1')], milestones, issues })),
      'p1'
    );
    expect(p1).toMatchObject({
      outcome: 'no_open_milestone',
      nextMilestoneId: null,
      actions: [],
    });
  });

  test.each([
    ['no lead', { leadId: null }, [user('lead')], 'no_lead'],
    [
      'a deactivated lead',
      {},
      [user('lead', { active: false })],
      'lead_inactive',
    ],
  ] as const)(
    'a project with %s and no open milestone is still blocked (design §6.1)',
    (_name, overrides, users, blockReason) => {
      const done = issue('d', {
        projectId: 'p1',
        milestoneId: 'm1',
        stateId: STATE.done,
      });
      const p1 = projectPlan(
        plan(
          workspace({
            users: [...users],
            projects: [project('p1', overrides)],
            milestones: [milestone('m1', 'p1')],
            issues: [done],
          })
        ),
        'p1'
      );
      expect(p1).toMatchObject({
        outcome: 'blocked',
        blockReason,
        nextMilestoneId: null,
        actions: [],
      });
    }
  );

  test.each<[ProjectStatusType, ProjectAllocationOutcome]>([
    ['backlog', 'inactive'],
    ['paused', 'inactive'],
    ['completed', 'inactive'],
    ['canceled', 'inactive'],
    ['planned', 'allocate'],
    ['started', 'allocate'],
  ])('project status %s → %s', (statusType, outcome) => {
    const p1 = projectPlan(
      plan(
        standard([issue('a')], { projects: [project('p1', { statusType })] })
      ),
      'p1'
    );
    expect(p1.outcome).toBe(outcome);
    expect(p1.actions.length).toBe(outcome === 'inactive' ? 0 : 1);
  });

  test('inactive is not loud even when inputs are missing', () => {
    const p1 = projectPlan(
      plan(
        standard([issue('a')], {
          projects: [project('p1', { statusType: 'paused', leadId: null })],
        })
      ),
      'p1'
    );
    expect(p1).toMatchObject({ outcome: 'inactive', blockReason: null });
  });

  test('projects are planned in timeline order', () => {
    const result = plan(
      workspace({
        initiatives: [initiative('i1', { priority: 1 })],
        projects: [
          project('loose', { priority: 1 }),
          project('in-i1-low', { initiativeIds: ['i1'], priority: 4 }),
          project('in-i1-high', { initiativeIds: ['i1'], priority: 2 }),
        ],
      })
    );
    expect(result.projects.map((p) => p.projectId)).toEqual([
      'in-i1-high',
      'in-i1-low',
      'loose',
    ]);
  });
});

describe('resolveTodoState', () => {
  const state = (
    id: string,
    name: string,
    type: WorkflowState['type'],
    position: number,
    teamId = 't'
  ): WorkflowState => ({
    id,
    teamId,
    name,
    type,
    position,
  });

  test.each<[string, WorkflowState[], string | null]>([
    [
      'the unstarted state named Todo wins over a lower position',
      [
        state('ready', 'Ready', 'unstarted', 1),
        state('todo', 'Todo', 'unstarted', 5),
      ],
      'todo',
    ],
    [
      'the name match ignores case and spaces',
      [
        state('ready', 'Ready', 'unstarted', 1),
        state('t', ' TODO ', 'unstarted', 3),
      ],
      't',
    ],
    [
      'a "Todo" that is not unstarted does not count',
      [
        state('x', 'Todo', 'backlog', 0),
        state('ready', 'Ready', 'unstarted', 4),
        state('next', 'Next', 'unstarted', 2),
      ],
      'next',
    ],
    [
      'else the lowest-position unstarted state',
      [state('b', 'B', 'unstarted', 9), state('a', 'A', 'unstarted', 3)],
      'a',
    ],
    [
      'no unstarted state → null',
      [
        state('bl', 'Backlog', 'backlog', 0),
        state('st', 'Doing', 'started', 1),
      ],
      null,
    ],
    [
      'other teams are ignored',
      [state('todo', 'Todo', 'unstarted', 0, 'other-team')],
      null,
    ],
  ])('%s', (_name, states, expected) => {
    const snapshot = indexWorkspace(workspace({ states }));
    expect(resolveTodoState(snapshot, 't')?.id ?? null).toBe(expected);
  });

  test('a backlog issue on a team with no unstarted state keeps its state', () => {
    const states = teamStates().filter((s) => s.type !== 'unstarted');
    const p1 = projectPlan(plan(standard([issue('a')], { states })), 'p1');
    expect(p1.actions[0]).toMatchObject({
      issueId: 'a',
      fromStateId: STATE.backlog,
      toStateId: null,
    });
  });

  test("each issue moves to its own team's Todo", () => {
    const states = [...teamStates(), ...teamStates('ops')];
    const p1 = projectPlan(
      plan(
        standard(
          [
            issue('eng', {
              identifier: 'ENG-1',
              createdAt: '2026-01-01T00:00:00Z',
            }),
            issue('ops', {
              teamId: 'ops',
              stateId: `ops:${STATE.backlog}`,
              identifier: 'OPS-1',
              createdAt: '2026-01-02T00:00:00Z',
            }),
          ],
          { states }
        )
      ),
      'p1'
    );
    expect(p1.actions.map((a) => [a.issueId, a.toStateId])).toEqual([
      ['eng', STATE.todo],
      ['ops', `ops:${STATE.todo}`],
    ]);
  });
});

describe('idempotency', () => {
  test('planning again after applying the actions yields no actions', () => {
    const data = standard([
      issue('a'),
      issue('b', { stateId: STATE.todo }),
      issue('c', { stateId: STATE.triage }),
      issue('d', { assigneeId: 'ana' }),
    ]);
    const first = plan(data);
    expect(first.totals.actions).toBe(2);

    const actions = new Map(
      first.projects.flatMap((p) => p.actions).map((a) => [a.issueId, a])
    );
    const applied: WorkspaceData = {
      ...data,
      issues: data.issues.map((i) => {
        const action = actions.get(i.id);
        return action === undefined
          ? i
          : {
              ...i,
              assigneeId: action.assigneeId,
              stateId: action.toStateId ?? i.stateId,
            };
      }),
    };
    const snapshot = indexWorkspace(applied);
    const ctx = context();
    const second = planAllocation(
      snapshot,
      ctx,
      assessWorkspace(snapshot, ctx)
    );
    expect(second.totals.actions).toBe(0);
    expect(projectPlan(second, 'p1').outcome).toBe('nothing_to_do');
    expect(
      projectPlan(second, 'p1').skipped.map((s) => [s.issueId, s.reason])
    ).toEqual([
      ['a', 'already_assigned'],
      ['b', 'already_assigned'],
      ['c', 'triage'],
      ['d', 'already_assigned'],
    ]);
  });
});

describe('allocationComment', () => {
  test('matches §7.4 exactly with a locale-free date', () => {
    expect(
      allocationComment({
        appName: 'Milestone Planner',
        projectName: 'Orion',
        milestoneName: 'Beta',
        targetDate: '2026-10-28',
      })
    ).toBe(
      'Assigned by Milestone Planner: you lead Orion and this is in its next milestone Beta, due Oct 28, 2026.'
    );
  });

  test('single-digit days are not padded', () => {
    expect(
      allocationComment({
        appName: 'MP',
        projectName: 'P',
        milestoneName: 'M',
        targetDate: '2027-03-05',
      })
    ).toBe(
      'Assigned by MP: you lead P and this is in its next milestone M, due Mar 5, 2027.'
    );
  });
});
