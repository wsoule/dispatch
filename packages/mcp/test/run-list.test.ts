import { TaskStore } from '@dispatch/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { isDaemonHealthy, readDaemonFile } from '../src/daemon.js';
import { createDispatchMcpServer } from '../src/index.js';

// Resolves dispatchd's bin script the same way `dispatch ui`/`dispatch serve`
// do (packages/cli/src/commands/daemon.ts's `resolveDaemonBin`): via Node's
// own module resolution against `@dispatch/server`'s one exported subpath
// (`./package.json` — the package is Bun-only, so nothing else in it is
// statically importable), never a hardcoded relative path. `@dispatch/mcp`
// only needs this for its own tests — run_list itself never imports
// `@dispatch/server`, only ever talks to a running daemon over HTTP — hence
// the workspace dependency living in devDependencies.
function resolveDaemonBin(): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/server/package.json'
  );
  return join(dirname(pkgJsonPath), 'src', 'bin.ts');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Dispatching a run provisions a real git worktree (packages/server/src/
// orchestrator/worktree.ts), which needs a real repo with at least one
// commit underneath — bare TaskStore.init() alone isn't enough for the
// live-daemon test below to actually get past `POST .../runs`.
function initGitRepo(dir: string): void {
  Bun.spawnSync(['git', 'init', '-b', 'main'], { cwd: dir });
  Bun.spawnSync(['git', 'config', 'user.email', 'test@example.com'], {
    cwd: dir,
  });
  Bun.spawnSync(['git', 'config', 'user.name', 'Test'], { cwd: dir });
  Bun.spawnSync(['git', 'commit', '--allow-empty', '-m', 'initial commit'], {
    cwd: dir,
  });
}

// Polls this test's own DISPATCH_HOME-scoped daemon file + health check
// until dispatchd finishes booting (or `timeoutMs` elapses), reusing the
// exact reader under test rather than a second copy of the same logic.
async function waitForHealthyPort(
  rootDir: string,
  timeoutMs = 5000
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = readDaemonFile(rootDir);
    if (info !== null && (await isDaemonHealthy(info.port))) return info.port;
    await sleep(50);
  }
  throw new Error('dispatchd did not become healthy in time');
}

async function connectClient(rootDir: string): Promise<Client> {
  const server = createDispatchMcpServer(rootDir);
  const client = new Client({ name: 'test-client', version: '1.0' });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  return client;
}

interface ToolCallResult {
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  content: { type: string; text?: string }[];
}

let fakeHome: string;
let root: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-mcp-runs-'));
  initGitRepo(root);
  TaskStore.init(root);
});

afterEach(() => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('run_list (no daemon running)', () => {
  it('returns an empty list with a note instead of an error', async () => {
    const client = await connectClient(root);
    const result = (await client.callTool({
      name: 'run_list',
      arguments: {},
    })) as ToolCallResult;
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      runs: [],
      note: 'dispatchd not running',
    });
  });

  it('is annotated read-only', async () => {
    const server = createDispatchMcpServer(root);
    const client = new Client({ name: 'test-client', version: '1.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
    const { tools } = await client.listTools();
    const runList = tools.find((t) => t.name === 'run_list');
    expect(runList?.annotations?.readOnlyHint).toBe(true);
  });
});

describe('run_list (live daemon)', () => {
  it('proxies GET /api/runs from a real dispatchd', async () => {
    const binPath = resolveDaemonBin();
    // Phase 7: production dispatchd only ever registers the real 'claude'
    // executor by default — `DISPATCH_ENABLE_FAKES=1` is what additionally
    // registers a scripted 'fake' one (see bin.ts's own doc comment), which
    // this test needs so it can dispatch a real run without constructing a
    // real Agent SDK session.
    const child = Bun.spawn(['bun', binPath, '--root', root, '--port', '0'], {
      env: {
        ...process.env,
        DISPATCH_HOME: fakeHome,
        DISPATCH_ENABLE_FAKES: '1',
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    try {
      const port = await waitForHealthyPort(root);

      const client = await connectClient(root);
      const empty = (await client.callTool({
        name: 'run_list',
        arguments: {},
      })) as ToolCallResult;
      expect(empty.isError).toBeUndefined();
      expect(empty.structuredContent?.runs).toEqual([]);
      expect(empty.structuredContent?.note).toBeUndefined();

      // Dispatch a real run against the live daemon using the 'fake'
      // executor DISPATCH_ENABLE_FAKES=1 registered above — a scripted
      // stand-in alongside the real 'claude' one (see bin.ts) — so this
      // proves the run_list proxy round-trip against a real /api/runs
      // response without ever constructing a real Agent SDK session.
      const baseUrl = `http://127.0.0.1:${port}`;
      const taskRes = await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'Dispatch for run_list smoke' }),
      });
      const task = (await taskRes.json()) as { meta: { id: string } };
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      });

      const withRun = (await client.callTool({
        name: 'run_list',
        arguments: {},
      })) as ToolCallResult;
      expect(withRun.isError).toBeUndefined();
      const runs = withRun.structuredContent?.runs as Record<string, unknown>[];
      expect(runs.some((r) => r.taskId === task.meta.id)).toBe(true);
    } finally {
      child.kill();
      await child.exited;
    }
  }, 15000);
});
