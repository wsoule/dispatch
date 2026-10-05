import { gateOf } from '@dispatch-foo/protocol';
import { createMemoryIds, insertFresh, newMemoryEntry } from '@dispatch/memory';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiContext } from '../../src/api.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { importClaudeRoute } from '../../src/memory/routes.js';
import { SYSTEM_SENDER } from '../../src/messaging/gates.js';
import { FakeOverseer } from '../../src/orchestrator/overseers/fake.js';
import { approvedClient, useSeedBase } from '../a2a/seed.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth, wsUrl } from '../testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function authHeaders(token: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    authorization: `Bearer ${token}`,
  };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeoutMs = 3000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('waitFor timed out');
}

// Runs use a StallingExecutor, so a dispatched run stays live; the app token
// dispatches them, so each acts for the owner (human:test, from initGitRepo).
let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
let executor: StallingExecutor;
const originalHome = process.env.DISPATCH_HOME;
// The memory id every overseer turn reads, after searching all memory.
let overseerReads = '';
const overseer = new FakeOverseer({
  ok: true,
  calls: [
    { tool: 'memory_search', input: { query: '' } },
    { tool: 'memory_read', input: () => ({ id: overseerReads }) },
  ],
});

function boot(): Promise<ServerHandle> {
  return startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', executor);
    },
    registerOverseers: (overseers) => {
      overseers.registerBackend('claude', overseer);
    },
  });
}

// A daemon restart on the same root and DISPATCH_HOME.
async function restart(): Promise<void> {
  await handle.stop();
  handle = await boot();
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
}

beforeEach(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(initGitRepo('dispatch-memory-v1-'));
  executor = new StallingExecutor();
  handle = await boot();
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Creates a task (with `taskFields`, such as `risk`) and dispatches it with
// the app token, waiting until its run is `running` and its token is minted.
async function liveRun(
  title: string,
  taskFields: Record<string, unknown> = {}
): Promise<{ runId: string; taskId: string }> {
  const task = await json<{ meta: { id: string } }>(
    await fetch(`${base}/api/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, ...taskFields }),
    })
  );
  return { runId: await dispatchLive(task.meta.id), taskId: task.meta.id };
}

// Dispatches an existing task with the app token and waits until its run is `running`.
async function dispatchLive(taskId: string): Promise<string> {
  const meta = await json<{ id: string }>(
    await fetch(`${base}/api/tasks/${taskId}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'claude' }),
    })
  );
  await waitFor(async () => {
    const r = await json<{ meta: { state: string } }>(
      await fetch(`${base}/api/runs/${meta.id}`)
    );
    return r.meta.state === 'running';
  });
  return meta.id;
}

// A client's handoff the owner approved: a task with a2a.db and messages.db evidence.
async function handedOffTask(title: string): Promise<string> {
  useSeedBase(base);
  const { caller } = await approvedClient(`c${Date.now()}`);
  const opened = await handle.a2a.port!.open(caller, {
    clientMessageId: `m-${title}`,
    contextId: null,
    kind: 'handoff',
    to: null,
    replyTo: null,
    body: 'Please do it.',
    refs: [],
    work: { skill: 'handoff', title },
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const row = handle.a2a.store!.getTask(opened.taskId)!;
  await handle.messaging.engine.reply(
    row.gate!,
    { body: '', choice: 'approve' },
    { address: handle.a2a.port!.deps.ownerRef, canDecide: true }
  );
  return row.dispatchTask!;
}

function runToken(): string {
  const token = executor.lastRunToken;
  if (token === undefined) throw new Error('no run token minted');
  return token;
}

// A webhook receiver, configured as the project's notifications webhook.
async function webhook(): Promise<{ hooks: string[]; stop(): void }> {
  const hooks: string[] = [];
  const hook = Bun.serve({
    port: 0,
    fetch: async (req) => {
      hooks.push(await req.text());
      return new Response('ok');
    },
  });
  await fetch(`${base}/api/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      notifications: { webhook: `http://127.0.0.1:${hook.port}/hook` },
    }),
  });
  return { hooks, stop: () => void hook.stop(true) };
}

