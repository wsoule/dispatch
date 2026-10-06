import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import { act, render } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import type { CockpitItem } from '../../lib/cockpit';
import { runSteps } from '../../lib/runStep';
import { CockpitRow } from './CockpitRow';

const ME = 'human:wyat';

function task(id: string, status: string): TaskListItem {
  return {
    meta: {
      id,
      title: `Title ${id}`,
      status,
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: ME,
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-10T00:00:00.000Z',
      dueDate: null,
      cycle: null,
    },
  } as unknown as TaskListItem;
}

function renderRow(
  item: CockpitItem,
  landing?: Parameters<typeof CockpitRow>[0]['landing']
) {
  return render(
    <div role="grid">
      <CockpitRow
        item={item}
        focused={false}
        plan={undefined}
        landing={landing}
        onActivate={() => {}}
      />
    </div>
  );
}

function badge(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-slot=landing-badge]');
}

describe('CockpitRow landing badge', () => {
  test('a teammate’s started task in the queue reads Landing', () => {
    const { container } = renderRow(
      {
        kind: 'started',
        key: 't-1',
        taskId: 't-1',
        owner: ME,
        task: task('t-1', 'In Review'),
      },
      'verifying'
    );
    expect(badge(container)?.textContent).toBe('Landing');
    expect(badge(container)?.getAttribute('title')).toBe('Landing · verifying');
  });

  test('an in-review row that is already queued says so beside its reason', () => {
    const { container } = renderRow(
      {
        kind: 'needs',
        key: 'needs:t-2',
        taskId: 't-2',
        owner: ME,
        reason: 'in-review',
        task: task('t-2', 'In Review'),
        run: undefined,
        since: '2026-09-10T00:00:00.000Z',
      },
      'waiting-github'
    );
    expect(container.textContent).toContain('In review');
    expect(badge(container)?.getAttribute('data-queue-state')).toBe(
      'waiting-github'
    );
  });

  test('no queue entry, no badge', () => {
    const { container } = renderRow({
      kind: 'started',
      key: 't-3',
      taskId: 't-3',
      owner: ME,
      task: task('t-3', 'In Progress'),
    });
    expect(badge(container)).toBeNull();
  });

  test('a landing row carries the badge, the queue step and the run’s cost', () => {
    const { container } = renderRow(
      {
        kind: 'landing',
        key: 'landing:t-4',
        taskId: 't-4',
        owner: ME,
        task: task('t-4', 'landing'),
        run: { costUsd: 1.25 } as RunMeta,
        since: '2026-09-10T00:00:00.000Z',
      },
      'rebasing'
    );
    const row = container.querySelector<HTMLElement>('[data-kind=landing]');
    expect(row?.textContent).toContain('Title t-4');
    expect(row?.textContent).toContain('rebasing');
    expect(row?.textContent).toContain('$1.25');
    expect(badge(container)?.getAttribute('title')).toBe('Landing · rebasing');
  });
});

describe('CockpitRow live step', () => {
  test('an in-flight row swaps the agent for its run’s latest step once the log says it', async () => {
    const run: RunMeta = {
      id: 'r-step-cockpit',
      taskId: 't-9',
      taskTitle: 'Title t-9',
      executor: 'claude',
      state: 'running',
      branch: 'b',
      baseBranch: 'main',
      worktreePath: '/wt/r-step-cockpit',
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    };
    const { container } = renderRow({
      kind: 'run',
      key: `run:${run.id}`,
      taskId: run.taskId,
      owner: ME,
      run,
      task: undefined,
      nested: false,
    });
    const step = () =>
      container.querySelector('[data-slot=run-step]')?.textContent ?? null;
    // The agent's name holds the slot until the first step arrives.
    expect(step()).toBeNull();
    expect(container.textContent).toContain('claude');
    await act(async () => {
      runSteps.record(run.id, {
        ts: '2026-09-20T00:00:01.000Z',
        kind: 'tool',
        toolName: 'Edit',
        toolInput: { file_path: '/wt/r-step-cockpit/src/foo.ts' },
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
    });
    expect(step()).toBe('Editing src/foo.ts');
    expect(
      container.querySelector('[data-slot=run-step]')?.getAttribute('title')
    ).toBe('claude · Editing src/foo.ts');
  });
});
