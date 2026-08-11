import type { RunMeta, RunQuestion } from '@dispatch/client';
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

const NO_QUESTIONS = new Map<string, RunQuestion[]>();

test('renders the idle copy with no runs', () => {
  render(
    <LiveRail
      runs={[]}
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={() => {}}
      onOpenInbox={() => {}}
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
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={onOpenTask}
      onOpenInbox={() => {}}
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
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={() => {}}
      onOpenInbox={() => {
        opened = true;
      }}
    />
  );
  const strip = screen.getByText('1 waiting on you →');
  fireEvent.click(strip);
  expect(opened).toBe(true);
});