describe('personal privacy', () => {
  it('a run saves to its operator; a decide-tier teammate sees none of it', async () => {
    const run = await liveRun('personal save');
    const token = runToken();
    const saved = await json<{ status: string; id: string }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({
          scope: 'personal',
          kind: 'fact',
          title: 'SECRET-PERSONAL-title',
          body: 'b',
        }),
      })
    );
    expect(saved.status).toBe('active');
    const ada = handle.team.teammates.issue('ada', 'decide');
    const adaList = await json<{ entries: { id: string }[] }>(
      await rawFetch(`${base}/api/memory`, { headers: authHeaders(ada) })
    );
    expect(adaList.entries.map((e) => e.id)).not.toContain(saved.id);
    expect(
      (
        await rawFetch(`${base}/api/memory/${saved.id}`, {
          headers: authHeaders(ada),
        })
      ).status
    ).toBe(403);
    expect((await fetch(`${base}/api/memory/${saved.id}`)).status).toBe(200);
    expect(
      (
        await json<{ activity: unknown[] }>(
          await rawFetch(`${base}/api/memory/activity`, {
            headers: authHeaders(ada),
          })
        )
      ).activity
    ).toEqual([]);
    const own = await json<{ activity: { summary: string }[] }>(
      await fetch(`${base}/api/memory/activity`)
    );
    expect(own.activity[0].summary).toContain('SECRET-PERSONAL-title');
    // A read recall, kept in the personal store.
    await rawFetch(`${base}/api/memory/${saved.id}`, {
      headers: authHeaders(token),
    });
    const hidden = await json<{ recalls: unknown[]; personalHidden: number }>(
      await rawFetch(`${base}/api/memory/recalls?runId=${run.runId}`, {
        headers: authHeaders(ada),
      })
    );
    expect(hidden.personalHidden).toBe(1);
    expect(JSON.stringify(hidden)).not.toContain(saved.id);
    const mine = await json<{
      recalls: { memoryId: string }[];
      personalHidden: number;
    }>(await fetch(`${base}/api/memory/recalls?runId=${run.runId}`));
    expect(mine.personalHidden).toBe(0);
    expect(mine.recalls.map((r) => r.memoryId)).toContain(saved.id);
  });

  it('never puts a personal title, handle or id on the WebSocket', async () => {
    const frames: string[] = [];
    const ws = new WebSocket(wsUrl(handle));
    ws.onmessage = (e) => frames.push(String(e.data));
    await new Promise((resolve) => (ws.onopen = resolve));
    await liveRun('ws check');
    const saved = await json<{ id: string; handle: string }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(runToken()),
        body: JSON.stringify({
          scope: 'personal',
          kind: 'fact',
          title: 'SECRET-WS-title',
          body: 'b',
        }),
      })
    );
    await waitFor(() => frames.some((f) => f.includes('"memory.changed"')));
    ws.close();
    const all = frames.join('\n');
    expect(all).toContain('{"type":"memory.changed","scope":"personal"}');
    for (const secret of ['SECRET-WS-title', saved.id, saved.handle])
      expect(all).not.toContain(secret);
  });

  // A run's rebuilt index, as a decide-tier non-operator, and the feed and
  // webhook after a personal save.
  it('a personal entry reaches no other human’s rebuilt index, no feed item and no webhook', async () => {
    const hook = await webhook();
    const personal = await json<{ id: string; handle: string }>(
      await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'personal',
          kind: 'fact',
          title: 'SECRET-INDEX-title',
          body: 'b',
        }),
      })
    );
    // Acts for the owner, so its index carries the entry.
    const run = await liveRun('index check');
    const ada = handle.team.teammates.issue('ada', 'decide');
    const asAda = await json<{ text: string | null; included: string[] }>(
      await rawFetch(`${base}/api/memory/index?runId=${run.runId}`, {
        headers: authHeaders(ada),
      })
    );
    expect(asAda.text).toContain('(1 personal lines hidden)');
    expect(asAda.included).not.toContain(personal.handle);
    expect(JSON.stringify(asAda)).not.toContain('SECRET-INDEX-title');
    const asOwner = await json<{ text: string }>(
      await fetch(`${base}/api/memory/index?runId=${run.runId}`)
    );
    expect(asOwner.text).toContain('SECRET-INDEX-title');
    const feed = await (await fetch(`${base}/api/decisions`)).text();
    // A negative: nothing should be sent, so wait out the webhook's delivery window once.
    await new Promise((resolve) => setTimeout(resolve, 200));
    for (const text of [feed, ...hook.hooks]) {
      expect(text).not.toContain('SECRET-INDEX-title');
      expect(text).not.toContain(personal.id);
      expect(text).not.toContain(personal.handle);
    }
    hook.stop();
  });

  // Every request-tier caller can start an overseer conversation and read its transcript.
  it('an overseer conversation never carries a personal entry, whoever starts it', async () => {
    const personal = await json<{ id: string; handle: string }>(
      await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'personal',
          kind: 'fact',
          title: 'SECRET-OVERSEER-title',
          body: 'SECRET-OVERSEER-body',
        }),
      })
    );
    await fetch(`${base}/api/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        kind: 'convention',
        title: 'overseer-visible convention',
        body: 'b',
      }),
    });
    overseerReads = personal.id;
    const ada = handle.team.teammates.issue('ada', 'decide');
    for (const token of [null, ada, handle.tokens.agentToken]) {
      const headers =
        token === null
          ? { 'content-type': 'application/json' }
          : authHeaders(token);
      const started = await json<{ id: string }>(
        await fetch(`${base}/api/overseer`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ prompt: 'what do you remember?' }),
        })
      );
      let transcript = '';
      await waitFor(async () => {
        transcript = await (
          await fetch(`${base}/api/overseer/${started.id}`, { headers })
        ).text();
        return (
          (JSON.parse(transcript) as { state: string }).state !== 'running'
        );
      });
      expect(transcript).toContain('overseer-visible convention');
      for (const secret of [
        'SECRET-OVERSEER-title',
        'SECRET-OVERSEER-body',
        personal.handle,
      ])
        expect(transcript).not.toContain(secret);
    }
  });

  // Owner-ness belongs to the daemon's own app token, never to a handle.
  it('only the owner’s own credential holds the owner’s personal memory and the Claude import', async () => {
    const secret = await json<{ id: string }>(
      await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'personal',
          kind: 'fact',
          title: 'OWNER-SECRET',
          body: 'b',
        }),
      })
    );
    const ada = handle.team.teammates.issue('ada', 'decide');
    const minted = await rawFetch(`${base}/api/team/tokens`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify({ handle: 'test', tier: 'request' }),
    });
    expect(minted.status).toBe(400);
    const own = await fetch(`${base}/api/team/tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handle: 'test', tier: 'request' }),
    });
    expect(own.status).toBe(400);
    // A token minted for the owner's handle before this refusal speaks for no one.
    const stolen = handle.team.teammates.issue('test', 'request');
    const listed = await rawFetch(`${base}/api/memory?scope=personal`, {
      headers: authHeaders(stolen),
    });
    expect(listed.status).toBe(401);
    // Even named as the owner, a principal without the owner's credential gets nothing personal.
    const impostor = {
      address: 'human:test',
      canDecide: true,
      kind: 'human',
    } as const;
    expect(handle.memory.host.operatorOf(impostor)?.identity).not.toBe('self');
    expect(
      handle.memory
        .engine!.list(impostor, { scope: 'personal' })
        .map((e) => e.id)
    ).not.toContain(secret.id);
    expect(handle.memory.health(impostor).claudeImport).toBeNull();
    const ctx = {
      principal: impostor,
      actorContext: { humanRef: 'human:test' },
      memory: handle.memory,
    } as unknown as ApiContext;
    await expect(
      importClaudeRoute(ctx, new URL(`${base}/api/memory/import/claude?none=1`))
    ).rejects.toThrow("only the daemon's own human");
    const mine = await json<{ entries: { id: string }[] }>(
      await fetch(`${base}/api/memory?scope=personal`)
    );
    expect(mine.entries.map((e) => e.id)).toContain(secret.id);
  });

  // origin and cause belong to the importer, amendments and ingest.
  it('refuses a client-supplied origin or cause, naming the field', async () => {
    for (const [field, value] of [
      ['origin', 'ledger:l-abcdef@2026-01-01T00:00:00.000Z'],
      ['cause', 'ingest'],
    ] as const) {
      const res = await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title: 'spoofed',
          body: 'b',
          [field]: value,
        }),
      });
      expect(res.status).toBe(400);
      expect((await json<{ field: string }>(res)).field).toBe(field);
    }
    expect(
      handle.memory.shared!.proposalByOrigin(
        'ledger:l-abcdef@2026-01-01T00:00:00.000Z'
      )
    ).toBeNull();
  });
});

