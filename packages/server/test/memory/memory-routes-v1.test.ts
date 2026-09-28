import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
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

function boot(): Promise<ServerHandle> {
  return startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', executor);
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
