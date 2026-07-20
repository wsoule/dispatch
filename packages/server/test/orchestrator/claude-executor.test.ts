import { describe, expect, it, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

// Bun-compat gate (see the phase-4 plan's Global Constraints): dispatchd
// runs entirely under Bun, so importing this module and constructing a
// ClaudeExecutor must succeed under Bun with no native-binding or import
// crash. This runs unconditionally in CI — no credentials, no subprocess,
// no network — as the required proof the Agent SDK loads at all under this
// runtime. The full real-session path below is separately gated because it
// spends real budget and needs a logged-in `claude` CLI.
describe('ClaudeExecutor Bun compatibility', () => {
  it('imports @anthropic-ai/claude-agent-sdk and constructs under Bun', () => {
    const executor = new ClaudeExecutor();
    expect(executor).toBeInstanceOf(ClaudeExecutor);
    expect(typeof executor.start).toBe('function');
  });
});

// Real end-to-end smoke test against the actual Agent SDK: a trivial task
// prompt, a real (throwaway) git repo, a small maxTurns cap. Only runs when
// DISPATCH_CLAUDE_SMOKE is set — CI never sets it, so this never needs
// credentials to pass the standard `bun test` baseline. Run manually with a
// logged-in `claude` CLI via:
//   DISPATCH_CLAUDE_SMOKE=1 bun test test/orchestrator/claude-executor.test.ts
test.skipIf(!process.env.DISPATCH_CLAUDE_SMOKE)(
  'runs a trivial real prompt to completion end-to-end',
  async () => {
    const cwd = initGitRepo('dispatch-claude-smoke-');
    try {
      const entries: NormalizedEntry[] = [];
      const finish = await new Promise<{
        state: string;
        error?: string;
        costUsd?: number;
        turns?: number;
      }>((resolve) => {
        const events: ExecutorEvents = {
          onEntry: (entry) => entries.push(entry),
          onApprovalRequest: (request) => {
            // acceptEdits auto-allows the one tool this prompt needs
            // (Write); nothing should ever reach here for this smoke test,
            // but auto-deny rather than hang forever if it does.
            run.approve(request.requestId, false);
          },
          onFinish: (result) => resolve(result),
        };
        const run = new ClaudeExecutor().start(
          {
            cwd,
            prompt:
              'Create a file named smoke.txt containing exactly the ' +
              'text "ok" (no trailing content), then stop. Do not run ' +
              'any other commands.',
            permissionMode: 'acceptEdits',
            maxTurns: 5,
          },
          events
        );
      });

      expect(finish.state).toBe('finished');
      expect(finish.turns).toBeGreaterThan(0);
      console.log(
        `DISPATCH_CLAUDE_SMOKE evidence: state=${finish.state} turns=${finish.turns} costUsd=${finish.costUsd} entries=${entries.length}`
      );
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  },
  60_000
);
