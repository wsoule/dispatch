import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';

import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';
import { recorded } from './claudeRecordings.js';
import { initGitRepo, withRunEndControls } from './helpers.js';

const repos: string[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) {
    rmSync(repo, { recursive: true, force: true });
  }
});

const RESULT = {
  type: 'result',
  subtype: 'success',
  session_id: 's-1',
  total_cost_usd: 0.01,
  num_turns: 1,
  is_error: false,
  result: '',
};

// Runs a ClaudeExecutor over an SDK message stream until the run finishes,
// collecting the entries it logs, the deltas it streams (only when `live`, the
// one case a run is given onDelta) and the options it opened the query with.
async function runOver(
  messages: Iterable<unknown>,
  live = false
): Promise<{
  entries: NormalizedEntry[];
  deltas: [string, string][];
  abandoned: string[];
  options: Options | undefined;
}> {
  const repo = initGitRepo('dispatch-claude-stream-');
  repos.push(repo);
  let options: Options | undefined;
  const executor = new ClaudeExecutor((args: { options?: Options }) => {
    options = args.options;
    return withRunEndControls([...messages]);
  });
  const entries: NormalizedEntry[] = [];
  const deltas: [string, string][] = [];
  const abandoned: string[] = [];
  await new Promise<void>((resolve) => {
    const events: ExecutorEvents = {
      onEntry: (entry) => entries.push(entry),
      onApprovalRequest: () => {},
      onFinish: () => resolve(),
      ...(live
        ? {
            onDelta: (id: string, text: string) => deltas.push([id, text]),
            onSegmentAbandoned: (id: string) => abandoned.push(id),
          }
        : {}),
    };
    executor.start(
      { cwd: repo, prompt: 'go', permissionMode: 'acceptEdits' },
      events
    );
  });
  return { entries, deltas, abandoned, options };
}

// The entries a scripted session between an init and a result logs.
async function entriesFor(messages: unknown[]): Promise<NormalizedEntry[]> {
  const { entries } = await runOver([
    { type: 'system', subtype: 'init', session_id: 's-1' },
    ...messages,
    RESULT,
  ]);
  return entries;
}

// The text each segment streamed, joined in order.
function streamedText(deltas: [string, string][]): Record<string, string> {
  const text: Record<string, string> = {};
  for (const [id, delta] of deltas) text[id] = (text[id] ?? '') + delta;
  return text;
}

function toolUse(id: string, name: string, parent: string | null = null) {
  return {
    type: 'assistant',
    session_id: 's-1',
    parent_tool_use_id: parent,
    message: {
      id: `msg-${id}`,
      content: [{ type: 'tool_use', id, name, input: { command: 'ls' } }],
    },
  };
}

function toolResult(
  id: string,
  content: unknown,
  opts: { isError?: boolean; parent?: string | null } = {}
) {
  return {
    type: 'user',
    session_id: 's-1',
    parent_tool_use_id: opts.parent ?? null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: id,
          content,
          ...(opts.isError !== undefined ? { is_error: opts.isError } : {}),
        },
      ],
    },
  };
}

// A top-level tool_result is its call's outcome, logged as a `tool` entry of
// its own that readers fold into the call by toolUseId.
describe('ClaudeExecutor tool results', () => {
  it('logs a tool call, then its result with the same toolUseId', async () => {
    const entries = await entriesFor([
      toolUse('tu-1', 'Bash'),
      toolResult('tu-1', 'file-a\nfile-b'),
    ]);

    expect(entries).toEqual([
      expect.objectContaining({
        kind: 'tool',
        toolName: 'Bash',
        toolUseId: 'tu-1',
        status: 'running',
      }),
      {
        ts: expect.any(String),
        kind: 'tool',
        toolUseId: 'tu-1',
        status: 'done',
      },
    ]);
  });

  it('marks a failed call as an error', async () => {
    const entries = await entriesFor([
      toolUse('tu-1', 'Bash'),
      toolResult('tu-1', [{ type: 'text', text: 'exit code 1' }], {
        isError: true,
      }),
    ]);

    expect(entries[1]).toMatchObject({
      kind: 'tool',
      toolUseId: 'tu-1',
      status: 'error',
    });
    expect(entries[1].toolName).toBeUndefined();
  });

  // The transcript reaches every request-tier client, and a result can carry
  // what the call read: the operator's exported memory, a personal doc.
  it("never copies a result's output into the transcript", async () => {
    const entries = await entriesFor([
      toolUse('tu-1', 'Read'),
      toolResult('tu-1', 'my private note'),
      toolUse('tu-2', 'mcp__dispatch__memory_search'),
      toolResult('tu-2', [{ type: 'text', text: 'a personal doc' }]),
    ]);

    for (const entry of [entries[1], entries[3]]) {
      expect('text' in entry).toBe(false);
    }
    expect(JSON.stringify(entries)).not.toContain('private');
    expect(JSON.stringify(entries)).not.toContain('personal');
  });

  it("skips a sub-agent's results, unknown calls and repeats", async () => {
    const entries = await entriesFor([
      toolUse('tu-sub', 'Grep', 'tu-spawn'),
      toolResult('tu-sub', 'match', { parent: 'tu-spawn' }),
      toolResult('tu-never-called', 'stray'),
      toolUse('tu-1', 'Bash'),
      toolResult('tu-1', 'once'),
      toolResult('tu-1', 'twice'),
    ]);

    expect(
      entries.map((e) => [e.toolUseId, e.status, e.parentToolUseId ?? null])
    ).toEqual([
      ['tu-sub', 'running', 'tu-spawn'],
      ['tu-1', 'running', null],
      ['tu-1', 'done', null],
    ]);
  });
});

