import type { PeerClient, PeerRow, TaskJson } from '@dispatch/a2a';
import { afterEach, beforeEach, expect, it } from 'bun:test';

import { OutboundWorker } from '../../src/a2a/outbound.js';
import { HUMAN, useTempProject, waitFor } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
let stop: () => void;
let reads = 0;
let task: TaskJson;
// Ticks the fake stream sends: one every `everyMs` until aborted.
let everyMs = 1;

const WORKING: TaskJson = {
  id: 'pt-1',
  contextId: 'pc-1',
  status: { state: 'TASK_STATE_WORKING' },
};

const PEER: PeerRow = {
  alias: 'acme',
  cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
  interfaceUrl: 'https://agent.example.com/a2a/v1',
  binding: 'HTTP+JSON',
  cardJson: JSON.stringify({ name: 'Acme', capabilities: { streaming: true } }),
  etag: null,
  fetchedAt: new Date().toISOString(),
  status: 'active',
  addedBy: 'human:wyat',
  addedTier: 'operator',
  allowHttp: false,
  allowOrigin: false,
  apiKeyHeader: null,
  createdAt: new Date().toISOString(),
};

// A peer whose SSE stream never stops ticking, the way keepalives or a chatty
// peer would, and whose task reads are counted.
// What the fake peer's send returns; a test may swap in a misbehaving task.
let sent: TaskJson;

const fakeClient = {
  send: () => Promise.resolve({ kind: 'task', task: sent }),
  getTask: () => {
    reads += 1;
    return Promise.resolve(task);
  },
  async *changes(_taskId: string, signal: AbortSignal) {
    while (!signal.aborted) {
      await Bun.sleep(everyMs);
      yield;
    }
  },
} as unknown as PeerClient;

beforeEach(async () => {
  f = await bridgeFixture(project.root());
  f.store.putPeer(PEER);
  reads = 0;
  everyMs = 1;
  task = WORKING;
  sent = WORKING;
  const worker = new OutboundWorker({
    engine: f.messaging.engine,
    messages: f.messaging.store,
    store: f.store,
    policy: () => f.deps.policy(),
    clientFor: () => fakeClient,
    refreshPeer: () => Promise.resolve(),
    markAuthFailed: () => undefined,
    guard: () => Promise.resolve(),
    disablePeer: () => undefined,
    now: () => f.deps.now?.() ?? new Date(),
    pollMs: () => 20,
  });
  stop = worker.start();
});
afterEach(() => {
  stop();
  f.close();
});

const ask = async () =>
  (
    await f.messaging.engine.send(
      {
        to: ['a2a:acme'],
        kind: 'question',
        blocking: true,
        body: 'Which colour?',
      },
      HUMAN
    )
  ).message;

it('reads the task at most once per poll floor while events stream in', async () => {
  const q = await ask();
  await waitFor(() => f.store.getOutbound(q.id, 'acme')?.state === 'open');
  const before = reads;
  await Bun.sleep(300);
  // ~300 ticks in 300 ms against a 20 ms floor: about fifteen reads, not hundreds.
  expect(reads - before).toBeGreaterThan(3);
  expect(reads - before).toBeLessThan(25);
});

it('never loses the last event of a burst', async () => {
  const q = await ask();
  await waitFor(() => f.store.getOutbound(q.id, 'acme')?.state === 'open');
  task = {
    ...WORKING,
    status: {
      state: 'TASK_STATE_COMPLETED',
      message: {
        messageId: 'pm-1',
        role: 'ROLE_AGENT',
        parts: [{ text: 'Blue' }],
      },
    },
  };
  await waitFor(() => f.messaging.engine.answerOf(q.id) !== null);
  expect(f.messaging.engine.answerOf(q.id)).toMatchObject({
    from: 'a2a:acme',
    body: 'Blue',
  });
});

it('stops at the 7-day limit even while the stream keeps ticking', async () => {
  const q = await ask();
  await waitFor(() => f.store.getOutbound(q.id, 'acme')?.state === 'open');
  const later = Date.now() + 8 * 86_400_000;
  f.deps.now = () => new Date(later);
  await waitFor(() => f.store.getOutbound(q.id, 'acme')?.state === 'failed');
  expect(f.store.getOutbound(q.id, 'acme')?.lastError).toBe(
    'no result in 7 days'
  );
  const settled = reads;
  await Bun.sleep(100);
  expect(reads).toBe(settled);
});

it.each([
  ['a task id over 200 bytes', { ...WORKING, id: 'x'.repeat(201) }],
  ['a task id across two lines', { ...WORKING, id: 'pt-1\npt-2' }],
  ['a context id over 200 bytes', { ...WORKING, contextId: 'c'.repeat(201) }],
])('refuses %s from a peer, and gives up', async (_what, bad) => {
  sent = bad as TaskJson;
  const q = await ask();
  await waitFor(() => f.store.getOutbound(q.id, 'acme')?.state === 'failed');
  expect(f.store.getOutbound(q.id, 'acme')).toMatchObject({
    remoteTaskId: null,
    remoteContextId: null,
    lastError: expect.stringContaining('invalid'),
  });
  expect(f.messaging.engine.answerOf(q.id)).toMatchObject({
    from: 'agent:dispatch',
  });
});
