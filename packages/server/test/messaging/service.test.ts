import { TaskStore } from '@dispatch/core';
import type { Delivery, Message } from '@dispatch/protocol';
import { openMessagesDb, SqliteMessageStore } from '@dispatch/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../../src/cache.js';
import type { ServerEvent } from '../../src/events.js';
import { EventBus } from '../../src/events.js';
import { createRunTokens } from '../../src/messaging/runTokens.js';
import { openMessaging } from '../../src/messaging/service.js';
import { Orchestrator } from '../../src/orchestrator/orchestrator.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';

// Waits for `check` to become true, polling rather than sleeping a fixed
// amount — the delivery/run-start flows here settle asynchronously.
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('waitFor timed out');
}

function stubMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: 'm-00000000000000000000000000',
    thread: 'm-00000000000000000000000000',
    replyTo: null,
    from: 'human:wyat',
    to: ['human:ada'],
    kind: 'message',
    body: 'hello',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

function stubDelivery(overrides: Partial<Delivery> = {}): Delivery {
  return {
    id: 'd-00000000000000000000000000',
    messageId: 'm-00000000000000000000000000',
    recipient: 'run:r-000001',
    runId: 'r-000001',
    via: 'direct',
    state: 'sending',
    updatedAt: '2026-09-23T10:00:00.000Z',
    ...overrides,
  };
}

let root: string;
let fakeHome: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-messaging-service-');
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function makeOrchestrator(): { orchestrator: Orchestrator; store: TaskStore } {
  const store = TaskStore.init(root);
  const cache = new TaskCache();
  cache.rebuild(store);
  const events = new EventBus();
  const orchestrator = new Orchestrator({
    rootDir: root,
    store,
    cache,
    events,
  });
  return { orchestrator, store };
}

describe('openMessaging', () => {
  it('boot recovers before serving', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const dbPath = join(root, 'messages.db');
    // Seed a message.db as if a crash caught a delivery mid-send to a run
    // that is no longer live (dispatchd never registered it this boot).
    const seedDb = openMessagesDb(dbPath);
    const seedStore = new SqliteMessageStore(seedDb);
    const message = stubMessage({ to: ['run:r-000001'] });
    const delivery = stubDelivery();
    seedStore.insertMessage(message);
    seedStore.insertDelivery(delivery);
    seedDb.close();

    const events = new EventBus();
    const messaging = await openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath,
    });
    const stored = messaging.store.getDelivery(delivery.id);
    expect(stored?.state).toBe('held');
    expect(stored?.runId).toBeNull();
    messaging.close();
  });

  it('bridges engine events to the bus', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const events = new EventBus();
    const seen: ServerEvent[] = [];
    events.subscribe((e) => {
      if (e.type === 'message.new' || e.type === 'delivery.changed') {
        seen.push(e);
      }
    });
    const messaging = await openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });
    await messaging.engine.send(
      { to: ['human:ada'], kind: 'message', body: 'hi there' },
      { address: 'human:wyat', canDecide: true }
    );
    expect(seen.map((e) => e.type)).toEqual([
      'message.new',
      'delivery.changed',
    ]);
    messaging.close();
  });

  it('delivers held messages when a run starts', async () => {
    const { orchestrator, store } = makeOrchestrator();
    const executor = new StallingExecutor();
    orchestrator.registerExecutor('stalling', executor);
    const task = store.create({ title: 'Read the mail' });
    const events = new EventBus();
    const messaging = await openMessaging({
      rootDir: root,
      orchestrator,
      store,
      events,
      ownerRef: 'human:wyat',
      dbPath: join(root, 'messages.db'),
    });

    // No run yet: this send is held on the task.
    await messaging.engine.send(
      {
        to: [`task:${task.meta.id}`],
        kind: 'message',
        body: 'are you there?',
      },
      { address: 'human:wyat', canDecide: true }
    );

    await orchestrator.dispatch(task.meta.id, 'stalling', {});
    await waitFor(() =>
      executor.sent.some((s) => s.includes('are you there?'))
    );
    messaging.close();
  });
});

describe('run tokens', () => {
  it('round-trip and reject tampering', () => {
    const tokens = createRunTokens(Buffer.from('a-fixed-test-secret'));
    const minted = tokens.mint('r-000001');
    expect(tokens.verify(minted)).toBe('r-000001');

    const forged = `r-000002.${minted.split('.')[1]}`;
    expect(tokens.verify(forged)).toBeNull();
    expect(tokens.verify('garbage')).toBeNull();
  });
});
