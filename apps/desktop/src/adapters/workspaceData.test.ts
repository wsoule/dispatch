import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import {
  DEFAULT_STATUS_MODEL,
  DEFAULT_STATUS_ROLES,
} from '@dispatch-foo/core/browser';
import type { EpicProgress, RunMeta } from '@dispatch/client';
import {
  assessWorkspace,
  buildDependencyGraph,
  buildTimelineView,
  DEFAULT_TUNING,
  indexWorkspace,
  planAllocation,
  resolveTodoState,
} from '@dispatch/planning';
import type { WorkspaceData } from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import { taskDoc } from '../lib/taskDoc.test-helper';
import {
  buildEvalContext,
  buildWorkspaceData,
  noProjectId,
  PLANNING_TEAM_ID,
  type WorkspaceDataInput,
} from './workspaceData';

const NOW = new Date('2026-10-26T12:00:00.000Z');

const PEOPLE = [
  { ref: 'human:wyat', name: 'Wyat Soule', email: 'wyat@example.com' },
  { ref: 'human:ana', name: 'Ana', avatarUrl: 'https://img/ana.png' },
];

function hrefFor(id: string): string {
  return `#/task/${id}`;
}

function build(
  tasks: readonly TaskListItem[],
  over: Partial<WorkspaceDataInput> = {}
): WorkspaceData {
  return buildWorkspaceData({
    tasks,
    model: DEFAULT_STATUS_MODEL,
    people: PEOPLE,
    executors: ['claude', 'codex'],
    me: 'human:wyat',
    hrefFor,
    ...over,
  });
}

/** A fixture hierarchy: an initiative over a project over a milestone over
 * a task with a sub-task, plus an orphan milestone and a stray task. */
function hierarchy(): TaskListItem[] {
  return [
    taskDoc({
      id: 'init-1',
      title: 'Platform',
      kind: 'initiative',
      priority: 'high',
      dueDate: '2026-12-31',
      status: 'working',
    }),
    taskDoc({
      id: 'proj-1',
      title: 'Storefront',
      kind: 'project',
      parent: 'init-1',
      assignee: 'human:ana',
      priority: 'urgent',
      status: 'working',
      startDate: '2026-10-01',
      dueDate: '2026-11-30',
      initiatives: ['init-2', 'init-1'],
    }),
    taskDoc(
      {
        id: 'ms-1',
        title: 'Beta',
        kind: 'milestone',
        parent: 'proj-1',
        dueDate: '2026-11-05',
      },
      '## Description\n\nDone means: the cart ships\n\n## Acceptance Criteria\n\n- [ ] a\n'
    ),
    taskDoc({
      id: 't-1',
      title: 'Persist the cart',
      kind: 'task',
      parent: 'ms-1',
      assignee: 'human:wyat',
      status: 'working',
      priority: 'high',
      external: 'linear:issue-uuid-1',
      created: '2026-10-01T10:00:00.000Z',
      updated: '2026-10-20T10:00:00.000Z',
      dueDate: '2026-11-01',
    }),
    taskDoc({
      id: 't-1a',
      title: 'Cart schema',
      kind: 'task',
      parent: 't-1',
      assignee: 'none',
      status: 'ready',
      blockedBy: ['t-1', 'ms-1', 'missing'],
    }),
    taskDoc({
      id: 'ms-orphan',
      title: 'Loose milestone',
      kind: 'milestone',
      parent: 'init-1',
    }),
    taskDoc({
      id: 't-orphan',
      title: 'Under the loose milestone',
      kind: 'task',
      parent: 'ms-orphan',
      status: 'landed',
      updated: '2026-10-21T10:00:00.000Z',
    }),
    taskDoc({
      id: 't-free',
      title: 'No container at all',
      kind: 'task',
      status: 'dropped',
      updated: '2026-10-22T10:00:00.000Z',
    }),
  ];
}

