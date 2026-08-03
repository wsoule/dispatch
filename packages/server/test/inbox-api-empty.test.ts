import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-inbox-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let fakeHome: string;
let root: string;
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
    webDistDir: null,
    writeDaemonFile: false,
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function capture(text: string): Promise<Response> {
  return fetch(`${baseUrl}/api/inbox`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text }),
  });
}

function list(): Promise<Response> {
  return fetch(`${baseUrl}/api/inbox`);
}

describe('POST /api/inbox', () => {
  // `splitCapture` strips a leading bullet or checkbox before filtering empty
  // lines, so text that is only markers clears `text.trim()` and stores nothing.
  it.each([['-'], ['*'], ['- [ ]'], ['-\n*\n- [x]']])(
    'rejects %p, which stores nothing',
    async (text) => {
      const res = await capture(text);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(
        'text contained no capturable lines'
      );
      expect(await (await list()).json()).toEqual([]);
    }
  );

  it('still accepts a bullet with prose after it', async () => {
    const res = await capture('- diffs go blank mid-run');
    expect(res.status).toBe(201);
    const created = (await res.json()) as { text: string }[];
    expect(created).toHaveLength(1);
    expect(created[0].text).toBe('diffs go blank mid-run');
  });
});
