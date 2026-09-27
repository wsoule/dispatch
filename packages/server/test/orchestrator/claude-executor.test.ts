import type {
  McpStdioServerConfig,
  Options,
  Query,
} from '@anthropic-ai/claude-agent-sdk';
import { DISPATCH_MESSAGING_TOOLS } from '@dispatch/core';
import { describe, expect, it, spyOn, test } from 'bun:test';
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
  MEMORY_TOOLS,
  STOP_DENIAL_MESSAGE,
} from '../../src/orchestrator/executors/claude.js';
import { floorGuard } from '../../src/orchestrator/floorHook.js';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';
import {
  floorDecision,
  initGitRepo,
  preToolUse,
  withRunEndControls,
} from './helpers.js';

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
describe('ClaudeExecutor effort', () => {
  it('hands the run effort to query() and leaves it unset when absent', () => {
    const seen: (Options | undefined)[] = [];
    const executor = new ClaudeExecutor((args: { options?: Options }) => {
      seen.push(args.options);
      return emptyMessages() as unknown as Query;
    });
    const base = { cwd: '/tmp/x', prompt: 'p', permissionMode: 'default' };

    executor.start({ ...base, effort: 'xhigh' }, noopEvents);
    executor.start(base, noopEvents);

    expect(seen[0]?.effort).toBe('xhigh');
    expect(seen[1]?.effort).toBeUndefined();
  });
});

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

  // The dispatch MCP tools that record the calling run read DISPATCH_RUN_ID
  // from their own env; this proves the executor wires it to the MCP server.
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

  it('hands the MCP server the run token file path, not a token', () => {
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
        runTokenFile: '/tmp/dispatch-runs/r-abc123.token',
        prompt: 'do the thing',
        permissionMode: 'acceptEdits',
        maxTurns: 5,
      },
      noopEvents
    );

    const dispatch = captured?.mcpServers?.dispatch as
      | McpStdioServerConfig
      | undefined;
    expect(dispatch?.env?.DISPATCH_RUN_TOKEN_FILE).toBe(
      '/tmp/dispatch-runs/r-abc123.token'
    );
    expect(dispatch?.env?.DISPATCH_RUN_TOKEN).toBeUndefined();
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

  // The CLI skips canUseTool under bypassPermissions and on a matching
  // settings allow rule, and a settings PermissionRequest hook can answer
  // before it (all verified against the bundled CLI). So the guard's hook
  // holds a floor command itself, through this executor's own approval flow,
  // and returns the human's answer as its decision.
  it('holds floor commands for a human through the approval flow, whatever the permission mode', async () => {
    for (const permissionMode of ['bypassPermissions', 'auto', 'acceptEdits']) {
      let captured: Options | undefined;
      const requests: {
        requestId: string;
        toolName: string;
        input: unknown;
      }[] = [];
      const executor = new ClaudeExecutor((args: { options?: Options }) => {
        captured = args.options;
        return emptyMessages() as unknown as Query;
      });
      const answers = [
        { allow: true },
        { allow: false, reason: 'not on main' },
      ];
      const run = executor.start(
        { cwd: '/tmp/dispatch-worktree-x', prompt: 'x', permissionMode },
        {
          ...noopEvents,
          onApprovalRequest: (request) => {
            requests.push(request);
            queueMicrotask(() =>
              run.approve(request.requestId, answers.shift()!)
            );
          },
        }
      );
      const push = { command: 'git push --force origin main' };
      expect(await floorDecision(captured?.hooks, 'Bash', push)).toBe('allow');
      expect(await preToolUse(captured?.hooks, 'Bash', push)).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason: 'not on main',
      });
      expect(requests).toEqual([
        { requestId: 'floor-tu-1', toolName: 'Bash', input: push },
        { requestId: 'floor-tu-1', toolName: 'Bash', input: push },
      ]);
      // Anything else takes the session's normal permission path.
      expect(
        await floorDecision(captured?.hooks, 'Bash', { command: 'bun test' })
      ).toBeUndefined();
      expect(requests).toHaveLength(2);
      expect(captured?.settings).toEqual(floorGuard('deny').settings);
      // A run's session keeps Claude's native auto memory.
      expect(
        (captured?.settings as { autoMemoryEnabled?: boolean } | undefined)
          ?.autoMemoryEnabled
      ).toBeUndefined();
    }
  });

  // A hold is parked on a human, so the run's own stop and cancel have to be
  // able to answer it, or a run stopped mid-hold would wait on it forever.
  it('answers a held floor command when the run is stopped or cancelled', async () => {
    for (const end of ['requestStop', 'interrupt'] as const) {
      let captured: Options | undefined;
      const executor = new ClaudeExecutor((args: { options?: Options }) => {
        captured = args.options;
        // interrupt() calls both control methods on the live query.
        return Object.assign(emptyMessages(), {
          interrupt: () => Promise.resolve(),
          close: () => {},
        }) as unknown as Query;
      });
      const run = executor.start(
        {
          cwd: '/tmp/dispatch-worktree-x',
          prompt: 'x',
          permissionMode: 'auto',
        },
        noopEvents
      );
      const held = preToolUse(captured?.hooks, 'Bash', {
        command: 'npm publish',
      });
      await Promise.resolve();
      if (end === 'requestStop') run.requestStop();
      else void run.interrupt();
      expect(await held).toMatchObject({
        permissionDecision: 'deny',
        permissionDecisionReason:
          end === 'requestStop' ? STOP_DENIAL_MESSAGE : 'run cancelled',
      });
    }
  });

  // After the hook's allow the CLI can still send the call on to canUseTool
  // (a settings ask rule, one of its safety checks, another hook's "ask");
  // the human already decided on that exact call, so it is not asked twice.
  it('does not ask twice about a floor call the human approved in the hook', async () => {
    let captured: Options | undefined;
    const requests: string[] = [];
    const executor = new ClaudeExecutor((args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    });
    const run = executor.start(
      {
        cwd: '/tmp/dispatch-worktree-x',
        prompt: 'x',
        permissionMode: 'default',
      },
      {
        ...noopEvents,
        onApprovalRequest: (request) => {
          requests.push(request.requestId);
          queueMicrotask(() =>
            run.approve(request.requestId, { allow: true, scope: 'session' })
          );
        },
      }
    );
    const push = { command: 'git push --force origin main' };
    expect(await floorDecision(captured?.hooks, 'Bash', push)).toBe('allow');
    // "Allow Bash for this run" on the floor approval still grants routine
    // Bash calls; it never pre-approves a floor call.
    expect(
      await captured?.canUseTool?.(
        'Bash',
        { command: 'bun test' },
        {
          signal: new AbortController().signal,
          toolUseID: 'tu-2',
          requestId: 'cli-uuid-2',
        }
      )
    ).toEqual({ behavior: 'allow', updatedInput: { command: 'bun test' } });
    expect(requests).toEqual(['floor-tu-1']);
    const callOpts = {
      signal: new AbortController().signal,
      toolUseID: 'tu-1',
      requestId: 'cli-uuid-1',
    };
    expect(await captured?.canUseTool?.('Bash', push, callOpts)).toEqual({
      behavior: 'allow',
      updatedInput: push,
    });
    expect(requests).toEqual(['floor-tu-1']);
    // Only that exact call: a changed input, or the same id again, is asked.
    const other = { command: 'git push --force origin release' };
    await captured?.canUseTool?.('Bash', other, callOpts);
    expect(requests).toEqual(['floor-tu-1', 'cli-uuid-1']);
  });

  // The run ends at its result, but a background sub-agent can still be
  // working, and once the query closes the CLI cannot hear a hold's answer: a
  // held floor call then went ahead as if no hook had decided (reproduced
  // under bypassPermissions). So the result settles every pending hold as a
  // refusal and stops the live background tasks before the query closes.
  it('refuses pending holds and stops background tasks when the result arrives', async () => {
    let captured: Options | undefined;
    let releaseResult!: () => void;
    const resultReleased = new Promise<void>((resolve) => {
      releaseResult = resolve;
    });
    const stopped: string[] = [];
    const applied: unknown[] = [];
    const executor = new ClaudeExecutor((args: { options?: Options }) => {
      captured = args.options;
      const messages = (async function* (): AsyncGenerator<unknown> {
        yield { type: 'system', subtype: 'init', session_id: 's' };
        yield {
          type: 'system',
          subtype: 'background_tasks_changed',
          session_id: 's',
          tasks: [
            { task_id: 'task-sub', task_type: 'subagent', description: 'x' },
          ],
        };
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'launched it' }] },
        };
        await resultReleased;
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          num_turns: 1,
          total_cost_usd: 0.01,
          session_id: 's',
          result: 'done',
          terminal_reason: 'completed',
          modelUsage: {},
          errors: [],
        };
      })();
      return Object.assign(messages, {
        stopTask: (taskId: string) => {
          stopped.push(taskId);
          return Promise.resolve();
        },
        applyFlagSettings: (settings: unknown) => {
          applied.push(settings);
          return Promise.resolve();
        },
        interrupt: () => Promise.resolve(),
        close: () => {},
      }) as unknown as Query;
    });
    const finished = new Promise<void>((resolve) => {
      executor.start(
        {
          cwd: '/tmp/dispatch-worktree-x',
          prompt: 'x',
          permissionMode: 'bypassPermissions',
        },
        { ...noopEvents, onFinish: () => resolve() }
      );
    });
    // Let the stream deliver the task list before the hold is raised.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const held = preToolUse(captured?.hooks, 'Bash', {
      command: 'git push --force origin main',
    });
    releaseResult();
    expect(await held).toMatchObject({ permissionDecision: 'deny' });
    expect(String((await held)?.permissionDecisionReason)).toContain(
      'run ended'
    );
    await finished;
    expect(stopped).toEqual(['task-sub']);
    expect(applied).toHaveLength(1);
    // Nothing raised after the result can be approved either.
    expect(
      await floorDecision(captured?.hooks, 'Bash', { command: 'npm publish' })
    ).toBe('deny');
  });

  // The CLI keeps working after the result (a finished or stopped background
  // task starts a fresh main-agent turn) and once the query closes nothing
  // can answer the floor hook; under bypassPermissions a floor command in
  // that turn ran. Every result therefore denies every call at the hook and
  // applies deny rules the CLI enforces by itself, even with nothing pending.
  it('makes every result final: deny rules applied, every later call refused', async () => {
    let captured: Options | undefined;
    const applied: unknown[] = [];
    const executor = new ClaudeExecutor((args: { options?: Options }) => {
      captured = args.options;
      return Object.assign(
        (function* (): Generator<unknown> {
          yield { type: 'system', subtype: 'init', session_id: 's' };
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'done' }] },
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
            num_turns: 1,
            total_cost_usd: 0.01,
            session_id: 's',
            result: 'done',
            terminal_reason: 'completed',
            modelUsage: {},
            errors: [],
          };
        })(),
        {
          applyFlagSettings: (settings: unknown) => {
            applied.push(settings);
            return Promise.resolve();
          },
          interrupt: () => Promise.resolve(),
          close: () => {},
        }
      ) as unknown as Query;
    });
    await new Promise<void>((resolve) => {
      executor.start(
        {
          cwd: '/tmp/dispatch-worktree-x',
          prompt: 'x',
          permissionMode: 'bypassPermissions',
        },
        { ...noopEvents, onFinish: () => resolve() }
      );
    });
    expect(applied).toHaveLength(1);
    const deny = (applied[0] as { permissions: { deny: string[] } }).permissions
      .deny;
    for (const tool of ['Bash', 'Write', 'Edit', 'Agent', 'SendMessage']) {
      expect(deny).toContain(tool);
    }
    // Every tool: a named list missed Monitor, which runs a shell command
    // and only some sessions have, and ran a force-push after the result.
    expect(deny).toContain('*');
    // The named fallback for a CLI that does not glob-match deny rules
    // covers every MCP server, not only the ones this executor adds.
    for (const rule of ['Monitor', 'mcp__*', 'ReadMcpResourceTool']) {
      expect(deny).toContain(rule);
    }
    // Floor or not, nothing more runs once the result is in.
    for (const [toolName, toolInput] of [
      ['Bash', { command: 'bun test' }],
      ['Edit', { file_path: 'a.ts' }],
    ] as const) {
      expect(
        await preToolUse(captured?.hooks, toolName, toolInput)
      ).toMatchObject({ permissionDecision: 'deny' });
    }
  });

  it('still finishes when the CLI never confirms a background task stopped', async () => {
    const executor = new ClaudeExecutor(
      () =>
        Object.assign(
          (function* (): Generator<unknown> {
            yield { type: 'system', subtype: 'init', session_id: 's' };
            yield {
              type: 'system',
              subtype: 'background_tasks_changed',
              session_id: 's',
              tasks: [{ task_id: 't', task_type: 'shell', description: 'x' }],
            };
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'done' }] },
            };
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              num_turns: 1,
              total_cost_usd: 0.01,
              session_id: 's',
              result: 'done',
              terminal_reason: 'completed',
              modelUsage: {},
              errors: [],
            };
          })(),
          {
            stopTask: () => new Promise<void>(() => {}),
            applyFlagSettings: () => Promise.resolve(),
            interrupt: () => Promise.resolve(),
            close: () => {},
          }
        ) as unknown as Query
    );
    const finish = await new Promise<{ state: string }>((resolve) => {
      executor.start(
        {
          cwd: '/tmp/dispatch-worktree-x',
          prompt: 'x',
          permissionMode: 'auto',
        },
        { ...noopEvents, onFinish: resolve }
      );
    });
    expect(finish.state).toBe('finished');
  }, 15_000);

  // An older Claude Code (a packaged app runs the `claude` on PATH) answers
  // apply_flag_settings with "Unsupported control request subtype". The run
  // still finishes, and the missing guarantee is logged with the CLI's
  // version rather than lost. A step that throws at once, rather than
  // rejecting, must not stop the run finishing either.
  it('logs each wind-down step that fails, naming the CLI version, and still finishes', async () => {
    const logged: string[] = [];
    const errorSpy = spyOn(console, 'error').mockImplementation(
      (...args: unknown[]) => {
        logged.push(args.map(String).join(' '));
      }
    );
    try {
      const executor = new ClaudeExecutor(
        () =>
          Object.assign(
            (function* (): Generator<unknown> {
              yield {
                type: 'system',
                subtype: 'init',
                session_id: 's',
                claude_code_version: '2.1.42',
              };
              yield {
                type: 'system',
                subtype: 'background_tasks_changed',
                session_id: 's',
                tasks: [{ task_id: 't', task_type: 'shell', description: 'x' }],
              };
              yield {
                type: 'assistant',
                message: { content: [{ type: 'text', text: 'done' }] },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                num_turns: 1,
                total_cost_usd: 0.01,
                session_id: 's',
                result: 'done',
                terminal_reason: 'completed',
                modelUsage: {},
                errors: [],
              };
            })(),
            {
              stopTask: () =>
                Promise.reject(
                  new Error('Unsupported control request subtype: stop_task')
                ),
              applyFlagSettings: () => {
                throw new Error(
                  'Unsupported control request subtype: apply_flag_settings'
                );
              },
              interrupt: () => Promise.resolve(),
              close: () => {},
            }
          ) as unknown as Query
      );
      const finish = await new Promise<{ state: string }>((resolve) => {
        executor.start(
          {
            cwd: '/tmp/dispatch-worktree-x',
            prompt: 'x',
            permissionMode: 'bypassPermissions',
            runId: 'r-1',
          },
          { ...noopEvents, onFinish: resolve }
        );
      });
      expect(finish.state).toBe('finished');
      expect(logged).toHaveLength(2);
      const denyWarning = logged.find((line) =>
        line.includes('apply_flag_settings')
      );
      expect(denyWarning).toContain('run r-1');
      expect(denyWarning).toContain('Claude Code 2.1.42');
      expect(denyWarning).toContain('not refused by a deny rule');
      const stopWarning = logged.find((line) => line.includes('stop_task'));
      expect(stopWarning).toContain('Claude Code 2.1.42');
      expect(stopWarning).toContain('background task t kept running');
    } finally {
      errorSpy.mockRestore();
    }
  });

  // Each of these was exercised through this executor against the real CLI:
  // AskUserQuestion's answers never arrive, cron jobs and wakeups die with
  // the run, and EnterWorktree moves the agent out of the run's worktree.
  it('removes the Claude Code tools that cannot work inside a dispatched run', () => {
    let captured: Options | undefined;
    const executor = new ClaudeExecutor((args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    });

    executor.start(
      { cwd: '/tmp/dispatch-worktree-x', prompt: 'x', permissionMode: 'auto' },
      noopEvents
    );

    expect(captured?.disallowedTools).toEqual([
      'AskUserQuestion',
      'CronCreate',
      'CronDelete',
      'CronList',
      'ScheduleWakeup',
      'EnterWorktree',
      'ExitWorktree',
    ]);
    // Dispatch's own question channel is the one that reaches the human.
    expect(captured?.disallowedTools).not.toContain('mcp__dispatch__msg_send');
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

  it("auto-allows every messaging and memory tool under 'acceptEdits'", async () => {
    let captured: Options | undefined;
    const executor = new ClaudeExecutor((args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    });
    let approvalRequested = false;
    executor.start(
      {
        cwd: '/tmp/dispatch-worktree-x',
        prompt: 'go',
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
    const tools = DISPATCH_MESSAGING_TOOLS.map((t) => `mcp__dispatch__${t}`);
    expect(tools).toContain('mcp__dispatch__msg_send');
    for (const tool of [...tools, ...MEMORY_TOOLS]) {
      const result = await captured?.canUseTool?.(
        tool,
        { to: ['human:wyat'] },
        fakeCanUseToolOptions(`req-${tool}`)
      );
      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: { to: ['human:wyat'] },
      });
    }
    expect(approvalRequested).toBe(false);
  });
});

