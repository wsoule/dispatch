import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch } from '../testAuth.js';
import { seedAgent } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-surfaces-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-surfaces-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  seedAgent(root, 'agent:test/a2a.acme', 'client-token');
  seedAgent(root, 'agent:test/claude', 'agent-token-ok');
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function api(
  path: string,
  token: string,
  init: { method?: string; body?: string } = {}
) {
  return rawFetch(`http://127.0.0.1:${handle.port}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
  });
}

describe('an A2A client token on /api', () => {
  it.each([
    ['GET', '/api/health'],
    ['GET', '/api/tasks'],
    ['POST', '/api/messages'],
    ['GET', '/api/threads'],
    ['GET', '/api/mailbox'],
    ['GET', '/api/decisions/open'],
    ['POST', '/api/agents/register'],
    ['PATCH', '/api/config'],
    ['GET', '/api/a2a/listener'],
  ])('%s %s answers 403 auth_a2a_client', async (method, path) => {
    const res = await api(path, 'client-token', {
      method,
      ...(method === 'GET' ? {} : { body: '{}' }),
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe(
      'auth_a2a_client'
    );
  });

  it('leaves an ordinary agent token working on messaging routes', async () => {
    const res = await api('/api/messages', 'agent-token-ok', {
      method: 'POST',
      body: JSON.stringify({
        to: ['human:test'],
        kind: 'message',
        body: 'hello',
      }),
    });
    expect(res.status).toBe(201);
  });
});
