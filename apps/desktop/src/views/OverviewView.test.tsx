import type { RunMeta } from '@dispatch/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { tintForState } from '../lib/feedState';
import { OverviewView } from './OverviewView';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-10T00:00:00.000Z',
    updatedAt: '2026-08-10T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function dataWith(
  runs: RunMeta[],
  overrides: Partial<DispatchProjectData> = {}
): DispatchProjectData {
  return {
    portLoading: false,
    portError: false,
    portErrorDetail: null,
    client: {},
    retryEnsureDispatchd: () => {},
    runs,
    tasks: [],
    epics: [],
    readyIds: new Set(),
    blockedIds: new Set(),
    mergeQueue: null,
    pendingApprovals: new Map(),
    openQuestions: new Map(),
    pendingScopeRequests: new Map(),
    fixLoops: new Map(),
    handleStopFixLoop: async () => {},
    handleApprove: async () => {},
    handleDispatch: async () => {},
    handleDequeueMerge: async () => {},
    ...overrides,
  } as unknown as DispatchProjectData;
}

function renderOverview(data: DispatchProjectData) {
  const log: string[] = [];
  const result = render(
    <OverviewView
      data={data}
      projectName="dispatch"
      onOpenRun={(id) => log.push(`run:${id}`)}
      onReviewRun={(id) => log.push(`review:${id}`)}
      onOpenTask={(id) => log.push(`task:${id}`)}
      onGoToBoard={() => log.push('board')}
    />
  );
  return { ...result, log };
}

test('the header crumb, state pills and tinted group headers over 36px rows', () => {
  const { container } = renderOverview(
    dataWith([
      run(),
      run({
        id: 'r-2',
        taskId: 't-2',
        taskTitle: 'Finished one',
        state: 'finished',
      }),
    ])
  );

  const header = container.querySelector('[data-slot="page-header"]');
  expect(header?.textContent).toContain('dispatch');
  expect(header?.textContent).toContain('Overview');

  // The ribbon is a row of view-tab pills with the count as plain text — no uppercase,
  // no mono.
  const ribbon = screen.getByRole('group', { name: 'Feed states' });
  const working = within(ribbon).getByRole('button', { name: /^Working/ });
  expect(working.className).toContain('rounded-pill');
  expect(working.className).not.toContain('uppercase');
  // The count is a separate muted span; the accessible name keeps the two apart.
  expect(working.getAttribute('aria-label')).toBe('Working, 1');
  expect(working.textContent).toBe('Working1');

  const groups = container.querySelectorAll('[data-slot="group-header"]');
  expect(Array.from(groups, (g) => g.textContent)).toEqual([
    'Review1',
    'Working1',
  ]);
  const reviewHeader = groups[0] as HTMLElement;
  expect(reviewHeader.className).toContain('status-tint');
  expect(reviewHeader.style.getPropertyValue('--tint')).toBe(
    tintForState('review')
  );
  expect(
    reviewHeader.querySelector('[data-slot="group-header-icon"] svg')
  ).not.toBeNull();

  const rows = container.querySelectorAll('[data-slot="list-row"]');
  expect(rows).toHaveLength(2);
  expect(rows[0]?.className).toContain('h-9');
});

test('a long group renders every row — no cap, no show-more', () => {
  const runs = Array.from({ length: 12 }, (_, i) =>
    run({ id: `r-${i}`, taskId: `t-${i}`, taskTitle: `Task ${i}` })
  );
  const { container } = renderOverview(dataWith(runs));
  expect(container.querySelectorAll('[data-slot="list-row"]')).toHaveLength(12);
  expect(screen.queryByText(/show the other/i)).toBeNull();
  expect(
    container.querySelector('[data-slot="group-header"]')?.textContent
  ).toBe('Working12');
});

test('urgent groups are pinned open; the machine groups fold from the header chevron', () => {
  const { container } = renderOverview(
    dataWith([
      run(),
      run({
        id: 'r-2',
        taskId: 't-2',
        taskTitle: 'Finished one',
        state: 'finished',
      }),
    ])
  );
  const groups = container.querySelectorAll('[data-slot="group-header"]');
  expect(
    within(groups[0] as HTMLElement).queryByRole('button', { name: /group/ })
  ).toBeNull();
  fireEvent.click(
    within(groups[1] as HTMLElement).getByRole('button', {
      name: 'Collapse group',
    })
  );
  expect(container.querySelectorAll('[data-slot="list-row"]')).toHaveLength(1);
  // The count stays on the folded header.
  expect(
    container.querySelectorAll('[data-slot="group-header"]')[1]?.textContent
  ).toBe('Working1');
});

test('a ribbon pill filters the feed; ready/blocked go to the board', () => {
  const { container, log } = renderOverview(
    dataWith(
      [
        run(),
        run({
          id: 'r-2',
          taskId: 't-2',
          taskTitle: 'Finished one',
          state: 'finished',
        }),
      ],
      { readyIds: new Set(['t-9']) }
    )
  );
  const ribbon = screen.getByRole('group', { name: 'Feed states' });
  fireEvent.click(within(ribbon).getByRole('button', { name: /^Review/ }));
  expect(container.querySelectorAll('[data-slot="list-row"]')).toHaveLength(1);
  expect(
    within(ribbon)
      .getByRole('button', { name: /^Review/ })
      .getAttribute('aria-pressed')
  ).toBe('true');
  fireEvent.click(within(ribbon).getByRole('button', { name: /^Ready/ }));
  expect(log).toEqual(['board']);
});

test('an empty feed is the quiet empty state, a filtered-out one says so', () => {
  const { container } = renderOverview(dataWith([]));
  expect(screen.getByText('All quiet')).toBeDefined();
  fireEvent.change(screen.getByRole('textbox', { name: 'Filter the feed' }), {
    target: { value: 'zzz' },
  });
  expect(
    container.querySelector('[data-slot="empty-state"]')?.textContent
  ).toContain('Nothing matches that filter');
});

test('clicking a row opens its run', () => {
  const { log } = renderOverview(dataWith([run()]));
  fireEvent.click(screen.getByRole('row'));
  expect(log).toEqual(['run:r-1']);
});