function byId<T extends { id: string }>(items: readonly T[], id: string): T {
  const found = items.find((item) => item.id === id);
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

describe('buildWorkspaceData: the team and its workflow', () => {
  test('one synthetic team owns one state per status definition, in board order', () => {
    const data = build([]);
    expect(data.workspaceId).toBe('dispatch');
    expect(data.teams).toEqual([
      expect.objectContaining({
        id: PLANNING_TEAM_ID,
        key: 'DSP',
        name: 'Dispatch',
      }),
    ]);
    expect(data.states.map((s) => [s.id, s.name, s.type, s.position])).toEqual([
      ['draft', 'Draft', 'backlog', 0],
      ['ready', 'Ready', 'unstarted', 1],
      ['working', 'Working', 'started', 2],
      ['review', 'Review', 'started', 3],
      ['landing', 'Landing', 'started', 4],
      ['landed', 'Landed', 'completed', 5],
      ['dropped', 'Dropped', 'canceled', 6],
    ]);
    expect(data.states.every((s) => s.teamId === PLANNING_TEAM_ID)).toBe(true);
    // The state allocation moves a Backlog issue to.
    const snapshot = indexWorkspace(data);
    expect(resolveTodoState(snapshot, PLANNING_TEAM_ID)?.id).toBe('ready');
  });

  test('a status a task carries that the config leaves undefined becomes a state typed as core reads it', () => {
    const model: StatusModel = {
      definitions: [
        { name: 'draft', type: 'backlog', color: null },
        { name: 'working', type: 'started', color: null },
      ],
      roles: DEFAULT_STATUS_ROLES,
    };
    const data = build(
      [
        // A legacy alias reads as its canonical status, no state of its own.
        taskDoc({ id: 't-1', title: 'a', status: 'in-progress' }),
        taskDoc({ id: 't-2', title: 'b', status: 'landed' }),
        taskDoc({ id: 't-3', title: 'c', status: 'mystery' }),
      ],
      { model }
    );
    expect(data.states.map((s) => [s.id, s.name, s.type])).toEqual([
      ['draft', 'Draft', 'backlog'],
      ['working', 'Working', 'started'],
      ['landed', 'Landed', 'completed'],
      ['mystery', 'Mystery', 'backlog'],
    ]);
    expect(data.issues.map((issue) => issue.stateId)).toEqual([
      'working',
      'landed',
      'mystery',
    ]);
    // No unstarted status: nothing to move a Backlog issue to.
    expect(resolveTodoState(indexWorkspace(data), PLANNING_TEAM_ID)).toBeNull();
  });

  test('without an unstarted state, allocation still assigns and leaves the state alone', () => {
    const model: StatusModel = {
      definitions: [
        { name: 'draft', type: 'backlog', color: null },
        { name: 'working', type: 'started', color: null },
        { name: 'landed', type: 'completed', color: null },
      ],
      roles: DEFAULT_STATUS_ROLES,
    };
    const data = build(
      [
        taskDoc({
          id: 'proj',
          title: 'P',
          kind: 'project',
          status: 'working',
          assignee: 'human:ana',
        }),
        taskDoc(
          {
            id: 'ms',
            title: 'M',
            kind: 'milestone',
            parent: 'proj',
            status: 'draft',
            dueDate: '2026-11-05',
          },
          '## Description\n\nDone means: done\n'
        ),
        taskDoc({
          id: 't',
          title: 'T',
          parent: 'ms',
          status: 'draft',
          assignee: 'none',
        }),
      ],
      { model }
    );
    const snapshot = indexWorkspace(data);
    const ctx = buildEvalContext(NOW);
    const plan = planAllocation(snapshot, ctx, assessWorkspace(snapshot, ctx));
    expect(plan.projects[0].outcome).toBe('allocate');
    expect(plan.projects[0].actions).toEqual([
      expect.objectContaining({
        issueId: 't',
        assigneeId: 'human:ana',
        fromStateId: 'draft',
        toStateId: null,
      }),
    ]);
  });
});

describe('buildWorkspaceData: users', () => {
  test('one per person, one per executor owned by me, and the agent pool', () => {
    const data = build([]);
    expect(data.users).toEqual([
      {
        id: 'human:wyat',
        name: 'Wyat Soule',
        displayName: 'Wyat Soule',
        email: 'wyat@example.com',
        avatarUrl: null,
        active: true,
        app: false,
      },
      {
        id: 'human:ana',
        name: 'Ana',
        displayName: 'Ana',
        email: null,
        avatarUrl: 'https://img/ana.png',
        active: true,
        app: false,
      },
      expect.objectContaining({
        id: 'agent:wyat/claude',
        name: 'claude',
        app: true,
      }),
      expect.objectContaining({ id: 'agent:wyat/codex', app: true }),
      expect.objectContaining({ id: 'agent', name: 'Any agent', app: true }),
    ]);
    // Before the daemon says who I am, an agent is not owned.
    expect(
      build([], { me: null, executors: ['claude'] }).users.map((u) => u.id)
    ).toEqual(['human:wyat', 'human:ana', 'agent:claude', 'agent']);
  });
});

describe('buildWorkspaceData: the hierarchy', () => {
  const data = build(hierarchy(), {
    linearLinks: {
      'issue-uuid-1': { identifier: 'ENG-12', url: 'https://linear/ENG-12' },
    },
  });

  test('initiatives', () => {
    expect(data.initiatives).toEqual([
      {
        id: 'init-1',
        name: 'Platform',
        sortOrder: 0,
        priority: 2,
        targetDate: '2026-12-31',
      },
    ]);
  });

  test('projects, with the lead when the assignee is a known user', () => {
    expect(byId(data.projects, 'proj-1')).toEqual({
      id: 'proj-1',
      name: 'Storefront',
      url: '#/task/proj-1',
      leadId: 'human:ana',
      priority: 1,
      sortOrder: 0,
      statusType: 'started',
      statusName: 'Working',
      // The parent initiative first, then the extra ones, once each.
      initiativeIds: ['init-1', 'init-2'],
      teamIds: [PLANNING_TEAM_ID],
      startDate: '2026-10-01',
      targetDate: '2026-11-30',
    });
  });

  test('an assignee that is not a user is no lead', () => {
    const [project] = build([
      taskDoc({
        id: 'p',
        title: 'P',
        kind: 'project',
        assignee: 'human:stranger',
      }),
    ]).projects;
    expect(project.leadId).toBeNull();
    expect(
      build([
        taskDoc({ id: 'p', title: 'P', kind: 'project', assignee: 'none' }),
      ]).projects[0].leadId
    ).toBeNull();
    // An agent is a user too: a fan-out's project is led by its executor.
    expect(
      build([
        taskDoc({
          id: 'p',
          title: 'P',
          kind: 'project',
          assignee: 'agent:wyat/claude',
        }),
      ]).projects[0].leadId
    ).toBe('agent:wyat/claude');
  });

  test('milestones under a project, with the description section', () => {
    expect(byId(data.milestones, 'ms-1')).toEqual({
      id: 'ms-1',
      projectId: 'proj-1',
      name: 'Beta',
      description: 'Done means: the cart ships',
      targetDate: '2026-11-05',
      sortOrder: 0,
    });
    // A list item (no body) has no description to read.
    expect(byId(data.milestones, 'ms-orphan').description).toBe('');
  });

  test('a milestone with no project above it goes under a synthetic, inactive "No project" lane', () => {
    const orphan = byId(data.milestones, 'ms-orphan');
    expect(orphan.projectId).toBe(noProjectId('init-1'));
    expect(byId(data.projects, noProjectId('init-1'))).toEqual({
      id: 'project:none:init-1',
      name: 'No project',
      url: '#/task/init-1',
      leadId: null,
      priority: 0,
      sortOrder: Number.MAX_SAFE_INTEGER,
      statusType: 'backlog',
      statusName: 'No project',
      initiativeIds: ['init-1'],
      teamIds: [PLANNING_TEAM_ID],
      startDate: null,
      targetDate: null,
    });
    // Its issues sit in the same lane, so the two indexes agree.
    expect(byId(data.issues, 't-orphan').projectId).toBe(noProjectId('init-1'));
    expect(byId(data.issues, 't-orphan').milestoneId).toBe('ms-orphan');

    // At the root, one lane for every loose milestone.
    const root = build([
      taskDoc({ id: 'm-a', title: 'A', kind: 'milestone' }),
      taskDoc({ id: 'm-b', title: 'B', kind: 'milestone', parent: 'gone' }),
    ]);
    expect(root.projects.map((p) => p.id)).toEqual(['project:none:root']);
    expect(root.projects[0].url).toBe('');
    expect(root.milestones.map((m) => m.projectId)).toEqual([
      'project:none:root',
      'project:none:root',
    ]);
  });

  test('issues, field by field', () => {
    expect(byId(data.issues, 't-1')).toEqual({
      id: 't-1',
      identifier: 'ENG-12',
      title: 'Persist the cart',
      url: '#/task/t-1',
      teamId: PLANNING_TEAM_ID,
      projectId: 'proj-1',
      milestoneId: 'ms-1',
      assigneeId: 'human:wyat',
      stateId: 'working',
      priority: 2,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-20T10:00:00.000Z',
      // Started with no run on record: when it was last touched.
      startedAt: '2026-10-20T10:00:00.000Z',
      completedAt: null,
      canceledAt: null,
      lastStateChangeAt: '2026-10-20T10:00:00.000Z',
      dueDate: '2026-11-01',
    });
    // Unlinked: named by its id.
    expect(byId(data.issues, 't-1a').identifier).toBe('t-1a');
    expect(byId(data.issues, 't-1a').assigneeId).toBeNull();
    expect(byId(data.issues, 't-1a').startedAt).toBeNull();
    // Containers are never issues.
    expect(data.issues.map((i) => i.id).sort()).toEqual([
      't-1',
      't-1a',
      't-free',
      't-orphan',
    ]);
  });

  test('a sub-task inherits the containers of its parent issue', () => {
    const sub = byId(data.issues, 't-1a');
    expect(sub.projectId).toBe('proj-1');
    expect(sub.milestoneId).toBe('ms-1');
    // A task under nothing has none.
    expect(byId(data.issues, 't-free').projectId).toBeNull();
    expect(byId(data.issues, 't-free').milestoneId).toBeNull();
  });

  test('relations are the blockedBy edges between issues only', () => {
    // t-1a is blocked by t-1 (an issue), ms-1 (a container, dropped) and
    // 'missing' (not in the set, dropped).
    expect(data.relations).toEqual([
      { id: 't-1->t-1a', blockerId: 't-1', blockedId: 't-1a' },
    ]);
    // A container's own blockedBy is dropped too.
    const containers = build([
      taskDoc({ id: 'm', title: 'M', kind: 'milestone', blockedBy: ['t'] }),
      taskDoc({ id: 't', title: 'T', blockedBy: ['m'] }),
    ]);
    expect(containers.relations).toEqual([]);
  });

  test('the legacy epic kind is a milestone', () => {
    const legacy = build([
      taskDoc({
        id: 'e',
        title: 'Old epic',
        kind: 'epic' as TaskListItem['meta']['kind'],
      }),
      taskDoc({ id: 't', title: 'T', parent: 'e' }),
    ]);
    expect(legacy.milestones.map((m) => m.id)).toEqual(['e']);
    expect(legacy.issues[0].milestoneId).toBe('e');
  });

  test('a cycle in parents answers no containers', () => {
    const cyclic = build([
      taskDoc({ id: 'a', title: 'A', parent: 'b' }),
      taskDoc({ id: 'b', title: 'B', parent: 'a' }),
    ]);
    expect(cyclic.issues.map((i) => i.projectId)).toEqual([null, null]);
  });
});

describe('buildWorkspaceData: project status', () => {
  function projectWith(status: string, session?: EpicProgress['session']) {
    const progress = new Map<string, Pick<EpicProgress, 'session'>>();
    if (session !== undefined) progress.set('p', { session });
    return build([taskDoc({ id: 'p', title: 'P', kind: 'project', status })], {
      epicProgressById: progress,
    }).projects[0].statusType;
  }

  const paused = {
    state: 'paused',
  } as unknown as NonNullable<EpicProgress['session']>;

  test('maps the status type onto the planning project statuses', () => {
    expect(projectWith('draft')).toBe('backlog');
    expect(projectWith('ready')).toBe('planned');
    expect(projectWith('working')).toBe('started');
    expect(projectWith('review')).toBe('started');
    expect(projectWith('landed')).toBe('completed');
    expect(projectWith('dropped')).toBe('canceled');
  });

  test('a paused fan-out session pauses an open project, never a finished one', () => {
    expect(projectWith('working', paused)).toBe('paused');
    expect(projectWith('ready', paused)).toBe('paused');
    expect(projectWith('landed', paused)).toBe('completed');
    expect(projectWith('dropped', paused)).toBe('canceled');
    const active = {
      state: 'active',
    } as unknown as NonNullable<EpicProgress['session']>;
    expect(projectWith('working', active)).toBe('started');
    expect(projectWith('working', null)).toBe('started');
  });
});

describe('buildWorkspaceData: timing approximations', () => {
  test('completed and canceled read `updated`; started reads the latest run, else `updated`', () => {
    const run = {
      createdAt: '2026-10-19T09:00:00.000Z',
    } as unknown as RunMeta;
    const data = build(
      [
        taskDoc({
          id: 'done',
          title: 'Done',
          status: 'landed',
          updated: '2026-10-21T10:00:00.000Z',
        }),
        taskDoc({
          id: 'gone',
          title: 'Gone',
          status: 'dropped',
          updated: '2026-10-22T10:00:00.000Z',
        }),
        taskDoc({
          id: 'ran',
          title: 'Ran',
          status: 'working',
          updated: '2026-10-23T10:00:00.000Z',
        }),
        taskDoc({
          id: 'queued',
          title: 'Queued',
          status: 'ready',
          updated: '2026-10-24T10:00:00.000Z',
        }),
      ],
      { latestRunByTaskId: new Map([['ran', run]]) }
    );
    const timing = (id: string) => {
      const issue = byId(data.issues, id);
      return [
        issue.startedAt,
        issue.completedAt,
        issue.canceledAt,
        issue.lastStateChangeAt,
      ];
    };
    expect(timing('done')).toEqual([
      null,
      '2026-10-21T10:00:00.000Z',
      null,
      '2026-10-21T10:00:00.000Z',
    ]);
    expect(timing('gone')).toEqual([
      null,
      null,
      '2026-10-22T10:00:00.000Z',
      '2026-10-22T10:00:00.000Z',
    ]);
    expect(timing('ran')).toEqual([
      '2026-10-19T09:00:00.000Z',
      null,
      null,
      '2026-10-23T10:00:00.000Z',
    ]);
    expect(timing('queued')).toEqual([
      null,
      null,
      null,
      '2026-10-24T10:00:00.000Z',
    ]);
  });

  test('a stored day keeps its calendar part; anything else is no date', () => {
    const data = build([
      taskDoc({
        id: 'm',
        title: 'M',
        kind: 'milestone',
        dueDate: '2026-11-05T00:00:00.000Z',
      }),
      taskDoc({ id: 'n', title: 'N', kind: 'milestone', dueDate: 'soon' }),
    ]);
    expect(data.milestones.map((m) => m.targetDate)).toEqual([
      '2026-11-05',
      null,
    ]);
  });
});

describe('buildEvalContext', () => {
  test('today is the local calendar day of now, with the default tuning and no meta', () => {
    const ctx = buildEvalContext(NOW);
    const pad = (n: number) => String(n).padStart(2, '0');
    expect(ctx.today).toBe(
      `${NOW.getFullYear()}-${pad(NOW.getMonth() + 1)}-${pad(NOW.getDate())}`
    );
    expect(ctx.now).toBe('2026-10-26T12:00:00.000Z');
    expect(ctx.tuning).toBe(DEFAULT_TUNING);
    expect(ctx.meta.size).toBe(0);
    expect(
      buildEvalContext(NOW, { ...DEFAULT_TUNING, warnLeadDays: 3 }).tuning
        .warnLeadDays
    ).toBe(3);
  });
});

/** The whole planning chain over a workspace, as usePlanning runs it. */
function evaluate(data: WorkspaceData) {
  const ctx = buildEvalContext(NOW);
  const snapshot = indexWorkspace(data);
  const assessments = assessWorkspace(snapshot, ctx);
  const allocation = planAllocation(snapshot, ctx, assessments);
  const timeline = buildTimelineView({
    snapshot,
    ctx,
    assessments,
    allocationPlan: allocation,
  });
  return { ctx, snapshot, assessments, allocation, timeline };
}

/** A generated workspace: `initiatives` initiatives, `projects` projects
 * spread over them, `perProject` milestones each, and `tasks` tasks dealt
 * round the milestones with a blocking edge to the task before them. */
function generated(input: {
  initiatives: number;
  projects: number;
  perProject: number;
  tasks: number;
}): TaskListItem[] {
  const out: TaskListItem[] = [];
  for (let i = 0; i < input.initiatives; i++) {
    out.push(
      taskDoc({ id: `init-${i}`, title: `Initiative ${i}`, kind: 'initiative' })
    );
  }
  const milestoneIds: string[] = [];
  for (let p = 0; p < input.projects; p++) {
    out.push(
      taskDoc({
        id: `proj-${p}`,
        title: `Project ${p}`,
        kind: 'project',
        parent:
          input.initiatives === 0 ? null : `init-${p % input.initiatives}`,
        status: 'working',
        assignee: p % 3 === 0 ? 'none' : 'human:ana',
        startDate: '2026-10-01',
      })
    );
    for (let m = 0; m < input.perProject; m++) {
      const id = `ms-${p}-${m}`;
      milestoneIds.push(id);
      out.push(
        taskDoc(
          {
            id,
            title: `Milestone ${p}.${m}`,
            kind: 'milestone',
            parent: `proj-${p}`,
            dueDate:
              m % 4 === 3
                ? null
                : `2026-${m % 2 === 0 ? '10' : '11'}-${String(10 + m).padStart(2, '0')}`,
          },
          m % 2 === 0 ? '## Description\n\nDone means: it ships\n' : ''
        )
      );
    }
  }
  const statuses = ['draft', 'ready', 'working', 'review', 'landed', 'dropped'];
  for (let t = 0; t < input.tasks; t++) {
    out.push(
      taskDoc({
        id: `t-${t}`,
        title: `Task ${t}`,
        parent:
          t % 10 === 9 ? `t-${t - 1}` : milestoneIds[t % milestoneIds.length],
        status: statuses[t % statuses.length],
        assignee: t % 4 === 0 ? 'none' : t % 4 === 1 ? 'human:wyat' : 'agent',
        blockedBy: t % 3 === 0 && t > 0 ? [`t-${t - 1}`] : [],
        updated: `2026-10-${String(1 + (t % 25)).padStart(2, '0')}T10:00:00.000Z`,
      })
    );
  }
  return out;
}

describe('the planning chain runs on the synthesis', () => {
  test('an empty workspace', () => {
    const { timeline, allocation, assessments } = evaluate(build([]));
    expect(timeline.groups).toEqual([]);
    expect(allocation.projects).toEqual([]);
    expect(assessments.size).toBe(0);
    expect(timeline.banners.issuesWithoutMilestone.count).toBe(0);
  });

  test('one project: a lane with its bars, banners for what is missing', () => {
    const { timeline, allocation, assessments, snapshot } = evaluate(
      build(hierarchy())
    );
    expect(timeline.groups.map((g) => g.name)).toEqual(['Platform']);
    const lanes = timeline.groups[0].lanes;
    expect(lanes.map((lane) => [lane.name, lane.active])).toEqual([
      ['Storefront', true],
      ['No project', false],
    ]);
    const storefront = lanes[0];
    expect(storefront.leadName).toBe('Ana');
    expect(storefront.bars.map((bar) => bar.milestoneId)).toEqual(['ms-1']);
    expect(storefront.bars[0].start).toBe('2026-10-01');
    expect(storefront.bars[0].end).toBe('2026-11-05');
    expect(storefront.bars[0].isNext).toBe(true);
    expect(assessments.get('ms-1')?.status).toBe('on_track');
    expect(assessments.get('ms-1')?.progress).toEqual(
      expect.objectContaining({ total: 2, open: 2, openUnassigned: 1 })
    );
    expect(assessments.get('ms-1')?.rubric.valid).toBe(true);
    // The orphan milestone's lane is inactive, so it raises no banner.
    expect(timeline.banners.milestonesWithoutDate).toEqual([]);
    expect(timeline.banners.projectsWithoutLead).toEqual([]);
    // Allocation hands the unassigned sub-task to the lead, keeping its state
    // (ready is already the Todo state).
    expect(allocation.projects.map((p) => [p.projectId, p.outcome])).toEqual([
      ['proj-1', 'allocate'],
      [noProjectId('init-1'), 'inactive'],
    ]);
    expect(allocation.projects[0].actions).toEqual([
      expect.objectContaining({
        issueId: 't-1a',
        assigneeId: 'human:ana',
        toStateId: null,
      }),
    ]);
    // The blocking edge survived the index.
    expect(snapshot.blockersOf.get('t-1a')).toEqual(['t-1']);
  });

  test('500 generated tasks: the chain runs under 50 ms', () => {
    const tasks = generated({
      initiatives: 2,
      projects: 10,
      perProject: 3,
      tasks: 500,
    });
    const linearLinks = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [
        `uuid-${i}`,
        { identifier: `ENG-${i}`, url: `https://linear/ENG-${i}` },
      ])
    );
    const latestRunByTaskId = new Map(
      Array.from({ length: 100 }, (_, i) => [
        `t-${i * 5}`,
        { createdAt: '2026-10-15T10:00:00.000Z' },
      ])
    );
    // Warm the JIT on a first pass: the hook recomputes many times a
    // session, so the steady state is what matters.
    evaluate(build(tasks, { linearLinks, latestRunByTaskId }));
    const started = performance.now();
    const data = build(tasks, { linearLinks, latestRunByTaskId });
    const { timeline, allocation, assessments } = evaluate(data);
    const elapsed = performance.now() - started;
    // Reported in the test output so a slowdown is seen, not only failed.
    console.log(`planning chain over 500 tasks: ${elapsed.toFixed(1)} ms`);
    expect(elapsed).toBeLessThan(50);

    expect(data.issues).toHaveLength(500);
    expect(data.milestones).toHaveLength(30);
    expect(data.projects).toHaveLength(10);
    expect(data.relations.length).toBeGreaterThan(100);
    expect(assessments.size).toBe(30);
    expect(timeline.groups.map((g) => g.lanes.length)).toEqual([5, 5]);
    // Timeline order: initiative 0's lanes (the even projects), then 1's.
    expect(
      timeline.banners.projectsWithoutLead.map((p) => p.projectId)
    ).toEqual(['proj-0', 'proj-6', 'proj-3', 'proj-9']);
    expect(timeline.banners.milestonesWithoutDate).toHaveLength(0);
    expect(allocation.totals.blockedProjects).toBeGreaterThan(0);

    // The milestone-level graph the timeline's connectors come from.
    const graphStarted = performance.now();
    const graph = buildDependencyGraph(
      indexWorkspace(data),
      buildEvalContext(NOW),
      assessments,
      { level: 'milestone' }
    );
    const graphElapsed = performance.now() - graphStarted;
    // Reported in the test output so a slowdown is seen, not only failed.
    console.log(
      `milestone graph over 500 tasks: ${graphElapsed.toFixed(1)} ms`
    );
    expect(graph.nodes).toHaveLength(30);
    expect(graph.edges.length).toBeGreaterThan(0);
  });
});
