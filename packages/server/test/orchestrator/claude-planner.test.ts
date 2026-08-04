import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';

import { CLAUDE_INSTALL_HINT } from '../../src/orchestrator/claudeCli.js';
import type { PlanProposal } from '../../src/orchestrator/planner.js';
import { ClaudePlanner } from '../../src/orchestrator/planners/claude.js';

// The exact text the Agent SDK throws when it can't resolve its own bundled
// native CLI binary — mirrors claude-executor.test.ts's own fixture for the
// same failure.
const MISSING_CLI_MESSAGE =
  'Native CLI binary for darwin-arm64 not found. Reinstall ' +
  '@anthropic-ai/claude-agent-sdk without --omit=optional, or set ' +
  'options.pathToClaudeCodeExecutable.';

const PROPOSAL: PlanProposal = {
  tasks: [
    {
      title: 'Do the thing',
      description: 'Do it well.',
      acceptanceCriteria: ['It is done'],
      blockedByIndices: [],
      priority: 'medium',
    },
  ],
};

// Bun-compat gate, mirroring claude-executor.test.ts's own: constructing a
// ClaudePlanner must succeed under Bun with no import/native-binding crash.
// The real SDK call is never exercised in CI — every scenario below injects a
// stub `queryFn`, same seam ClaudeExecutor uses.
describe('ClaudePlanner Bun compatibility', () => {
  it('imports @anthropic-ai/claude-agent-sdk and constructs under Bun', () => {
    const planner = new ClaudePlanner('/tmp/does-not-matter');
    expect(planner).toBeInstanceOf(ClaudePlanner);
    expect(typeof planner.start).toBe('function');
    expect(typeof planner.sendMessage).toBe('function');
  });
});

describe('ClaudePlanner.start', () => {
  it('returns the reply, proposal, and session id from a successful result', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        structured_output: { message: "here's a plan", proposal: PROPOSAL },
      };
    }
    const fakeQueryFn = () => fakeMessages() as unknown as Query;
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    const turn = await planner.start('build the thing');
    expect(turn.reply).toBe("here's a plan");
    expect(turn.proposal).toEqual(PROPOSAL);
    expect(turn.sessionId).toBe('sess-1');
  });

  // Planner must run isolated: no operator environment, no subagents, read-only.
  it('runs read-only with no subagents, no user settings, and no MCP servers', async () => {
    const proposal: PlanProposal = { tasks: [] };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: { message: 'ok', proposal },
      };
    }
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return fakeMessages() as unknown as Query;
    };
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    await planner.start('build the thing');

    expect(captured?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(captured?.settingSources).toEqual(['project', 'local']);
    expect(captured?.tools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(captured?.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
    expect(captured?.strictMcpConfig).toBe(true);
    expect(captured?.skills).toEqual([]);
  });

  it('rejects when the result message is an error subtype', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['boom'],
      };
    }
    const fakeQueryFn = () => fakeMessages() as unknown as Query;
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    await expect(planner.start('build the thing')).rejects.toThrow(/boom/);
  });

  it('rejects when a successful result carries no structured_output', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield { type: 'result', subtype: 'success' };
    }
    const fakeQueryFn = () => fakeMessages() as unknown as Query;
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    await expect(planner.start('build the thing')).rejects.toThrow(
      /no structured output/
    );
  });

  it('rejects when the stream ends with no result message at all', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
    }
    const fakeQueryFn = () => fakeMessages() as unknown as Query;
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    await expect(planner.start('build the thing')).rejects.toThrow(
      /no result message/
    );
  });
});

describe('ClaudePlanner.sendMessage', () => {
  it('resumes the prior session and returns the refined turn', async () => {
    const refined: PlanProposal = {
      tasks: [
        ...PROPOSAL.tasks,
        {
          title: 'A second task',
          description: 'Added on the follow-up turn.',
          acceptanceCriteria: [],
          blockedByIndices: [0],
          priority: 'low',
        },
      ],
    };
    // Capture the options the SDK is called with so we can assert the prior
    // session id is passed through as `resume` — this is what makes a
    // follow-up turn retain the first turn's context.
    let capturedResume: unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fakeQueryFn = (args: any) => {
      capturedResume = args.options.resume;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function* fakeMessages(): AsyncGenerator<any> {
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-2',
          structured_output: { message: 'added it', proposal: refined },
        };
      }
      return fakeMessages() as unknown as Query;
    };
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    const turn = await planner.sendMessage('sess-1', 'add a second task');
    expect(capturedResume).toBe('sess-1');
    expect(turn.reply).toBe('added it');
    expect(turn.proposal).toEqual(refined);
    expect(turn.sessionId).toBe('sess-2');
  });
});

// The bug this branch of coverage guards against: a packaged desktop app has
// no `node_modules`-bundled Claude Code CLI for the Agent SDK to auto-resolve,
// so `query()` throws the SDK's raw "Native CLI binary for ... not found"
// message. ClaudeExecutor already had a DISPATCH_CLAUDE_BIN -> bundled CLI ->
// PATH `claude` -> install-hint fallback chain (see claude-executor.test.ts's
// own "Claude Code CLI resolution" describe block); the planner made its own
// unwrapped `query()` call and got none of it, so "Plans" reported the raw
// SDK text as "planning failed: Native CLI binary for darwin-arm64 not
// found..." while dispatching a run from the task page worked fine. These
// tests prove ClaudePlanner's turns go through the same shared
// openClaudeQuery() chain (claudeCli.ts) as the executor.
describe('ClaudePlanner Claude Code CLI resolution', () => {
  it('falls back to a PATH `claude` when the bundled attempt reports a missing CLI, and still returns a proposal', async () => {
    const originalWhich = Bun.which;
    Bun.which = ((cmd: string) =>
      cmd === 'claude'
        ? '/fake/path/claude'
        : originalWhich(cmd)) as typeof Bun.which;
    try {
      let calls = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function* fakeMessages(): AsyncGenerator<any> {
        yield {
          type: 'result',
          subtype: 'success',
          structured_output: { message: 'planned', proposal: PROPOSAL },
        };
      }
      const fakeQueryFn = () => {
        calls += 1;
        if (calls === 1) throw new Error(MISSING_CLI_MESSAGE);
        return fakeMessages() as unknown as Query;
      };
      const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

      const turn = await planner.start('build the thing');

      expect(turn.proposal).toEqual(PROPOSAL);
      expect(calls).toBe(2);
    } finally {
      Bun.which = originalWhich;
    }
  });

  it('rejects with the actionable install hint, not the raw SDK text, when every resolution attempt fails', async () => {
    const originalWhich = Bun.which;
    Bun.which = (() => null) as typeof Bun.which;
    try {
      const fakeQueryFn = () => {
        throw new Error(MISSING_CLI_MESSAGE);
      };
      const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

      await expect(planner.start('build the thing')).rejects.toThrow(
        CLAUDE_INSTALL_HINT
      );
    } finally {
      Bun.which = originalWhich;
    }
  });

  it('rewrites a missing-CLI error that surfaces lazily on the first iteration, not just a synchronous one', async () => {
    const originalWhich = Bun.which;
    Bun.which = (() => null) as typeof Bun.which;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      async function* fakeMessages(): AsyncGenerator<any> {
        throw new Error(MISSING_CLI_MESSAGE);
      }
      const fakeQueryFn = () => fakeMessages() as unknown as Query;
      const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

      await expect(planner.start('build the thing')).rejects.toThrow(
        CLAUDE_INSTALL_HINT
      );
    } finally {
      Bun.which = originalWhich;
    }
  });
});
