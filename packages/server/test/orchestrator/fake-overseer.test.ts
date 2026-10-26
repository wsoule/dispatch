import { describe, expect, it } from 'bun:test';

import type {
  OverseerToolset,
  OverseerTurnOptions,
} from '../../src/orchestrator/overseerBackend.js';
import { FakeOverseer } from '../../src/orchestrator/overseers/fake.js';

// One harmless tool, recording each call into `log` beside the text events.
function toolsetLogging(log: string[]): OverseerToolset {
  return {
    tools: [],
    call: (name) => {
      log.push(`call ${name}`);
      return Promise.resolve({ content: {}, isError: false });
    },
  };
}

// Turn options that log every delta and narration into `log`.
function logging(log: string[]): OverseerTurnOptions {
  return {
    onTextDelta: (id, text) => log.push(`delta ${id}: ${text}`),
    onNarration: (id, text) => log.push(`narration ${id}: ${text}`),
  };
}

describe('FakeOverseer narration and streaming', () => {
  it('streams narration and the reply in pieces, narration ahead of its call', async () => {
    const log: string[] = [];
    const backend = new FakeOverseer({
      ok: true,
      turns: [
        {
          calls: [{ tool: 'list_runs', narration: 'Checking the runs.' }],
          reply: 'All of them are idle.',
          stream: { chunk: 8 },
        },
      ],
    });
    const turn = await backend.start('hi', toolsetLogging(log), logging(log));
    expect(log).toEqual([
      'delta fake-0-0: Checking',
      'delta fake-0-0:  the run',
      'delta fake-0-0: s.',
      'narration fake-0-0: Checking the runs.',
      'call list_runs',
      'delta fake-0-1: All of t',
      'delta fake-0-1: hem are ',
      'delta fake-0-1: idle.',
    ]);
    expect(turn).toEqual({
      reply: 'All of them are idle.',
      streamId: 'fake-0-1',
      sessionId: '1',
    });
  });

  it('without a stream reports narration whole and streams nothing', async () => {
    const log: string[] = [];
    const backend = new FakeOverseer({
      ok: true,
      calls: [{ tool: 'list_runs', narration: 'Looking now.' }],
      reply: 'done',
    });
    const turn = await backend.start('hi', toolsetLogging(log), logging(log));
    expect(log).toEqual(['narration fake-0-0: Looking now.', 'call list_runs']);
    expect(turn).toEqual({ reply: 'done', sessionId: '1' });
  });

  it('stops streaming once the turn is stopped', async () => {
    const log: string[] = [];
    const abortController = new AbortController();
    const backend = new FakeOverseer({
      ok: true,
      reply: 'a long reply that keeps going',
      stream: { chunk: 4, delayMs: 20 },
    });
    const turn = backend.start('hi', toolsetLogging(log), {
      ...logging(log),
      abortController,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    abortController.abort();
    await turn;
    const sent = log.length;
    expect(sent).toBeGreaterThan(0);
    expect(sent).toBeLessThan(8);
  });
});
