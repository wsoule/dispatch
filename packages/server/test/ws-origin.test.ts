import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';

// The origin a page on the open web presents. CORS does not apply to a
// WebSocket handshake, so the upgrade itself is the only place to stop it.
const HOSTILE = 'https://evil.example';

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-ws-origin-'));
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

// Opens /ws with the given Origin and reports the first message it received,
// or null when the handshake failed. Settled before `ws.close()`, which
// dispatches `close` synchronously and would otherwise overwrite a message.
function connect(
  origin: string | null
): Promise<{ opened: boolean; firstMessage: string | null }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(
      `${baseUrl}/ws`,
      origin === null ? undefined : ({ headers: { origin } } as never)
    );
    let settled = false;
    const settle = (firstMessage: string | null): void => {
      if (settled) return;
      settled = true;
      resolve({ opened: firstMessage !== null, firstMessage });
      ws.close();
    };
    ws.addEventListener('message', (event) => {
      settle(String((event as MessageEvent).data));
    });
    ws.addEventListener('error', () => settle(null));
    ws.addEventListener('close', () => settle(null));
  });
}

describe('/ws origin guard', () => {
  it('refuses the upgrade from an untrusted origin', async () => {
    // The plain HTTP view of the same handshake, so the status is observable.
    const res = await fetch(`${baseUrl}/ws`, { headers: { origin: HOSTILE } });
    expect(res.status).toBe(403);
    expect(await res.text()).toBe('cross-origin websocket rejected');

    const { opened, firstMessage } = await connect(HOSTILE);
    expect(opened).toBe(false);
    expect(firstMessage).toBeNull();
  });

  it('still accepts the desktop webview origin', async () => {
    const { opened, firstMessage } = await connect('tauri://localhost');
    expect(opened).toBe(true);
    expect(JSON.parse(firstMessage ?? '{}').type).toBe('hello');
  });

  it('still accepts the vite dev harness origin', async () => {
    const { opened, firstMessage } = await connect('http://localhost:5199');
    expect(opened).toBe(true);
    expect(JSON.parse(firstMessage ?? '{}').type).toBe('hello');
  });

  it('still accepts a non-browser client that sends no origin', async () => {
    const { opened, firstMessage } = await connect(null);
    expect(opened).toBe(true);
    expect(JSON.parse(firstMessage ?? '{}').type).toBe('hello');
  });
});
