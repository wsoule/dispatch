import type { RunMeta } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { LiveRail } from './LiveRail';

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
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

test('renders the idle copy with no runs', () => {
  render(
    <LiveRail
      runs={[]}
      attentionCount={0}
      onOpenTask={() => {}}
      onOpenInbox={() => {}}
      collapsed={false}
    />
  );
  expect(screen.getByText('No agents running.')).toBeDefined();
  expect(screen.queryByText(/waiting on you/)).toBeNull();
});

test('renders a row per live run, clicking opens its task', () => {
  const onOpenTask = (
    taskId: string,
    tab: string,
    runId: string | undefined
  ) => {
    calls.push([taskId, tab, runId]);
  };
  const calls: unknown[] = [];
  render(
    <LiveRail
      runs={[run()]}
      attentionCount={0}
      onOpenTask={onOpenTask}
      onOpenInbox={() => {}}
      collapsed={false}
    />
  );
  const row = screen.getByText('Do the thing');
  fireEvent.click(row);
  expect(calls).toEqual([['t-1', 'chat', 'r-1']]);
});

test('shows the attention strip when something is waiting, and it navigates to the inbox', () => {
  let opened = false;
  render(
    <LiveRail
      runs={[run({ state: 'awaiting-approval' })]}
      attentionCount={1}
      onOpenTask={() => {}}
      onOpenInbox={() => {
        opened = true;
      }}
      collapsed={false}
    />
  );
  const strip = screen.getByText('1 waiting on you →');
  fireEvent.click(strip);
  expect(opened).toBe(true);
});

// The "never hides" rule survives the move into the sidebar: the collapsed icon strip must
// still say something is waiting, or collapsing the rail becomes a way to lose the only
// always-on signal in the shell.
test('the collapsed strip still shows the attention count and opens the inbox', () => {
  let opened = false;
  render(
    <LiveRail
      runs={[run({ state: 'awaiting-approval' })]}
      attentionCount={1}
      onOpenTask={() => {}}
      onOpenInbox={() => {
        opened = true;
      }}
      collapsed
    />
  );

  const badge = screen.getByRole('button', { name: '1 waiting on you' });
  expect(badge.textContent).toBe('1');
  fireEvent.click(badge);
  expect(opened).toBe(true);
});

// Collapsed, the run rows and headings disappear — only the two essentials survive: the
// attention count (above) and that agents are running at all.
test('the collapsed strip drops rows but keeps the running count', () => {
  render(
    <LiveRail
      runs={[run(), run({ id: 'r-2', taskId: 't-2', taskTitle: 'Other' })]}
      attentionCount={0}
      onOpenTask={() => {}}
      onOpenInbox={() => {}}
      collapsed
    />
  );
  expect(screen.queryByText('Live agents')).toBeNull();
  expect(screen.queryByText('Do the thing')).toBeNull();
  expect(screen.getByTitle('2 agents running').textContent).toContain('2');
});
