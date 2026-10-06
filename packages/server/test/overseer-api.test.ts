import { TaskStore, updateConfig } from '@dispatch-foo/core';
import type { Message } from '@dispatch-foo/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { claudeMemoryDir, projectKeyOf } from '../src/orchestrator/paths.js';
import type { ApprovalDecision } from '../src/orchestrator/types.js';
import { json } from './json.js';
import {
  BEFORE_CUTOVER,
  importAtCutover,
  seedLedger,
} from './memory/fixtures.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth, wsUrl } from './testAuth.js';

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

  it('queues while a turn is in flight, Stop ends it, and 404s an unknown id', async () => {
    await startWithOverseer(new HangingOverseer());
    const { record } = await startConversation();
    expect(record.state).toBe('running');

    const busy = await fetch(`${baseUrl}/api/overseer/${record.id}/message`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'still there?' }),
    });
    expect(busy.status).toBe(202);
    const queued = (await busy.json()) as OverseerRecord;
    expect(queued.queued?.map((q) => q.text)).toEqual(['still there?']);

    const stopped = await fetch(`${baseUrl}/api/overseer/${record.id}/stop`, {
      method: 'POST',
    });
    expect(stopped.status).toBe(200);
    const after = await settled(record.id);
    expect(after.state).toBe('ready');
    expect(after.messages.at(-1)).toMatchObject({ notice: 'stopped' });

    const current = (await json(
      await fetch(`${baseUrl}/api/overseer/current`)
    )) as { conversation: OverseerRecord | null };
    expect(current.conversation?.id).toBe(record.id);

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

// The open gates a deciding human is asked, as the desktop reads them.
async function openGates(): Promise<Message[]> {
  return (
    (await json(await fetch(`${baseUrl}/api/decisions/open`))) as {
      items: Message[];
    }
  ).items;
}