// The booted daemon decides A2A provenance the way docs does: from handoff
// evidence, never the a2a label alone.
describe('re-homing (D33)', () => {
  it('a decide-tier teammate re-homes only their own entries; the agentToken gets 403', async () => {
    const OTHER = 'bbbbbbbbbbbb';
    // The owner's entry, narrowed to another checkout.
    insertFresh(
      handle.memory.stores.personal('self'),
      createMemoryIds(),
      Date.now(),
      (id) =>
        newMemoryEntry(
          {
            scope: 'personal',
            kind: 'fact',
            title: 'the owner’s old checkout',
            body: 'b',
            author: 'human:test',
            trust: 'human',
            projectKey: OTHER,
          },
          id,
          new Date().toISOString()
        ),
      'human:test',
      'save'
    );
    const ada = handle.team.teammates.issue('ada', 'decide');
    const saved = await json<{ id: string }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(ada),
        body: JSON.stringify({
          scope: 'personal',
          kind: 'fact',
          title: 'ada’s old checkout',
          body: 'b',
          projectOnly: true,
        }),
      })
    );
    const identity = handle.memory.host.operatorOf({
      address: 'human:ada',
      canDecide: true,
      kind: 'human',
    })?.identity;
    const adaStore = handle.memory.stores.personal(identity ?? '');
    const entry = adaStore.getEntry(saved.id);
    if (entry === null) throw new Error('ada’s entry was not saved');
    adaStore.updateEntry(
      { ...entry, projectKey: OTHER, rev: entry.rev + 1 },
      'human:ada',
      'edit'
    );
    const keys = await json<{ current: string; others: unknown[] }>(
      await rawFetch(`${base}/api/memory/rehome`, { headers: authHeaders(ada) })
    );
    expect(keys.others).toEqual([{ key: OTHER, count: 1 }]);
    const moved = await rawFetch(`${base}/api/memory/rehome`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify({ from: OTHER }),
    });
    expect(await json<unknown>(moved)).toEqual({ moved: 1 });
    expect(adaStore.getEntry(saved.id)?.projectKey).toBe(keys.current);
    expect(handle.memory.stores.personal('self').projectKeyCounts()).toEqual([
      { key: OTHER, count: 1 },
    ]);
    const agent = await rawFetch(`${base}/api/memory/rehome`, {
      method: 'POST',
      headers: authHeaders(handle.tokens.agentToken),
      body: JSON.stringify({ from: OTHER }),
    });
    expect(agent.status).toBe(403);
  });
});

