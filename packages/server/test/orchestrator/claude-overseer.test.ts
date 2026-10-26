import type {
  Options,
  Query,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { CLAUDE_INSTALL_HINT } from '../../src/orchestrator/claudeCli.js';
import { floorGuard } from '../../src/orchestrator/floorHook.js';
import { toolDescriptionForModel } from '../../src/orchestrator/overseerBackend.js';
import type {
  OverseerToolResult,
  OverseerToolset,
  OverseerTurnOptions,
} from '../../src/orchestrator/overseerBackend.js';
import {
  EMPTY_REPLY_MESSAGE,
  overseerInstructions,
} from '../../src/orchestrator/overseerPrompt.js';
import {
  ClaudeOverseer,
  OVERSEER_TOOL_PREFIX,
  overseerSdkTools,
} from '../../src/orchestrator/overseers/claude.js';
import { recorded } from './claudeRecordings.js';
import { floorDecision, preToolUse } from './helpers.js';

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
// suite is about what ClaudeOverseer sends to the SDK and how it routes a call
// back, not about what the tools themselves do.
function stubToolset(result?: OverseerToolResult): {
  toolset: OverseerToolset;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const toolset: OverseerToolset = {
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
    call: (name, input) => {
      calls.push({ name, input });
      return Promise.resolve(
        result ?? { content: { ok: true }, isError: false }
      );
    },
  };
  return { toolset, calls };
}

// One `result` message is the minimum a turn needs to settle.
function successStream(
  fields: Record<string, unknown> = {}
): () => Iterable<unknown> {
  return function* stream() {
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
// the Options the backend handed to `query()`. The stream is a plain iterable:
// the backend reads it with `for await`, which accepts sync iterables too.
async function runTurn(
  stream: () => Iterable<unknown>,
  toolset: OverseerToolset,
  send?: (
    overseer: ClaudeOverseer,
    toolset: OverseerToolset
  ) => Promise<unknown>,
  options: OverseerTurnOptions = {}
): Promise<{ captured?: Options; turn: unknown }> {
  let captured: Options | undefined;
  const queryFn = (args: { options?: Options }) => {
    captured = args.options;
    return stream() as unknown as Query;
  };
  const overseer = new ClaudeOverseer(
    '/tmp/does-not-matter',
    queryFn as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
  );
  const turn =
    send === undefined
      ? await overseer.start('what is going on?', toolset, options)
      : await send(overseer, toolset);
  return { captured, turn };
}

// The canUseTool callback's third argument, as far as these tests read it.
const callOpts = { requestId: 'req-1' } as Parameters<
  NonNullable<Options['canUseTool']>
>[2];

describe('ClaudeOverseer Bun compatibility', () => {
  it('imports @anthropic-ai/claude-agent-sdk and constructs under Bun', () => {
    const overseer = new ClaudeOverseer('/tmp/does-not-matter');
    expect(overseer).toBeInstanceOf(ClaudeOverseer);
    expect(typeof overseer.start).toBe('function');
    expect(typeof overseer.sendMessage).toBe('function');
  });
});

describe('ClaudeOverseer session wiring', () => {
  it('runs as a full Claude Code session in the checkout with its own MCP server on top', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset, undefined, {
      permissionMode: 'auto',
      maxTurns: 40,
      maxBudgetUsd: 2.5,
    });

    // No `tools: []` and no empty settings/skills lists: the overseer is
    // meant to do everything a `claude` session at this checkout can, and
    // the checkout's CLAUDE.md only loads with 'project' among the sources.
    expect(captured?.tools).toBeUndefined();
    expect(captured?.settingSources).toEqual(['user', 'project', 'local']);
    expect(captured?.skills).toBeUndefined();
    expect(captured?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: expect.stringContaining('overseer'),
    });
    // Its own tools are pre-approved; the rest go through canUseTool.
    expect(captured?.allowedTools).toEqual([
      `${OVERSEER_TOOL_PREFIX}list_runs`,
      `${OVERSEER_TOOL_PREFIX}cancel_run`,
    ]);
    expect(Object.keys(captured?.mcpServers ?? {})).toContain('overseer');
    // The project's own policy and caps, exactly as a dispatched run gets.
    expect(captured?.permissionMode).toBe('auto');
    expect(captured?.maxTurns).toBe(40);
    expect(captured?.maxBudgetUsd).toBe(2.5);
    // No background tasks: one outliving the turn ran floor commands after
    // the query closed. The rest of the environment is inherited.
    expect(captured?.env?.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS).toBe('1');
    expect(captured?.env?.PATH).toBe(process.env.PATH);
    // With no one to authorize anything, a floor command is refused, as
    // canUseTool refuses every gated call.
    expect(
      await floorDecision(captured?.hooks, 'Bash', {
        command: 'gh release create v2.0.0',
      })
    ).toBe('deny');
    expect(captured?.settings).toMatchObject(
      floorGuard('deny').settings as Record<string, unknown>
    );
  });

  // The hook holds a floor command through the same authorizeTool gate
  // canUseTool uses, since the CLI can skip canUseTool or let a settings
  // PermissionRequest hook answer first (see floorGuard).
  it('holds floor commands for a human through authorizeTool', async () => {
    const { toolset } = stubToolset();
    const asked: { requestId: string; toolName: string }[] = [];
    const { captured } = await runTurn(successStream(), toolset, undefined, {
      authorizeTool: (request) => {
        asked.push(request);
        return Promise.resolve({ allow: false, reason: 'not from chat' });
      },
    });
    const release = { command: 'gh release create v2.0.0' };
    expect(await preToolUse(captured?.hooks, 'Bash', release)).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'not from chat',
    });
    expect(asked).toEqual([
      expect.objectContaining({
        requestId: 'floor-tu-1',
        toolName: 'Bash',
        input: release,
      }),
    ]);
    // Anything else is left to canUseTool and the session's own policy.
    expect(
      await floorDecision(captured?.hooks, 'Bash', { command: 'git status' })
    ).toBeUndefined();
    expect(asked).toHaveLength(1);
  });

  // After the hook's allow the CLI can still send the call on to canUseTool;
  // the human already decided on that exact call, so authorizeTool is not
  // asked again.
  it('does not ask twice about a floor call approved in the hook', async () => {
    const { toolset } = stubToolset();
    let asks = 0;
    const { captured } = await runTurn(successStream(), toolset, undefined, {
      authorizeTool: () => {
        asks += 1;
        return Promise.resolve({ allow: true });
      },
    });
    const release = { command: 'gh release create v2.0.0' };
    expect(await floorDecision(captured?.hooks, 'Bash', release)).toBe('allow');
    expect(
      await captured?.canUseTool?.('Bash', release, {
        signal: new AbortController().signal,
        toolUseID: 'tu-1',
        requestId: 'cli-uuid-1',
      })
    ).toEqual({ behavior: 'allow', updatedInput: release });
    expect(asks).toBe(1);
  });

  it('leaves the caps and policy to the SDK defaults when the project sets none', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset);
    expect(captured?.permissionMode).toBeUndefined();
    expect(captured?.maxTurns).toBeUndefined();
    expect(captured?.maxBudgetUsd).toBeUndefined();
  });

  // Its transcripts are readable by request-tier callers, so it never loads
  // the owner's native Claude notes.
  it('keeps Claude’s auto memory off beside the floor’s settings', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset);
    const settings = captured?.settings as Record<string, unknown> | undefined;
    expect(settings).toMatchObject({
      env: { CLAUDE_CODE_SIMPLE: '0', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
      disableSkillShellExecution: true,
      autoMemoryEnabled: false,
    });
    expect(settings?.autoMemoryDirectory).toBeUndefined();
    expect(captured?.additionalDirectories).toBeUndefined();
  });

  it('tells the model that a mutating call only queues an action', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset);

    const prompt = captured?.systemPrompt as { append?: string } | undefined;
    expect(prompt?.append).toContain(
      'queues the action as an approval card the human answers'
    );
    // Dispatch's own side doors always wait on a human.
    expect(prompt?.append).toContain('always waits on a human');
    expect(prompt?.append).toContain('never report one as done');
    // And that a built-in denial is the human's answer, not an obstacle.
    expect(prompt?.append).toContain('respect rather than work around');
  });

  it('allows its own tools with their input intact without asking anyone', async () => {
    const { toolset } = stubToolset();
    let asked = 0;
    const { captured } = await runTurn(successStream(), toolset, undefined, {
      authorizeTool: () => {
        asked += 1;
        return Promise.resolve({ allow: false });
      },
    });

    const allowed = await captured?.canUseTool?.(
      `${OVERSEER_TOOL_PREFIX}list_runs`,
      { limit: 3 },
      callOpts
    );
    expect(allowed).toEqual({
      behavior: 'allow',
      updatedInput: { limit: 3 },
    });
    expect(asked).toBe(0);
  });

  it('routes every other tool through authorizeTool and runs it only on allow', async () => {
    const { toolset } = stubToolset();
    const seen: unknown[] = [];
    const answers: { allow: boolean; reason?: string }[] = [
      { allow: true },
      { allow: false, reason: 'not on main, thanks' },
      { allow: false },
    ];
    const { captured } = await runTurn(successStream(), toolset, undefined, {
      authorizeTool: (request) => {
        seen.push(request);
        return Promise.resolve(answers.shift() ?? { allow: false });
      },
    });

    const allowed = await captured?.canUseTool?.(
      'Bash',
      { command: 'git status' },
      callOpts
    );
    expect(allowed).toEqual({
      behavior: 'allow',
      updatedInput: { command: 'git status' },
    });
    expect(seen[0]).toEqual({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'git status' },
    });

    // A refusal carries the human's reason to the model verbatim...
    const denied = await captured?.canUseTool?.(
      'Edit',
      { file_path: 'a.ts' },
      callOpts
    );
    expect(denied).toEqual({
      behavior: 'deny',
      message: 'not on main, thanks',
    });
    // ...and a bare refusal still says who refused.
    const bare = await captured?.canUseTool?.('Read', {}, callOpts);
    expect(bare).toEqual({ behavior: 'deny', message: 'denied by user' });
  });

  it('refuses every built-in tool when there is no one to ask', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset);
    for (const tool of ['Bash', 'Read', 'mcp__dispatch__task_save']) {
      const denied = await captured?.canUseTool?.(tool, {}, callOpts);
      expect(denied?.behavior).toBe('deny');
    }
  });

  it('reports built-in tool calls from assistant messages, not its own', async () => {
    const { toolset } = stubToolset();
    const stream = function* stream() {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'assistant',
        session_id: 'sess-1',
        message: {
          content: [
            { type: 'text', text: 'let me look' },
            { type: 'tool_use', name: 'Bash', input: { command: 'ls' } },
            {
              type: 'tool_use',
              name: `${OVERSEER_TOOL_PREFIX}list_runs`,
              input: {},
            },
          ],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 'sess-1',
        result: 'two files',
      };
    };
    const reported: [string, unknown][] = [];
    await runTurn(stream, toolset, undefined, {
      onToolUse: (name, input) => reported.push([name, input]),
    });
    expect(reported).toEqual([['Bash', { command: 'ls' }]]);
  });

  it('returns the reply and session id, and resumes the prior session on a follow-up', async () => {
    const { toolset } = stubToolset();
    const opening = await runTurn(successStream(), toolset);
    expect(opening.turn).toEqual({ reply: 'all quiet', sessionId: 'sess-1' });
    expect(opening.captured?.resume).toBeUndefined();

    const followUp = await runTurn(
      successStream({ session_id: 'sess-2' }),
      toolset,
      (overseer, tools) =>
        overseer.sendMessage('sess-1', 'and now?', tools, { model: 'm-1' })
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
    const errored = function* stream() {
      yield { type: 'result', subtype: 'error_max_turns', session_id: 's' };
    };
    await expect(runTurn(errored, toolset)).rejects.toThrow(
      'overseer turn failed: error_max_turns'
    );

    const silent = function* stream() {
      yield { type: 'system', subtype: 'init', session_id: 's' };
    };
    await expect(runTurn(silent, toolset)).rejects.toThrow(
      'overseer turn produced no result message'
    );
  });

  it('fails a turn the signed-out CLI reports as an error success', async () => {
    const { toolset } = stubToolset();
    await expect(
      runTurn(
        successStream({
          is_error: true,
          result: 'Not logged in · Please run /login',
        }),
        toolset
      )
    ).rejects.toThrow('Not logged in · Please run /login');
  });

  it('rewrites the SDK missing-CLI error into an install hint', async () => {
    const { toolset } = stubToolset();
    const queryFn = () => {
      throw new Error(MISSING_CLI_MESSAGE);
    };
    const overseer = new ClaudeOverseer(
      '/tmp/does-not-matter',
      queryFn as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
    );
    // `Bun.which('claude')` may or may not find a CLI on the machine running
    // this, so only the no-CLI branch is asserted on when there is none.
    if (Bun.which('claude') === null) {
      await expect(overseer.start('hi', toolset)).rejects.toThrow(
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
  def: ReturnType<typeof overseerSdkTools>[number],
  args: unknown
): Promise<{ content: unknown; isError?: boolean }> {
  return (
    def.handler as unknown as (
      a: unknown,
      extra: unknown
    ) => Promise<{ content: unknown; isError?: boolean }>
  )(args, undefined);
}

describe('overseerSdkTools', () => {
  it('routes a call through the toolset and hands the payload back as JSON', async () => {
    const { toolset, calls } = stubToolset();
    const [listRuns] = overseerSdkTools(toolset);

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
    const [, cancelRun] = overseerSdkTools(toolset);

    const result = await invoke(cancelRun, { runId: 'r-9' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('run not found: r-9');
  });

  it('advertises the tool parameters and says which tools only queue', () => {
    const { toolset } = stubToolset();
    const [listRuns, cancelRun] = overseerSdkTools(toolset);

    expect(Object.keys(listRuns.inputSchema)).toEqual(['limit']);
    expect(Object.keys(cancelRun.inputSchema)).toEqual(['runId']);
    expect(listRuns.description).not.toContain('QUEUES');
    expect(cancelRun.description).toContain('QUEUES this action');
  });
});

describe('shared overseer pieces', () => {
  it('words the instructions for whichever agent runs the session', () => {
    expect(overseerInstructions('Claude Code')).toContain(
      'a full Claude Code session in the project checkout'
    );
    expect(overseerInstructions('Codex')).toContain(
      'a full Codex session in the project checkout'
    );
    expect(overseerInstructions('Codex').replace('Codex', 'Claude Code')).toBe(
      overseerInstructions('Claude Code')
    );
  });

  it('promises gated reads only to an agent that asks before reading', () => {
    const gated = overseerInstructions('Claude Code');
    expect(gated).toContain('reading its token file');
    const ungated = overseerInstructions('Codex', { ungatedReads: true });
    expect(ungated).not.toContain('reading its token file');
    expect(ungated).toContain('without asking');
    expect(ungated).toContain('Never read the daemon’s token file');
    // Only that paragraph differs.
    expect(ungated.split('\n\n').length).toBe(gated.split('\n\n').length);
  });

  it('moves into planning unprompted for multi-task work, not small asks', () => {
    const planning = overseerInstructions('Claude Code')
      .split('\n\n')
      .find((paragraph) => paragraph.startsWith('Planning happens here'));
    expect(planning).toContain('even if they never ask for a breakdown');
    expect(planning).toContain('ask what you must know');
    expect(planning).toContain(
      'A single small task, a question or a status check is not a plan'
    );
    expect(planning).toContain(
      'one create_plan card rather than a card per task'
    );
    expect(planning).toContain('also starts its agents');
  });

  it('tells the model a mutating tool only queues', () => {
    const { toolset } = stubToolset();
    const [listRuns, cancelRun] = toolset.tools;
    expect(toolDescriptionForModel(listRuns)).toBe('Live and recent runs.');
    expect(toolDescriptionForModel(cancelRun)).toBe(
      'Stop a live run. QUEUES this action for human confirmation — calling it does not perform it.'
    );
  });

  it('appends the Claude-worded instructions to the claude_code preset', async () => {
    const { toolset } = stubToolset();
    const { captured } = await runTurn(successStream(), toolset);
    expect(captured?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append: overseerInstructions('Claude Code'),
    });
  });
});

describe('ClaudeOverseer attachments', () => {
  // Runs a turn with `attachments` and returns the prompt query() was given.
  async function promptFor(
    attachments: OverseerTurnOptions['attachments']
  ): Promise<unknown> {
    let prompt: unknown;
    const queryFn = (args: { prompt: unknown }) => {
      prompt = args.prompt;
      return successStream()() as unknown as Query;
    };
    const overseer = new ClaudeOverseer(
      '/tmp/does-not-matter',
      queryFn as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
    );
    await overseer.start('what is this?', stubToolset().toolset, {
      attachments,
    });
    return prompt;
  }

  it('sends an attached image inline, ahead of the text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'overseer-attach-'));
    const shot = join(dir, 'shot.png');
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const prompt = await promptFor([
        { name: 'shot.png', absolutePath: shot, mimeType: 'image/png' },
      ]);
      // Streamed, and the stream ends once the turn has settled.
      const messages: SDKUserMessage[] = [];
      for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
        messages.push(m);
      }
      expect(messages).toHaveLength(1);
      expect(messages[0].message.content).toEqual([
        {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
          },
        },
        { type: 'text', text: 'what is this?' },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a plain prompt when nothing attached can go inline', async () => {
    expect(
      await promptFor([
        {
          name: 'log.txt',
          absolutePath: '/nowhere/log.txt',
          mimeType: 'text/plain',
        },
        {
          name: 'gone.png',
          absolutePath: '/nowhere/gone.png',
          mimeType: 'image/png',
        },
      ])
    ).toBe('what is this?');
  });
});

// Turn options that log what the backend reported, in order: every delta by
// segment, narration and tool rows as the transcript would get them, and
// each segment the stream abandoned.
function liveRecorder(on: { live?: boolean; narration?: boolean } = {}) {
  const rows: string[] = [];
  const text = new Map<string, string>();
  const options: OverseerTurnOptions = {
    onToolUse: (name) => rows.push(`tool ${name}`),
    ...(on.live === false
      ? {}
      : {
          onTextDelta: (id: string, delta: string) =>
            text.set(id, `${text.get(id) ?? ''}${delta}`),
          onSegmentAbandoned: (id: string) => rows.push(`abandoned ${id}`),
        }),
    ...(on.narration === false
      ? {}
      : {
          onNarration: (id: string, said: string) =>
            rows.push(`narration ${id}: ${said}`),
        }),
  };
  return { rows, text, options };
}

const STRING_REPLY =
  "The current year is 2026, which matches today's date of October 23, 2026.\n\ndone";

describe('ClaudeOverseer live text and narration', () => {
  it('streams each text block under its own segment and keeps the line before a tool call as narration', async () => {
    const { toolset } = stubToolset();
    const { rows, text, options } = liveRecorder();
    const { captured, turn } = await runTurn(
      recorded('string'),
      toolset,
      undefined,
      options
    );
    expect(captured?.includePartialMessages).toBe(true);
    expect(Object.fromEntries(text)).toEqual({
      'msg_string_1:0': "I'll check the date.",
      'msg_string_2:0': STRING_REPLY,
    });
    // The narration lands before the call it led to, and the reply is not
    // narration as well.
    expect(rows).toEqual([
      "narration msg_string_1:0: I'll check the date.",
      'tool Bash',
    ]);
    expect(turn).toMatchObject({
      reply: STRING_REPLY,
      streamId: 'msg_string_2:0',
    });
  });

  it('keys a text block after a thinking block by its own index, in streaming-input mode', async () => {
    const { toolset } = stubToolset();
    const { rows, text, options } = liveRecorder();
    const { turn } = await runTurn(
      recorded('stream'),
      toolset,
      undefined,
      options
    );
    expect([...text.keys()]).toEqual(['msg_stream_1:1', 'msg_stream_2:0']);
    expect(rows).toEqual([
      'narration msg_stream_1:1: I will check the date.',
      'tool Bash',
    ]);
    expect(turn).toMatchObject({ streamId: 'msg_stream_2:0' });
  });

  it('without live text asks for no partial messages and counts text blocks per message', async () => {
    const { toolset } = stubToolset();
    const { rows, options } = liveRecorder({ live: false });
    // What the SDK sends with includePartialMessages off: no stream events.
    const { captured, turn } = await runTurn(
      recorded('stream', (e) => e.type !== 'stream_event'),
      toolset,
      undefined,
      options
    );
    expect(captured?.includePartialMessages).toBeUndefined();
    expect(rows).toEqual([
      'narration msg_stream_1:0: I will check the date.',
      'tool Bash',
    ]);
    expect(turn).toMatchObject({ streamId: 'msg_stream_2:0' });
  });

  it('with neither callback replies exactly as before', async () => {
    const { toolset } = stubToolset();
    const { rows, options } = liveRecorder({ live: false, narration: false });
    const { captured, turn } = await runTurn(
      recorded('string'),
      toolset,
      undefined,
      options
    );
    expect(captured?.includePartialMessages).toBeUndefined();
    expect(rows).toEqual(['tool Bash']);
    expect(turn).toMatchObject({ reply: STRING_REPLY, sessionId: 'sess-rec' });
  });

  it("ignores a sub-agent's text, tool calls and usage", async () => {
    const { toolset } = stubToolset();
    const { rows, text, options } = liveRecorder();
    const sub = { parent_tool_use_id: 'toolu_task', session_id: 's' };
    const stream = function* stream() {
      yield { type: 'system', subtype: 'init', session_id: 's' };
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'msg_top',
          content: [{ type: 'tool_use', name: 'Task', input: {} }],
          usage: { input_tokens: 1200 },
        },
      };
      yield {
        ...sub,
        type: 'stream_event',
        event: { type: 'message_start', message: { id: 'msg_sub' } },
      };
      yield {
        ...sub,
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        },
      };
      yield {
        ...sub,
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'sub-agent musing' },
        },
      };
      yield {
        ...sub,
        type: 'assistant',
        message: {
          id: 'msg_sub',
          content: [
            { type: 'text', text: 'sub-agent musing' },
            { type: 'tool_use', name: 'Grep', input: {} },
          ],
          usage: { input_tokens: 90_000 },
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 's',
        result: 'found it',
      };
    };
    const { turn } = await runTurn(stream, toolset, undefined, options);
    expect(text.size).toBe(0);
    expect(rows).toEqual(['tool Task']);
    expect(turn).toMatchObject({ reply: 'found it', contextTokens: 1200 });
  });

  it('keeps pending text the result does not contain as narration, ahead of the reply', async () => {
    const { toolset } = stubToolset();
    const { rows, options } = liveRecorder();
    const stream = function* stream() {
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'msg_a',
          content: [
            { type: 'text', text: 'An aside the result leaves out.' },
            { type: 'text', text: 'The answer.' },
          ],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 's',
        result: 'The answer.',
      };
    };
    const { turn } = await runTurn(stream, toolset, undefined, options);
    expect(rows).toEqual([
      'narration msg_a:0: An aside the result leaves out.',
    ]);
    expect(turn).toMatchObject({ reply: 'The answer.', streamId: 'msg_a:1' });
  });

  // The CLI falls back to a non-streaming request when the stream fails
  // mid-block: the half-streamed block never finishes, and its text comes
  // again under a new API message.
  it('reports a block its stream broke off as abandoned, never as narration', async () => {
    const { toolset } = stubToolset();
    const { rows, text, options } = liveRecorder();
    const event = (e: object) => ({
      type: 'stream_event',
      session_id: 's',
      parent_tool_use_id: null,
      event: e,
    });
    const block = (id: string, said: string) => [
      event({ type: 'message_start', message: { id } }),
      event({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text' },
      }),
      event({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: said },
      }),
    ];
    const stream = function* stream() {
      yield* block('msg_A', 'Let me lo');
      yield event({ type: 'content_block_stop', index: 0 });
      yield event({ type: 'message_stop' });
      yield* block('msg_B', 'Let me look.');
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'msg_B',
          content: [
            { type: 'text', text: 'Let me look.' },
            { type: 'tool_use', name: 'Read', input: {} },
          ],
        },
      };
      yield event({ type: 'content_block_stop', index: 0 });
      yield event({ type: 'message_stop' });
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 's',
        result: 'Seen it.',
      };
    };
    const { turn } = await runTurn(stream, toolset, undefined, options);
    expect(Object.fromEntries(text)).toEqual({
      'msg_A:0': 'Let me lo',
      'msg_B:0': 'Let me look.',
    });
    expect(rows).toEqual([
      'abandoned msg_A:0',
      'narration msg_B:0: Let me look.',
      'tool Read',
    ]);
    expect(turn).toMatchObject({ reply: 'Seen it.' });
    expect(turn).not.toHaveProperty('streamId');
  });

  it('commits narration when the CLI asks about a call before its message is read', async () => {
    const { toolset } = stubToolset();
    const { rows, options } = liveRecorder();
    let sdkOptions: Options | undefined;
    const stream = async function* stream() {
      yield {
        type: 'assistant',
        parent_tool_use_id: null,
        message: {
          id: 'msg_a',
          content: [{ type: 'text', text: 'Let me look.' }],
        },
      };
      await sdkOptions?.canUseTool?.('Read', { file_path: 'a' }, callOpts);
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 's',
        result: 'Seen it.',
      };
    };
    const queryFn = (args: { options?: Options }) => {
      sdkOptions = args.options;
      return stream() as unknown as Query;
    };
    const overseer = new ClaudeOverseer(
      '/tmp/does-not-matter',
      queryFn as unknown as typeof import('@anthropic-ai/claude-agent-sdk').query
    );
    await overseer.start('look', toolset, {
      ...options,
      authorizeTool: (request) => {
        rows.push(`ask ${request.toolName}`);
        return Promise.resolve({ allow: true });
      },
    });
    expect(rows).toEqual(['narration msg_a:0: Let me look.', 'ask Read']);
  });
});
