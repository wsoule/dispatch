import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';

let home: string;
let root: string;
let handle: ServerHandle;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-reserve-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-reserve-');
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  useTestAuth(handle);
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it.each(['A2A.x', ' a2a.x', '-a2a.x', 'a2a.acme'])(
  'refuses to register %j as an ordinary agent',
  async (name) => {
    const res = await fetch(
      `http://127.0.0.1:${handle.port}/api/agents/register`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, client: 'claude-code' }),
      }
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      'reserved for A2A clients'
    );
  }
);

it('still registers a name that merely contains a2a', async () => {
  const res = await fetch(
    `http://127.0.0.1:${handle.port}/api/agents/register`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'my-a2a.tool', client: 'claude-code' }),
    }
  );
  expect(res.status).toBe(201);
});
