import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test';
import { appendFileSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { waitFor } from '../messaging/harness.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';
import { approvedClient, freePort, useSeedBase } from './seed.js';

// One daemon end to end: the owner mints an intake link through /api, a
// person submits the form on the A2A listener, the owner approves the
// handoff, and the status page and the webhook follow it.

let home: string;
let root: string;
let handle: ServerHandle | null = null;
let hook: ReturnType<typeof Bun.serve> | null = null;
const originalHome = process.env.DISPATCH_HOME;
const hooks: { event: string; request: Record<string, unknown> }[] = [];

// waitFor for a check that has to fetch.
async function eventually(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('eventually timed out');
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-intake-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-intake-');
  TaskStore.init(root);
  hooks.length = 0;
  hook = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    // The same webhook also gets decision.opened for the proposal gate;
    // only the intake events are kept.
    fetch: async (req) => {
      const body = (await req.json()) as {
        event: string;
        request: Record<string, unknown>;
      };
      if (body.event === 'request.changed') hooks.push(body);
      return new Response('ok');
    },
  });
  appendFileSync(
    join(root, '.dispatch', 'config.yml'),
    `\nnotifications:\n  webhook: http://127.0.0.1:${hook.port}/hook\n`
  );
});
afterEach(async () => {
  await handle?.stop();
  handle = null;
  await hook?.stop(true);
  hook = null;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it('takes a request through an intake link and follows it to approval', async () => {
  const listenerPort = await freePort();
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
    a2a: { port: listenerPort },
  });
  const api = `http://127.0.0.1:${handle.port}`;
  useTestAuth(handle);
  useSeedBase(api);
  const { caller } = await approvedClient('web-form');

  // The shared agent token may not mint a credential outside people use.
  const asAgent = await rawFetch(`${api}/api/a2a/intake`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${handle.tokens.agentToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ client: 'web-form' }),
  });
  expect(asAgent.status).toBe(403);

  const minted = await fetch(`${api}/api/a2a/intake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'web-form', label: 'Feature requests' }),
  });
  expect(minted.status).toBe(201);
  const link = (await minted.json()) as {
    id: string;
    client: string;
    token: string;
    url: string;
  };
  expect(link.client).toBe(caller.address);
  expect(link.url).toBe(`http://127.0.0.1:${listenerPort}/r/${link.token}`);
  const listed = (await (await fetch(`${api}/api/a2a/intake`)).json()) as {
    links: Record<string, unknown>[];
  };
  expect(listed.links).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain(link.token);

  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  let statusUrl: string;
  try {
    const form = await rawFetch(link.url);
    expect(form.status).toBe(200);
    expect(await form.text()).toContain('Feature requests');

    const sent = await rawFetch(link.url, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        title: 'Dark mode',
        details: 'Please add a dark theme.',
        name: 'Sam',
        contact: 'sam@example.com',
      }).toString(),
    });
    expect(sent.status).toBe(303);
    statusUrl = new URL(sent.headers.get('location')!, link.url).href;
    expect(statusUrl).toMatch(
      new RegExp(`^http://127\\.0\\.0\\.1:${listenerPort}/s/[0-9a-f]{64}$`)
    );
    expect(await (await rawFetch(statusUrl)).text()).toContain(
      'Received: waiting for the team to accept it.'
    );
    const statusToken = statusUrl.slice(statusUrl.lastIndexOf('/') + 1);
    // Access lines name the route, never a token.
    const access = lines.filter((l) => l.startsWith('a2a: '));
    expect(access.some((l) => l.includes('/r/…'))).toBe(true);
    expect(access.some((l) => l.includes('/s/…'))).toBe(true);
    expect(lines.join('\n')).not.toContain(link.token);
    expect(lines.join('\n')).not.toContain(statusToken);
  } finally {
    spy.mockRestore();
  }

  // The owner sees an ordinary handoff awaiting approval, and approves it.
  const { tasks } = (await (
    await fetch(`${api}/api/a2a/tasks?client=web-form`)
  ).json()) as { tasks: { id: string; gate: string; dispatchTask: string }[] };
  expect(tasks).toHaveLength(1);
  const draft = (await (
    await fetch(`${api}/api/tasks/${tasks[0].dispatchTask}`)
  ).json()) as { meta: { labels: string[] }; body: string };
  expect(draft.meta.labels).toContain('a2a');
  expect(draft.body).toContain('From: Sam (sam@example.com)');

  await waitFor(() => hooks.some((h) => h.request.step === 'received'));
  const received = hooks.find((h) => h.request.step === 'received')!;
  expect(received).toMatchObject({
    event: 'request.changed',
    request: { title: 'Dark mode', contact: 'sam@example.com', statusUrl },
  });

  const answered = await fetch(
    `${api}/api/messages/${encodeURIComponent(tasks[0].gate)}/reply`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '', choice: 'approve' }),
    }
  );
  expect(answered.status).toBeLessThan(300);
  await eventually(async () =>
    (await (await rawFetch(statusUrl)).text()).includes(
      'Accepted: queued for work.'
    )
  );
  await waitFor(() => hooks.some((h) => h.request.step === 'accepted'));
  expect(
    hooks.find((h) => h.request.step === 'accepted')!.request.statusUrl
  ).toBeUndefined();

  // Revoking the link closes the form; the request's page stays readable.
  const revoked = await fetch(`${api}/api/a2a/intake/${link.id}/revoke`, {
    method: 'POST',
  });
  expect(revoked.status).toBe(204);
  expect((await rawFetch(link.url)).status).toBe(404);
  expect((await rawFetch(statusUrl)).status).toBe(200);
});
