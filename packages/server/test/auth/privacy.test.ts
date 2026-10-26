import { describe, expect, it } from 'bun:test';

import type { World } from './world.js';
import { call, invite, liveRun, useWorld, waitFor } from './world.js';

// XH-R4: the decision feed shows each item to its participants and to
// deciders only, and a run's DM to a human never reaches other sockets as a
// run.log line.

const world = useWorld();

const secrets = (text: string) => [
  ...new Set(text.match(/PRIVATE-[A-Z-]+/g) ?? []),
];

// A teammate's DM question to the owner, and a run's, both still open.
async function privateAsks(w: World, from: string) {
  const run = await liveRun(w, w.app, 'owner work');
  const dm = await call(w, from, 'POST', '/api/messages', {
    to: ['human:test'],
    kind: 'question',
    blocking: true,
    body: 'PRIVATE-DM: should we let bob go?',
  });
  expect(dm.status).toBe(201);
  const rq = await call(w, run.runToken, 'POST', '/api/messages', {
    to: ['human:test'],
    kind: 'question',
    blocking: true,
    body: 'PRIVATE-RUN-Q: the prod key is in .env, rotate?',
  });
  expect(rq.status).toBe(201);
  return run;
}

describe('GET /api/decisions', () => {
  it('shows a request-tier teammate, the agent token and a run none of it', async () => {
    const w = world();
    const dec = await invite(w, 'dec@x.io', 'decide');
    const req = await invite(w, 'req@x.io', 'request');
    const run = await privateAsks(w, dec.token);
    const other = await liveRun(w, w.app, 'other');

    for (const token of [req.token, w.agent, other.runToken]) {
      const feed = await call(w, token, 'GET', '/api/decisions');
      expect(feed.status).toBe(200);
      expect(secrets(feed.text)).toEqual([]);
    }
    // The run that asked still sees its own question.
    const own = await call(w, run.runToken, 'GET', '/api/decisions');
    expect(secrets(own.text)).toEqual(['PRIVATE-RUN-Q']);
    // Deciders see everything.
    for (const token of [w.app, dec.token]) {
      const feed = await call(w, token, 'GET', '/api/decisions');
      expect(secrets(feed.text).sort()).toEqual([
        'PRIVATE-DM',
        'PRIVATE-RUN-Q',
      ]);
    }
  });

  it("shows a request-tier teammate their own run's items", async () => {
    const w = world();
    const req = await invite(w, 'req@x.io', 'request');
    const run = await liveRun(w, req.token, 'mine');
    await call(w, run.runToken, 'POST', '/api/messages', {
      to: [`human:${req.handle}`],
      kind: 'question',
      blocking: true,
      body: 'PRIVATE-MINE: which branch?',
    });
    const feed = await call(w, req.token, 'GET', '/api/decisions');
    expect(secrets(feed.text)).toEqual(['PRIVATE-MINE']);
  });
});

