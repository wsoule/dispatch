import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { OverseerRecord } from '../src/orchestrator/overseer.js';
import type {
  OverseerBackend,
  OverseerToolset,
  OverseerTurn,
  OverseerTurnOptions,
} from '../src/orchestrator/overseerBackend.js';
import { FakeOverseer } from '../src/orchestrator/overseers/fake.js';
import type { FakeOverseerScript } from '../src/orchestrator/overseers/fake.js';
import type { ApprovalDecision } from '../src/orchestrator/types.js';
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
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-overseer-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// A backend whose turns never settle, for asserting the busy (409) shape —
// FakeOverseer always resolves on the same tick, so it can't hold a
// conversation at `running`.
class HangingOverseer implements OverseerBackend {
  start(): Promise<OverseerTurn> {
    return new Promise<OverseerTurn>(() => {});
  }
  sendMessage(): Promise<OverseerTurn> {
    return new Promise<OverseerTurn>(() => {});
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

// Boots a daemon whose 'claude' overseer backend is the given fake, with a
// FakeExecutor under 'claude' too so a confirmed dispatch_task action runs a
// real (fake-executed) dispatch rather than touching the Agent SDK.
async function startWithOverseer(backend: OverseerBackend): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerOverseers: (overseerManager) => {
      overseerManager.registerBackend('claude', backend);
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
  record: OverseerRecord;
}> {
  const res = await fetch(`${baseUrl}/api/overseer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt }),
  });
  return { res, record: (await json(res)) as OverseerRecord };
}

async function getRecord(id: string): Promise<OverseerRecord> {
  return (await json(
    await fetch(`${baseUrl}/api/overseer/${id}`)
  )) as OverseerRecord;
}

async function settled(id: string): Promise<OverseerRecord> {
  await waitFor(async () => (await getRecord(id)).state !== 'running');
  return getRecord(id);
}

describe('POST /api/overseer and GET /api/overseer/:id', () => {
  it('202s the running record immediately and settles to ready', async () => {
    await startWithOverseer(
      new FakeOverseer({ ok: true, reply: 'Nothing is running.' })
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
    await startWithOverseer(new FakeOverseer({ ok: true }));

    const empty = await fetch(`${baseUrl}/api/overseer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '' }),
    });
    expect(empty.status).toBe(400);

    const unknown = await fetch(`${baseUrl}/api/overseer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', backend: 'nope' }),
    });
    expect(unknown.status).toBe(400);
    expect((await json(unknown)).error).toContain('invalid backend');

    const badEffort = await fetch(`${baseUrl}/api/overseer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hi', effort: 'extreme' }),
    });
    expect(badEffort.status).toBe(400);
    expect((await json(badEffort)).error).toContain('invalid effort');
  });

  it('404s an unknown conversation id', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true }));
    const res = await fetch(`${baseUrl}/api/overseer/wc-000000`);
    expect(res.status).toBe(404);
  });

  it('surfaces a failed turn as state failed with the error', async () => {
    await startWithOverseer(
      new FakeOverseer({ ok: false, error: 'model down' })
    );
    const { record } = await startConversation();
    const failed = await settled(record.id);
    expect(failed.state).toBe('failed');
    expect(failed.error).toBe('model down');
  });

  it('broadcasts overseer.changed with the conversation id', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'hello' }));
    const ws = new WebSocket(wsUrl(handle));
    const changed = new Promise<string>((resolve) => {
      ws.addEventListener('message', (ev) => {
        const parsed = JSON.parse(ev.data as string) as {
          type: string;
          conversationId?: string;
        };
        if (parsed.type === 'overseer.changed') {
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

describe('POST /api/overseer/:id/message', () => {
  it('202s back to running and settles with the follow-up reply', async () => {
    await startWithOverseer(
      new FakeOverseer({
        ok: true,
        turns: [{ reply: 'first' }, { reply: 'second' }],
      })
    );
    const { record } = await startConversation('opening');
    await settled(record.id);

    const res = await fetch(`${baseUrl}/api/overseer/${record.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'and now?' }),
    });
    expect(res.status).toBe(202);
    const busyRecord = (await json(res)) as OverseerRecord;
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
    await startWithOverseer(new HangingOverseer());
    const { record } = await startConversation();
    expect(record.state).toBe('running');

    const busy = await fetch(`${baseUrl}/api/overseer/${record.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'still there?' }),
    });
    expect(busy.status).toBe(409);

    const missing = await fetch(`${baseUrl}/api/overseer/wc-000000/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello?' }),
    });
    expect(missing.status).toBe(404);
  });

  it('400s an empty text', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true }));
    const { record } = await startConversation();
    await settled(record.id);
    const res = await fetch(`${baseUrl}/api/overseer/${record.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/overseer/:id/actions/:actionId/confirm', () => {
  // Creates the task before the daemon boots (it reads task files at startup)
  // and scripts a single turn that queues dispatching it.
  async function startWithQueuedDispatch(): Promise<OverseerRecord> {
    const doc = store.create({ title: 'Widget task' });
    const script: FakeOverseerScript = {
      ok: true,
      calls: [{ tool: 'dispatch_task', input: { taskId: doc.meta.id } }],
      reply: 'I queued a dispatch for your confirmation.',
    };
    await startWithOverseer(new FakeOverseer(script));
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
      `${baseUrl}/api/overseer/${conversationId}/actions/${actionId}/confirm`,
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
    const confirmed = (await json(res)) as OverseerRecord;
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
    const denied = (await json(res)) as OverseerRecord;
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

// A backend standing in for a full Claude Code session that wants to run one
// built-in tool: it asks the daemon through `authorizeTool` and replies with
// what it was told, so the route's effect is readable off the transcript.
class GatedOverseer implements OverseerBackend {
  decided: ApprovalDecision | undefined;

  start(
    _prompt: string,
    _toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    return this.turn(options);
  }

  sendMessage(
    _sessionId: string | undefined,
    _message: string,
    _toolset: OverseerToolset,
    options?: OverseerTurnOptions
  ): Promise<OverseerTurn> {
    return this.turn(options);
  }

  private async turn(options?: OverseerTurnOptions): Promise<OverseerTurn> {
    options?.onToolUse?.('Bash', { command: 'git status' });
    this.decided = await options?.authorizeTool?.({
      requestId: 'req-1',
      toolName: 'Bash',
      input: { command: 'git status' },
    });
    return {
      reply: this.decided?.allow === true ? 'clean tree' : 'could not look',
      sessionId: 's-1',
    };
  }
}

async function decide(
  conversationId: string,
  requestId: string,
  body: unknown
): Promise<Response> {
  return fetch(
    `${baseUrl}/api/overseer/${conversationId}/approvals/${requestId}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
}

// Opens a conversation against the gated backend and returns the record once
// its built-in call is parked.
async function startParked(): Promise<{
  backend: GatedOverseer;
  record: OverseerRecord;
}> {
  const backend = new GatedOverseer();
  await startWithOverseer(backend);
  const { record } = await startConversation('is the tree clean?');
  await waitFor(
    async () => (await getRecord(record.id)).pendingApprovals.length > 0
  );
  return { backend, record: await getRecord(record.id) };
}

describe('POST /api/overseer/:id/approvals/:requestId', () => {
  it('parks the built-in call on the running record until decided', async () => {
    const { record } = await startParked();
    expect(record.state).toBe('running');
    expect(record.pendingApprovals).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
        toolName: 'Bash',
        summary: 'Bash: git status',
      }),
    ]);
    expect(record.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'approval',
        requestId: 'req-1',
        outcome: 'pending',
      })
    );
  });

  it('allow runs the call and the turn settles on its result', async () => {
    const { backend, record } = await startParked();

    const res = await decide(record.id, 'req-1', {
      allow: true,
      scope: 'session',
    });
    expect(res.status).toBe(200);
    const decided = (await json(res)) as OverseerRecord;
    expect(decided.pendingApprovals).toEqual([]);
    expect(decided.messages.at(-1)).toEqual(
      expect.objectContaining({ role: 'approval', outcome: 'allowed' })
    );

    const ready = await settled(record.id);
    expect(backend.decided).toEqual({ allow: true, scope: 'session' });
    expect(ready.messages.at(-1)).toEqual(
      expect.objectContaining({ role: 'assistant', text: 'clean tree' })
    );
  });

  it('deny hands the reason to the session and nothing runs', async () => {
    const { backend, record } = await startParked();

    const res = await decide(record.id, 'req-1', {
      allow: false,
      reason: 'not now',
    });
    expect(res.status).toBe(200);

    const ready = await settled(record.id);
    expect(backend.decided).toEqual({ allow: false, reason: 'not now' });
    expect(
      ready.messages.find(
        (m) => m.role === 'approval' && m.outcome === 'denied'
      )?.text
    ).toBe('Denied: Bash: git status — not now');
    expect(ready.messages.at(-1)).toEqual(
      expect.objectContaining({ role: 'assistant', text: 'could not look' })
    );
  });

  it('404s an unknown request and an unknown conversation, 400s a bad body', async () => {
    const { record } = await startParked();

    expect((await decide(record.id, 'req-9', { allow: true })).status).toBe(
      404
    );
    expect((await decide('wc-000000', 'req-1', { allow: true })).status).toBe(
      404
    );
    expect((await decide(record.id, 'req-1', { allow: 'yes' })).status).toBe(
      400
    );
    expect(
      (await decide(record.id, 'req-1', { allow: true, scope: 'forever' }))
        .status
    ).toBe(400);
    // Still parked: none of those touched it.
    expect((await getRecord(record.id)).pendingApprovals).toHaveLength(1);
    await decide(record.id, 'req-1', { allow: false });
    await settled(record.id);
  });
});

describe('POST /api/overseer model choice', () => {
  it('keeps a chosen model on the record and 400s a blank one', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'hi' }));

    const chosen = await fetch(`${baseUrl}/api/overseer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', model: 'claude-fable-5-1' }),
    });
    expect(chosen.status).toBe(202);
    expect(((await json(chosen)) as OverseerRecord).model).toBe(
      'claude-fable-5-1'
    );

    const blank = await fetch(`${baseUrl}/api/overseer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello', model: '  ' }),
    });
    expect(blank.status).toBe(400);

    const { record } = await startConversation('plain');
    expect(record.model).toBeUndefined();
  });
});
