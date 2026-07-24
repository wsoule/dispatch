import type {
  McpStdioServerConfig,
  Options,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, test } from 'bun:test';
import { rmSync } from 'node:fs';

import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';
import { initGitRepo } from './helpers.js';

// A no-op ExecutorEvents sink for tests below that only care about what
// gets *sent* to the SDK's query() (the mcpServers wiring), not about any
// resulting entry/approval/finish events.
const noopEvents: ExecutorEvents = {
  onEntry: () => {},
  onApprovalRequest: () => {},
  onFinish: () => {},
};

// An empty async generator — completes immediately with no messages, which
// is fine for the mcpServers-wiring tests below: they only need `start()`'s
// synchronous `queryFn(...)` call to have happened, not any particular
// message stream afterward.
async function* emptyMessages(): AsyncGenerator<never> {}

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

// Bug 1 (fix/executor-mcp-wiring): a dispatched agent previously had no way
// to reach the dispatch MCP tools (run_list/task_comment) at all — the Agent
// SDK's `query()`, unlike the interactive `claude` CLI, does NOT auto-load a
// project's committed `.mcp.json`. These tests prove the fix at the
// `queryFn` seam: the exact `Options` this executor hands to `query()` must
// carry an explicit `mcpServers.dispatch` stdio entry, since a real Claude
// session (needed to prove the tools are actually callable end-to-end)
// cannot be assumed to have credentials in this environment.
describe('ClaudeExecutor dispatch MCP server wiring', () => {
  it('wires an mcpServers.dispatch stdio entry rooted at the worktree cwd, with DISPATCH_PROJECT_ROOT set to the project root', () => {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);

    executor.start(
      {
        cwd: '/tmp/dispatch-worktree-x',
        projectRoot: '/tmp/dispatch-project-y',
        prompt: 'do the thing',
        permissionMode: 'acceptEdits',
        maxTurns: 5,
      },
      noopEvents
    );

    const dispatch = captured?.mcpServers?.dispatch as
      | McpStdioServerConfig
      | undefined;
    expect(dispatch).toBeDefined();
    expect(dispatch?.command).toBe('bun');
    // args: [<mcp bin path>, '--root', <worktree cwd>] — rooted at the
    // WORKTREE, not the project, so task_list/task_get/task_save/task_next
    // see the run's own repo checkout.
    expect(dispatch?.args?.[0]).toMatch(/[/\\]mcp[/\\]src[/\\]bin\.ts$/);
    expect(dispatch?.args?.[1]).toBe('--root');
    expect(dispatch?.args?.[2]).toBe('/tmp/dispatch-worktree-x');
    // The daemon-discovery/task_comment override: the PROJECT root, not the
    // worktree — see packages/mcp/src/tools.ts's projectRoot() helper.
    expect(dispatch?.env?.DISPATCH_PROJECT_ROOT).toBe(
      '/tmp/dispatch-project-y'
    );
    // The spawned server still needs the rest of this process's environment
    // (PATH, for `bun` itself to be found) — an explicit `env` on a stdio
    // MCP server config replaces rather than extends the inherited one.
    expect(dispatch?.env?.PATH).toBe(process.env.PATH);
  });

  it('falls back to cwd for DISPATCH_PROJECT_ROOT when no projectRoot is given', () => {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);

    executor.start(
      {
        cwd: '/tmp/dispatch-worktree-only',
        prompt: 'do the thing',
        permissionMode: 'acceptEdits',
        maxTurns: 5,
      },
      noopEvents
    );

    const dispatch = captured?.mcpServers?.dispatch as
      | McpStdioServerConfig
      | undefined;
    expect(dispatch?.env?.DISPATCH_PROJECT_ROOT).toBe(
      '/tmp/dispatch-worktree-only'
    );
  });

  // agent-comms: `agent_message`/`message_user` (packages/mcp/src/tools.ts)
  // read DISPATCH_RUN_ID back out of their own process env to identify the
  // calling run as a message's sender without it having to know its own run
  // id ahead of time — this proves the executor actually wires that env var
  // through to the spawned MCP server.
  it('wires DISPATCH_RUN_ID to the run id passed in ExecutorStartOptions', () => {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);

    executor.start(
      {
        cwd: '/tmp/dispatch-worktree-x',
        projectRoot: '/tmp/dispatch-project-y',
        runId: 'r-abc123',
        prompt: 'do the thing',
        permissionMode: 'acceptEdits',
        maxTurns: 5,
      },
      noopEvents
    );

    const dispatch = captured?.mcpServers?.dispatch as
      | McpStdioServerConfig
      | undefined;
    expect(dispatch?.env?.DISPATCH_RUN_ID).toBe('r-abc123');
  });
});

