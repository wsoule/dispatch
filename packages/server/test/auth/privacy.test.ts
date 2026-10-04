import { describe, expect, it } from 'bun:test';

import type { World } from './world.js';
import { call, invite, liveRun, useWorld } from './world.js';

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