describe('A2A provenance', () => {
  it('a run of a handed-off task acts for no one and lists no project memory', async () => {
    await fetch(`${base}/api/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        kind: 'convention',
        title: 'PROJECT-ONLY convention',
        body: 'b',
      }),
    });
    const titlesFor = async (token: string): Promise<string[]> =>
      (
        await json<{ entries: { title: string }[] }>(
          await rawFetch(`${base}/api/memory`, { headers: authHeaders(token) })
        )
      ).entries.map((e) => e.title);
    const operatorOf = async (runId: string): Promise<string | null> =>
      (
        await json<{ meta: { operator?: string | null } }>(
          await fetch(`${base}/api/runs/${runId}`)
        )
      ).meta.operator ?? null;

    const plain = await liveRun('ordinary task');
    expect(await titlesFor(runToken())).toContain('PROJECT-ONLY convention');
    expect(await operatorOf(plain.runId)).toBe('human:test');

    await liveRun('labelled only', { labels: ['a2a'] });
    expect(await titlesFor(runToken())).toContain('PROJECT-ONLY convention');

    const asked = await dispatchLive(await handedOffTask('asked over A2A'));
    expect(await titlesFor(runToken())).not.toContain(
      'PROJECT-ONLY convention'
    );
    expect(await operatorOf(asked)).toBeNull();
  });

  it('a review run of a handed-off task lists no project memory either', async () => {
    await fetch(`${base}/api/memory`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        scope: 'project',
        kind: 'convention',
        title: 'PROJECT-ONLY convention',
        body: 'b',
      }),
    });
    // Starts a review run on a fresh task and lists memory with its token.
    const reviewTitles = async (taskId: string): Promise<string[]> => {
      await handle.orchestrator.dispatchAuxRun({
        taskId,
        kind: 'review',
        head: 'main',
        executor: 'claude',
        buildPrompt: () => 'review this',
        operator: null,
      });
      return (
        await json<{ entries: { title: string }[] }>(
          await rawFetch(`${base}/api/memory`, {
            headers: authHeaders(runToken()),
          })
        )
      ).entries.map((e) => e.title);
    };

    const plain = await json<{ meta: { id: string } }>(
      await fetch(`${base}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'reviewed' }),
      })
    );
    expect(await reviewTitles(plain.meta.id)).toContain(
      'PROJECT-ONLY convention'
    );
    expect(await reviewTitles(await handedOffTask('reviewed'))).not.toContain(
      'PROJECT-ONLY convention'
    );
  });
});