// Answers a gate as the app token's human, the way the desktop does.
async function answerGate(id: string, choice: string): Promise<Response> {
  return fetch(`${baseUrl}/api/messages/${id}/reply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: '', choice }),
  });
}

function gateType(message: Message): string | undefined {
  return (message.data as { type?: string } | undefined)?.type;
}

describe('overseer action gates', () => {
  // Creates the task before the daemon boots (it reads task files at startup)
  // and scripts a single turn that queues dispatching it.
  async function startWithQueuedDispatch(): Promise<{
    ready: OverseerRecord;
    gate: Message;
  }> {
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
    const gate = (await openGates()).find(
      (m) => gateType(m) === 'overseer-action'
    );
    if (gate === undefined) throw new Error('no overseer-action gate');
    expect(gate.data).toMatchObject({
      conversation: ready.id,
      actionId: ready.pendingActions[0].id,
    });
    return { ready, gate };
  }

  async function listRuns(): Promise<
    { taskId: string; operator?: string | null }[]
  > {
    return (await json(await fetch(`${baseUrl}/api/runs`))) as {
      taskId: string;
      operator?: string | null;
    }[];
  }

  it('confirm applies the action and dispatches the run', async () => {
    const { ready, gate } = await startWithQueuedDispatch();

    expect((await answerGate(gate.id, 'confirm')).status).toBe(201);

    const confirmed = await getRecord(ready.id);
    expect(confirmed.pendingActions).toHaveLength(0);
    expect(confirmed.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'action',
        actionId: ready.pendingActions[0].id,
        outcome: 'applied',
      })
    );
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    // Confirmed with the app token, the run acts for the owner.
    expect(runs[0].operator).toBe('human:test');
    expect(await openGates()).toEqual([]);
  });

  it("a teammate's confirm dispatches a run that acts for the teammate", async () => {
    const { gate } = await startWithQueuedDispatch();
    const ada = handle.team.teammates.issue('ada', 'decide');
    const res = await fetch(`${baseUrl}/api/messages/${gate.id}/reply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${ada}`,
      },
      body: JSON.stringify({ body: '', choice: 'confirm' }),
    });
    expect(res.status).toBe(201);
    const runs = await listRuns();
    expect(runs).toHaveLength(1);
    expect(runs[0].operator).toBe('human:ada');
  });

  it('cancel records the refusal and dispatches nothing', async () => {
    const { ready, gate } = await startWithQueuedDispatch();

    expect((await answerGate(gate.id, 'cancel')).status).toBe(201);

    const denied = await getRecord(ready.id);
    expect(denied.pendingActions).toHaveLength(0);
    expect(denied.messages.at(-1)).toEqual(
      expect.objectContaining({
        role: 'action',
        actionId: ready.pendingActions[0].id,
        outcome: 'denied',
      })
    );
    expect(await listRuns()).toHaveLength(0);
  });

  it('refuses an answer from the shared agent token', async () => {
    const { gate } = await startWithQueuedDispatch();
    const res = await fetch(`${baseUrl}/api/messages/${gate.id}/reply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${handle.tokens.agentToken}`,
      },
      body: JSON.stringify({ body: '', choice: 'confirm' }),
    });
    expect(res.status).toBe(403);
    expect(await listRuns()).toHaveLength(0);
  });
});

// A backend standing in for a full Claude Code session that wants to run one
// built-in tool: it asks the daemon through `authorizeTool` and replies with
// what it was told, so the gate's effect is readable off the transcript.
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

describe('overseer memory tools', () => {
  it('searches memory as the owner’s overseer, and ledger_entries lists only receipts', async () => {
    const backend = new FakeOverseer({
      ok: true,
      calls: [
        { tool: 'memory_search', input: { query: 'pnpm' } },
        { tool: 'ledger_entries' },
      ],
    });
    await startWithOverseer(backend);
    seedLedger(
      root,
      {
        kind: 'hazard',
        title: 'pnpm 11 ignores onlyBuiltDependencies',
        detail: 'use allowBuilds',
        authoredBy: 'human:test',
      },
      BEFORE_CUTOVER
    );
    importAtCutover(handle.memory);

    const { record } = await startConversation('what do we know about pnpm?');
    await settled(record.id);
    const [search, ledger] = backend.observations;
    expect(search.result.isError).toBe(false);
    expect(search.result.content).toMatchObject({
      hits: [
        expect.objectContaining({
          title: 'pnpm 11 ignores onlyBuiltDependencies',
        }),
      ],
    });
    expect(ledger.result.content).toMatchObject({ entries: [], total: 0 });
  });

  // Request-tier callers read overseer transcripts, so no turn carries the
  // owner's personal memory, even with the export on and the import complete.
  it('writes no export for an overseer turn, whatever the Claude setting', async () => {
    const seen: OverseerTurnOptions[] = [];
    const backend: OverseerBackend = {
      start: (_prompt, _toolset, options = {}) => {
        seen.push(options);
        return Promise.resolve({ reply: 'noted', sessionId: 's-o' });
      },
      sendMessage: () => Promise.resolve({ reply: 'ok' }),
    };
    updateConfig(root, { memory: { claudeAutoMemory: 'export' } });
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerOverseers: (overseerManager) => {
        overseerManager.registerBackend('claude', backend);
      },
      memoryPreflight: () => Promise.resolve({ ok: true, version: '2.1.210' }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    handle.memory.personal
      .personal('self')
      .setMeta(`claude-import:${projectKeyOf(root)}`, 'complete');
    await handle.memory.refreshPreflight();

    const { record } = await startConversation('remember the queue order');
    await settled(record.id);
    expect(seen).toHaveLength(1);
    expect(existsSync(claudeMemoryDir(root, `o-${record.id}`))).toBe(false);
  });
});

describe('overseer tool-approval gates', () => {
  // Opens a conversation against the gated backend and returns the record and
  // its gate once the built-in call is parked.
  async function startParked(): Promise<{
    backend: GatedOverseer;
    record: OverseerRecord;
    gate: Message;
  }> {
    const backend = new GatedOverseer();
    await startWithOverseer(backend);
    const { record } = await startConversation('is the tree clean?');
    await waitFor(async () =>
      (await openGates()).some((m) => gateType(m) === 'tool-approval')
    );
    const gate = (await openGates()).find(
      (m) => gateType(m) === 'tool-approval'
    );
    if (gate === undefined) throw new Error('no tool-approval gate');
    return { backend, record: await getRecord(record.id), gate };
  }

  it('parks the built-in call on the running record and asks through a gate', async () => {
    const { record, gate } = await startParked();
    expect(record.state).toBe('running');
    expect(record.pendingApprovals).toEqual([
      expect.objectContaining({
        requestId: 'req-1',
        toolName: 'Bash',
        summary: 'Bash: git status',
      }),
    ]);
    expect(gate.data).toEqual({
      type: 'tool-approval',
      requestId: 'req-1',
      conversation: record.id,
      tool: 'Bash',
      input: { command: 'git status' },
      floor: false,
    });
    expect(gate.choices).toEqual(['approve', 'approve-session', 'deny']);
    await answerGate(gate.id, 'deny');
    await settled(record.id);
  });

  it('approve-session runs the call and the turn settles on its result', async () => {
    const { backend, record, gate } = await startParked();

    expect((await answerGate(gate.id, 'approve-session')).status).toBe(201);

    const ready = await settled(record.id);
    expect(backend.decided).toEqual({ allow: true, scope: 'session' });
    expect(ready.pendingApprovals).toEqual([]);
    expect(ready.messages.at(-1)).toEqual(
      expect.objectContaining({ role: 'assistant', text: 'clean tree' })
    );
  });

  it('deny hands the reason to the session and nothing runs', async () => {
    const { backend, record, gate } = await startParked();

    const res = await fetch(`${baseUrl}/api/messages/${gate.id}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'not now', choice: 'deny' }),
    });
    expect(res.status).toBe(201);

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
});

