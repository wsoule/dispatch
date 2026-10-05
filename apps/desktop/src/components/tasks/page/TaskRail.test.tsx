import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  fakeHost,
  type HostLog,
  newLog,
  PageProviders,
  task,
} from './pageHost.test-helper';

// The Review mode pulls in the Pierre diff, whose worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { TaskPage } = await import('./TaskPage');

function mount(tasks: ReturnType<typeof task>[], log: HostLog = newLog()) {
  render(
    <PageProviders host={fakeHost(log, { tasks })}>
      <TaskPage taskId="t-1" layout="peek" />
    </PageProviders>
  );
  const rail = document.querySelector<HTMLElement>('[data-slot=task-rail]');
  if (rail === null) throw new Error('no rail');
  return rail;
}

describe('TaskRail Linear fields', () => {
  test('a project shows its icon in its colour, its start date and its creator', () => {
    const rail = mount([
      task('t-1', {
        kind: 'project',
        icon: 'Rocket',
        color: '#5e6ad2',
        startDate: '2026-10-01',
        creator: 'human:maya',
      }),
    ]);
    const container = rail.querySelector<HTMLElement>(
      '[data-slot=container-row]'
    );
    expect(container?.textContent).toContain('Project');
    expect(container?.getAttribute('title')).toBe(
      'Icon Rocket · Color #5e6ad2'
    );
    const icon = container?.querySelector<SVGElement>(
      '[data-slot=container-icon]'
    );
    // Rocket is a known Linear icon, drawn in the project's colour.
    expect(icon?.getAttribute('class')).toContain('lucide-rocket');
    expect(icon?.getAttribute('style')).toContain('color');
    expect(
      rail.querySelector('[data-slot=start-date-control]')?.textContent
    ).toContain('Oct 1');
    expect(
      rail.querySelector('[data-slot=creator-row]')?.textContent
    ).toContain('Created by maya');
  });

  test('an emoji icon draws as itself', () => {
    const rail = mount([task('t-1', { kind: 'milestone', icon: '🧭' })]);
    expect(rail.querySelector('[data-slot=container-icon]')?.textContent).toBe(
      '🧭'
    );
  });

  test('a plain task with neither field shows no start date or creator row', () => {
    const rail = mount([task('t-1')]);
    expect(rail.querySelector('[data-slot=container-row]')).toBeNull();
    expect(rail.querySelector('[data-slot=start-date-control]')).toBeNull();
    expect(rail.querySelector('[data-slot=creator-row]')).toBeNull();
  });

  test('setting and clearing the start date patches the task', async () => {
    const log = newLog();
    mount([task('t-1', { kind: 'project', startDate: '2026-10-01' })], log);
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Change start date'));
      await Promise.resolve();
    });
    fireEvent.change(screen.getByLabelText('Start date'), {
      target: { value: '2026-10-05' },
    });
    expect(log.updates.at(-1)).toEqual({
      id: 't-1',
      patch: { startDate: '2026-10-05' },
    });
    await act(async () => {
      fireEvent.click(screen.getByLabelText('Change start date'));
      await Promise.resolve();
    });
    fireEvent.click(screen.getByText('Clear start date'));
    expect(log.updates.at(-1)).toEqual({
      id: 't-1',
      patch: { startDate: null },
    });
  });
});
