import { describe, expect, it } from 'bun:test';

import {
  containerCreate,
  INITIATIVE_FIELDS,
  initiativePatch,
  initiativePush,
  initiativeValues,
  MILESTONE_FIELDS,
  milestonePatch,
  milestonePush,
  milestoneValues,
  PROJECT_FIELDS,
  projectPatch,
  projectPush,
  projectValues,
  taskInitiativeValues,
  taskMilestoneValues,
  taskProjectValues,
} from '../src/linearContainers.js';
import type {
  LinearInitiative,
  LinearProject,
  LinearProjectMilestone,
} from '../src/linearMap.js';
import { applyUpdatePatch } from '../src/store.js';
import type { TaskMeta } from '../src/types.js';
import {
  context,
  doc,
  linked,
  pick,
  PROJECT_STATUSES,
  rng,
} from './linearFixtures.js';

const NOW = '2026-07-10T00:00:00.000Z';

function project(overrides: Partial<LinearProject> = {}): LinearProject {
  return {
    id: 'p-x',
    name: 'Checkout v2',
    summary: 'Short summary',
    content: 'Long **content**\n\n## Scope\n\nall of it',
    icon: 'Rocket',
    color: '#5e6ad2',
    startDate: '2026-07-01',
    targetDate: '2026-09-30',
    leadId: 'u-ana',
    status: PROJECT_STATUSES[2],
    priority: 2,
    url: 'https://linear.app/acme/project/x',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    teamIds: ['team-1'],
    initiatives: [
      { id: 'i2p-1', initiativeId: 'init-b' },
      { id: 'i2p-2', initiativeId: 'init-a' },
    ],
    ...overrides,
  };
}

