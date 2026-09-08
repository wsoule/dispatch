import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { DaemonFileInfo } from '../src/daemon.js';
import {
  daemonFilePath,
  daemonRequest,
  DaemonUnreachableError,
  liveDaemon,
  REQUEST_TIMEOUT_MS,
} from '../src/daemon.js';

let fakeHome: string;
let rootDir: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

// A port that accepts every connection and answers none of them — the shape
// of the 2026-08-23 daemon, alive with a blocked event loop.
let stalled: ReturnType<typeof Bun.serve>;
let stalledPort: number;
const pending: ((r: Response) => void)[] = [];

function daemonInfo(): DaemonFileInfo {
  return {
    rootDir,
    port: stalledPort,
    pid: process.pid,
    startedAt: '2026-08-23T01:20:27Z',
    agentToken: 'c'.repeat(64),
  };
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-mcp-deadline-'));
  process.env.DISPATCH_HOME = fakeHome;
  rootDir = join(fakeHome, 'project');
  stalled = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => new Promise<Response>((resolve) => pending.push(resolve)),
  });
  stalledPort = stalled.port ?? 0;
  const path = daemonFilePath(rootDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(daemonInfo()));
});

afterEach(async () => {
  for (const resolve of pending.splice(0)) resolve(new Response('late'));
  await stalled.stop(true);
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

describe('daemon deadlines', () => {
  it('liveDaemon gives up on a daemon that accepts but never answers', async () => {
    const started = Date.now();
    const live = await liveDaemon(rootDir, 200);
    expect(live).toBeNull();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it('daemonRequest turns a stalled daemon into DaemonUnreachableError', async () => {
    const started = Date.now();
    await expect(
      daemonRequest(daemonInfo(), '/api/runs', {
        signal: AbortSignal.timeout(200),
      })
    ).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  // The default is 30s, far too long to wait out in a unit test, so this
  // inspects the signal handed to fetch rather than the elapsed time. Without
  // it a wedged daemon holds the tool for the MCP client's own ceiling —
  // 1800s on 2026-08-23.
  it('attaches its own deadline signal when the caller passes none', async () => {
    const realFetch = globalThis.fetch;
    const signals: (AbortSignal | null | undefined)[] = [];
    globalThis.fetch = ((_input: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return Promise.resolve(new Response('{}'));
    }) as typeof fetch;
    try {
      await daemonRequest(daemonInfo(), '/api/runs');
      const own = AbortSignal.timeout(200);
      await daemonRequest(daemonInfo(), '/api/runs', { signal: own });
      expect(signals[0]).toBeInstanceOf(AbortSignal);
      expect(signals[0]?.aborted).toBe(false);
      // A caller that brought its own deadline keeps it.
      expect(signals[1]).toBe(own);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('bounds an ordinary request well under the MCP client idle ceiling', () => {
    expect(REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(REQUEST_TIMEOUT_MS).toBeLessThan(120_000);
  });
});