// Live text replays a real Agent SDK 0.3.293 session recorded with partial
// messages on (test/fixtures/claude-overseer-stream.json, "stream"): a line,
// a Bash call, then the answer. Each text block streams under its own
// segment, and the entry it ends as names that segment.
describe('ClaudeExecutor live text', () => {
  const LINE = 'msg_stream_1:1';
  const ANSWER = 'msg_stream_2:0';

  it('streams each text block and stamps its entry with the segment', async () => {
    const { entries, deltas, abandoned, options } = await runOver(
      recorded('stream')(),
      true
    );

    expect(abandoned).toEqual([]);
    expect(options?.includePartialMessages).toBe(true);
    const answer = entries.at(-1)?.text ?? '';
    expect(answer).toStartWith('The year is 2026');
    expect(streamedText(deltas)).toEqual({
      [LINE]: 'I will check the date.',
      [ANSWER]: answer,
    });
    expect(
      entries.map((e) => [e.kind, e.toolName ?? null, e.streamId ?? null])
    ).toEqual([
      ['assistant', null, LINE],
      ['tool', 'Bash', null],
      ['tool', null, null],
      ['assistant', null, ANSWER],
    ]);
  });

  // The CLI falls back to a non-streaming request when the stream fails
  // mid-block: the half-streamed block never finishes, and its text comes
  // again under a new API message.
  it('reports a block its message stopped without finishing as abandoned', async () => {
    const event = (e: object) => ({
      type: 'stream_event',
      session_id: 's-1',
      parent_tool_use_id: null,
      event: e,
    });
    const text = (index: number, delta: string) =>
      event({
        type: 'content_block_delta',
        index,
        delta: { type: 'text_delta', text: delta },
      });
    const { entries, deltas, abandoned } = await runOver(
      [
        { type: 'system', subtype: 'init', session_id: 's-1' },
        event({ type: 'message_start', message: { id: 'msg_A' } }),
        event({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        }),
        text(0, 'Half a sen'),
        event({ type: 'content_block_stop', index: 0 }),
        event({ type: 'message_stop' }),
        event({ type: 'message_start', message: { id: 'msg_B' } }),
        event({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text' },
        }),
        text(0, 'A whole sentence.'),
        {
          type: 'assistant',
          session_id: 's-1',
          parent_tool_use_id: null,
          message: {
            id: 'msg_B',
            content: [{ type: 'text', text: 'A whole sentence.' }],
          },
        },
        event({ type: 'content_block_stop', index: 0 }),
        event({ type: 'message_stop' }),
        RESULT,
      ],
      true
    );

    expect(streamedText(deltas)).toEqual({
      'msg_A:0': 'Half a sen',
      'msg_B:0': 'A whole sentence.',
    });
    expect(abandoned).toEqual(['msg_A:0']);
    expect(entries.map((e) => e.streamId)).toEqual(['msg_B:0']);
  });

  it('asks for no partial messages and stamps nothing when no one watches', async () => {
    const { entries, deltas, options } = await runOver(recorded('stream')());

    expect(options?.includePartialMessages).toBeUndefined();
    expect(deltas).toEqual([]);
    expect(entries.some((e) => e.streamId !== undefined)).toBe(false);
  });

  // An older CLI, or one that sends no stream events: nothing streams, and
  // each text block is still named, by its place in its API message.
  it('names text blocks by their place when the stream sends no events', async () => {
    const { entries, deltas } = await runOver(
      recorded('stream', (e) => e.type !== 'stream_event')(),
      true
    );

    expect(deltas).toEqual([]);
    expect(
      entries.filter((e) => e.kind === 'assistant').map((e) => e.streamId)
    ).toEqual(['msg_stream_1:0', 'msg_stream_2:0']);
  });

  it("does not stream a sub-agent's text", async () => {
    const sub = { parent_tool_use_id: 'tu-spawn', session_id: 's-1' };
    const { entries, deltas } = await runOver(
      [
        { type: 'system', subtype: 'init', session_id: 's-1' },
        {
          ...sub,
          type: 'stream_event',
          event: { type: 'message_start', message: { id: 'msg-sub' } },
        },
        {
          ...sub,
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text' },
          },
        },
        {
          ...sub,
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'sub-agent words' },
          },
        },
        {
          ...sub,
          type: 'assistant',
          message: {
            id: 'msg-sub',
            content: [{ type: 'text', text: 'sub-agent words' }],
          },
        },
        RESULT,
      ],
      true
    );

    expect(deltas).toEqual([]);
    expect(entries).toEqual([
      {
        ts: expect.any(String),
        kind: 'assistant',
        text: 'sub-agent words',
        parentToolUseId: 'tu-spawn',
      },
    ]);
  });
});
