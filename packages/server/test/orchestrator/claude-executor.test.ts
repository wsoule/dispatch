import type {
  McpStdioServerConfig,
  Options,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it, test } from 'bun:test';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import {
  buildCartoMcpServerConfig,
  cartoMcpServers,
  ClaudeExecutor,
} from '../../src/orchestrator/executors/claude.js';
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

  // Security: this `env` is serialized by the SDK into the `--mcp-config`
  // value on the spawned CLI's ARGV, where any local process can read it via
  // `ps`. It used to be a straight copy of the whole `process.env`, which put
  // every credential dispatchd happened to inherit — GITHUB_TOKEN, API keys,
  // DB passwords — into a world-readable process listing. The dispatch MCP
  // server reads exactly three variables of its own, so the env is now an
  // allowlist.
  it('does not leak unrelated environment variables (notably secrets) into the MCP server env', () => {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);

    const secrets = {
      GITHUB_TOKEN: 'ghp_should_not_appear',
      OPENAI_KEY: 'sk-should-not-appear',
      EXPRESS_SESSION_SECRET: 'session-should-not-appear',
      SOME_DB_PASSWORD: 'pw-should-not-appear',
    };
    const previous = new Map(
      Object.keys(secrets).map((key) => [key, process.env[key]])
    );
    Object.assign(process.env, secrets);
    try {
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
    } finally {
      for (const [key, value] of previous) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }

    const dispatch = captured?.mcpServers?.dispatch as
      | McpStdioServerConfig
      | undefined;
    const env = dispatch?.env ?? {};
    for (const key of Object.keys(secrets)) {
      expect(env[key]).toBeUndefined();
    }
    // Nothing secret-shaped survives under any name — guards against a future
    // passthrough entry quietly re-admitting one.
    const serialized = JSON.stringify(env);
    for (const value of Object.values(secrets)) {
      expect(serialized).not.toContain(value);
    }

    // What the child genuinely needs is still there: PATH so `bun` can be
    // found, plus the three variables packages/mcp actually reads.
    expect(env.PATH).toBe(process.env.PATH!);
    expect(env.DISPATCH_PROJECT_ROOT).toBe('/tmp/dispatch-project-y');
    expect(env.DISPATCH_RUN_ID).toBe('r-abc123');
  });

  // DISPATCH_HOME redirects all dispatch state away from the real home
  // directory, and the MCP child's own daemon discovery reads it
  // (packages/mcp/src/daemon.ts) — an allowlist that dropped it would break
  // every test harness and any non-default install.
  it('passes DISPATCH_HOME through to the MCP server env when set', () => {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);

    const prev = process.env.DISPATCH_HOME;
    process.env.DISPATCH_HOME = '/tmp/dispatch-home-under-test';
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
      if (prev === undefined) delete process.env.DISPATCH_HOME;
      else process.env.DISPATCH_HOME = prev;
    }

    const dispatch = captured?.mcpServers?.dispatch as
      | McpStdioServerConfig
      | undefined;
    expect(dispatch?.env?.DISPATCH_HOME).toBe('/tmp/dispatch-home-under-test');
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

// Dispatched agents must behave like a human running `claude` in the
// worktree — reading this project's own CLAUDE.md/AGENTS.md and getting the
// CLI's real system prompt — rather than a bare SDK session with neither.
// `query()`'s own defaults already cover this (per sdk.d.ts), but pinning
// both explicitly means a future SDK default change can't silently regress
// it; this proves the exact `Options` this executor hands to `query()`
// carries both, at the same `queryFn` seam the mcpServers wiring tests above
// use.
describe('ClaudeExecutor CLI-parity system prompt and setting sources', () => {
  it('requests the claude_code preset system prompt and loads user/project/local settings', () => {
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
        permissionMode: 'auto',
        maxTurns: 5,
      },
      noopEvents
    );

    expect(captured?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
    });
    expect(captured?.settingSources).toEqual(['user', 'project', 'local']);
  });
});

// A minimal-but-valid stand-in for the second (`options`) argument
// `canUseTool` receives from the SDK — only `requestId` and `toolUseID` are
// actually read by this executor's callback and by the approval-flow
// assertions below; `signal` is required by the type but never inspected.
function fakeCanUseToolOptions(
  requestId: string
): Parameters<NonNullable<Options['canUseTool']>>[2] {
  return {
    signal: new AbortController().signal,
    toolUseID: `tu-${requestId}`,
    requestId,
  };
}

