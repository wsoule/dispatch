import type { TaskListItem } from '@dispatch-foo/core/browser';
import { NO_INITIATIVE_ID } from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import { cardParents, upperLevelGroups } from './graphLevels';
import { taskDoc } from './taskDoc.test-helper';

// Growth (initiative) › Storefront (project) › Beta (milestone) › t-cart; Storefront's own
// loose t-copy; Search (project, no initiative) › Index › t-rank; t-loose has no project.
const CONTAINERS: TaskListItem[] = [
  taskDoc({ id: 'i-growth', title: 'Growth', kind: 'initiative' }),
  taskDoc({ id: 'i-empty', title: 'Empty', kind: 'initiative' }),
  taskDoc({
    id: 'p-store',
    title: 'Storefront',
    kind: 'project',
    parent: 'i-growth',
  }),
  taskDoc({ id: 'p-search', title: 'Search', kind: 'project' }),
  taskDoc({
    id: 'ms-beta',
    title: 'Beta',
    kind: 'milestone',
    parent: 'p-store',
  }),
  taskDoc({
    id: 'ms-index',
    title: 'Index',
    kind: 'milestone',
    parent: 'p-search',
  }),
];
const TASKS: TaskListItem[] = [
  taskDoc({
    id: 't-cart',
    title: 't-cart',
    parent: 'ms-beta',
    blockedBy: ['t-rank'],
  }),
  taskDoc({ id: 't-copy', title: 't-copy', parent: 'p-store' }),
  taskDoc({ id: 't-sub', title: 't-sub', parent: 't-cart' }),
  taskDoc({ id: 't-rank', title: 't-rank', parent: 'ms-index' }),
  taskDoc({ id: 't-loose', title: 't-loose' }),
];

const rowsOf = (groups: ReturnType<typeof upperLevelGroups>) =>
  groups.map((g) => [g.milestoneId, g.label, g.rows.map((r) => r.doc.meta.id)]);

describe('upperLevelGroups', () => {
  test('the project level holds every task under each project, subtasks included', () => {
    expect(rowsOf(upperLevelGroups(TASKS, CONTAINERS, 'project'))).toEqual([
      ['p-store', 'Storefront', ['t-cart', 't-copy', 't-sub']],
      ['p-search', 'Search', ['t-rank']],
    ]);
  });

  test('the initiative level adds No initiative last and leaves empty initiatives out', () => {
    expect(rowsOf(upperLevelGroups(TASKS, CONTAINERS, 'initiative'))).toEqual([
      ['i-growth', 'Growth', ['t-cart', 't-copy', 't-sub']],
      [NO_INITIATIVE_ID, 'No initiative', ['t-rank']],
    ]);
  });

  test('a parent loop ends the walk instead of hanging', () => {
    const loop = [
      taskDoc({ id: 'a', title: 'a', parent: 'b' }),
      taskDoc({ id: 'b', title: 'b', parent: 'a' }),
    ];
    expect(upperLevelGroups(loop, [], 'project')).toEqual([]);
  });
});

describe('cardParents', () => {
  test('frames milestones in their projects, and projects in their initiatives', () => {
    const projects = upperLevelGroups(TASKS, CONTAINERS, 'project');
    expect([...cardParents(projects, CONTAINERS, 'initiative')]).toEqual([
      ['p-store', { id: 'i-growth', label: 'Growth' }],
      ['p-search', { id: NO_INITIATIVE_ID, label: 'No initiative' }],
    ]);
    const beta = { ...projects[0], milestoneId: 'ms-beta' };
    expect([...cardParents([beta], CONTAINERS, 'project')]).toEqual([
      ['ms-beta', { id: 'p-store', label: 'Storefront' }],
    ]);
  });
});
