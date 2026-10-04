import { credentialsPath, TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LISTENER } from '../../src/a2a/settings.js';
import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { useTestAuth } from '../testAuth.js';
import { FixturePeer } from './fixturePeer.js';
import { freePort } from './seed.js';

let home: string;
let root: string;
let handle: ServerHandle | null = null;
let peer: FixturePeer;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-health-home-')));
  process.env.DISPATCH_HOME = home;
  root = initGitRepo('a2a-health-');
  TaskStore.init(root);
  peer = new FixturePeer().start();
});
afterEach(async () => {
  await handle?.stop();
  handle = null;
  await peer.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

it('health names an unreadable credentials file and the unsigned card', async () => {
  const h = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    webDistDir: null,
  });
  handle = h;
  useTestAuth(h);
  const base = `http://127.0.0.1:${h.port}`;
  await fetch(`${base}/api/a2a/peers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      alias: 'fixture',
      cardUrl: peer.cardUrl(),
      token: 'peer-token',
    }),
  });
  const problems = async () =>
    (
      (await (await fetch(`${base}/api/health`)).json()) as {
        problems: string[];
      }
    ).problems;
  expect(await problems()).toEqual([]);

  writeFileSync(credentialsPath(), '{ not json');
  const listenerPort = await freePort();
  await h.a2a.applySettings({
    ...DEFAULT_LISTENER,
    enabled: true,
    port: listenerPort,
  });
  await fetch(`http://127.0.0.1:${listenerPort}/.well-known/agent-card.json`);
  const found = await problems();
  expect(found).toContainEqual(expect.stringContaining('cannot be parsed'));
  expect(found).toContainEqual(
    expect.stringContaining('A2A card signing is off')
  );
});
