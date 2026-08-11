import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { WardenRecord } from '../src/orchestrator/warden.js';
import type {
  WardenBackend,
  WardenTurn,
} from '../src/orchestrator/wardenBackend.js';
import { FakeWarden } from '../src/orchestrator/wardens/fake.js';
import type { FakeWardenScript } from '../src/orchestrator/wardens/fake.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth, wsUrl } from './testAuth.js';

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 5000,
  intervalMs = 20
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error('waitFor timed out');
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-warden-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// A backend whose turns never settle, for asserting the busy (409) shape —
// FakeWarden always resolves on the same tick, so it can't hold a
// conversation at `running`.
class HangingWarden implements WardenBackend {
  start(): Promise<WardenTurn> {
    return new Promise<WardenTurn>(() => {});
  }
  sendMessage(): Promise<WardenTurn> {
    return new Promise<WardenTurn>(() => {});
  }
}

let fakeHome: string;
let root: string;
let store: TaskStore;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  store = TaskStore.init(root);
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Boots a daemon whose 'claude' warden backend is the given fake, with a
// FakeExecutor under 'claude' too so a confirmed dispatch_task action runs a
// real (fake-executed) dispatch rather than touching the Agent SDK.
async function startWithWarden(backend: WardenBackend): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerWardens: (wardenManager) => {
      wardenManager.registerBackend('claude', backend);
    },
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor(
        'claude',
        new FakeExecutor({ finish: { state: 'finished', sessionId: 's-1' } })
      );
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

async function startConversation(prompt = 'what is running?'): Promise<{
  res: Response;
  record: WardenRecord;
}> {
  const res = await fetch(`${baseUrl}/api/warden`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return { res, record: (await json(res)) as WardenRecord };
}

async function getRecord(id: string): Promise<WardenRecord> {
  return (await json(
    await fetch(`${baseUrl}/api/warden/${id}`)
  )) as WardenRecord;
}

async function settled(id: string): Promise<WardenRecord> {
  await waitFor(async () => (await getRecord(id)).state !== 'running');
  return getRecord(id);
}

describe('POST /api/warden and GET /api/warden/:id', () => {
  it('202s the running record immediately and settles to ready', async () => {
    await startWithWarden(
      new FakeWarden({ ok: true, reply: 'Nothing is running.' })
    );

    const { res, record } = await startConversation('what is running?');
    expect(res.status).toBe(202);
    expect(record.id).toMatch(/^wc-/);
    expect(record.state).toBe('running');
    expect(record.messages).toEqual([
      expect.objectContaining({ role: 'user', text: 'what is running?' }),
    ]);

    const ready = await settled(record.id);
    expect(ready.state).toBe('ready');
    expect(ready.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'assistant',
        text: 'Nothing is running.',
      })
    );
  });

  it('400s an empty prompt and an unregistered backend', async () => {
    await startWithWarden(new FakeWarden({ ok: true }));

    const empty = await fetch(`${baseUrl}/api/warden`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(empty.status).toBe(400);

    const unknown = await fetch(`${baseUrl}/api/warden`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', backend: 'nope' }),
    });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).error).toContain('invalid backend');
  });

  it('404s an unknown conversation id', async () => {
    await startWithWarden(new FakeWarden({ ok: true }));
    const res = await fetch(`${baseUrl}/api/warden/wc-000000`);
    expect(res.status).toBe(404);
  });

  it('surfaces a failed turn as state failed with the error', async () => {
    await startWithWarden(new FakeWarden({ ok: false, error: 'model down' }));
    const { record } = await startConversation();
    const failed = await settled(record.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('model down');
  });

  it('broadcasts warden.changed with the conversation id', async () => {
    await startWithWarden(new FakeWarden({ ok: true, reply: 'hello' }));
    const ws = new WebSocket(wsUrl(handle));
    const changed = new Promise<string>((resolve) => {
      ws.addEventListener('message', (ev) => {
        const parsed = JSON.parse(ev.data as string) as {
          type: string;
          conversationId?: string;
        };
        if (parsed.type === 'warden.changed') {
          resolve(parsed.conversationId ?? '');
        }
      });
    });
    await new Promise<void>((resolve) =>
      ws.addEventListener('open', () => resolve())
    );

    const { record } = await startConversation();
    const conversationId = await Promise.race([
      changed,
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('WS timeout')), 3000)
      ),
    ]);
    expect(conversationId).toBe(record.id);
    ws.close();
  });
});

