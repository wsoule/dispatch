import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { CLAUDE_INSTALL_HINT } from '../../src/orchestrator/claudeCli.js';
import type {
  WardenToolResult,
  WardenToolset,
} from '../../src/orchestrator/wardenBackend.js';
import {
  ClaudeWarden,
  EMPTY_REPLY_MESSAGE,
  WARDEN_TOOL_PREFIX,
  wardenSdkTools,
} from '../../src/orchestrator/wardens/claude.js';

// The exact text the Agent SDK throws when it can't resolve its own bundled
// native CLI binary — mirrors claude-planner.test.ts's fixture for the same
// failure.
const MISSING_CLI_MESSAGE =
  'Native CLI binary for darwin-arm64 not found. Reinstall ' +
  '@anthropic-ai/claude-agent-sdk without --omit=optional, or set ' +
  'options.pathToClaudeCodeExecutable.';

interface Recorded {
  name: string;
  input: unknown;
}

// A toolset with one tool of each kind, standing in for the real registry: this
// suite is about what ClaudeWarden sends to the SDK and how it routes a call
// back, not about what the tools themselves do.
function stubToolset(result?: WardenToolResult): {
  toolset: WardenToolset;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const toolset: WardenToolset = {
    tools: [
      {
        name: 'list_runs',
        description: 'Live and recent runs.',
        inputSchema: z.object({ limit: z.number().optional() }),
        mutating: false,
      },
      {
        name: 'cancel_run',
        description: 'Stop a live run.',
        inputSchema: z.object({ runId: z.string() }),
        mutating: true,
      },
    ],
    call: async (name, input) => {
      calls.push({ name, input });
      return result ?? { content: { ok: true }, isError: false };
    },
  };
  return { toolset, calls };
}

// One `result` message is the minimum a turn needs to settle.
function successStream(
  fields: Record<string, unknown> = {}
): () => AsyncGenerator<unknown> {
  return async function* stream() {
    yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
    yield {
      type: 'result',
      subtype: 'success',
      session_id: 'sess-1',
      result: 'all quiet',
      ...fields,
    };
  };
}

// Runs one turn against a scripted message stream, returning both the turn and
// the Options the backend handed to `query()`.
async function runTurn(
  stream: () => AsyncGenerator<unknown>,
  toolset: WardenToolset,
  send?: (warden: ClaudeWarden, toolset: WardenToolset) => Promise<unknown>
): Promise<{ captured?: Options; turn: unknown }> {
  let captured: Options | undefined;
  const queryFn = (args: { options?: Options }) => {
    captured = args.options;
    return stream() as unknown as Query;
  };
  const warden = new ClaudeWarden(
    '/tmp/does-not-matter',
    queryFn as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
  );
  const turn =
    send === undefined
      ? await warden.start('what is going on?', toolset)
      : await send(warden, toolset);
  return { captured, turn };
}

describe('ClaudeWarden Bun compatibility', () => {
  it('imports @anthropic-ai/claude-agent-sdk and constructs under Bun', () => {
    const warden = new ClaudeWarden('/tmp/does-not-matter');
    expect(warden).toBeInstanceOf(ClaudeWarden);
    expect(typeof warden.start).toBe('function');
    expect(typeof warden.sendMessage).toBe('function');
  });
});

