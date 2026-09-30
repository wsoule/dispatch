import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo, StallingExecutor } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth, wsUrl } from '../testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
const originalHome = process.env.DISPATCH_HOME;

// Memory v1 is on by default, so the app token's human resolves to an identity.
beforeEach(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'docs-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(initGitRepo('docs-personal-'));
  const executor = new StallingExecutor();
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (o) => o.registerExecutor('claude', executor),
  });
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}/api`;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function waitFor(
  check: () => boolean | Promise<boolean>,
  ms = 4000
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('waitFor timed out');
}

// A teammate token at `tier`, issued through the decide-tier route.
async function teammateToken(
  email: string,
  tier: 'request' | 'decide'
): Promise<string> {
  const res = await post('/team/tokens', { email, tier });
  return (await json<{ token: string }>(res)).token;
}

describe('personal docs over the routes', () => {
  it('broadcasts doc.changed for a personal doc without its id', async () => {
    const ws = new WebSocket(wsUrl(handle));
    const frames: { type: string; scope?: string; id?: string }[] = [];
    ws.onmessage = (e) =>
      frames.push(JSON.parse(String(e.data)) as { type: string });
    await waitFor(() => frames.some((f) => f.type === 'hello'));
    const res = await post('/docs', {
      title: 'Mine',
      body: 'x\n',
      scope: 'personal',
    });
    expect(res.status).toBe(201);
    await waitFor(() => frames.some((f) => f.type === 'doc.changed'));
    expect(frames.filter((f) => f.type === 'doc.changed')).toEqual([
      { type: 'doc.changed', scope: 'personal' },
    ]);
    ws.close();
  });

  it('answers a teammate 404 and a decide-tier teammate 403 by id, and promotes for the owner', async () => {
    const made = await json<{ doc: { id: string }; handle: string }>(
      await post('/docs', { title: 'Plan', body: 'x\n', scope: 'personal' })
    );
    expect(made.handle).toBe('plan');
    const as = async (token: string, path: string) =>
      rawFetch(`${base}${path}`, {
        headers: { authorization: `Bearer ${token}` },
      });
    const reader = await teammateToken('alice@example.com', 'request');
    const lead = await teammateToken('grace@example.com', 'decide');
    expect((await as(reader, `/docs/${made.doc.id}`)).status).toBe(404);
    expect((await as(reader, '/docs/~plan')).status).toBe(404);
    expect((await as(lead, `/docs/${made.doc.id}`)).status).toBe(403);
    expect((await fetch(`${base}/docs/~plan`)).status).toBe(200);
    expect((await fetch(`${base}/docs/plan`)).status).toBe(404);
    const promoted = await post('/docs/~plan/promote', {});
    expect(promoted.status).toBe(201);
    expect(
      await json<{ doc: { scope: string; handle: string } }>(promoted)
    ).toMatchObject({ doc: { scope: 'team', handle: 'plan' } });
    expect((await as(reader, '/docs/plan')).status).toBe(200);
  });
});
