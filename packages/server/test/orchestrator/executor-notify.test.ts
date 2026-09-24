import { describe, expect, it } from 'bun:test';

import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';

// A query() stand-in that never yields; it only captures the options.
function capturingQuery() {
  const captured: { options?: Record<string, unknown> } = {};
  const fn = ((args: { options: Record<string, unknown> }) => {
    captured.options = args.options;
    return {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
      interrupt: async () => {},
    };
  }) as never;
  return { fn, captured };
}

describe('ClaudeExecutor.notify', () => {
  it('delivers queued digests through the PostToolUse hook, once', async () => {
    const { fn, captured } = capturingQuery();
    const run = new ClaudeExecutor(fn).start(
      {
        cwd: '/tmp',
        prompt: 'p',
        permissionMode: 'default',
        runId: 'r-000001',
      },
      {
        onEntry() {},
        onApprovalRequest: async () => {},
        onFinish() {},
      } as never
    );
    run.notify('📬 one');
    run.notify('📬 two');
    const hooks = captured.options!.hooks as {
      PostToolUse: { hooks: ((...a: unknown[]) => Promise<unknown>)[] }[];
    };
    const hook = hooks.PostToolUse[0].hooks[0];
    const out = (await hook({}, undefined, {
      signal: new AbortController().signal,
    })) as {
      hookSpecificOutput?: {
        hookEventName: string;
        additionalContext?: string;
      };
    };
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'PostToolUse',
      additionalContext: '📬 one\n📬 two',
    });
    expect(
      await hook({}, undefined, { signal: new AbortController().signal })
    ).toEqual({});
  });
});
