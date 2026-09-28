import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { FakeOverseer } from '../../src/orchestrator/overseers/fake.js';
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
  const meta = await json<{ id: string }>(
    await fetch(`${base}/api/tasks/${task.meta.id}/runs`, {
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
  return { runId: meta.id, taskId: task.meta.id };
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

// The booted daemon decides A2A provenance the way docs does: the a2a label.
describe('A2A provenance', () => {
  it('a run of an a2a-labelled task acts for no one and lists no project memory', async () => {
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

    const asked = await liveRun('asked over A2A', { labels: ['a2a'] });
    expect(await titlesFor(runToken())).not.toContain(
      'PROJECT-ONLY convention'
    );
    expect(await operatorOf(asked.runId)).toBeNull();
  });

  it('a review run of an a2a-labelled task lists no project memory either', async () => {
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
    const reviewTitles = async (labels: string[]): Promise<string[]> => {
      const task = await json<{ meta: { id: string } }>(
        await fetch(`${base}/api/tasks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ title: 'reviewed', labels }),
        })
      );
      await handle.orchestrator.dispatchAuxRun({
        taskId: task.meta.id,
        kind: 'review',
        head: 'main',
        executor: 'claude',
        buildPrompt: () => 'review this',
      });
      return (
        await json<{ entries: { title: string }[] }>(
          await rawFetch(`${base}/api/memory`, {
            headers: authHeaders(runToken()),
          })
        )
      ).entries.map((e) => e.title);
    };

    expect(await reviewTitles([])).toContain('PROJECT-ONLY convention');
    expect(await reviewTitles(['a2a'])).not.toContain(
      'PROJECT-ONLY convention'
    );
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
    expect(run.taskId).toBeTruthy();
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
});

describe('Settings → Memory routes', () => {
  const OWNER = {
    address: 'human:test',
    canDecide: true,
    kind: 'human',
  } as const;
  const CLAUDE_AGENT = {
    address: 'agent:test/claude-code',
    canDecide: false,
    kind: 'agent',
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