// The "keeps saying running" bug's root cause for a packaged app: the SDK
// spawns a native CLI it can't find, so query() throws
// "Native CLI binary for <platform>-<arch> not found. Reinstall
// @anthropic-ai/claude-agent-sdk without --omit=optional, ..." — a message
// meaningless to a desktop-app user. The executor rewrites that into an
// actionable install command, and honors DISPATCH_CLAUDE_BIN as an explicit
// override so a machine with Claude Code installed elsewhere still works.
describe('ClaudeExecutor Claude Code CLI resolution', () => {
  it('rewrites the SDK "Native CLI binary not found" error into an actionable install command', () => {
    const fakeQueryFn = () => {
      throw new Error(
        'Native CLI binary for darwin-arm64 not found. Reinstall ' +
          '@anthropic-ai/claude-agent-sdk without --omit=optional, or set ' +
          'options.pathToClaudeCodeExecutable.'
      );
    };
    const executor = new ClaudeExecutor(fakeQueryFn as never);

    expect(() =>
      executor.start(
        {
          cwd: '/tmp/dispatch-worktree-x',
          prompt: 'do the thing',
          permissionMode: 'acceptEdits',
          maxTurns: 5,
        },
        noopEvents
      )
    ).toThrow(/Claude Code CLI not found.*install\.sh/s);
  });

  it('passes DISPATCH_CLAUDE_BIN through as pathToClaudeCodeExecutable', () => {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);

    const prev = process.env.DISPATCH_CLAUDE_BIN;
    process.env.DISPATCH_CLAUDE_BIN = '/opt/custom/claude';
    try {
      executor.start(
        {
          cwd: '/tmp/dispatch-worktree-x',
          prompt: 'do the thing',
          permissionMode: 'acceptEdits',
          maxTurns: 5,
        },
        noopEvents
      );
    } finally {
      if (prev === undefined) delete process.env.DISPATCH_CLAUDE_BIN;
      else process.env.DISPATCH_CLAUDE_BIN = prev;
    }

    expect(captured?.pathToClaudeCodeExecutable).toBe('/opt/custom/claude');
  });

  // A non-CLI error is passed through unchanged — the rewrite must not swallow
  // unrelated startup failures behind a misleading "install Claude Code" hint.
  it('passes a non-CLI startup error through unchanged', () => {
    const fakeQueryFn = () => {
      throw new Error('some other startup failure');
    };
    const executor = new ClaudeExecutor(fakeQueryFn as never);

    expect(() =>
      executor.start(
        {
          cwd: '/tmp/dispatch-worktree-x',
          prompt: 'do the thing',
          permissionMode: 'acceptEdits',
          maxTurns: 5,
        },
        noopEvents
      )
    ).toThrow('some other startup failure');
  });
});

// M7: a run that fails mid-stream — after the SDK's very first message (the
// 'system'/'init' message that always carries the session id) but before
// any terminal 'result' message ever arrives — must still report the
// session id on its failed finish, or there is nothing for sendMessage's
// `resume: true` path to resume. `queryFn` is the constructor seam that
// makes this testable without a real Agent SDK session (the smoke test
// above/below is what exercises the real thing).
describe('ClaudeExecutor session-id capture on a mid-stream failure', () => {
  it('reports the sessionId captured from the system/init message even when the run fails before any result message', async () => {
    const repo = initGitRepo('dispatch-claude-sessionid-');
    try {
      // A plain (sync) generator works fine here — `for...of await` awaits
      // each yielded value regardless, and this fake has nothing to
      // actually await.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function* fakeMessages(): Generator<any> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-mid-stream-fail',
        };
        throw new Error('stream exploded before a result message');
      }
      // Cast: only the async-iteration protocol fakeMessages() already
      // provides is actually exercised by consume() in this scenario.
      const fakeQueryFn = () => fakeMessages() as unknown as Query;
      const executor = new ClaudeExecutor(fakeQueryFn);

      const finish = await new Promise<{
        state: string;
        error?: string;
        sessionId?: string;
      }>((resolve) => {
        const events: ExecutorEvents = {
          onEntry: () => {},
          onApprovalRequest: () => {},
          onFinish: (result) => resolve(result),
        };
        executor.start(
          {
            cwd: repo,
            prompt: 'do the thing',
            permissionMode: 'acceptEdits',
            maxTurns: 5,
          },
          events
        );
      });

      expect(finish.state).toBe('failed');
      expect(finish.error).toBe('stream exploded before a result message');
      expect(finish.sessionId).toBe('sess-mid-stream-fail');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Bug 2 (fix/executor-mcp-wiring): a run whose underlying SDK stream ends
// with no 'result' message at all — the CLI process getting killed out from
// under an approval it was waiting on, or any other abrupt exit — must still
// reach onFinish with a real error, not silently leave the run stuck
// 'running' forever with nothing left driving it (which is what previously
// surfaced downstream as state=failed/error=None/turns=None/cost=None once
// a dispatchd restart's reconcileOnBoot eventually force-failed it).
describe('ClaudeExecutor abrupt stream end with no result message', () => {
  it('reports a failed finish with a non-empty error when the stream ends without a result', async () => {
    const repo = initGitRepo('dispatch-claude-no-result-');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function* fakeMessages(): Generator<any> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-no-result',
        };
        // No 'result' message, and the generator just returns — the
        // "process exited without ever finishing the turn" case.
      }
      const fakeQueryFn = () => fakeMessages() as unknown as Query;
      const executor = new ClaudeExecutor(fakeQueryFn);

      const finish = await new Promise<{
        state: string;
        error?: string;
        sessionId?: string;
        turns?: number;
        costUsd?: number;
      }>((resolve) => {
        const events: ExecutorEvents = {
          onEntry: () => {},
          onApprovalRequest: () => {},
          onFinish: (result) => resolve(result),
        };
        executor.start(
          {
            cwd: repo,
            projectRoot: repo,
            prompt: 'do the thing',
            permissionMode: 'acceptEdits',
            maxTurns: 5,
          },
          events
        );
      });

      expect(finish.state).toBe('failed');
      expect(finish.error).toBe('agent session ended without a final result');
      expect(finish.error).toBeTruthy();
      expect(finish.sessionId).toBe('sess-no-result');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
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