describe('ClaudeWarden session wiring', () => {
  it('runs with no built-in tools, no settings sources, and only its own MCP server', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset);

    // The warden holds operator authority, so it gets no Read/Bash/Edit at all.
    expect(captured?.tools).toEqual([]);
    expect(captured?.allowedTools).toEqual([
      `${WARDEN_TOOL_PREFIX}list_runs`,
      `${WARDEN_TOOL_PREFIX}cancel_run`,
    ]);
    expect(captured?.settingSources).toEqual([]);
    expect(captured?.skills).toEqual([]);
    expect(captured?.strictMcpConfig).toBe(true);
    expect(Object.keys(captured?.mcpServers ?? {})).toEqual(['warden']);
    expect(captured?.maxTurns).toBeGreaterThan(0);
  });

  it('tells the model that a mutating call only queues an action', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset);

    // A plain string, not `{ type: 'preset', preset: 'claude_code' }` — that
    // preset describes a coding agent working in a checkout, which is the
    // wrong job for a session with no file tools.
    const prompt = captured?.systemPrompt;
    expect(typeof prompt).toBe('string');
    expect(prompt as string).toContain('queues the action for the human');
    expect(prompt as string).toContain(
      'never report a mutating action as done'
    );
  });

  it('allows its own tools with their input intact and refuses everything else', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset);
    const callOpts = {} as Parameters<NonNullable<Options['canUseTool']>>[2];

    const allowed = await captured?.canUseTool?.(
      `${WARDEN_TOOL_PREFIX}list_runs`,
      { limit: 3 },
      callOpts
    );
    expect(allowed).toEqual({
      behavior: 'allow',
      updatedInput: { limit: 3 },
    });

    for (const forbidden of ['Bash', 'Read', 'mcp__dispatch__task_save']) {
      const denied = await captured?.canUseTool?.(forbidden, {}, callOpts);
      expect(denied?.behavior).toBe('deny');
    }
  });

  it('returns the reply and session id, and resumes the prior session on a follow-up', async () => {
    const { toolset } = stubToolset();
    const opening = await runTurn(successStream(), toolset);
    expect(opening.turn).toEqual({ reply: 'all quiet', sessionId: 'sess-1' });
    expect(opening.captured?.resume).toBeUndefined();

    const followUp = await runTurn(
      successStream({ session_id: 'sess-2' }),
      toolset,
      (warden, tools) => warden.sendMessage('sess-1', 'and now?', tools, 'm-1')
    );
    expect(followUp.captured?.resume).toBe('sess-1');
    expect(followUp.captured?.model).toBe('m-1');
    expect(followUp.turn).toMatchObject({ sessionId: 'sess-2' });
  });

  it('stands in a readable line for a turn that says nothing at all', async () => {
    const { toolset } = stubToolset();
    const { turn } = await runTurn(successStream({ result: '   ' }), toolset);
    expect(turn).toMatchObject({ reply: EMPTY_REPLY_MESSAGE });
  });

  it('fails the turn on a non-success result and on a stream with no result', async () => {
    const { toolset } = stubToolset();
    const errored = async function* stream() {
      yield { type: 'result', subtype: 'error_max_turns', session_id: 's' };
    };
    await expect(runTurn(errored, toolset)).rejects.toThrow(
      'warden turn failed: error_max_turns'
    );

    const silent = async function* stream() {
      yield { type: 'system', subtype: 'init', session_id: 's' };
    };
    await expect(runTurn(silent, toolset)).rejects.toThrow(
      'warden turn produced no result message'
    );
  });

  it('rewrites the SDK missing-CLI error into an install hint', async () => {
    const { toolset } = stubToolset();
    const queryFn = () => {
      throw new Error(MISSING_CLI_MESSAGE);
    };
    const warden = new ClaudeWarden(
      '/tmp/does-not-matter',
      queryFn as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
    );
    // `Bun.which('claude')` may or may not find a CLI on the machine running
    // this, so only the no-CLI branch is asserted on when there is none.
    if (Bun.which('claude') === null) {
      await expect(warden.start('hi', toolset)).rejects.toThrow(
        CLAUDE_INSTALL_HINT
      );
    }
  });
});

// The SDK infers a tool's argument type from its raw shape, and a shape
// assembled at runtime infers to "no known keys" — so a test invoking a handler
// directly has to hand its arguments over untyped. The model sends whatever it
// sends anyway; the registry is what validates it.
function invoke(
  def: ReturnType<typeof wardenSdkTools>[number],
  args: unknown
): Promise<{ content: unknown; isError?: boolean }> {
  return (
    def.handler as unknown as (
      a: unknown,
      extra: unknown
    ) => Promise<{ content: unknown; isError?: boolean }>
  )(args, undefined);
}

describe('wardenSdkTools', () => {
  it('routes a call through the toolset and hands the payload back as JSON', async () => {
    const { toolset, calls } = stubToolset();
    const [listRuns] = wardenSdkTools(toolset);

    const result = await invoke(listRuns, { limit: 2 });

    expect(calls).toEqual([{ name: 'list_runs', input: { limit: 2 } }]);
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([
      { type: 'text', text: JSON.stringify({ ok: true }) },
    ]);
  });

  it("passes a tool-level failure back as the model's problem, not a thrown turn", async () => {
    const { toolset } = stubToolset({
      content: { error: 'run not found: r-9' },
      isError: true,
    });
    const [, cancelRun] = wardenSdkTools(toolset);

    const result = await invoke(cancelRun, { runId: 'r-9' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('run not found: r-9');
  });

  it('advertises the tool parameters and says which tools only queue', () => {
    const { toolset } = stubToolset();
    const [listRuns, cancelRun] = wardenSdkTools(toolset);

    expect(Object.keys(listRuns.inputSchema)).toEqual(['limit']);
    expect(Object.keys(cancelRun.inputSchema)).toEqual(['runId']);
    expect(listRuns.description).not.toContain('QUEUES');
    expect(cancelRun.description).toContain('QUEUES this action');
  });
});
