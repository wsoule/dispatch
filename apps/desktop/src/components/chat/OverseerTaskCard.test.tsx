import type { RunMeta } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import { appliedTaskCard } from '../../lib/overseerTaskCard';
import { OverseerTaskCard } from './OverseerTaskCard';

function run(over: Partial<RunMeta>): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-a',
    taskTitle: 'Schema',
    state: 'running',
    createdAt: '2026-11-01T10:00:00Z',
    ...over,
  } as RunMeta;
}

const titles: Record<string, string> = {
  't-a': 'Schema',
  't-b': 'Endpoints',
  't-c': 'UI',
};

function rows(): HTMLElement[] {
  return screen.getAllByTestId('overseer-task-row');
}

describe('OverseerTaskCard', () => {
  test('the head counts proposed and started; rows read live only once started', () => {
    const card = appliedTaskCard(['t-a', 't-b', 't-c'], (id) => titles[id], [
      run({
        id: 'r-a',
        taskId: 't-a',
        lastStep: { text: 'Editing src/db.ts', at: '2026-11-01T10:01:00Z' },
      }),
      run({ id: 'r-b', taskId: 't-b', state: 'failed' }),
    ]);
    render(<OverseerTaskCard card={card} />);
    expect(screen.getByRole('heading').textContent).toBe('3 suggested tasks');
    expect(screen.getByText('2 started')).toBeTruthy();
    const [a, b, c] = rows();
    expect(a.dataset['live']).toBe('true');
    expect(a.dataset['runState']).toBe('running');
    // The live run's step is its status line; a failed run says so in words.
    expect(a.textContent).toContain('Editing src/db.ts');
    expect(b.textContent).toContain('Failed');
    // The dot carries the run's feed state and names it.
    expect(
      a.querySelector('[data-slot="state-dot"]')?.getAttribute('data-state')
    ).toBe('working');
    expect(
      b.querySelector('[data-slot="state-dot"]')?.getAttribute('data-state')
    ).toBe('failed');
    expect(c.dataset['live']).toBe('false');
    expect(c.querySelector('[data-slot="state-dot"]')).toBeNull();
  });

  test('a merged run takes the closed-out disc', () => {
    const card = appliedTaskCard(['t-a'], (id) => titles[id], [
      run({
        state: 'finished',
        reviewAction: 'merge',
        reviewedAt: '2026-11-01T11:00:00Z',
      }),
    ]);
    render(<OverseerTaskCard card={card} />);
    expect(
      rows()[0]
        .querySelector('[data-slot="state-dot"]')
        ?.getAttribute('data-state')
    ).toBe('done');
  });

  test('a row with a task opens it; a proposed title does not', () => {
    const onOpenTask = mock((_id: string) => {});
    render(
      <OverseerTaskCard
        card={{
          entries: [{ taskId: 't-a', title: 'Schema' }, { title: 'Not yet' }],
          proposed: 2,
          started: 0,
        }}
        onOpenTask={onOpenTask}
      />
    );
    expect(screen.getAllByRole('button')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: /Schema/ }));
    expect(onOpenTask).toHaveBeenCalledWith('t-a');
  });
});