describe("a run's DM", () => {
  it('is never broadcast as run.log to sockets outside the conversation', async () => {
    const w = world();
    const req = await invite(w, 'req@x.io', 'request');
    const run = await liveRun(w, w.app, 'owner work');
    const frames: string[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${w.handle.port}/ws?token=${req.token}`
    );
    await new Promise((r) => (ws.onopen = r));
    ws.onmessage = (e) => frames.push(String(e.data));
    const owner: string[] = [];
    const ows = new WebSocket(
      `ws://127.0.0.1:${w.handle.port}/ws?token=${w.app}`
    );
    await new Promise((r) => (ows.onopen = r));
    ows.onmessage = (e) => owner.push(String(e.data));

    await call(w, run.runToken, 'POST', '/api/messages', {
      to: ['human:test'],
      kind: 'message',
      body: 'PRIVATE-RUN-DM for the owner only',
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(frames.filter((f) => f.includes('PRIVATE-RUN-DM'))).toEqual([]);
    // The owner, whom it was for, still sees it on the run's log.
    expect(
      owner.some((f) => f.includes('PRIVATE-RUN-DM') && f.includes('"run.log"'))
    ).toBe(true);
    ws.close();
    ows.close();
  });
});

// A run.log message frame as one socket heard it.
interface HeardEntry {
  index?: number;
  entry: { kind: string; text?: string; redacted?: boolean };
}

// Opens /ws as `token` and keeps the run.log message frames it hears.
async function listen(
  w: World,
  token: string
): Promise<{ heard: HeardEntry[]; close: () => void }> {
  const heard: HeardEntry[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${w.handle.port}/ws?token=${token}`);
  await new Promise((r) => (ws.onopen = r));
  ws.onmessage = (e) => {
    const frame = JSON.parse(String(e.data)) as HeardEntry & { type: string };
    if (frame.type === 'run.log' && frame.entry.kind === 'message')
      heard.push({ index: frame.index, entry: frame.entry });
  };
  return { heard, close: () => ws.close() };
}

// A request-tier teammate's message to the owner's run, and the run's DM back
// to them: one entry delivered to the run, one it sent.
async function privateExchange(w: World) {
  const req = await invite(w, 'req@x.io', 'request');
  const run = await liveRun(w, w.app, 'owner work');
  return {
    req,
    run,
    async send() {
      const sent = await call(w, req.token, 'POST', '/api/messages', {
        to: [`task:${run.taskId}`],
        kind: 'message',
        body: 'PRIVATE-IN: the staging password is hunter2',
      });
      expect(sent.status).toBe(201);
      const dm = await call(w, run.runToken, 'POST', '/api/messages', {
        to: [`human:${req.handle}`],
        kind: 'message',
        body: 'PRIVATE-OUT: rotated it',
      });
      expect(dm.status).toBe(201);
    },
  };
}

describe("a run transcript's message entries", () => {
  // The free plan's three seats: the owner (who decides), the teammate in
  // the conversation and one outside it.
  it('reach sockets outside the message redacted, at the same index', async () => {
    const w = world();
    const outsider = await invite(w, 'out@x.io', 'request');
    const exchange = await privateExchange(w);
    const sockets = {
      participant: await listen(w, exchange.req.token),
      decider: await listen(w, w.app),
      outsider: await listen(w, outsider.token),
      agent: await listen(w, w.agent),
    };
    await exchange.send();
    await waitFor(() =>
      Object.values(sockets).every((s) => s.heard.length === 2)
    );

    const texts = (s: { heard: HeardEntry[] }) =>
      s.heard.map((h) => secrets(h.entry.text ?? ''));
    expect(texts(sockets.participant)).toEqual([
      ['PRIVATE-IN'],
      ['PRIVATE-OUT'],
    ]);
    expect(texts(sockets.decider)).toEqual([['PRIVATE-IN'], ['PRIVATE-OUT']]);
    for (const s of [sockets.outsider, sockets.agent]) {
      expect(texts(s)).toEqual([[], []]);
      for (const h of s.heard) {
        expect(Object.keys(h.entry).sort()).toEqual([
          'kind',
          'messageId',
          'redacted',
          'ts',
        ]);
      }
    }
    const indexes = sockets.participant.heard.map((h) => h.index);
    expect(indexes.every((i) => typeof i === 'number')).toBe(true);
    for (const s of Object.values(sockets)) {
      expect(s.heard.map((h) => h.index)).toEqual(indexes);
      s.close();
    }
  });

  it('GET /api/runs/:id redacts the ones its caller may not read', async () => {
    const w = world();
    const outsider = await invite(w, 'out@x.io', 'request');
    const exchange = await privateExchange(w);
    const other = await liveRun(w, w.app, 'other');
    await exchange.send();
    const path = `/api/runs/${exchange.run.runId}`;

    const read = async (token: string) => {
      const detail = await call(w, token, 'GET', path);
      expect(detail.status).toBe(200);
      return detail.json.entries as HeardEntry['entry'][];
    };
    // The teammate in the conversation, the deciding owner, and the run.
    for (const token of [exchange.req.token, w.app, exchange.run.runToken]) {
      const entries = (await read(token)).filter((e) => e.kind === 'message');
      expect(entries.map((e) => secrets(e.text ?? ''))).toEqual([
        ['PRIVATE-IN'],
        ['PRIVATE-OUT'],
      ]);
    }
    // Everyone else: the entries keep their places, redacted.
    const whole = await read(w.app);
    for (const token of [outsider.token, w.agent, other.runToken]) {
      const entries = await read(token);
      expect(secrets(JSON.stringify(entries))).toEqual([]);
      expect(entries).toHaveLength(whole.length);
      expect(entries.map((e) => e.kind)).toEqual(whole.map((e) => e.kind));
      expect(entries.filter((e) => e.redacted === true)).toHaveLength(2);
    }
  });
});