describe('overseer lines on the bus', () => {
  interface ThreadSummary {
    thread: string;
    root: Message;
    count: number;
  }

  async function threads(): Promise<ThreadSummary[]> {
    return (
      (await json(await fetch(`${baseUrl}/api/threads`))) as {
        threads: ThreadSummary[];
      }
    ).threads;
  }

  it('a turn from the app token is a thread opened by the owner', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'all quiet' }));
    const { ref } = (await json(await fetch(`${baseUrl}/api/whoami`))) as {
      ref: string;
    };

    const { record } = await startConversation('what is running?');
    await settled(record.id);
    await waitFor(async () =>
      (await getRecord(record.id)).messages.every(
        (m) => m.messageId !== undefined
      )
    );
    const { thread } = await getRecord(record.id);

    const opened = (await threads()).find((t) => t.thread === thread);
    expect(opened?.root).toMatchObject({
      from: ref,
      body: 'what is running?',
    });
    // The overseer's reply lands in the same thread, from its own agent.
    const { messages } = (await json(
      await fetch(`${baseUrl}/api/threads/${thread}`)
    )) as { messages: Message[] };
    expect(messages.map((m) => [m.from, m.to, m.body])).toEqual([
      [
        ref,
        [`agent:${ref.slice('human:'.length)}/overseer`],
        'what is running?',
      ],
      [`agent:${ref.slice('human:'.length)}/overseer`, [ref], 'all quiet'],
    ]);
  });

  it("the shared agent token is refused: the overseer is a human's", async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'all quiet' }));

    const res = await fetch(`${baseUrl}/api/overseer`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${handle.tokens.agentToken}`,
      },
      body: JSON.stringify({ prompt: 'what is running?' }),
    });
    expect(res.status).toBe(403);
    expect(((await json(res)) as { code: string }).code).toBe(
      'auth_agent_token'
    );
    expect(await threads()).toEqual([]);
  });
});

describe("the overseer's name", () => {
  it('cannot be registered by another agent while the overseer holds it', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'all quiet' }));
    const register = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${handle.tokens.agentToken}`,
      },
      body: JSON.stringify({ name: 'overseer', client: 'probe' }),
    });
    expect(register.status).toBe(409);
    const { error } = (await json(register)) as { error: string };
    expect(error).toEndWith(
      "is Dispatch's own agent; register under another name"
    );
  });
});

