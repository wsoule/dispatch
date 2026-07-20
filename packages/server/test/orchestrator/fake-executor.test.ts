import { describe, expect, it } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { FakeExecutor } from '../../src/orchestrator/executors/fake.js';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';
import { initGitRepo, runGitSync } from './helpers.js';

// A tiny in-memory sink for ExecutorEvents so tests can assert on exactly
// what an executor reported without needing the full orchestrator.
function collectEvents(): {
  events: ExecutorEvents;
  entries: NormalizedEntry[];
  approvals: { requestId: string; toolName: string; input: unknown }[];
  finishes: unknown[];
} {
  const entries: NormalizedEntry[] = [];
  const approvals: { requestId: string; toolName: string; input: unknown }[] =
    [];
  const finishes: unknown[] = [];
  return {
    entries,
    approvals,
    finishes,
    events: {
      onEntry: (e) => entries.push(e),
      onApprovalRequest: (r) => approvals.push(r),
      onFinish: (f) => finishes.push(f),
    },
  };
}

const baseOpts = {
  prompt: 'do the thing',
  permissionMode: 'acceptEdits',
  maxTurns: 10,
};

describe('FakeExecutor', () => {
  it('emits scripted entries in order and finishes with the scripted result', async () => {
    const repo = initGitRepo();
    const executor = new FakeExecutor({
      steps: [
        { entry: { ts: 't1', kind: 'assistant', text: 'Starting' } },
        { entry: { ts: 't2', kind: 'tool', toolName: 'ls', status: 'done' } },
      ],
      finish: { state: 'finished', costUsd: 0.1, turns: 2 },
    });
    const { events, entries, finishes } = collectEvents();

    executor.start({ ...baseOpts, cwd: repo }, events);

    await Bun.sleep(10);
    expect(entries).toEqual([
      { ts: 't1', kind: 'assistant', text: 'Starting' },
      { ts: 't2', kind: 'tool', toolName: 'ls', status: 'done' },
    ]);
    expect(finishes).toEqual([{ state: 'finished', costUsd: 0.1, turns: 2 }]);
  });

  it('actually writes and commits files in the worktree when scripted', async () => {
    const repo = initGitRepo();
    const executor = new FakeExecutor({
      steps: [
        {
          write: (cwd) => {
            writeFileSync(join(cwd, 'feature.txt'), 'hello from the agent\n');
          },
          commitMessage: 'agent: add feature.txt',
        },
      ],
      finish: { state: 'finished' },
    });
    const { events, finishes } = collectEvents();

    executor.start({ ...baseOpts, cwd: repo }, events);
    await Bun.sleep(10);

    expect(finishes).toHaveLength(1);
    expect(readFileSync(join(repo, 'feature.txt'), 'utf8')).toBe(
      'hello from the agent\n'
    );
    const log = runGitSync(repo, ['log', '-1', '--pretty=%s']).trim();
    expect(log).toBe('agent: add feature.txt');
  });

  it('raises an approval request and waits for approve() before continuing', async () => {
    const repo = initGitRepo();
    const executor = new FakeExecutor({
      steps: [
        { entry: { ts: 't0', kind: 'assistant', text: 'before' } },
        {
          approval: {
            requestId: 'req-1',
            toolName: 'edit_file',
            input: { path: 'x' },
          },
        },
        { entry: { ts: 't1', kind: 'assistant', text: 'after' } },
      ],
      finish: { state: 'finished' },
    });
    const { events, entries, approvals, finishes } = collectEvents();

    const run = executor.start({ ...baseOpts, cwd: repo }, events);
    await Bun.sleep(10);

    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toEqual({
      requestId: 'req-1',
      toolName: 'edit_file',
      input: { path: 'x' },
    });
    // Only the entry before the approval gate has fired so far.
    expect(entries).toEqual([{ ts: 't0', kind: 'assistant', text: 'before' }]);
    expect(finishes).toHaveLength(0);

    run.approve('req-1', true);
    await Bun.sleep(10);

    expect(entries).toEqual([
      { ts: 't0', kind: 'assistant', text: 'before' },
      { ts: 't1', kind: 'assistant', text: 'after' },
    ]);
    expect(finishes).toEqual([{ state: 'finished' }]);
  });

  it('finishes as failed when an approval request is denied', async () => {
    const repo = initGitRepo();
    const executor = new FakeExecutor({
      steps: [
        {
          approval: {
            requestId: 'req-2',
            toolName: 'edit_file',
            input: {},
          },
        },
        { entry: { ts: 'never', kind: 'assistant', text: 'unreachable' } },
      ],
      finish: { state: 'finished' },
    });
    const { events, entries, finishes } = collectEvents();

    const run = executor.start({ ...baseOpts, cwd: repo }, events);
    await Bun.sleep(10);
    run.approve('req-2', false);
    await Bun.sleep(10);

    expect(entries).toEqual([]);
    expect(finishes).toEqual([{ state: 'failed', error: 'approval denied' }]);
  });

  it('stops emitting further steps once interrupted', async () => {
    const repo = initGitRepo();
    const executor = new FakeExecutor({
      steps: [
        {
          approval: { requestId: 'req-3', toolName: 't', input: {} },
        },
        { entry: { ts: 'never', kind: 'assistant', text: 'unreachable' } },
      ],
      finish: { state: 'finished' },
    });
    const { events, entries, finishes } = collectEvents();

    const run = executor.start({ ...baseOpts, cwd: repo }, events);
    await Bun.sleep(10);
    await run.interrupt();
    await Bun.sleep(10);

    expect(entries).toEqual([]);
    expect(finishes).toEqual([]);
  });

  // I6: a scripted step throwing (e.g. `write` pointed at a path that
  // doesn't exist) must never leave the run silently stuck mid-script —
  // that's a zombie run, "running" forever with nothing actually running it.
  // playScript's own try/catch must convert any thrown error into a normal
  // `onFinish({ state: 'failed' })` call.
  it('finishes as failed instead of hanging when a scripted step throws', async () => {
    const repo = initGitRepo();
    const executor = new FakeExecutor({
      steps: [
        {
          write: () => {
            throw new Error('boom: step exploded');
          },
        },
      ],
      finish: { state: 'finished' },
    });
    const { events, finishes } = collectEvents();

    executor.start({ ...baseOpts, cwd: repo }, events);
    await Bun.sleep(10);

    expect(finishes).toEqual([
      { state: 'failed', error: 'boom: step exploded' },
    ]);
  });
});