function initiative(
  overrides: Partial<LinearInitiative> = {}
): LinearInitiative {
  return {
    id: 'init-x',
    name: 'Grow revenue',
    description: 'short',
    content: 'The long version',
    ownerId: 'u-me',
    creatorId: 'u-me',
    status: 'Active',
    targetDate: '2026-12-31',
    color: '#f00',
    icon: 'Target',
    url: 'https://linear.app/acme/initiative/x',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function milestone(
  overrides: Partial<LinearProjectMilestone> = {}
): LinearProjectMilestone {
  return {
    id: 'm-x',
    name: 'Beta',
    description: 'Beta cut',
    targetDate: '2026-08-15',
    sortOrder: 1,
    projectId: 'p-1',
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    archivedAt: null,
    ...overrides,
  };
}

function workspace(): TaskMeta[] {
  return [
    linked('t-a', 'initiative', 'init-a'),
    linked('t-b', 'initiative', 'init-b'),
    linked('t-p1', 'project', 'p-1'),
  ];
}

function same(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  fields: readonly string[]
) {
  for (const f of fields) {
    if (JSON.stringify(a[f]) !== JSON.stringify(b[f])) {
      throw new Error(
        `${f}: ${JSON.stringify(a[f])} != ${JSON.stringify(b[f])}`
      );
    }
  }
}

describe('projects', () => {
  it('round-trips every project field through a container task', () => {
    const random = rng(3);
    for (let run = 0; run < 100; run++) {
      const remote = project({
        status: pick(
          random,
          PROJECT_STATUSES.filter((s) => s.type !== 'paused')
        ),
        leadId: pick(random, [null, 'u-me', 'u-ana']),
        priority: Math.floor(random() * 5),
        startDate: pick(random, [null, '2026-07-01']),
        targetDate: pick(random, [null, '2026-09-30']),
        icon: pick(random, [null, 'Rocket']),
        content: pick(random, [null, '', 'Body', 'Body\n\n## Scope\n\nx']),
        initiatives: pick(random, [
          [],
          [{ id: 'l1', initiativeId: 'init-a' }],
          [
            { id: 'l1', initiativeId: 'init-b' },
            { id: 'l2', initiativeId: 'init-a' },
          ],
        ]),
        archivedAt: pick(random, [null, '2026-07-05T00:00:00.000Z']),
      });
      const tasks = workspace();
      const start = doc(linked('t-x', 'project', 'p-x'));
      const ctx0 = context([...tasks, start.meta]);
      const pulled = applyUpdatePatch(
        start,
        projectPatch(remote, PROJECT_FIELDS, start, ctx0),
        NOW
      );
      const ctx = context([...tasks, pulled.meta]);
      same(
        taskProjectValues(pulled, ctx),
        projectValues(remote, ctx),
        PROJECT_FIELDS
      );
    }
  });

  it('parents a project on its first initiative and keeps the rest as extras', () => {
    const ctx = context(workspace());
    const patch = projectPatch(
      project(),
      ['initiatives'],
      doc(linked('t-x', 'project', 'p-x')),
      ctx
    );
    expect(patch.parent).toBe('t-b');
    expect(patch.initiatives).toEqual(['t-a']);
  });

  it('reads a paused project as started and never pushes paused back', () => {
    const ctx = context(workspace());
    const paused = project({ status: PROJECT_STATUSES[3] });
    expect(projectValues(paused, ctx).status).toBe('started');
    const task = doc(
      linked('t-x', 'project', 'p-x', 'project', { status: 'In Progress' })
    );
    expect(projectPush(task, ['status'], paused, ctx).input.statusId).toBe(
      'ps-started'
    );
    const todo = doc(
      linked('t-x', 'project', 'p-x', 'project', { status: 'Todo' })
    );
    expect(projectPush(todo, ['status'], paused, ctx).input.statusId).toBe(
      'ps-planned'
    );
  });

  // A team whose workflow has its own Paused state (backlog-typed here) can
  // show a paused project as paused, both ways.
  function withPausedState(tasks: TaskMeta[]) {
    const ctx = context(tasks);
    return {
      ...ctx,
      model: {
        ...ctx.model,
        definitions: [
          ...ctx.model.definitions,
          { name: 'Paused', type: 'backlog' as const, color: null },
        ],
      },
    };
  }

  it('maps a project status by name when the team has a status spelling it', () => {
    const ctx = withPausedState(workspace());
    const paused = project({ status: PROJECT_STATUSES[3] });
    expect(projectValues(paused, ctx).status).toBe('=paused');
    const start = doc(
      linked('t-x', 'project', 'p-x', 'project', { status: 'In Progress' })
    );
    const pulled = applyUpdatePatch(
      start,
      projectPatch(paused, ['status'], start, ctx),
      NOW
    );
    expect(pulled.meta.status).toBe('Paused');
    same(taskProjectValues(pulled, ctx), projectValues(paused, ctx), [
      'status',
    ]);
    // Back in progress here: pushed as Linear's own In Progress, by name.
    const resumed = applyUpdatePatch(pulled, { status: 'In Progress' }, NOW);
    expect(taskProjectValues(resumed, ctx).status).toBe('=in progress');
    expect(projectPush(resumed, ['status'], paused, ctx).input.statusId).toBe(
      'ps-started'
    );
    expect(projectPush(pulled, ['status'], paused, ctx).input.statusId).toBe(
      'ps-paused'
    );
  });

  it('keeps a paused project’s local status when no status spells Paused', () => {
    const ctx = context(workspace());
    const paused = project({ status: PROJECT_STATUSES[3] });
    const start = doc(
      linked('t-x', 'project', 'p-x', 'project', { status: 'In Review' })
    );
    const patch = projectPatch(paused, ['status'], start, ctx);
    expect(patch.status).toBe('In Review');
    // Both read as started: a move among started statuses here never unpauses.
    expect(taskProjectValues(start, ctx).status).toBe(
      projectValues(paused, ctx).status
    );
  });

  it('never matches a name across the done line', () => {
    const ctx = context(workspace());
    // A workspace that named its completed project status "Todo".
    const odd = project({
      status: { id: 'ps-odd', name: 'Todo', type: 'completed' },
    });
    expect(projectValues(odd, ctx).status).toBe('completed');
    const start = doc(
      linked('t-x', 'project', 'p-x', 'project', { status: 'Todo' })
    );
    expect(projectPatch(odd, ['status'], start, ctx).status).toBe('Done');
  });

  it('turns initiative membership edits into link and unlink calls', () => {
    const ctx = context(workspace());
    const task = doc(
      linked('t-x', 'project', 'p-x', 'project', {
        parent: 't-a',
        initiatives: [],
      })
    );
    const push = projectPush(task, ['initiatives'], project(), ctx);
    expect(push.link).toEqual([]);
    expect(push.unlink).toEqual(['i2p-1']);
    const grow = doc(
      linked('t-x', 'project', 'p-x', 'project', {
        parent: 't-a',
        initiatives: ['t-b'],
      })
    );
    expect(
      projectPush(
        grow,
        ['initiatives'],
        project({ initiatives: [] }),
        ctx
      ).link.sort()
    ).toEqual(['init-a', 'init-b']);
  });

  it('never pushes an archive or a cleared color', () => {
    const ctx = context(workspace());
    const task = doc(
      linked('t-x', 'project', 'p-x', 'project', {
        color: null,
        archivedAt: NOW,
      })
    );
    expect(
      projectPush(task, ['color', 'archived'], project(), ctx).input
    ).toEqual({});
  });

  it('falls back to the summary when a project has no long content', () => {
    const ctx = context(workspace());
    expect(projectValues(project({ content: null }), ctx).description).toBe(
      'Short summary'
    );
  });
});

describe('milestones', () => {
  it('round-trips every milestone field', () => {
    const tasks = workspace();
    const start = doc(linked('t-x', 'milestone', 'm-x'));
    const remote = milestone();
    const pulled = applyUpdatePatch(
      start,
      milestonePatch(
        remote,
        MILESTONE_FIELDS,
        start,
        context([...tasks, start.meta])
      ),
      NOW
    );
    expect(pulled.meta.parent).toBe('t-p1');
    const ctx = context([...tasks, pulled.meta]);
    same(
      taskMilestoneValues(pulled, ctx),
      milestoneValues(remote, ctx),
      MILESTONE_FIELDS
    );
    expect(pulled.meta.sortOrder).toBe(1);
    expect(milestonePush(pulled, MILESTONE_FIELDS, ctx)).toEqual({
      name: 'Beta',
      description: 'Beta cut',
      targetDate: '2026-08-15',
      projectId: 'p-1',
      sortOrder: 1,
    });
  });

  it('never pushes an order a local milestone never had', () => {
    const tasks = workspace();
    const local = doc(linked('t-x', 'milestone', 'm-x'));
    const ctx = context([...tasks, local.meta]);
    expect(local.meta.sortOrder).toBeNull();
    expect(milestonePush(local, ['sortOrder'], ctx)).toEqual({});
    const moved = doc(
      linked('t-x', 'milestone', 'm-x', 'milestone', {
        sortOrder: -2,
      })
    );
    expect(milestonePush(moved, ['sortOrder'], ctx)).toEqual({ sortOrder: -2 });
  });
});

describe('initiative status names', () => {
  it('matches an initiative status a team state spells, by name', () => {
    const base = context(workspace());
    const ctx = {
      ...base,
      model: {
        ...base.model,
        definitions: [
          ...base.model.definitions,
          { name: 'Active', type: 'started' as const, color: null },
        ],
      },
    };
    const active = initiative({ status: 'Active' });
    expect(initiativeValues(active, ctx).status).toBe('=active');
    const start = doc(
      linked('t-x', 'initiative', 'init-x', 'initiative', {
        status: 'In Progress',
      })
    );
    const pulled = applyUpdatePatch(
      start,
      initiativePatch(active, ['status'], start, ctx),
      NOW
    );
    expect(pulled.meta.status).toBe('Active');
    expect(initiativePush(pulled, ['status'], ctx).status).toBe('Active');
  });
});

describe('initiatives', () => {
  it('round-trips every initiative field, statuses by category', () => {
    for (const status of ['Planned', 'Active', 'Completed', 'Canceled']) {
      const tasks = workspace();
      const start = doc(linked('t-x', 'initiative', 'init-x'));
      const remote = initiative({ status });
      const pulled = applyUpdatePatch(
        start,
        initiativePatch(
          remote,
          INITIATIVE_FIELDS,
          start,
          context([...tasks, start.meta])
        ),
        NOW
      );
      const ctx = context([...tasks, pulled.meta]);
      same(
        taskInitiativeValues(pulled, ctx),
        initiativeValues(remote, ctx),
        INITIATIVE_FIELDS
      );
      expect(initiativePush(pulled, ['status'], ctx).status).toBe(status);
    }
  });

  it('pushes a proposed initiative back as planned', () => {
    const ctx = context(workspace());
    const task = doc(
      linked('t-x', 'initiative', 'init-x', 'initiative', { status: 'Backlog' })
    );
    expect(
      initiativeValues(initiative({ status: 'Proposed' }), ctx).status
    ).toBe('backlog');
    expect(initiativePush(task, ['status'], ctx).status).toBe('Planned');
  });
});

describe('containerCreate', () => {
  it('creates a container task linked from the start', () => {
    expect(
      containerCreate('project', { id: 'p-9', name: 'P' }, 'Todo')
    ).toEqual({
      title: 'P',
      kind: 'project',
      status: 'Todo',
      external: 'linear-project:p-9',
    });
  });
});
