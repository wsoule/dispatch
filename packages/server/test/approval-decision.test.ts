import { describe, expect, test } from 'bun:test';

import { FakeExecutor } from '../src/orchestrator/executors/fake';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../src/orchestrator/types';

/** Drives a FakeExecutor script that pauses on one approval gate. */
function startWithGate(): {
  run: ReturnType<FakeExecutor['start']>;
  finished: Promise<{ state: string; error?: string }>;
  requestId: string;
} {
  const executor = new FakeExecutor({
    steps: [
      {
        approval: {
          requestId: 'req-1',
          toolName: 'Bash',
          input: { command: 'rm -rf /' },
        },
      },
    ],
    finish: { state: 'finished' },
  });

  let resolveFinish: (v: { state: string; error?: string }) => void = () => {};
  const finished = new Promise<{ state: string; error?: string }>((r) => {
    resolveFinish = r;
  });

  const events: ExecutorEvents = {
    onEntry: (_e: NormalizedEntry) => {},
    onApprovalRequest: () => {},
    onFinish: (r: { state: string; error?: string }) => resolveFinish(r),
  } as unknown as ExecutorEvents;

  const run = executor.start(
    { prompt: 'go', cwd: '/tmp', permissionMode: 'default' } as never,
    events
  );
  return { run, finished, requestId: 'req-1' };
}

/** Lets the executor's async script reach its approval gate before answering. */
async function tick(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

describe('approval decisions', () => {
  test('allowing lets the run finish', async () => {
    const { run, finished, requestId } = startWithGate();
    await tick();
    run.approve(requestId, { allow: true });
    expect((await finished).state).toBe('finished');
  });

  test('denying fails the run', async () => {
    const { run, finished, requestId } = startWithGate();
    await tick();
    run.approve(requestId, { allow: false });
    const result = await finished;
    expect(result.state).toBe('failed');
  });

  // The button says "deny and tell it why", so the reason has to actually travel — a bare
  // refusal leaves the agent guessing at what it did wrong.
  test('a denial reason reaches the outcome rather than being dropped', async () => {
    const { run, finished, requestId } = startWithGate();
    await tick();
    run.approve(requestId, {
      allow: false,
      reason: 'that would delete the repo',
    });
    const result = await finished;
    expect(result.error).toContain('that would delete the repo');
  });

  test('denying with no reason still reports a denial', async () => {
    const { run, finished, requestId } = startWithGate();
    await tick();
    run.approve(requestId, { allow: false });
    expect((await finished).error).toBe('approval denied');
  });

  test('answering an unknown request is a no-op, not a crash', async () => {
    const { run, finished, requestId } = startWithGate();
    await tick();
    run.approve('req-nope', { allow: true });
    run.approve(requestId, { allow: true });
    expect((await finished).state).toBe('finished');
  });

  test('a second answer to the same request is ignored', async () => {
    const { run, finished, requestId } = startWithGate();
    await tick();
    run.approve(requestId, { allow: true });
    run.approve(requestId, { allow: false });
    expect((await finished).state).toBe('finished');
  });
});