// AUTO_ALLOWED_EDIT_TOOLS's fast-path is deliberately scoped to
// `permissionMode: 'acceptEdits'` only (see the doc comment on
// AUTO_ALLOWED_EDIT_TOOLS in claude.ts): under `'auto'`, the SDK's own model
// classifier already auto-approves the routine calls before `canUseTool` is
// even invoked, and only forwards the ones it flagged worth a human look —
// force-allowing an edit tool that reaches this callback under `'auto'`
// would silently discard that one safety valve. These tests call the exact
// `canUseTool` this executor hands to `query()` directly, at the same
// `queryFn` capture seam the tests above use, rather than driving a full
// scripted SDK message stream.
describe('ClaudeExecutor canUseTool edit-tool fast-path', () => {
  it("does NOT auto-allow an edit tool under permissionMode 'auto' — it goes to the approval flow instead", async () => {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);

    let approvalRequested = false;
    let requestedToolName: string | undefined;
    executor.start(
      {
        cwd: '/tmp/dispatch-worktree-x',
        prompt: 'do the thing',
        permissionMode: 'auto',
        maxTurns: 5,
      },
      {
        onEntry: () => {},
        onApprovalRequest: (request) => {
          approvalRequested = true;
          requestedToolName = request.toolName;
        },
        onFinish: () => {},
      }
    );

    // Fire-and-forget: the callback awaits approve(), which nothing ever
    // calls in this test — only whether it routed to the approval flow at
    // all (rather than resolving immediately with 'allow') is under test.
    void captured?.canUseTool?.(
      'Write',
      {},
      fakeCanUseToolOptions('req-auto-write')
    );
    // Let the microtask queue drain so the async canUseTool body actually
    // runs up to its `onApprovalRequest` call before asserting on it.
    await Promise.resolve();

    expect(approvalRequested).toBe(true);
    expect(requestedToolName).toBe('Write');
  });

  it("still auto-allows an edit tool under permissionMode 'acceptEdits' (fast-path unchanged)", async () => {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);

    let approvalRequested = false;
    executor.start(
      {
        cwd: '/tmp/dispatch-worktree-x',
        prompt: 'do the thing',
        permissionMode: 'acceptEdits',
        maxTurns: 5,
      },
      {
        onEntry: () => {},
        onApprovalRequest: () => {
          approvalRequested = true;
        },
        onFinish: () => {},
      }
    );

    const result = await captured?.canUseTool?.(
      'Write',
      { file_path: 'x.txt' },
      fakeCanUseToolOptions('req-acceptedits-write')
    );

    expect(result).toEqual({
      behavior: 'allow',
      updatedInput: { file_path: 'x.txt' },
    });
    expect(approvalRequested).toBe(false);
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

// Drives one scripted `result` message through the executor and returns the
// finish it reported. Every truncation test below differs only in the fields
// on that single result message, so they share this harness.
async function finishForResult(
  result: Record<string, unknown>
): Promise<{ state: string; error?: string; turns?: number }> {
  const repo = initGitRepo('dispatch-claude-terminal-reason-');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function* fakeMessages(): Generator<any> {
      yield { type: 'system', subtype: 'init', session_id: 'sess-tr' };
      yield { type: 'result', ...result };
    }
    const executor = new ClaudeExecutor(
      (() => fakeMessages() as unknown as Query) as never
    );
    return await new Promise((resolve) => {
      executor.start(
        {
          cwd: repo,
          prompt: 'do the thing',
          permissionMode: 'acceptEdits',
          maxTurns: 100,
        },
        {
          onEntry: () => {},
          onApprovalRequest: () => {},
          onFinish: (finish) => resolve(finish),
        }
      );
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

// The "said complete but actually got cut off" bug. A run stopped by the
// Claude usage/session limit comes back from the SDK as `subtype: 'success'`
// — the CLI process *did* exit cleanly — with the real outcome carried on
// `terminal_reason` instead (see SDKResultSuccess in the SDK's sdk.d.ts).
// finishFromResult used to branch on `subtype` alone, so such a run was
// recorded `finished` with an empty error, and the truncated work looked done.
// Real evidence this happened: run r-bdf748's transcript ends with the
// assistant line "You've hit your session limit · resets 3:50pm" immediately
// followed by a `finished` state line.
describe('ClaudeExecutor truncated-run detection', () => {
  it("reports failed with an actionable error when the session limit cut the run off (subtype 'success', terminal_reason 'blocking_limit')", async () => {
    const finish = await finishForResult({
      subtype: 'success',
      is_error: false,
      num_turns: 72,
      total_cost_usd: 3.37,
      session_id: 'sess-tr',
      stop_reason: null,
      terminal_reason: 'blocking_limit',
      errors: [],
    });

    expect(finish.state).toBe('failed');
    expect(finish.error).toMatch(/usage limit/i);
    // The partial work still happened — turn/cost accounting must survive the
    // reclassification so the run's cost isn't silently lost.
    expect(finish.turns).toBe(72);
  });

  it.each([
    ['max_turns', /turn limit/i],
    ['budget_exhausted', /budget/i],
    ['prompt_too_long', /too long/i],
    ['hook_stopped', /hook/i],
  ])(
    "reports failed for terminal_reason '%s' even under subtype 'success'",
    async (terminalReason, expected) => {
      const finish = await finishForResult({
        subtype: 'success',
        is_error: false,
        num_turns: 5,
        total_cost_usd: 0.1,
        session_id: 'sess-tr',
        stop_reason: null,
        terminal_reason: terminalReason,
        errors: [],
      });

      expect(finish.state).toBe('failed');
      expect(finish.error).toMatch(expected);
    }
  );

  // An unrecognized future terminal_reason must default to "not complete"
  // rather than silently claiming success — the whole class of bug this
  // detection exists to prevent.
  it('reports failed for an unrecognized terminal_reason, carrying the raw reason', async () => {
    const finish = await finishForResult({
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.1,
      session_id: 'sess-tr',
      stop_reason: null,
      terminal_reason: 'some_future_reason',
      errors: [],
    });

    expect(finish.state).toBe('failed');
    expect(finish.error).toContain('some_future_reason');
  });

  it("reports finished for terminal_reason 'completed'", async () => {
    const finish = await finishForResult({
      subtype: 'success',
      is_error: false,
      num_turns: 9,
      total_cost_usd: 0.5,
      session_id: 'sess-tr',
      stop_reason: null,
      terminal_reason: 'completed',
      errors: [],
    });

    expect(finish.state).toBe('finished');
    expect(finish.error).toBeUndefined();
  });

  // Back-compat: an SDK (or a fixture) that never sets terminal_reason at all
  // must keep the original subtype-only behavior rather than start failing
  // every run.
  it('reports finished when terminal_reason is absent entirely', async () => {
    const finish = await finishForResult({
      subtype: 'success',
      is_error: false,
      num_turns: 9,
      total_cost_usd: 0.5,
      session_id: 'sess-tr',
      stop_reason: null,
      errors: [],
    });

    expect(finish.state).toBe('finished');
  });

  // `is_error` is the SDK's other success-subtype failure signal, independent
  // of terminal_reason.
  it("reports failed when is_error is set despite subtype 'success'", async () => {
    const finish = await finishForResult({
      subtype: 'success',
      is_error: true,
      num_turns: 4,
      total_cost_usd: 0.2,
      session_id: 'sess-tr',
      stop_reason: null,
      errors: [],
      result: 'something went wrong upstream',
    });

    expect(finish.state).toBe('failed');
    expect(finish.error).toBeTruthy();
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
            run.approve(request.requestId, { allow: false });
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

describe('buildCartoMcpServerConfig', () => {
  it('passes only allowlisted environment variables', () => {
    const config = buildCartoMcpServerConfig('/proj', {
      path: '/opt/homebrew/bin/carto',
      version: '2.1.3',
    }) as McpStdioServerConfig;
    expect(config.type).toBe('stdio');
    // McpStdioServerConfig has no `cwd` field, so carto must be spawned
    // through a shell wrapper (`command: '/bin/sh'`) that `cd`s into the
    // project root first — the actual carto invocation is in `args`.
    expect(config.command).toBe('/bin/sh');
    expect(JSON.stringify(config.args)).toContain('carto');
    // The SDK serializes env into the spawned CLI's argv, visible via `ps`.
    for (const key of Object.keys(config.env ?? {})) {
      expect(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']).toContain(key);
    }
  });

  it('never widens the tool tier', () => {
    const config = buildCartoMcpServerConfig('/proj', {
      path: '/opt/homebrew/bin/carto',
      version: '2.1.3',
    }) as McpStdioServerConfig;
    expect(config.env?.CARTO_MCP_TIER).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('CARTO_MCP_TIER');
  });

  it('roots carto at the project, never at a run worktree', () => {
    const config = buildCartoMcpServerConfig('/proj', {
      path: '/opt/homebrew/bin/carto',
      version: '2.1.3',
    });
    expect(JSON.stringify(config)).toContain('/proj');
  });

  // Security: a projectRoot (user-configured) or binary.path (from a PATH
  // entry) containing shell metacharacters must never be able to run as a
  // command. Interpolating either into the `-c` script text — even
  // JSON-escaped, which only escapes `"` and `\`, not `$` or backticks — lets
  // a `$(...)` payload execute inside double quotes under POSIX sh. Passing
  // both as positional parameters ($1/$2) instead means the shell binds them
  // to variables without ever re-parsing their contents as script text.
  it('passes projectRoot as a positional shell parameter, never spliced into the script text', () => {
    const maliciousRoot = '/tmp/proj$(touch /tmp/should-not-exist)';
    const config = buildCartoMcpServerConfig(maliciousRoot, {
      path: '/opt/homebrew/bin/carto',
      version: '2.1.3',
    }) as McpStdioServerConfig;
    const script = config.args?.[1] ?? '';
    // The payload must not appear inside the `-c` script text itself...
    expect(script).not.toContain(maliciousRoot);
    expect(script).not.toContain('$(');
    // ...only as a separate argv element, which sh assigns to $1 verbatim
    // and never re-parses.
    expect(config.args).toContain(maliciousRoot);
  });
});

// A discoverable stub `carto` for the config-gating tests below, so what they
// prove is the config decision, not whatever carto this machine happens to
// have. packages/cli's preload sets DISPATCH_CARTO_DISABLED when `bun test`
// runs from the repo root; it is lifted for the duration of `fn`.
function withStubCarto<T>(fn: () => T): T {
  const binDir = mkdtempSync(join(tmpdir(), 'dispatch-carto-bin-'));
  const stub = join(binDir, 'carto');
  writeFileSync(stub, '#!/bin/sh\necho "carto-md 2.1.3"\n');
  chmodSync(stub, 0o755);
  const originalPath = process.env.PATH;
  const originalDisabled = process.env.DISPATCH_CARTO_DISABLED;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
  delete process.env.DISPATCH_CARTO_DISABLED;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
    if (originalDisabled !== undefined) {
      process.env.DISPATCH_CARTO_DISABLED = originalDisabled;
    }
    rmSync(binDir, { recursive: true, force: true });
  }
}

function writeCartoConfig(root: string, mode: string): void {
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    `carto:\n  enabled: ${mode}\n`
  );
}

// `off` means "no discovery, no MCP entry, no sync" — an opted-out project
// must not get a carto server spawned into every dispatched run.
describe('carto MCP entry honors carto.enabled', () => {
  it('contributes an entry when the mode allows it', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-proj-'));
    try {
      writeCartoConfig(root, 'on');
      const servers = withStubCarto(() => cartoMcpServers(root));
      expect(Object.keys(servers)).toEqual(['carto']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('contributes nothing when the mode is off', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-proj-'));
    try {
      writeCartoConfig(root, 'off');
      const servers = withStubCarto(() => cartoMcpServers(root));
      expect(Object.keys(servers)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults to contributing an entry when the config cannot be parsed', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-proj-'));
    try {
      mkdirSync(join(root, '.dispatch'), { recursive: true });
      writeFileSync(join(root, '.dispatch', 'config.yml'), 'statuses: [a\n');
      const servers = withStubCarto(() => cartoMcpServers(root));
      expect(Object.keys(servers)).toEqual(['carto']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the carto entry out of a dispatched run under off', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-proj-'));
    try {
      writeCartoConfig(root, 'off');
      let captured: Options | undefined;
      const executor = new ClaudeExecutor((args: { options?: Options }) => {
        captured = args.options;
        return emptyMessages() as unknown as Query;
      });
      withStubCarto(() =>
        executor.start(
          {
            cwd: root,
            projectRoot: root,
            prompt: 'do the thing',
            permissionMode: 'acceptEdits',
            maxTurns: 5,
          },
          noopEvents
        )
      );
      expect(captured?.mcpServers?.dispatch).toBeDefined();
      expect(captured?.mcpServers?.carto).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