describe('owner-attributed agents', () => {
  // The owner's personal secret, and an agent the shared agentToken registered
  // (so agent:test/<name>, attributed to the owner) still awaiting approval.
  async function setup(
    name: string
  ): Promise<{ secret: string; address: string; token: string }> {
    const saved = await json<{ id: string }>(
      await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'personal',
          kind: 'fact',
          title: 'OWNER-SECRET',
          body: 'b',
        }),
      })
    );
    const reg = await rawFetch(`${base}/api/agents/register`, {
      method: 'POST',
      headers: authHeaders(handle.tokens.agentToken),
      body: JSON.stringify({ name, client: 'curl' }),
    });
    expect(reg.status).toBe(201);
    const body = await json<{ address: string; token: string }>(reg);
    expect(body.address).toBe(`agent:test/${name}`);
    return { secret: saved.id, address: body.address, token: body.token };
  }

  function approveAs(address: string, token: string): Promise<Response> {
    return rawFetch(
      `${base}/api/agents/${encodeURIComponent(address)}/approve`,
      { method: 'POST', headers: authHeaders(token) }
    );
  }

  function registrationGate(address: string): string {
    const gate = handle.messaging.engine.openBlocking().find((m) => {
      const data = gateOf(m);
      return data?.type === 'agent-registration' && data.agent === address;
    });
    if (gate === undefined) throw new Error(`no gate for ${address}`);
    return gate.id;
  }

  // The ids the agent's own token lists in personal scope, or the status
  // that refused it.
  async function personalIds(token: string): Promise<string[] | number> {
    const res = await rawFetch(`${base}/api/memory?scope=personal`, {
      headers: authHeaders(token),
    });
    if (res.status !== 200) return res.status;
    return (await json<{ entries: { id: string }[] }>(res)).entries.map(
      (e) => e.id
    );
  }

  it("a teammate's approval opens none of the owner's personal memory", async () => {
    const { secret, address, token } = await setup('evil');
    const ada = handle.team.teammates.issue('ada', 'decide');
    expect((await approveAs(address, ada)).status).toBe(200);
    expect(await personalIds(token)).toEqual([]);
    const del = await rawFetch(`${base}/api/memory/${secret}`, {
      method: 'DELETE',
      headers: authHeaders(token),
    });
    expect(del.status).not.toBe(200);
    const read = await rawFetch(`${base}/api/memory/${secret}`, {
      headers: authHeaders(token),
    });
    expect(read.status).not.toBe(200);
    expect(
      handle.memory.host.operatorOf({
        address,
        canDecide: false,
        kind: 'agent',
      })?.identity
    ).toBe('!not-owner');
    const owner = await json<{ entries: { id: string }[] }>(
      await fetch(`${base}/api/memory?scope=personal`)
    );
    expect(owner.entries.map((e) => e.id)).toContain(secret);
  });

  it('a teammate answering the registration gate opens none of it', async () => {
    const { address, token } = await setup('evil2');
    const ada = handle.team.teammates.issue('ada', 'decide');
    const reply = await rawFetch(
      `${base}/api/messages/${registrationGate(address)}/reply`,
      {
        method: 'POST',
        headers: authHeaders(ada),
        body: JSON.stringify({ body: '', choice: 'approve' }),
      }
    );
    expect(reply.status).toBe(201);
    expect(handle.messaging.store.getAgent(address)?.status).toBe('approved');
    expect(await personalIds(token)).toEqual([]);
  });

  it('the owner approving with the app token opens it', async () => {
    const { secret, address, token } = await setup('mine');
    expect((await approveAs(address, handle.tokens.appToken)).status).toBe(200);
    expect(await personalIds(token)).toContain(secret);
  });

  it('the owner answering the registration gate with the app token opens it', async () => {
    const { secret, address, token } = await setup('mine2');
    const reply = await fetch(
      `${base}/api/messages/${registrationGate(address)}/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '', choice: 'approve' }),
      }
    );
    expect(reply.status).toBe(201);
    expect(await personalIds(token)).toContain(secret);
  });

  it('only an approving answer to the registration gate records an owner approval', async () => {
    const decided: [string, boolean][] = [];
    const host = handle.memory.host;
    const original = host.agentDecided.bind(host);
    host.agentDecided = (address, ownerCredential) => {
      decided.push([address, ownerCredential]);
      original(address, ownerCredential);
    };
    const denied = await setup('denied');
    const approved = await setup('approved');
    for (const [agent, choice] of [
      [denied, 'deny'],
      [approved, 'approve'],
    ] as const) {
      const reply = await fetch(
        `${base}/api/messages/${registrationGate(agent.address)}/reply`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: '', choice }),
        }
      );
      expect(reply.status).toBe(201);
    }
    expect(decided).toEqual([[approved.address, true]]);
  });

  it("a teammate's re-approval after a revoke drops the owner's approval", async () => {
    const { secret, address, token } = await setup('again');
    await approveAs(address, handle.tokens.appToken);
    expect(await personalIds(token)).toContain(secret);
    const ada = handle.team.teammates.issue('ada', 'decide');
    const revoked = await rawFetch(
      `${base}/api/agents/${encodeURIComponent(address)}/revoke`,
      { method: 'POST', headers: authHeaders(ada) }
    );
    expect(revoked.status).toBe(200);
    expect((await approveAs(address, ada)).status).toBe(200);
    expect(await personalIds(token)).toEqual([]);
  });

  it("the owner's approval survives a restart", async () => {
    const { secret, address, token } = await setup('kept');
    await approveAs(address, handle.tokens.appToken);
    await restart();
    expect(await personalIds(token)).toContain(secret);
  });
});

describe('the memory gate', () => {
  it('a run’s team proposal raises a content-free gate; the feed and webhook never carry its title', async () => {
    const hook = await webhook();
    await liveRun('proposer');
    const proposed = await json<{
      status: string;
      proposal: string;
      gate: string;
    }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(runToken()),
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title: 'SECRET-TEAM-title',
          body: 'detail',
        }),
      })
    );
    expect(proposed.status).toBe('proposed');
    const open = await json<{
      items: { id: string; body: string; data: { type: string } }[];
    }>(await fetch(`${base}/api/decisions/open`));
    const gate = open.items.find((m) => m.id === proposed.gate)!;
    expect(gate.data.type).toBe('memory');
    expect(gate.body).toMatch(
      /^run:r-[0-9a-f]+ proposes a team memory \(hazard\)\. Review it in Needs you\.$/
    );
    const feed = await (await fetch(`${base}/api/decisions`)).text();
    await waitFor(() => hook.hooks.length > 0);
    for (const text of [feed, ...hook.hooks, JSON.stringify(open)])
      expect(text).not.toContain('SECRET-TEAM-title');
    const card = await json<{ proposal: { content: { title: string } } }>(
      await fetch(`${base}/api/memory/proposals/${proposed.proposal}`)
    );
    expect(card.proposal.content.title).toBe('SECRET-TEAM-title');
    const listed = await json<{ proposals: { id: string }[] }>(
      await fetch(`${base}/api/memory/proposals?state=open`)
    );
    expect(listed.proposals.map((p) => p.id)).toEqual([proposed.proposal]);
    hook.stop();
  });

  it('approving in the gate makes a confirmed team entry every principal can read', async () => {
    await liveRun('approve me');
    const p = await json<{ proposal: string; gate: string }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(runToken()),
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title: 'flaky server tests',
          body: 'chunks',
        }),
      })
    );
    await fetch(`${base}/api/messages/${p.gate}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '', choice: 'approve' }),
    });
    const ada = handle.team.teammates.issue('ada', 'request');
    const entries = await json<{ entries: { title: string; trust: string }[] }>(
      await rawFetch(`${base}/api/memory`, { headers: authHeaders(ada) })
    );
    expect(entries.entries).toContainEqual(
      expect.objectContaining({
        title: 'flaky server tests',
        trust: 'confirmed',
      })
    );
  });

  it('at rung 4 a routine task’s proposal applies with no gate and a content-free receipt', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'policy:\n  rung: 4\n'
    );
    const run = await liveRun('auto');
    const out = await json<{ status: string; handle: string }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(runToken()),
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title: 'SECRET-AUTO-title',
          body: 'd',
        }),
      })
    );
    expect(out.status).toBe('active');
    const ledger = await json<{ title: string; detail: string }[]>(
      await fetch(`${base}/api/ledger`)
    );
    const receipt = ledger.find((l) => l.title.startsWith('Memory approved'))!;
    expect(receipt.title).toBe(`Memory approved: team hazard ${out.handle}`);
    expect(receipt.detail).toContain(
      'auto-decided by policy rung 4 (memory gate)'
    );
    expect(JSON.stringify(ledger)).not.toContain('SECRET-AUTO-title');
    const task = await json<{ body: string }>(
      await fetch(`${base}/api/tasks/${run.taskId}`)
    );
    expect(task.body).toContain(
      `[policy] Memory approved: team hazard ${out.handle}`
    );
    expect(task.body).not.toContain('SECRET-AUTO-title');
  });

  it('a proposal with no task behind it always waits for a human, even at rung 4', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'policy:\n  rung: 4\n'
    );
    const out = await json<{ status: string }>(
      await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title: 'the owner decides directly',
          body: 'd',
        }),
      })
    );
    // The owner is a decide-tier human: a direct write.
    expect(out.status).toBe('active');
    const ada = handle.team.teammates.issue('ada', 'request');
    const proposed = await json<{ status: string }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(ada),
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title: 'no task behind this one',
          body: 'd',
        }),
      })
    );
    expect(proposed.status).toBe('proposed');
  });

  it('replays an Idempotency-Key with the first result', async () => {
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'idempotency-key': 'k-1',
      },
      body: JSON.stringify({
        scope: 'team',
        kind: 'fact',
        title: 'once',
        body: '',
      }),
    };
    const first = await fetch(`${base}/api/memory`, init);
    const second = await fetch(`${base}/api/memory`, init);
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(await second.json()).toEqual(await first.json());
  });

  it('replays a retire’s Idempotency-Key with the first result', async () => {
    const target = await json<{ id: string }>(
      await fetch(`${base}/api/memory`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          scope: 'team',
          kind: 'fact',
          title: 'retire me once',
          body: '',
        }),
      })
    );
    const ada = handle.team.teammates.issue('ada', 'request');
    const init = {
      method: 'POST',
      headers: { ...authHeaders(ada), 'idempotency-key': 'k-retire' },
      body: JSON.stringify({ reason: 'no longer true' }),
    };
    const url = `${base}/api/memory/${target.id}/retire`;
    const first = await rawFetch(url, init);
    const second = await rawFetch(url, init);
    expect([first.status, second.status]).toEqual([200, 200]);
    const out = await json<{ status: string; proposal: string }>(first);
    expect(out.status).toBe('proposed');
    expect(await second.json()).toEqual(out);
    expect(
      handle.memory.shared!.listProposals({ states: ['open'] }).map((p) => p.id)
    ).toEqual([out.proposal]);
  });

  // A crash between an answer and its effect: messaging replays the answer at
  // the next boot, and only a handler registered before messaging.recover()
  // sees the replay.
  // Approval tells every other live run the entry reaches; a rejection
  // tells the author's run why.
  it('tells live runs of an approved entry, and the author of a rejection', async () => {
    await liveRun('listener');
    await liveRun('author');
    const propose = (title: string) =>
      rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(runToken()),
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title,
          body: 'd',
        }),
      }).then((res) => json<{ proposal: string; gate: string }>(res));
    const reply = (gate: string, choice: string, body: string) =>
      fetch(`${base}/api/messages/${gate}/reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body, choice }),
      });
    const approved = await propose('watch the lockfile');
    await reply(approved.gate, 'approve', '');
    const entry = handle.memory
      .shared!.listEntries()
      .find((e) => e.title === 'watch the lockfile')!;
    await waitFor(() =>
      executor.notified.some((n) => n.includes(`(${entry.handle})`))
    );
    // The author's own run is skipped, so one of the two live runs hears it.
    expect(
      executor.notified.filter((n) => n.includes(`(${entry.handle})`))
    ).toHaveLength(1);
    const rejected = await propose('not this one');
    await reply(rejected.gate, 'reject', 'wrong lockfile');
    await waitFor(() =>
      executor.notified.some((n) =>
        n.includes(`proposal ${rejected.proposal} was rejected by`)
      )
    );
    expect(executor.notified.at(-1)).toMatch(/: wrong lockfile$/);
  });

  it('closes a second open gate for one proposal at the next boot', async () => {
    await liveRun('two gates');
    const p = await json<{ proposal: string; gate: string }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(runToken()),
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title: 'one gate only',
          body: 'd',
        }),
      })
    );
    const stray = await handle.messaging.engine.send(
      {
        to: ['human:test'],
        kind: 'question',
        blocking: true,
        choices: ['approve', 'reject'],
        body: 'a duplicate gate',
        data: {
          type: 'memory',
          proposalId: p.proposal,
          action: 'add',
          scope: 'team',
          kind: 'hazard',
        },
      },
      SYSTEM_SENDER
    );
    await restart();
    const open = handle.messaging.engine
      .openBlocking()
      .filter((m) => gateOf(m)?.type === 'memory')
      .map((m) => m.id);
    expect(open).toEqual([p.gate]);
    expect(open).not.toContain(stray.message.id);
  });

  it('decides a proposal whose answered gate had not taken effect before a restart', async () => {
    await liveRun('crash before the effect');
    const p = await json<{ proposal: string; gate: string }>(
      await rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(runToken()),
        body: JSON.stringify({
          scope: 'team',
          kind: 'hazard',
          title: 'survives a crash',
          body: 'd',
        }),
      })
    );
    handle.memory.engine!.applyGateAnswer = () => {
      throw new Error('crash before the effect');
    };
    await fetch(`${base}/api/messages/${p.gate}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '', choice: 'approve' }),
    });
    expect(handle.memory.shared!.getProposal(p.proposal)?.state).toBe('open');
    await restart();
    expect(handle.memory.shared!.getProposal(p.proposal)?.state).toBe(
      'approved'
    );
    expect(handle.memory.shared!.listEntries().map((e) => e.title)).toContain(
      'survives a crash'
    );
  });
});

