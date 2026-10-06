import { TaskStore } from '@dispatch-foo/core';
import { afterEach, describe, expect, it } from 'bun:test';

import { EventBus } from '../../src/events.js';
import type { SocketAudience } from '../../src/events.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import type { Messaging } from '../../src/messaging/service.js';
import type { AuthTier } from '../../src/tiers.js';
import {
  HUMAN,
  makeOrchestrator,
  openRecovered,
  useTempProject,
  waitFor,
} from './harness.js';

// A socket double carrying the same audience data index.ts puts on a real one.
class FakeSocket {
  readonly frames: { type: string }[] = [];
  constructor(readonly data: SocketAudience) {}
  send(raw: string): void {
    this.frames.push(JSON.parse(raw) as { type: string });
  }
  types(): string[] {
    return this.frames.map((f) => f.type);
  }
}

function socket(ref: string, tier: AuthTier, agentToken = false): FakeSocket {
  return new FakeSocket({ ref, tier, agentToken });
}

const project = useTempProject();
const opened: Messaging[] = [];

afterEach(() => {
  for (const m of opened.splice(0)) m.close();
});

async function setup() {
  const { orchestrator, store } = makeOrchestrator(project.root());
  const events = new EventBus();
  const messaging = await openRecovered(
    project.root(),
    orchestrator,
    store,
    events
  );
  opened.push(messaging);
  const owner = socket('human:wyat', 'operator');
  const ada = socket('human:ada', 'request');
  const lead = socket('human:lin', 'decide');
  const carl = socket('human:carl', 'request');
  const shared = socket('human:wyat', 'request', true);
  for (const s of [owner, ada, lead, carl, shared]) events.add(s);
  return { messaging, events, owner, ada, lead, carl, shared };
}

describe('/ws message events are scoped', () => {
  it('a DM reaches its participants and deciding humans, not other teammates or the shared agent token', async () => {
    const { messaging, owner, ada, lead, carl, shared } = await setup();
    await messaging.engine.send(
      { to: ['human:ada'], kind: 'message', body: 'lunch?' },
      HUMAN
    );
    expect(owner.types()).toContain('message.new');
    expect(ada.types()).toContain('message.new');
    expect(ada.types()).toContain('delivery.changed');
    expect(lead.types()).toContain('message.new');
    expect(carl.types()).not.toContain('message.new');
    expect(carl.types()).not.toContain('delivery.changed');
    expect(shared.types()).toEqual([]);
  });

  it('a request-tier sender sees its own message', async () => {
    const { messaging, ada } = await setup();
    await messaging.engine.send(
      { to: ['human:wyat'], kind: 'message', body: 'hi' },
      { address: 'human:ada', canDecide: false }
    );
    expect(ada.types()).toContain('message.new');
  });

  it('events that are not about messages still reach every socket', async () => {
    const { events, carl, shared } = await setup();
    events.broadcast({ type: 'task.changed' });
    expect(carl.types()).toEqual(['task.changed']);
    expect(shared.types()).toEqual(['task.changed']);
  });

  it('in-process listeners still get every message event', async () => {
    const { messaging, events } = await setup();
    const seen: string[] = [];
    events.subscribe((e) => seen.push(e.type));
    await messaging.engine.send(
      { to: ['human:ada'], kind: 'message', body: 'x' },
      HUMAN
    );
    expect(seen).toContain('message.new');
    expect(seen).toContain('delivery.changed');
  });

  it('a socket with no audience data gets no scoped event', async () => {
    const { messaging, events } = await setup();
    const frames: string[] = [];
    events.add({ send: (raw) => frames.push(raw) });
    await messaging.engine.send(
      { to: ['human:ada'], kind: 'message', body: 'x' },
      HUMAN
    );
    expect(frames).toEqual([]);
  });
});

describe('/ws on a running daemon', () => {
  let handle: ServerHandle | null = null;
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.close();
    if (handle !== null) await handle.stop();
    handle = null;
  });

  // Opens /ws with `token` and records every frame's type once it is open.
  function listen(port: number, token: string): Promise<string[]> {
    const types: string[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
    sockets.push(ws);
    ws.addEventListener('message', (event) => {
      types.push((JSON.parse(String(event.data)) as { type: string }).type);
    });
    return new Promise((resolve, reject) => {
      ws.addEventListener('open', () => resolve(types));
      ws.addEventListener('error', () => reject(new Error('ws failed')));
    });
  }

  it("keeps message events off the shared agent token's socket, even the owner's own", async () => {
    TaskStore.init(project.root());
    handle = await startServer({
      rootDir: project.root(),
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
    });
    const { appToken, agentToken } = handle.tokens;
    const base = `http://127.0.0.1:${handle.port}`;
    const app = await listen(handle.port, appToken);
    const agent = await listen(handle.port, agentToken);
    const headers = {
      'content-type': 'application/json',
      authorization: `Bearer ${appToken}`,
    };

    const sent = await fetch(`${base}/api/messages`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: ['human:test'], kind: 'message', body: 'x' }),
    });
    expect(sent.status).toBe(201);
    // A later unscoped event: frames arrive in order, so once it lands any
    // message event sent to the same socket would already be there.
    await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ title: 'after the message' }),
    });
    await waitFor(
      () => app.includes('task.changed') && agent.includes('task.changed')
    );

    expect(app).toContain('message.new');
    expect(agent).not.toContain('message.new');
    expect(agent).not.toContain('delivery.changed');
  });
});
