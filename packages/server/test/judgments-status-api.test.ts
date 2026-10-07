import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { JudgmentClient } from '../src/judgments/client.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

let fakeHome: string;
let root: string;
let handle: ServerHandle | null = null;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-judgments-status-'));
  runGitSync(root, ['init', '-b', 'main']);
  TaskStore.init(root);
});

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function status(judgments: JudgmentClient | null, probe = false) {
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    judgments,
  });
  useTestAuth(handle);
  const res = await fetch(
    `http://127.0.0.1:${handle.port}/api/judgments/status${probe ? '?probe=1' : ''}`
  );
  return (await res.json()) as Record<string, unknown>;
}

test('no key: not configured, nothing probed', async () => {
  expect(await status(null, true)).toMatchObject({
    configured: false,
    model: null,
  });
});

test('a key: configured with its model; probe=1 times one call', async () => {
  const client: JudgmentClient = {
    model: 'jev-latest',
    judge: () => Promise.resolve({} as never),
  };
  const body = await status(client, true);
  expect(body).toMatchObject({
    configured: true,
    model: 'jev-latest',
    probe: { ok: true },
  });
});