// Risk caps and per-gate pins decide a run's proposal.
describe.each([
  ['routine', 4, null, 'active'],
  ['routine', 3, null, 'proposed'],
  ['elevated', 4, null, 'proposed'],
  ['critical', 4, null, 'proposed'],
  ['routine', 1, 'auto', 'active'],
  ['elevated', 1, 'auto', 'proposed'],
  ['routine', 4, 'block', 'proposed'],
] as const)(
  'memory gate policy: a %s task at rung %i, pin %s',
  (risk, rung, pin, expected) => {
    it(`makes the proposal ${expected}`, async () => {
      const gates = pin === null ? '' : `  gates:\n    memory: ${pin}\n`;
      writeFileSync(
        join(root, '.dispatch', 'config.yml'),
        `policy:\n  rung: ${rung}\n${gates}`
      );
      await liveRun(`policy ${risk} ${rung} ${pin ?? 'none'}`, { risk });
      const out = await json<{ status: string }>(
        await rawFetch(`${base}/api/memory`, {
          method: 'POST',
          headers: authHeaders(runToken()),
          body: JSON.stringify({
            scope: 'team',
            kind: 'hazard',
            title: `policy ${risk} ${rung} ${pin ?? 'none'}`,
            body: 'd',
          }),
        })
      );
      expect(out.status).toBe(expected);
    });
  }
);

