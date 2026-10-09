import type { EpicProgress, RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { LEAVE_MS } from '../../lib/flowList';
import { InflowColumn, OutflowColumn, spendLine } from './FlowColumns';

function run(id: string, state: RunMeta['state'], title: string): RunMeta {
  return {
    id,
    taskId: `t-${id}`,
    taskTitle: title,
    state,
    createdAt: '2026-10-06T09:00:00Z',
    updatedAt: '2026-10-06T09:00:00Z',
  } as RunMeta;
}

test('Going out lists live runs, opens their task, and says so when nothing runs', () => {
  const opened: string[] = [];
  const view = render(
    <OutflowColumn
      runs={[
        run('a', 'running', 'Warm the cache'),
        run('b', 'finished', 'Done one'),
      ]}
      merges={[]}
      setAside={[]}
      onOpenTask={(id) => opened.push(id)}
    />
  );
  expect(screen.getByRole('heading', { name: /Going out\s*1/ })).toBeTruthy();
  expect(screen.queryByText('Done one')).toBeNull();
  fireEvent.click(screen.getByText('Warm the cache'));
  expect(opened).toEqual(['t-a']);
  view.unmount();

  render(
    <OutflowColumn runs={[]} merges={[]} setAside={[]} onOpenTask={() => {}} />
  );
  expect(screen.getByText('Nothing is running.')).toBeTruthy();
});

test('a run that finishes slides out before it leaves', async () => {
  const live = [run('a', 'running', 'Warm the cache')];
  const view = render(
    <OutflowColumn
      runs={live}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
    />
  );
  view.rerender(
    <OutflowColumn runs={[]} merges={[]} setAside={[]} onOpenTask={() => {}} />
  );
  const leaving = screen.getByText('Warm the cache').closest('.animate-out');
  expect(leaving).not.toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LEAVE_MS + 50));
  });
  expect(screen.queryByText('Warm the cache')).toBeNull();
});

test('Coming in counts what waits and says so when nothing does', () => {
  render(<InflowColumn count={0}>{null}</InflowColumn>);
  expect(screen.getByRole('heading', { name: /Coming in\s*0/ })).toBeTruthy();
  expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
});

function session(
  epicId: string,
  state: 'active' | 'paused',
  live: number
): EpicProgress {
  return {
    epicId,
    active: state === 'active',
    session: { epicId, state, maxSpendUsd: 60 },
    spend: { settledUsd: 12.5, maxSpendUsd: 60 },
    children: [],
    waves: [],
    liveRuns: Array.from({ length: live }, (_, i) =>
      run(`${epicId}-${i}`, 'running', 'child')
    ),
  } as unknown as EpicProgress;
}

test('Going out lists live milestone sessions with their spend and opens them', () => {
  const opened: string[] = [];
  render(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={(id) => opened.push(id)}
      sessions={[session('e-1', 'active', 2), session('e-2', 'paused', 0)]}
      epicTitle={(id) => (id === 'e-1' ? 'Checkout rework' : id)}
    />
  );
  expect(screen.getByRole('heading', { name: /Going out\s*2/ })).toBeTruthy();
  const rows = screen.getAllByTestId('overseer-session-row');
  expect(rows.map((r) => r.textContent)).toEqual([
    'Checkout rework› 2 running$12.50 / $60',
    'e-2› paused$12.50 / $60',
  ]);
  fireEvent.click(screen.getByText('Checkout rework'));
  expect(opened).toEqual(['e-1']);
});

test('Landing offers Merge all ready while finished work waits, even with nothing queued', async () => {
  let merged = 0;
  const view = render(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
      mergeReady={3}
      onMergeAll={() => {
        merged++;
        return Promise.resolve();
      }}
    />
  );
  expect(screen.queryByText('Nothing is running.')).toBeNull();
  const button = screen.getByTestId('overseer-merge-all');
  expect(button.textContent).toBe('Merge all ready (3)');
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
  expect(merged).toBe(1);
  view.rerender(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
      mergeReady={0}
      onMergeAll={() => Promise.resolve()}
    />
  );
  expect(screen.queryByTestId('overseer-merge-all')).toBeNull();
  expect(screen.getByText('Nothing is running.')).toBeTruthy();
});

test('the head reads today’s spend and the live ceilings, and hides at zero', () => {
  expect(spendLine(4.5, null)).toBe('$4.50 today');
  expect(spendLine(0, null)).toBeNull();
  expect(spendLine(null, { live: 0, settledUsd: 0, ceilingUsd: null })).toBe(
    null
  );
  expect(spendLine(4.5, { live: 2, settledUsd: 41.2, ceilingUsd: 120 })).toBe(
    '$4.50 today · 2 milestones live · $41.20 of $120 ceilings'
  );
  render(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
      spendToday={4.5}
    />
  );
  expect(screen.getByTestId('overseer-spend').textContent).toBe('$4.50 today');
});
