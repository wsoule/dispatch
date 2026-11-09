import type { MergeQueueEntry, MergeQueueSnapshot } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { ToastProvider } from '../components/shell/Toasts';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { LandingView } from './LandingView';

const now = Date.now();
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function entry(over: Partial<MergeQueueEntry>): MergeQueueEntry {
  return {
    runId: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    state: 'queued',
    enqueuedAt: ago(20),
    stateSince: ago(3),
    ...over,
  };
}

const SNAPSHOT: MergeQueueSnapshot = {
  entries: [
    entry({
      runId: 'r-config',
      taskId: 't-config',
      taskTitle: 'Landing-mode config',
      state: 'verifying',
    }),
    entry({
      runId: 'r-dep',
      taskId: 't-dep',
      taskTitle: 'Use the config',
      state: 'waiting-blockers',
    }),
  ],
  history: [
    entry({
      runId: 'r-bad',
      taskId: 't-bad',
      taskTitle: 'Broken branch',
      state: 'failed',
      reason: 'git rebase failed: error: could not apply 1234567... x',
      conflicts: ['src/a.ts'],
      output: 'some verify output',
      finishedAt: ago(1),
    }),
    entry({
      runId: 'r-bad2',
      taskId: 't-bad2',
      taskTitle: 'Slow tests',
      state: 'failed',
      reason: 'test timed out after 900s — raise it',
      finishedAt: ago(2),
    }),
  ],
};

function setup(snapshot: MergeQueueSnapshot | null = SNAPSHOT) {
  const calls: string[] = [];
  const data = {
    config: null,
    mergeQueue: snapshot,
    tasksIncludingArchived: [
      {
        meta: {
          id: 't-config',
          title: 'Landing-mode config',
          status: 'landing',
          blockedBy: [],
        },
      },
      {
        meta: {
          id: 't-dep',
          title: 'Use the config',
          status: 'landing',
          blockedBy: ['t-config'],
        },
      },
    ],
    handleEnqueueMerge: (runId: string) => {
      calls.push(`enqueue:${runId}`);
      return runId === 'r-bad2'
        ? Promise.reject(new Error('run has already been reviewed'))
        : Promise.resolve();
    },
    handleDequeueMerge: (runId: string) => {
      calls.push(`dequeue:${runId}`);
      return Promise.resolve();
    },
    handleRecheckMergeQueue: () => Promise.resolve(),
  } as unknown as DispatchProjectData;
  render(
    <ToastProvider>
      <LandingView
        data={data}
        onBack={() => calls.push('back')}
        onOpenRun={(taskId, runId) => calls.push(`open:${taskId}/${runId}`)}
      />
    </ToastProvider>
  );
  return calls;
}

describe('LandingView', () => {
  test('groups failures first, then the queue, with counts in the filter tabs', () => {
    setup();
    const sections = screen
      .getAllByTestId(/^landing-section-/)
      .map((el) => el.dataset.testid);
    expect(sections).toEqual([
      'landing-section-failed',
      'landing-section-in-progress',
    ]);
    expect(screen.getByRole('tab', { name: 'Failed 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'In progress 2' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Landed today 0' })).toBeTruthy();
  });

  test('a row shows its stage, position, elapsed time and one-line reason', () => {
    setup();
    const config = screen.getByTestId('landing-row-r-config');
    expect(config.textContent).toContain('Verifying · 3m');
    expect(config.textContent).toContain('#1 of 2');
    const bad = screen.getByTestId('landing-row-r-bad');
    expect(bad.textContent).toContain('Rebase conflict in src/a.ts');
  });

  test('a run waiting on another names it, and the blocker opens that run', () => {
    const calls = setup();
    const dep = screen.getByTestId('landing-row-r-dep');
    expect(dep.textContent).toContain(
      'Waiting on Landing-mode config (#1 · verifying)'
    );
    fireEvent.click(screen.getByTestId('landing-blocker'));
    expect(calls).toEqual(['open:t-config/r-config']);
  });

  test('only a queued entry can be pulled; the one verifying cannot', () => {
    const calls = setup();
    const pulls = screen.getAllByTestId('landing-pull');
    expect(pulls.map((b) => (b as HTMLButtonElement).disabled)).toEqual([
      true,
      false,
    ]);
    fireEvent.click(pulls[1]);
    expect(calls).toContain('dequeue:r-dep');
  });

  test('re-queue all failed retries each and toasts the ones the daemon refused', async () => {
    const calls = setup();
    fireEvent.click(screen.getByTestId('landing-requeue-all'));
    await waitFor(() =>
      expect(calls).toEqual(['enqueue:r-bad', 'enqueue:r-bad2'])
    );
    await waitFor(() =>
      expect(screen.getByText('Could not re-queue')).toBeTruthy()
    );
  });

  test('bulk-selecting failed rows offers a re-queue for just those', async () => {
    const calls = setup();
    fireEvent.click(
      screen.getByRole('checkbox', { name: 'Select Broken branch' })
    );
    const bulk = await screen.findByTestId('landing-requeue-selected');
    expect(bulk.textContent).toBe('Re-queue 1');
    fireEvent.click(bulk);
    await waitFor(() => expect(calls).toEqual(['enqueue:r-bad']));
  });

  test('the log action opens the reason, conflicted files and verify output', async () => {
    setup();
    const row = screen.getByTestId('landing-row-r-bad');
    fireEvent.click(row.querySelector('[data-testid="landing-log-open"]'));
    const log = await screen.findByTestId('landing-log');
    expect(log.textContent).toContain('src/a.ts');
    expect(log.textContent).toContain('some verify output');
  });

  test('clicking a row opens its run', () => {
    const calls = setup();
    fireEvent.click(screen.getByTestId('landing-row-r-bad'));
    expect(calls).toEqual(['open:t-bad/r-bad']);
  });

  test('an empty queue says so, and a missing snapshot says it is loading', () => {
    setup({ entries: [], history: [] });
    expect(screen.getByText('Nothing is headed for main')).toBeTruthy();
  });

  test('before the first snapshot it is loading', () => {
    setup(null);
    expect(screen.getByText('Loading the merge queue')).toBeTruthy();
  });
});