describe('a revoked overseer', () => {
  it('stays off: registering its name again with the agent token is refused', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'all quiet' }));
    const { ref } = (await json(await fetch(`${baseUrl}/api/whoami`))) as {
      ref: string;
    };
    const overseer = `agent:${ref.slice('human:'.length)}/overseer`;
    const revoked = await fetch(
      `${baseUrl}/api/agents/${encodeURIComponent(overseer)}/revoke`,
      { method: 'POST' }
    );
    expect(revoked.status).toBe(200);

    const register = await fetch(`${baseUrl}/api/agents/register`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${handle.tokens.agentToken}`,
      },
      body: JSON.stringify({ name: 'overseer', client: 'probe' }),
    });
    expect(register.status).toBe(409);

    const refused = await startConversation();
    expect(refused.res.status).toBe(409);
    expect((refused.record as unknown as { code?: string }).code).toBe(
      'overseer_revoked'
    );
    const { agents } = (await json(
      await fetch(`${baseUrl}/api/agents/roster`)
    )) as { agents: { address: string; status: string }[] };
    expect(agents.find((a) => a.address === overseer)?.status).toBe('revoked');
    expect(
      (await openGates()).filter((m) => gateType(m) === 'agent-registration')
    ).toEqual([]);
  });

  it('comes back on when a human approves its revoked row', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'all quiet' }));
    const { ref } = (await json(await fetch(`${baseUrl}/api/whoami`))) as {
      ref: string;
    };
    const overseer = encodeURIComponent(
      `agent:${ref.slice('human:'.length)}/overseer`
    );
    await fetch(`${baseUrl}/api/agents/${overseer}/revoke`, { method: 'POST' });
    const approved = await fetch(`${baseUrl}/api/agents/${overseer}/approve`, {
      method: 'POST',
    });
    expect(approved.status).toBe(200);
    expect((await startConversation()).res.status).toBe(202);
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

describe('who an overseer conversation belongs to', () => {
  // A teammate's own decide-tier token, issued through the team route.
  async function teammate(): Promise<string> {
    const res = await fetch(`${baseUrl}/api/team/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'priya@example.com', tier: 'decide' }),
    });
    return ((await json(res)) as { token: string }).token;
  }

  it('records its owner, who reads it; a teammate cannot read or speak in it', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'all quiet' }));
    const { record } = await startConversation();
    expect(record.owner).toBeDefined();

    const token = await teammate();
    const read = await rawFetch(`${baseUrl}/api/overseer/${record.id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(read.status).toBe(404);
    const speak = await rawFetch(
      `${baseUrl}/api/overseer/${record.id}/message`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ text: 'hi' }),
      }
    );
    expect(speak.status).toBe(404);

    // The operator (the app token) still reads it.
    expect((await fetch(`${baseUrl}/api/overseer/${record.id}`)).status).toBe(
      200
    );
  });

  it('lists and revokes its grants', async () => {
    await startWithOverseer(new FakeOverseer({ ok: true, reply: 'all quiet' }));
    const { record } = await startConversation();
    const grants = await fetch(`${baseUrl}/api/overseer/${record.id}/grants`);
    expect(await json(grants)).toEqual({ grants: [] });
    const revoked = await fetch(
      `${baseUrl}/api/overseer/${record.id}/grants/${encodeURIComponent('Bash:moonx')}`,
      { method: 'DELETE' }
    );
    expect(await json(revoked)).toEqual({ revoked: false });
  });
});
