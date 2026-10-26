import {
  DEFAULT_STATUS_MODEL,
  type TaskListItem,
} from '@dispatch-foo/core/browser';
import {
  assessWorkspace,
  indexWorkspace,
  type MilestoneAssessment,
  type Snapshot,
} from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import type { ContainerStatus } from '../lib/containerStatus';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import {
  buildCrumbs,
  buildProjectsSection,
  buildSettingsLink,
  buildShellNav,
  buildShellTabs,
  orbCountTone,
  planningProjectMark,
  type ProjectMark,
  projectMark,
  SHELL_DESTINATION_LABELS,
} from './shell';
import { buildEvalContext, buildWorkspaceData } from './workspaceData';

const QUIET = {
  count: null,
  tone: 'idle' as const,
  label: 'Overseer · nothing waiting on you',
};

function nav(over: Partial<Parameters<typeof buildShellNav>[0]> = {}) {
  return buildShellNav({
    destination: 'overseer',
    overseer: QUIET,
    needsYou: 0,
    threadsUnread: 0,
    modLabel: '⌘',
    ...over,
  });
}

describe('buildShellNav', () => {
  test('seven rows in order, the current one marked, keys as the shell prints them', () => {
    const items = nav({ destination: 'threads' });
    expect(items.map((item) => item.label)).toEqual([
      'Overseer',
      'Issues',
      'Needs you',
      'Timeline',
      'Threads',
      'Docs',
      'Runs',
    ]);
    expect(items.map((item) => item.current)).toEqual([
      false,
      false,
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(items[0].shortcut).toEqual(['⌘', '1']);
    expect(items[2].shortcut).toEqual(['G', 'I']);
    expect(items[3].shortcut).toEqual(['G', 'L']);
    expect(items[5].shortcut).toBeUndefined();
    expect(items.every((item) => item.href === `#/${item.id}`)).toBe(true);
  });

  test('Needs you counts the asks in amber; Threads the unread in the accent', () => {
    const items = nav({ needsYou: 2, threadsUnread: 3 });
    const needs = items.find((item) => item.id === 'needs-you');
    expect(needs?.count).toBe(2);
    expect(needs?.countTone).toBe('warning');
    expect(needs?.countLabel).toBe('2 waiting on you');
    const threads = items.find((item) => item.id === 'threads');
    expect(threads?.count).toBe(3);
    expect(threads?.countTone).toBe('accent');
    expect(threads?.countLabel).toBe('3 unread');
  });

  test('the Overseer row carries the orb badge, in the orb tone', () => {
    const quiet = nav()[0];
    expect(quiet.count).toBeUndefined();
    const asking = nav({
      overseer: {
        count: 5,
        tone: 'amber',
        label: 'Overseer · 5 waiting on you (work 5)',
      },
    })[0];
    expect(asking.count).toBe(5);
    expect(asking.countTone).toBe('warning');
    expect(asking.countLabel).toBe('Overseer · 5 waiting on you (work 5)');
    const reviewing = nav({
      overseer: { count: 1, tone: 'green', label: 'Overseer · 1 ready' },
    })[0];
    expect(reviewing.countTone).toBe('success');
  });

  test('the orb hues keep their meaning as tones; idle is a quiet number', () => {
    expect(orbCountTone('amber')).toBe('warning');
    expect(orbCountTone('green')).toBe('success');
    expect(orbCountTone('motion')).toBe('info');
    expect(orbCountTone('broken')).toBe('danger');
    expect(orbCountTone('off')).toBe('muted');
    expect(orbCountTone('idle')).toBeUndefined();
  });
});

describe('buildSettingsLink', () => {
  test('is current while Settings is open and counts admin items quietly', () => {
    expect(
      buildSettingsLink({ destination: 'issues', adminItems: [] })
    ).toEqual({ href: '#/settings', label: 'Settings', current: false });
    expect(
      buildSettingsLink({
        destination: 'settings',
        adminItems: [
          { label: '1 machine waiting to join', page: 'team', count: 1 },
          { label: '2 Claude files skipped', page: 'memory', count: 2 },
        ],
      })
    ).toEqual({ href: '#/settings', label: 'Settings · 3', current: true });
    // The Runs page is its own row, not Settings.
    expect(
      buildSettingsLink({ destination: 'runs', adminItems: [] }).current
    ).toBe(false);
  });
});

describe('buildShellTabs', () => {
  test('the phone keeps the four main destinations', () => {
    const tabs = buildShellTabs('docs');
    expect(tabs.map((tab) => tab.label)).toEqual([
      'Overseer',
      'Issues',
      'Threads',
      'Docs',
    ]);
    expect(tabs.map((tab) => tab.current)).toEqual([false, false, false, true]);
  });
});

const NOW = new Date('2026-10-09T12:00:00Z');

function health(
  health: ContainerStatus['health'],
  over: Partial<ContainerStatus> = {}
): ContainerStatus {
  return {
    asks: 0,
    failed: 0,
    working: 0,
    review: 0,
    done: 0,
    total: 4,
    health,
    ...over,
  };
}

describe('projectMark', () => {
  test('maps a container health onto the status diamond', () => {
    expect(projectMark(null, null, NOW).status).toBe('missing');
    expect(projectMark(health('idle', { total: 0 }), null, NOW)).toEqual({
      status: 'missing',
      label: 'No issues yet',
    });
    expect(projectMark(health('finished', { done: 4 }), null, NOW)).toEqual({
      status: 'done',
      label: 'All issues done',
    });
    expect(projectMark(health('attention', { asks: 1 }), null, NOW)).toEqual({
      status: 'at_risk',
      label: 'Needs attention',
    });
    expect(projectMark(health('moving', { working: 1 }), null, NOW)).toEqual({
      status: 'on_track',
      label: 'In progress',
    });
    expect(projectMark(health('idle'), null, NOW)).toEqual({
      status: 'on_track',
      label: 'On track',
    });
  });

  test('a target date in the past is overdue unless everything is done', () => {
    expect(projectMark(health('idle'), '2026-10-01', NOW).status).toBe(
      'overdue'
    );
    expect(projectMark(health('attention'), '2026-10-01', NOW).status).toBe(
      'overdue'
    );
    expect(projectMark(health('idle'), '2026-10-20', NOW).status).toBe(
      'on_track'
    );
    expect(
      projectMark(health('finished', { done: 4 }), '2026-10-01', NOW).status
    ).toBe('done');
  });
});

function project(id: string, over: Partial<TaskListItem['meta']> = {}) {
  return taskDoc({ id, title: `Project ${id}`, kind: 'project', ...over });
}

describe('buildProjectsSection', () => {
  test('one row per project, linking to its page, with its mark', () => {
    const tasks = [
      taskDoc({ id: 't-1', title: 'An issue' }),
      project('p-1'),
      taskDoc({ id: 'm-1', title: 'A milestone', kind: 'milestone' }),
      project('p-2', { dueDate: '2026-09-30' }),
    ];
    const statuses: Record<string, ContainerStatus> = {
      'p-1': health('attention', { asks: 2 }),
      'p-2': health('idle'),
    };
    const section = buildProjectsSection({
      tasks,
      containerStatusOf: (id) => statuses[id] ?? null,
      now: NOW,
    });
    expect(section.title).toBe('Projects');
    expect(section.action).toEqual({ label: 'All', href: '#/projects' });
    expect(section.items).toEqual([
      {
        id: 'p-1',
        label: 'Project p-1',
        href: '#/task/p-1',
        status: 'at_risk',
        statusLabel: 'Needs attention',
      },
      {
        id: 'p-2',
        label: 'Project p-2',
        href: '#/task/p-2',
        status: 'overdue',
        statusLabel: 'Overdue',
      },
    ]);
  });

  test('the planning mark wins over the container status, per project', () => {
    const tasks = [
      project('p-1', { dueDate: '2026-09-30' }),
      project('p-2'),
      project('p-3'),
    ];
    const planned: Record<string, ProjectMark> = {
      // The planning sees the next milestone at risk; the container status
      // (idle, overdue by its date) is not consulted.
      'p-1': { status: 'at_risk', label: 'At risk' },
      'p-3': { status: 'done', label: 'All milestones complete' },
    };
    const section = buildProjectsSection({
      tasks,
      containerStatusOf: () => health('attention', { asks: 1 }),
      statusOf: (id) => planned[id] ?? null,
      now: NOW,
    });
    expect(
      section.items.map((item) => [item.id, item.status, item.statusLabel])
    ).toEqual([
      ['p-1', 'at_risk', 'At risk'],
      // No planning reading: the container status fallback.
      ['p-2', 'at_risk', 'Needs attention'],
      ['p-3', 'done', 'All milestones complete'],
    ]);
  });

  test('the legacy epic kind is a milestone, never a project', () => {
    const section = buildProjectsSection({
      tasks: [
        taskDoc({
          id: 'e-1',
          title: 'Old epic',
          kind: 'epic' as TaskListItem['meta']['kind'],
        }),
      ],
      containerStatusOf: () => null,
      now: NOW,
    });
    expect(section.items).toEqual([]);
    expect(section.emptyLabel).toBe('No projects yet');
  });

  test('stops at the limit, in list order', () => {
    const tasks = Array.from({ length: 15 }, (_, i) => project(`p-${i}`));
    const section = buildProjectsSection({
      tasks,
      containerStatusOf: () => null,
      now: NOW,
    });
    expect(section.items).toHaveLength(12);
    expect(section.items[0].id).toBe('p-0');
    expect(section.items[11].id).toBe('p-11');
    expect(
      buildProjectsSection({
        tasks,
        containerStatusOf: () => null,
        now: NOW,
        limit: 3,
      }).items
    ).toHaveLength(3);
  });
});

describe('buildCrumbs', () => {
  test('project / destination / open task', () => {
    expect(
      buildCrumbs({ projectName: 'storefront', destination: 'issues' })
    ).toEqual([
      { label: 'storefront', href: '#/overseer' },
      { label: 'Issues', href: '#/issues' },
    ]);
    expect(
      buildCrumbs({
        projectName: 'storefront',
        destination: 'needs-you',
        taskTitle: 'Persist the cart',
      })
    ).toEqual([
      { label: 'storefront', href: '#/overseer' },
      { label: 'Needs you', href: '#/needs-you' },
      { label: 'Persist the cart' },
    ]);
  });

  test('without a project the destination stands alone', () => {
    expect(
      buildCrumbs({
        projectName: null,
        destination: 'overseer',
        taskTitle: null,
      })
    ).toEqual([{ label: 'Overseer', href: '#/overseer' }]);
  });
});

test('every destination has a label', () => {
  expect(Object.keys(SHELL_DESTINATION_LABELS).sort()).toEqual([
    'docs',
    'issues',
    'needs-you',
    'overseer',
    'runs',
    'settings',
    'threads',
    'timeline',
  ]);
});

describe('planningProjectMark', () => {
  /** A planning over `tasks`, as App's usePlanning computes it. */
  function plan(tasks: Parameters<typeof buildWorkspaceData>[0]['tasks']): {
    snapshot: Snapshot;
    assessments: Map<string, MilestoneAssessment>;
  } {
    const snapshot = indexWorkspace(
      buildWorkspaceData({
        tasks,
        model: DEFAULT_STATUS_MODEL,
        people: [{ ref: 'human:ana', name: 'Ana' }],
        executors: [],
        me: 'human:ana',
        hrefFor: (id) => `#/task/${id}`,
      })
    );
    const assessments = assessWorkspace(snapshot, buildEvalContext(new Date()));
    return { snapshot, assessments };
  }
  const DONE = '## Description\n\nDone means: it ships.\n';
  const project = taskDoc({
    id: 'p-1',
    title: 'Storefront',
    kind: 'project',
    status: 'working',
    assignee: 'human:ana',
  });

  test('is the next milestone’s mark: overdue first, on track once valid', () => {
    const { snapshot, assessments } = plan([
      project,
      taskDoc(
        {
          id: 'ms-late',
          title: 'Late',
          kind: 'milestone',
          parent: 'p-1',
          dueDate: dayFromNow(-2),
        },
        DONE
      ),
      taskDoc({ id: 't-1', title: 'A', parent: 'ms-late', status: 'ready' }),
      taskDoc(
        {
          id: 'ms-next',
          title: 'Next',
          kind: 'milestone',
          parent: 'p-1',
          dueDate: dayFromNow(20),
        },
        DONE
      ),
      taskDoc({ id: 't-2', title: 'B', parent: 'ms-next', status: 'ready' }),
    ]);
    expect(planningProjectMark(snapshot, assessments, 'p-1')).toEqual({
      status: 'overdue',
      label: 'Overdue',
    });
  });

  test('a missing input is the dotted mark; done once every milestone is complete; null with none', () => {
    const { snapshot, assessments } = plan([
      project,
      // No due date and no issues: the rubric fails.
      taskDoc({
        id: 'ms-bare',
        title: 'Bare',
        kind: 'milestone',
        parent: 'p-1',
      }),
    ]);
    expect(planningProjectMark(snapshot, assessments, 'p-1')?.status).toBe(
      'missing'
    );
    const done = plan([
      project,
      taskDoc(
        {
          id: 'ms-done',
          title: 'Done',
          kind: 'milestone',
          parent: 'p-1',
          dueDate: dayFromNow(-30),
        },
        DONE
      ),
      taskDoc({ id: 't-1', title: 'A', parent: 'ms-done', status: 'done' }),
    ]);
    expect(planningProjectMark(done.snapshot, done.assessments, 'p-1')).toEqual(
      { status: 'done', label: 'All milestones complete' }
    );
    const bare = plan([project]);
    expect(
      planningProjectMark(bare.snapshot, bare.assessments, 'p-1')
    ).toBeNull();
    expect(
      planningProjectMark(bare.snapshot, bare.assessments, 'p-x')
    ).toBeNull();
  });

  test('buildProjectsSection takes the planning mark over the rolled-up status', () => {
    const { snapshot, assessments } = plan([
      project,
      taskDoc(
        {
          id: 'ms-late',
          title: 'Late',
          kind: 'milestone',
          parent: 'p-1',
          dueDate: dayFromNow(-2),
        },
        DONE
      ),
      taskDoc({ id: 't-1', title: 'A', parent: 'ms-late', status: 'ready' }),
    ]);
    const section = buildProjectsSection({
      tasks: [project],
      containerStatusOf: () => null,
      statusOf: (id) => planningProjectMark(snapshot, assessments, id),
    });
    expect(section.items[0]).toMatchObject({
      status: 'overdue',
      statusLabel: 'Overdue',
    });
  });
});
