import { loadConfig, TaskStore } from '@dispatch/core';
import type { LabelDefinition } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-labels-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function putColor(name: string, color: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/labels`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, color }),
  });
}

describe('who may color a label', () => {
  function putAs(token: string): Promise<Response> {
    return rawFetch(`${baseUrl}/api/labels`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ name: 'Type/Bug', color: '#eb5757' }),
    });
  }

  // The registry lives in config.yml, which an agent may never rewrite.
  it('an agent holding the on-disk token cannot', async () => {
    const res = await putAs(handle.tokens.agentToken);
    expect(res.status).toBe(403);
    expect(loadConfig(root).labels).toBeUndefined();
  });

  it('a decide-tier teammate can', async () => {
    const lead = handle.team.teammates.issue('ada', 'decide');
    expect((await putAs(lead)).status).toBe(200);
    expect(loadConfig(root).labels?.map((l) => l.name)).toEqual(['Type/Bug']);
  });
});

describe('/api/labels', () => {
  it('starts empty, then lists what a PUT colors', async () => {
    const empty = await fetch(`${baseUrl}/api/labels`);
    expect(await empty.json()).toEqual({ labels: [] });

    const put = await putColor('Type/Bug', '#eb5757');
    expect(put.status).toBe(200);
    const expected: LabelDefinition[] = [
      { name: 'Type/Bug', color: '#eb5757', group: null, external: null },
    ];
    expect(await put.json()).toEqual({ labels: expected });
    const listed = await fetch(`${baseUrl}/api/labels`);
    expect(await listed.json()).toEqual({ labels: expected });
    expect(loadConfig(root).labels).toEqual(expected);

    // Case-insensitive: the same label, recolored, not a second entry.
    await putColor('type/bug', '#0f783c');
    expect(loadConfig(root).labels?.map((l) => l.color)).toEqual(['#0f783c']);
    // Clearing a local-only label's color drops it.
    await putColor('Type/Bug', null);
    expect(loadConfig(root).labels).toBeUndefined();
  });

  it('refuses a color that is not hex, and a nameless label', async () => {
    expect((await putColor('web', 'red')).status).toBe(400);
    expect((await putColor('', '#fff')).status).toBe(400);
    const config = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: [{ name: 'web', color: 'nope' }] }),
    });
    expect(config.status).toBe(400);
  });

  it('takes the whole registry through PATCH /api/config', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ labels: [{ name: 'web', color: '#5e6ad2' }] }),
    });
    expect(res.status).toBe(200);
    const listed = (await (await fetch(`${baseUrl}/api/labels`)).json()) as {
      labels: LabelDefinition[];
    };
    expect(listed.labels.map((l) => [l.name, l.color])).toEqual([
      ['web', '#5e6ad2'],
    ]);
  });
});