describe('POST /api/warden/:id/message', () => {
  it('202s back to running and settles with the follow-up reply', async () => {
    await startWithWarden(
      new FakeWarden({
        ok: true,
        turns: [{ reply: 'first' }, { reply: 'second' }],
      })
    );
    const { record } = await startConversation('opening');
    await settled(record.id);

    const res = await fetch(`${baseUrl}/api/warden/${record.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'and now?' }),
    });
    expect(res.status).toBe(202);
    const busyRecord = (await json(res)) as WardenRecord;
    expect(busyRecord.state).toBe('running');
    expect(busyRecord.messages.at(-1)).toEqual(
      expect.objectContaining({ role: 'user', text: 'and now?' })
    );

    const ready = await settled(record.id);
    expect(ready.messages.at(-1)).toEqual(
      expect.objectContaining({ role: 'assistant', text: 'second' })
    );
  });

  it('409s while a turn is in flight and 404s an unknown id', async () => {
    await startWithWarden(new HangingWarden());
    const { record } = await startConversation();
    expect(record.state).toBe('running');

    const busy = await fetch(`${baseUrl}/api/warden/${record.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'still there?' }),
    });
    expect(busy.status).toBe(409);

    const missing = await fetch(`${baseUrl}/api/warden/wc-000000/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello?' }),
    });
    expect(missing.status).toBe(404);
  });

  it('400s an empty text', async () => {
    await startWithWarden(new FakeWarden({ ok: true }));
    const { record } = await startConversation();
    await settled(record.id);
    const res = await fetch(`${baseUrl}/api/warden/${record.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/warden/:id/actions/:actionId/confirm', () => {
  // Creates the task before the daemon boots (it reads task files at startup)
  // and scripts a single turn that queues dispatching it.
  async function startWithQueuedDispatch(): Promise<WardenRecord> {
    const doc = store.create({ title: 'Widget task' });
    const script: FakeWardenScript = {
      ok: true,
      calls: [{ tool: 'dispatch_task', input: { taskId: doc.meta.id } }],
      reply: 'I queued a dispatch for your confirmation.',
    };
    await startWithWarden(new FakeWarden(script));
    const { record } = await startConversation(`dispatch ${doc.meta.id}`);
    const ready = await settled(record.id);
    expect(ready.pendingActions).toHaveLength(1);
    return ready;
  }

  async function confirm(
    conversationId: string,
    actionId: string,
    approve: unknown
  ): Promise<Response> {
    return fetch(
      `${baseUrl}/api/warden/${conversationId}/actions/${actionId}/confirm`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ approve }),
      }
    );
  }

  async function listRuns(): Promise<{ taskId: string }[]> {
    return (await json(await fetch(`${baseUrl}/api/runs`))) as {
      taskId: string;
    }[];
  }

  it('approve applies the action and dispatches the run', async () => {
    const ready = await startWithQueuedDispatch();
    const action = ready.pendingActions[0];

    const res = await confirm(ready.id, action.id, true);
    expect(res.status).toBe(200);
    const confirmed = (await json(res)) as WardenRecord;
    expect(confirmed.pendingActions).toHaveLength(0);
    expect(confirmed.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'action',
        actionId: action.id,
        outcome: 'applied',
      })
    );
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
  });

  it('deny records the refusal and dispatches nothing', async () => {
    const ready = await startWithQueuedDispatch();
    const action = ready.pendingActions[0];

    const res = await confirm(ready.id, action.id, false);
    expect(res.status).toBe(200);
    const denied = (await json(res)) as WardenRecord;
    expect(denied.pendingActions).toHaveLength(0);
    expect(denied.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'action',
        actionId: action.id,
        outcome: 'denied',
      })
    );
    expect(await listRuns()).toHaveLength(0);
  });

  it('404s an unknown action id and an unknown conversation', async () => {
    const ready = await startWithQueuedDispatch();

    const unknownAction = await confirm(ready.id, 'wa-000000', true);
    expect(unknownAction.status).toBe(404);

    const unknownConversation = await confirm(
      'wc-000000',
      ready.pendingActions[0].id,
      true
    );
    expect(unknownConversation.status).toBe(404);
  });

  it('400s a non-boolean approve', async () => {
    const ready = await startWithQueuedDispatch();
    const res = await confirm(ready.id, ready.pendingActions[0].id, 'yes');
    expect(res.status).toBe(400);
  });
});