describe('identities over HTTP', () => {
  it('answers 409 for a reused handle until the human starts fresh', async () => {
    // Bind ada with one roster email, then change the roster entry's email.
    writeFileSync(
      join(root, '.dispatch', 'team.yml'),
      'members:\n  - handle: ada\n    email: ada@old.com\n    displayName: Ada\n    emails: []\n'
    );
    const ada = handle.team.teammates.issue('ada', 'request');
    const personal = (title: string) =>
      rawFetch(`${base}/api/memory`, {
        method: 'POST',
        headers: authHeaders(ada),
        body: JSON.stringify({
          scope: 'personal',
          kind: 'fact',
          title,
          body: '',
        }),
      });
    expect((await personal('mine')).status).toBe(201);
    writeFileSync(
      join(root, '.dispatch', 'team.yml'),
      'members:\n  - handle: ada\n    email: ada@new.com\n    displayName: Ada\n    emails: []\n'
    );
    const conflict = await personal('again');
    expect(conflict.status).toBe(409);
    expect((await json<{ error: string }>(conflict)).error).toContain(
      'this handle was bound to someone else; link or start fresh'
    );
    const health = await json<{
      personal: { available: boolean; reason: string | null } | null;
    }>(
      await rawFetch(`${base}/api/memory/health`, { headers: authHeaders(ada) })
    );
    expect(health.personal).toMatchObject({ available: false });
    const fresh = await rawFetch(`${base}/api/memory/link`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify({ fresh: true }),
    });
    expect(fresh.status).toBe(200);
    expect((await personal('again')).status).toBe(201);
  });

  // Ada's identity also serves another project, so linking this one away
  // must leave its entries where that project still reads them.
  it('moves entries on a link only off an identity no project uses', async () => {
    const email = 'ada@x.com';
    writeFileSync(
      join(root, '.dispatch', 'team.yml'),
      `members:\n  - handle: ada\n    email: ${email}\n    displayName: Ada\n    emails: []\n`
    );
    const ada = handle.team.teammates.issue('ada', 'request');
    const saved = await rawFetch(`${base}/api/memory`, {
      method: 'POST',
      headers: authHeaders(ada),
      body: JSON.stringify({
        scope: 'personal',
        kind: 'fact',
        title: 'mine',
        body: '',
      }),
    });
    expect(saved.status).toBe(201);
    const identities = handle.memory.identities!;
    const here = handle.memory.host.projectKey();
    const alias = (projectKey: string) => ({
      projectKey,
      handle: 'ada',
      rosterEmail: email,
    });
    const shared = identities.completeLink({
      ...alias('bbbbbbbbbbbb'),
      code: identities.startLink(alias(here)).code,
    }).identity;
    identities.resolve({ ...alias('cccccccccccc'), isOwner: false });
    const { code } = identities.startLink(alias('cccccccccccc'));
    const linked = await rawFetch(`${base}/api/memory/link/${code}`, {
      method: 'POST',
      headers: authHeaders(ada),
    });
    expect(linked.status).toBe(200);
    expect(
      handle.memory.personal
        .personal(shared)
        .listEntries()
        .map((e) => e.title)
    ).toEqual(['mine']);
  });

  it('refuses a fresh start for the owner', async () => {
    const fresh = await fetch(`${base}/api/memory/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fresh: true }),
    });
    expect(fresh.status).toBe(400);
  });
});

describe('Settings → Memory routes', () => {
  const OWNER = {
    address: 'human:test',
    canDecide: true,
    kind: 'human',
    ownerCredential: true,
  } as const;
  const CLAUDE_AGENT = {
    address: 'agent:test/claude-code',
    canDecide: false,
    kind: 'agent',
    ownerCredential: true,
  } as const;

  function post(path: string, token?: string): Promise<Response> {
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    };
    return token === undefined
      ? fetch(`${base}${path}`, init)
      : rawFetch(`${base}${path}`, { ...init, headers: authHeaders(token) });
  }

  it('filters the list by origin and trust', async () => {
    const engine = handle.memory.engine!;
    await engine.save(CLAUDE_AGENT, {
      scope: 'personal',
      kind: 'fact',
      title: 'from claude',
      body: '',
      origin: 'claude:aaaaaaaaaaaa/a.md',
    });
    await engine.save(CLAUDE_AGENT, {
      scope: 'personal',
      kind: 'fact',
      title: 'agent note with no origin',
      body: '',
    });
    await engine.save(OWNER, {
      scope: 'personal',
      kind: 'fact',
      title: 'owner note from claude',
      body: '',
      origin: 'claude:aaaaaaaaaaaa/b.md',
    });
    const listed = await json<{ entries: { title: string }[] }>(
      await fetch(`${base}/api/memory?origin=claude&trust=agent`)
    );
    expect(listed.entries.map((e) => e.title)).toEqual(['from claude']);
    expect((await fetch(`${base}/api/memory?origin=docs`)).status).toBe(400);
    expect((await fetch(`${base}/api/memory?trust=sure`)).status).toBe(400);
  });

  it('lists skipped Claude files and accepts one as an agent-trust personal entry', async () => {
    const self = handle.memory.personal.personal('self');
    self.addIngestProblem({
      id: 'ip-1',
      lineage: 'r-9f2c01',
      file: 'notes/proto-shims.md',
      reason: 'too-large',
      size: 70_000,
      sha256: 'a'.repeat(64),
      content:
        '---\nname: proto shims live in ~/.proto/shims\nmetadata:\n  type: project\n---\nexport PATH first',
      at: '2026-09-25T10:00:00.000Z',
    });
    self.addIngestProblem({
      id: 'ip-2',
      lineage: 'r-9f2c01',
      file: 'link.md',
      reason: 'symlink',
      size: 0,
      sha256: 'b'.repeat(64),
      content: null,
      at: '2026-09-25T09:00:00.000Z',
    });
    const problems = async (token?: string) =>
      (
        await json<{ problems: Record<string, unknown>[] }>(
          token === undefined
            ? await fetch(`${base}/api/memory/ingest-problems`)
            : await rawFetch(`${base}/api/memory/ingest-problems`, {
                headers: authHeaders(token),
              })
        )
      ).problems;
    const listed = await problems();
    expect(listed.map((p) => [p.id, p.reason])).toEqual([
      ['ip-1', 'too-large'],
      ['ip-2', 'symlink'],
    ]);
    expect(listed[0]).not.toHaveProperty('content');
    const ada = handle.team.teammates.issue('ada', 'decide');
    expect(await problems(ada)).toEqual([]);

    const accepted = await post('/api/memory/ingest-problems/ip-1/accept');
    expect(accepted.status).toBe(201);
    const saved = await json<{ status: string; id: string }>(accepted);
    expect(saved.status).toBe('active');
    const read = await json<{ entry: Record<string, unknown> }>(
      await fetch(`${base}/api/memory/${saved.id}`)
    );
    expect(read.entry).toMatchObject({
      scope: 'personal',
      kind: 'fact',
      trust: 'agent',
      author: 'agent:test/claude-code',
      title: 'proto shims live in ~/.proto/shims',
      body: 'export PATH first',
    });
    expect(read.entry.projectKey).not.toBeNull();

    // Nothing of a symlink was kept, so it stays listed for the human to see.
    expect((await post('/api/memory/ingest-problems/ip-2/accept')).status).toBe(
      400
    );
    expect((await problems()).map((p) => p.id)).toEqual(['ip-2']);
    expect((await post('/api/memory/ingest-problems/ip-1/accept')).status).toBe(
      404
    );
    expect(
      (await post('/api/memory/ingest-problems/ip-2/accept', ada)).status
    ).toBe(404);
  });

  it('keeps a skipped file listed when saving it is refused', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'memory:\n  personalWritesPerHour: 1\n'
    );
    const self = handle.memory.personal.personal('self');
    for (const id of ['ip-1', 'ip-2'])
      self.addIngestProblem({
        id,
        lineage: 'r-9f2c01',
        file: `${id}.md`,
        reason: 'too-large',
        size: 70_000,
        sha256: 'c'.repeat(64),
        content: `kept from ${id}`,
        at: '2026-09-25T10:00:00.000Z',
      });
    expect((await post('/api/memory/ingest-problems/ip-1/accept')).status).toBe(
      201
    );
    expect((await post('/api/memory/ingest-problems/ip-2/accept')).status).toBe(
      429
    );
    expect(self.ingestProblems(10)).toEqual([
      {
        id: 'ip-2',
        lineage: 'r-9f2c01',
        file: 'ip-2.md',
        reason: 'too-large',
        size: 70_000,
        at: '2026-09-25T10:00:00.000Z',
      },
    ]);
  });

  it('names the caller’s identity, its aliases and a placeholder roster email', async () => {
    writeFileSync(
      join(root, '.dispatch', 'team.yml'),
      'members:\n  - handle: ada\n    email: local@localhost\n    displayName: Ada\n    emails: []\n'
    );
    type Identity = {
      identity: string;
      aliases: { projectKey: string; handle: string }[];
      placeholderEmail: boolean;
    };
    const own = await json<Identity>(
      await fetch(`${base}/api/memory/identity`)
    );
    expect(own).toMatchObject({ identity: 'self', placeholderEmail: false });
    expect(own.aliases.map((a) => a.handle)).toEqual(['test']);
    const ada = handle.team.teammates.issue('ada', 'request');
    const theirs = await json<Identity>(
      await rawFetch(`${base}/api/memory/identity`, {
        headers: authHeaders(ada),
      })
    );
    expect(theirs.identity).toMatch(/^pid-/);
    expect(theirs.aliases.map((a) => a.handle)).toEqual(['ada']);
    expect(theirs.placeholderEmail).toBe(true);
  });
});
