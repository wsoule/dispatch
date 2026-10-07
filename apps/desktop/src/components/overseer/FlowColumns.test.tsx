import type { RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { LEAVE_MS } from '../../lib/flowList';
import { InflowColumn, OutflowColumn } from './FlowColumns';

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