// The irreversibility floor at the executor (see floor.ts): a floor command
// raises the approval flow ahead of every allow branch. Neither the
// acceptEdits fast-path nor an earlier "approve Bash for this session" grant
// may let a force-push, publish, or repo-settings change through — each
// irreversible act is its own human decision, at every policy rung.
describe('ClaudeExecutor canUseTool irreversibility floor', () => {
  function startWithApprovals() {
    let captured: Options | undefined;
    const fakeQueryFn = (args: { options?: Options }) => {
      captured = args.options;
      return emptyMessages() as unknown as Query;
    };
    const executor = new ClaudeExecutor(fakeQueryFn);
    const requested: string[] = [];
    const run = executor.start(
      {
        cwd: '/tmp/dispatch-worktree-x',
        prompt: 'do the thing',
        permissionMode: 'acceptEdits',
        maxTurns: 5,
      },
      {
        onEntry: () => {},
        onApprovalRequest: (request) => {
          requested.push(request.requestId);
        },
        onFinish: () => {},
      }
    );
    return { run, requested, canUseTool: () => captured?.canUseTool };
  }

  it('re-asks for a floor command even after Bash was approved for the session', async () => {
    const { run, requested, canUseTool } = startWithApprovals();

    // A routine Bash call, approved for the whole session.
    const first = canUseTool()?.(
      'Bash',
      { command: 'ls' },
      fakeCanUseToolOptions('req-ls')
    );
    await Promise.resolve();
    expect(requested).toEqual(['req-ls']);
    run.approve('req-ls', { allow: true, scope: 'session' });
    expect(await first).toMatchObject({ behavior: 'allow' });

    // The grant now covers Bash: a second routine call never asks.
    const second = await canUseTool()?.(
      'Bash',
      { command: 'git status' },
      fakeCanUseToolOptions('req-status')
    );
    expect(second).toMatchObject({ behavior: 'allow' });
    expect(requested).toEqual(['req-ls']);

    // But every floor command still parks for its own decision.
    for (const [requestId, command] of [
      ['req-force', 'git push --force origin main'],
      ['req-publish', 'npm publish'],
      ['req-visibility', 'gh repo edit --visibility public'],
      ['req-tag', 'git push origin v1.2.3'],
      ['req-delete', 'git push origin --delete main'],
    ]) {
      void canUseTool()?.(
        'Bash',
        { command },
        fakeCanUseToolOptions(requestId)
      );
      await Promise.resolve();
      expect(requested).toContain(requestId);
    }
  });

  it('a denied floor command tells the agent why, and a later one asks again', async () => {
    const { run, requested, canUseTool } = startWithApprovals();
    const first = canUseTool()?.(
      'Bash',
      { command: 'npm publish' },
      fakeCanUseToolOptions('req-publish-1')
    );
    await Promise.resolve();
    run.approve('req-publish-1', { allow: false, reason: 'not yet' });
    expect(await first).toEqual({ behavior: 'deny', message: 'not yet' });

    // Allowing one floor command is a once-only decision by construction:
    // even `scope: 'session'` on it does not pre-approve the next one.
    const second = canUseTool()?.(
      'Bash',
      { command: 'npm publish' },
      fakeCanUseToolOptions('req-publish-2')
    );
    await Promise.resolve();
    run.approve('req-publish-2', { allow: true, scope: 'session' });
    expect(await second).toMatchObject({ behavior: 'allow' });
    void canUseTool()?.(
      'Bash',
      { command: 'npm publish' },
      fakeCanUseToolOptions('req-publish-3')
    );
    await Promise.resolve();
    expect(requested).toEqual([
      'req-publish-1',
      'req-publish-2',
      'req-publish-3',
    ]);
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

// The session id reaching onFinish is not enough on its own: a daemon that
// dies mid-run never sees a finish, so the run's resume handle has to be
// reported the moment the init message names it. Orchestrator.recordSession
// is what persists it; this is the executor half of that contract.
describe('ClaudeExecutor session-id reporting during a run', () => {
  it('reports the session through onSession before the run finishes', async () => {
    const repo = initGitRepo('dispatch-claude-live-session-');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function* fakeMessages(): Generator<any> {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: 'sess-reported-early',
        };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-reported-early',
          total_cost_usd: 0.01,
          num_turns: 1,
          is_error: false,
          result: '',
        };
      }
      const executor = new ClaudeExecutor(() =>
        withRunEndControls(fakeMessages())
      );

      // Order, not just presence: a session reported only alongside the
      // finish would satisfy a containment check while leaving the crash
      // window exactly as wide as before.
      const order: string[] = [];
      await new Promise<void>((resolve) => {
        const events: ExecutorEvents = {
          onEntry: () => {},
          onApprovalRequest: () => {},
          onSession: (sessionId) => order.push(`session:${sessionId}`),
          onFinish: () => {
            order.push('finish');
            resolve();
          },
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

      expect(order).toEqual(['session:sess-reported-early', 'finish']);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// A resume that does not actually reattach its session is the worst kind of
// failure: the SDK keeps a plain `resume` on the SAME session id (only
// `forkSession` mints a new one), so an init message carrying a different id
// means the agent underneath this run has no memory of the conversation the
// run claims to continue. That must fail loudly, never quietly start over.
describe('ClaudeExecutor resume session reattachment', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function* sessionMessages(sessionId: string): Generator<any> {
    yield { type: 'system', subtype: 'init', session_id: sessionId };
    yield {
      type: 'assistant',
      session_id: sessionId,
      message: { content: [{ type: 'text', text: 'carrying on' }] },
    };
    yield {
      type: 'result',
      subtype: 'success',
      session_id: sessionId,
      total_cost_usd: 0.01,
      num_turns: 1,
      is_error: false,
      result: '',
    };
  }

  async function resumeOnto(
    resumeSessionId: string,
    actualSessionId: string
  ): Promise<{
    finish: Parameters<ExecutorEvents['onFinish']>[0];
    sessions: string[];
    entries: number;
  }> {
    const repo = initGitRepo('dispatch-claude-resume-');
    try {
      const executor = new ClaudeExecutor(() =>
        withRunEndControls(sessionMessages(actualSessionId))
      );
      const sessions: string[] = [];
      let entries = 0;
      const finish = await new Promise<
        Parameters<ExecutorEvents['onFinish']>[0]
      >((resolve) => {
        executor.start(
          {
            cwd: repo,
            projectRoot: repo,
            prompt: 'pick up where you left off',
            resumeSessionId,
            permissionMode: 'acceptEdits',
            maxTurns: 5,
          },
          {
            onEntry: () => {
              entries++;
            },
            onApprovalRequest: () => {},
            onSession: (sessionId) => sessions.push(sessionId),
            onFinish: resolve,
          }
        );
      });
      return { finish, sessions, entries };
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }

  it('fails the run when the agent opens a different session than the one it was asked to resume', async () => {
    const { finish, sessions, entries } = await resumeOnto(
      'sess-lost',
      'sess-fresh'
    );
    expect(finish.state).toBe('failed');
    expect(finish.error).toContain('sess-lost');
    expect(finish.error).toContain('sess-fresh');
    // The fresh session is never reported as this run's handle: recording it
    // would make the next resume continue the wrong conversation.
    expect(sessions).toEqual([]);
    expect(finish.sessionId).toBeUndefined();
    // Nothing the stray session went on to say is streamed as this run's work.
    expect(entries).toBe(0);
  });

  it('continues normally when the resumed session id matches', async () => {
    const { finish, sessions, entries } = await resumeOnto(
      'sess-kept',
      'sess-kept'
    );
    expect(finish.state).toBe('finished');
    expect(sessions).toEqual(['sess-kept']);
    expect(entries).toBe(1);
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
// finish it reported. Every truncation/zero-turn test below differs only in
// the fields on that single result message (plus whether the stream carried
// any assistant output and whether the run was a resume), so they share this
// harness. `assistantOutput` defaults to true — a real session that reaches a
// result has produced at least one assistant message, and the zero-turn tests
// below are exactly the ones that opt out.
async function finishForResult(
  result: Record<string, unknown>,
  opts: {
    resumeSessionId?: string;
    assistantOutput?: boolean;
    // Messages the SDK streams before the terminal result — e.g. the
    // synthetic assistant message explaining an API error. Counts as
    // assistant output when it carries any.
    preceding?: Record<string, unknown>[];
  } = {}
): Promise<{
  state: string;
  error?: string;
  turns?: number;
  sessionId?: string;
}> {
  const repo = initGitRepo('dispatch-claude-terminal-reason-');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function* fakeMessages(): Generator<any> {
      // A resume's init echoes the session it reattached; anything else trips
      // the landed reattach guard before the zero-turn one under test here.
      yield {
        type: 'system',
        subtype: 'init',
        session_id: opts.resumeSessionId ?? 'sess-tr',
      };
      if (opts.assistantOutput !== false) {
        yield {
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'working on it' }] },
        };
      }
      yield* opts.preceding ?? [];
      yield { type: 'result', ...result };
    }
    const executor = new ClaudeExecutor((() =>
      withRunEndControls(fakeMessages())) as never);
    return await new Promise((resolve) => {
      executor.start(
        {
          cwd: repo,
          prompt: 'do the thing',
          permissionMode: 'acceptEdits',
          maxTurns: 100,
          resumeSessionId: opts.resumeSessionId,
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

  // 2026-09-04: seven runs died to the usage limit, but the SDK tagged the
  // stop `terminal_reason: 'api_error'` (not 'blocking_limit'), so every run
  // record said only "the Claude API errored" and the real reason had to be
  // dug out of each transcript's last assistant line — a synthetic message
  // carrying `error: 'rate_limit'` and the limit text.
  it("names the usage limit when a rate_limit assistant message precedes an 'api_error' stop", async () => {
    const finish = await finishForResult(
      {
        subtype: 'success',
        is_error: false,
        num_turns: 67,
        total_cost_usd: 18.12,
        session_id: 'sess-tr',
        stop_reason: null,
        terminal_reason: 'api_error',
        errors: [],
      },
      {
        preceding: [
          {
            type: 'assistant',
            error: 'rate_limit',
            session_id: 'sess-tr',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: "You've hit your session limit · resets 10pm (America/Detroit)",
                },
              ],
            },
          },
        ],
      }
    );

    expect(finish.state).toBe('failed');
    expect(finish.error).toMatch(/usage limit/i);
    expect(finish.error).toContain('resets 10pm');
    expect(finish.turns).toBe(67);
  });

  // The other rate_limit: credits exhausted rather than a session window, and
  // the remedy is the opposite of "wait for the reset" — so the lead must not
  // supply one, only the SDK's own text.
  it('carries the out-of-credits text without contradicting it', async () => {
    const finish = await finishForResult(
      {
        subtype: 'success',
        is_error: false,
        num_turns: 15,
        total_cost_usd: 2.5,
        session_id: 'sess-tr',
        stop_reason: null,
        terminal_reason: 'api_error',
        errors: [],
      },
      {
        preceding: [
          {
            type: 'assistant',
            error: 'rate_limit',
            session_id: 'sess-tr',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [
                {
                  type: 'text',
                  text: "You're out of usage credits. Switch to another model, or manage usage credits at https://example.invalid/usage",
                },
              ],
            },
          },
        ],
      }
    );

    expect(finish.state).toBe('failed');
    expect(finish.error).toContain('out of usage credits');
    expect(finish.error).not.toMatch(/once your limit resets/);
  });

  it("keeps the generic message for an 'api_error' stop with no API-error message before it", async () => {
    const finish = await finishForResult({
      subtype: 'success',
      is_error: false,
      num_turns: 2,
      total_cost_usd: 0.1,
      session_id: 'sess-tr',
      stop_reason: null,
      terminal_reason: 'api_error',
      errors: [],
    });

    expect(finish.state).toBe('failed');
    expect(finish.error).toMatch(/Claude API errored/);
  });

  it("appends the SDK's text for an API error kind it has no specific wording for", async () => {
    const finish = await finishForResult(
      {
        subtype: 'success',
        is_error: false,
        num_turns: 2,
        total_cost_usd: 0.1,
        session_id: 'sess-tr',
        stop_reason: null,
        terminal_reason: 'api_error',
        errors: [],
      },
      {
        preceding: [
          {
            type: 'assistant',
            error: 'server_error',
            session_id: 'sess-tr',
            parent_tool_use_id: null,
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: 'API Error: 500 upstream' }],
            },
          },
        ],
      }
    );

    expect(finish.error).toBe(
      'the Claude API errored before the agent finished (API Error: 500 upstream)'
    );
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

// The zero-turn no-op bug (t-ed735b, runs r-297e7b and r-3b5a48): resuming a
// session that had expired or gone terminal (both incidents resumed sessions
// predating a daemon restart) makes the CLI start, find nothing to continue,
// and exit *cleanly* — `subtype: 'success'`, `terminal_reason: 'completed'`,
// `num_turns: 0`, not one assistant message. Every existing guard passes and
// the run was recorded `finished`, silently dropping the follow-up work it
// was asked to do. A finish that did no work at all must be `failed`.
describe('ClaudeExecutor zero-turn finish detection', () => {
  const cleanExit = {
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0,
    session_id: 'sess-tr',
    stop_reason: null,
    terminal_reason: 'completed',
    errors: [],
  };

  it('reports failed when a resumed run finishes with zero turns and no assistant output', async () => {
    // Init and result both carry the resumed id, as a real reattach does.
    const finish = await finishForResult(
      { ...cleanExit, session_id: 'sess-old', num_turns: 0 },
      { resumeSessionId: 'sess-old', assistantOutput: false }
    );

    expect(finish.state).toBe('failed');
    expect(finish.error).toMatch(/the resumed session/);
    expect(finish.error).toMatch(/no work|without executing/i);
    // The accounting the SDK reported is preserved, and the sessionId must
    // survive so the run can be re-driven with another resume.
    expect(finish.turns).toBe(0);
    expect(finish.sessionId).toBe('sess-old');
  });

  it('reports failed when a fresh run finishes with zero turns and no assistant output', async () => {
    const finish = await finishForResult(
      { ...cleanExit, num_turns: 0 },
      { assistantOutput: false }
    );

    expect(finish.state).toBe('failed');
    expect(finish.error).toBeTruthy();
    // Not a resume, so the error must not blame session resumption.
    expect(finish.error).not.toMatch(/the resumed session/);
  });

  // Defense against cumulative turn accounting: if a resumed session's
  // num_turns ever counts the *prior* session's turns, a no-op resume would
  // report turns > 0 — the absence of any assistant output in THIS stream is
  // the signal that nothing actually happened.
  it('reports failed when a run claims turns but produced no assistant output at all', async () => {
    const finish = await finishForResult(
      { ...cleanExit, num_turns: 40 },
      { resumeSessionId: 'sess-old', assistantOutput: false }
    );

    expect(finish.state).toBe('failed');
    expect(finish.error).toBeTruthy();
  });

  it('reports finished for a resumed run that actually executed turns', async () => {
    const finish = await finishForResult(
      { ...cleanExit, num_turns: 3, total_cost_usd: 0.2 },
      { resumeSessionId: 'sess-old' }
    );

    expect(finish.state).toBe('finished');
    expect(finish.error).toBeUndefined();
  });

  // Back-compat, mirroring the terminal_reason convention above: a result
  // that never carries num_turns at all is "no opinion", so assistant output
  // alone keeps the run finished rather than failing every run under an SDK
  // (or fixture) without the field.
  it('reports finished when num_turns is absent but assistant output was seen', async () => {
    const finish = await finishForResult({
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.2,
      session_id: 'sess-tr',
      stop_reason: null,
      terminal_reason: 'completed',
      errors: [],
    });

    expect(finish.state).toBe('finished');
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
      version: '2.1.4',
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
      version: '2.1.4',
    }) as McpStdioServerConfig;
    expect(config.env?.CARTO_MCP_TIER).toBeUndefined();
    expect(JSON.stringify(config)).not.toContain('CARTO_MCP_TIER');
  });

  it('roots carto at the project, never at a run worktree', () => {
    const config = buildCartoMcpServerConfig('/proj', {
      path: '/opt/homebrew/bin/carto',
      version: '2.1.4',
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
      version: '2.1.4',
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
function withStubCarto<T>(fn: () => T, version = '2.1.4'): T {
  const binDir = mkdtempSync(join(tmpdir(), 'dispatch-carto-bin-'));
  const stub = join(binDir, 'carto');
  writeFileSync(stub, `#!/bin/sh\necho "carto-md ${version}"\n`);
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

  // Below 2.1.4, `carto serve` starts but never connects its stdio transport
  // (carto#9), so the entry would cost every run an MCP server that answers
  // nothing. Blast radius still works there — that path reads the container
  // as a library, not over MCP.
  it('contributes nothing when carto is too old to connect its MCP transport', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-carto-proj-'));
    try {
      writeCartoConfig(root, 'on');
      const servers = withStubCarto(() => cartoMcpServers(root), '2.1.3');
      expect(Object.keys(servers)).toEqual([]);
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

/**
 * The graceful-stop path against the lever a live Agent SDK session gives us:
 * the PreToolUse hook and the `canUseTool` gate (see STOP_DENIAL_MESSAGE).
 * These drive both directly off the `Options` the executor hands to `query()` — the same
 * `queryFn` seam the wiring tests above use — because the alternative is a real
 * credentialed Claude session, which CI cannot assume.
 */
describe('ClaudeExecutor graceful stop', () => {
  // A Query stub that never ends on its own, so a test can observe what
  // `requestStop` does (and does not do) to a session still in flight.
  function stubQuery(): {
    query: Query;
    interrupts: number;
    closes: number;
    release: () => void;
  } {
    const state = { interrupts: 0, closes: 0 };
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      release = resolve;
    });
    const query = {
      // A stream that produces nothing: the first `next()` parks on `done` and
      // then reports the stream ended, so the run under test stays in flight
      // until `release()` is called. Written as an explicit iterator rather
      // than a generator because a generator that never yields is exactly what
      // this needs to express and cannot.
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<never>> => {
          await done;
          return { done: true, value: undefined };
        },
      }),
      interrupt: () => {
        state.interrupts += 1;
      },
      close: () => {
        state.closes += 1;
      },
    } as unknown as Query;
    return {
      query,
      get interrupts() {
        return state.interrupts;
      },
      get closes() {
        return state.closes;
      },
      release,
    };
  }

  function startStopped(
    events: ExecutorEvents = noopEvents,
    permissionMode = 'acceptEdits'
  ) {
    let captured: Options | undefined;
    const stub = stubQuery();
    const executor = new ClaudeExecutor((args: { options?: Options }) => {
      captured = args.options;
      return stub.query;
    });
    const run = executor.start(
      {
        cwd: '/tmp/dispatch-worktree-stop',
        projectRoot: '/tmp/dispatch-project-stop',
        prompt: 'do the thing',
        permissionMode,
      },
      events
    );
    return { run, stub, options: captured! };
  }

  // The SDK's own call options carry more than this executor reads (an abort
  // signal, suggestions); `requestId` is the only field `canUseTool` touches.
  const callOpts = { requestId: 'req-1' } as never;

  // The SDK types a permission result as nullable; this executor's gate always
  // returns one, so the assertion is where that gets pinned down once instead
  // of at every read of `.behavior`/`.message` below.
  async function decided(
    result: Promise<unknown>
  ): Promise<{ behavior: string; message?: string }> {
    const settled = await result;
    expect(settled).not.toBeNull();
    return settled as { behavior: string; message?: string };
  }

  it('denies a tool call made after the stop, including one it would otherwise auto-allow', async () => {
    const { run, stub, options } = startStopped();
    try {
      // `Edit` under acceptEdits is auto-allowed — the strongest case that the
      // stop check has to sit ahead of.
      const before = await decided(options.canUseTool!('Edit', {}, callOpts));
      expect(before.behavior).toBe('allow');

      run.requestStop();

      const after = await decided(options.canUseTool!('Edit', {}, callOpts));
      expect(after.behavior).toBe('deny');
      expect(after.message).toBe(STOP_DENIAL_MESSAGE);
      // The instruction has to tell the model what to do instead, not just say
      // no — that is what turns a refusal into a clean wind-down.
      expect(STOP_DENIAL_MESSAGE).toContain('end your turn');
    } finally {
      stub.release();
    }
  });

  it('resolves an approval the run was parked on, carrying the same instruction', async () => {
    const requests: { requestId: string; toolName: string }[] = [];
    const { run, stub, options } = startStopped({
      ...noopEvents,
      onApprovalRequest: (request) => requests.push(request),
    });
    try {
      // Not awaited: `Bash` is gated, so this promise stays pending until a
      // human answers — or, here, until the stop answers for them.
      const pending = options.canUseTool!('Bash', {}, callOpts);
      await Promise.resolve();
      expect(requests).toHaveLength(1);

      run.requestStop();

      const result = await decided(pending);
      expect(result.behavior).toBe('deny');
      expect(result.message).toBe(STOP_DENIAL_MESSAGE);
    } finally {
      stub.release();
    }
  });

  // The CLI skips canUseTool under bypassPermissions, on a settings allow rule
  // and for calls the auto-mode classifier approves; the hook runs in every
  // mode, so it is what gets the stop to the agent there.
  it('denies every call from the PreToolUse hook after the stop, in every permission mode', async () => {
    for (const permissionMode of [
      'default',
      'acceptEdits',
      'auto',
      'bypassPermissions',
    ]) {
      const { run, stub, options } = startStopped(noopEvents, permissionMode);
      try {
        expect(
          await floorDecision(options.hooks, 'Edit', { file_path: 'a.ts' })
        ).toBeUndefined();
        expect(
          await floorDecision(options.hooks, 'Bash', { command: 'bun test' })
        ).toBeUndefined();

        run.requestStop();

        for (const [toolName, toolInput] of [
          ['Edit', { file_path: 'a.ts' }],
          ['Bash', { command: 'bun test' }],
          // Refused, not parked for a human: the run is winding down.
          ['Bash', { command: 'git push --force origin main' }],
        ] as const) {
          expect(
            await preToolUse(options.hooks, toolName, toolInput)
          ).toMatchObject({
            permissionDecision: 'deny',
            permissionDecisionReason: STOP_DENIAL_MESSAGE,
          });
        }
      } finally {
        stub.release();
      }
    }
  });

  // The distinction from cancel, at the SDK boundary: interrupting is what
  // kills the agent mid-work, and a graceful stop must never do it — the run
  // still owes us a closing turn and the `result` message that carries it.
  it('leaves the session running rather than interrupting it', async () => {
    const { run, stub } = startStopped();
    try {
      run.requestStop();
      expect(stub.interrupts).toBe(0);
      expect(stub.closes).toBe(0);

      // Cancel, by contrast, does interrupt.
      await run.interrupt();
      expect(stub.interrupts).toBe(1);
    } finally {
      stub.release();
    }
  });
});
