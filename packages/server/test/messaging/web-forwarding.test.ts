import { TaskStore } from '@dispatch-foo/core';
import type { LinkHttpResponse } from '@dispatch-foo/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch, useTestAuth } from '../testAuth.js';

// A request someone sends from app.dispatch.foo to their own machine reaches
// the project's daemon as the hub's `http` call, and is replayed on the
// daemon's own API as the operator at the decide tier: it can review and
// decide, never reach an operator route or the hub link itself.

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
const originalHome = process.env.DISPATCH_HOME;

beforeAll(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-web-forward-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    hubLink: true,
  });
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
});

afterAll(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function forward(
  request: { method?: string; path: string; body?: unknown },
  token = handle.hubLink!.token
): Promise<{ status: number; answer: LinkHttpResponse | null }> {
  const res = await rawFetch(`${base}/api/hub-link/http`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      project: 'p',
      method: request.method ?? 'GET',
      path: request.path,
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer smuggled',
        cookie: 'x=1',
      },
      body:
        request.body === undefined
          ? ''
          : Buffer.from(JSON.stringify(request.body)).toString('base64'),
    }),
  });
  return {
    status: res.status,
    answer: res.ok ? ((await res.json()) as LinkHttpResponse) : null,
  };
}

const bodyOf = (answer: LinkHttpResponse | null): unknown =>
  JSON.parse(Buffer.from(answer?.body ?? '', 'base64').toString('utf8'));

describe('requests forwarded from the web', () => {
  it('act as the operator at the decide tier', async () => {
    const { answer } = await forward({ path: '/api/whoami' });
    expect(answer?.status).toBe(200);
    expect(bodyOf(answer)).toMatchObject({ tier: 'decide' });
  });

  it('can write the board', async () => {
    const { answer } = await forward({
      method: 'POST',
      path: '/api/tasks',
      body: { title: 'From the web' },
    });
    expect(answer?.status).toBe(201);
    const listed = (await (
      await fetch(`${base}/api/tasks?fields=meta`)
    ).json()) as {
      meta: { title: string };
    }[];
    expect(listed.some((t) => t.meta.title === 'From the web')).toBe(true);
  });

  it('never reach an operator route, the hub link, or anything outside /api/', async () => {
    expect(
      (
        await forward({
          method: 'PUT',
          path: '/api/machine/web-access',
          body: { enabled: false },
        })
      ).answer?.status
    ).toBe(403);
    expect(
      (await forward({ method: 'POST', path: '/api/remote/pair', body: {} }))
        .answer?.status
    ).toBe(403);
    expect(
      (await forward({ method: 'POST', path: '/api/hub-link/mail', body: {} }))
        .answer?.status
    ).toBe(404);
    expect((await forward({ path: '/index.html' })).answer?.status).toBe(404);
  });

  it('never hand out lasting access: no pairing, team tokens or machine switches', async () => {
    for (const [method, path] of [
      ['POST', '/api/pair/offer'],
      ['POST', '/api/team/tokens'],
      ['GET', '/api/machine/web-access'],
      ['GET', '/api/devices'],
    ] as const) {
      const { answer } = await forward({
        method,
        path,
        body: { tier: 'decide' },
      });
      expect(`${method} ${path} ${String(answer?.status)}`).toBe(
        `${method} ${path} 403`
      );
    }
    // Reading the board's people is still fine from the web.
    expect(
      (await forward({ path: '/api/team/status' })).answer?.status
    ).not.toBe(403);
  });

  it('are refused without the token this daemon gave its hub', async () => {
    expect(
      (await forward({ path: '/api/whoami' }, 'not-the-link')).status
    ).toBe(401);
  });

  it('report no hub to switch when none runs on this machine', async () => {
    const res = await fetch(`${base}/api/machine/web-access`);
    expect(res.status).toBe(409);
  });
});
