import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, expect, setDefaultTimeout } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { initGitRepo } from '../orchestrator/helpers.js';
import { rawFetch } from '../testAuth.js';
import { freePort } from './seed.js';

export interface Daemon {
  handle: ServerHandle;
  root: string;
  api: string;
  listener: string;
  // An /api call as the owner (the operator tier), or with `token`.
  call(
    path: string,
    init?: { method?: string; body?: unknown; token?: string }
  ): Promise<Response>;
}

interface DaemonOptions {
  noticeBackoffMs?: number[];
}

// Two or more in-process daemons, each on its own scratch root with its A2A
// listener open on loopback, sharing one scratch DISPATCH_HOME per test.
// Sets the calling file's test timeout: each daemon is a git init plus a full
// boot, 1-2 s apiece on macOS and past bun's 5 s default for two under load.
export function useDaemons() {
  setDefaultTimeout(30_000);
  let home: string;
  let daemons: Daemon[] = [];
  const stopped = new Set<Daemon>();
  const originalHome = process.env.DISPATCH_HOME;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-pairing-home-')));
    process.env.DISPATCH_HOME = home;
    daemons = [];
    stopped.clear();
  });
  afterEach(async () => {
    for (const d of daemons) {
      if (!stopped.has(d)) await d.handle.stop();
      rmSync(d.root, { recursive: true, force: true });
    }
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  async function start(root: string, options: DaemonOptions) {
    return startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      webDistDir: null,
      ...(options.noticeBackoffMs === undefined
        ? {}
        : { a2aNoticeBackoffMs: options.noticeBackoffMs }),
    });
  }

  function caller(d: Pick<Daemon, 'handle'>): Daemon['call'] {
    return (path, init = {}) =>
      rawFetch(`http://127.0.0.1:${d.handle.port}${path}`, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${init.token ?? d.handle.tokens.appToken}`,
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      });
  }

  async function daemon(
    prefix: string,
    options: DaemonOptions = {}
  ): Promise<Daemon> {
    const root = initGitRepo(prefix);
    TaskStore.init(root);
    const handle = await start(root, options);
    const d = {
      handle,
      root,
      api: `http://127.0.0.1:${handle.port}`,
      listener: '',
      call: undefined as unknown as Daemon['call'],
    };
    d.call = caller(d);
    const port = await freePort();
    const put = await d.call('/api/a2a/listener', {
      method: 'PUT',
      body: { enabled: true, host: '127.0.0.1', port },
    });
    expect(put.status).toBe(200);
    d.listener = `http://127.0.0.1:${port}`;
    daemons.push(d);
    return d;
  }

  async function stop(d: Daemon): Promise<void> {
    await d.handle.stop();
    stopped.add(d);
  }

  // Stops and starts the daemon on the same root; its listener reopens on
  // the port its settings name.
  async function restart(d: Daemon, options: DaemonOptions = {}) {
    if (!stopped.has(d)) await d.handle.stop();
    d.handle = await start(d.root, options);
    d.api = `http://127.0.0.1:${d.handle.port}`;
    stopped.delete(d);
  }

  async function offer(a: Daemon, alias = 'bob', token?: string) {
    const res = await a.call('/api/a2a/pairings', {
      body: { alias },
      ...(token === undefined ? {} : { token }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as {
      id: string;
      code: string;
      fingerprint: string;
      expiresAt: string;
    };
  }

  const accept = (b: Daemon, code: string, alias = 'alice', token?: string) =>
    b.call('/api/a2a/pairings/accept', {
      body: { code, alias },
      ...(token === undefined ? {} : { token }),
    });

  // Pairs A (offering, alias bob) with B (accepting, alias alice).
  async function paired(a: Daemon, b: Daemon, token?: string): Promise<void> {
    const { code } = await offer(a, 'bob', token);
    expect((await accept(b, code)).status).toBe(200);
  }

  return { daemon, stop, restart, offer, accept, paired };
}

export const ownerOf = async (d: Daemon): Promise<string> =>
  ((await (await d.call('/api/whoami')).json()) as { ref: string }).ref;

// A reader of the owner's notice bodies, newest last.
export async function noticesOf(d: Daemon): Promise<() => string[]> {
  const owner = await ownerOf(d);
  return () =>
    d.handle.messaging.engine
      .inbox(owner)
      .filter(({ message }) => message.kind === 'notice')
      .map(({ message }) => message.body);
}

export const clientOf = (d: Daemon, name: string) =>
  d.handle.a2a.store!.clients().find((c) => c.name === name)!;

export const agentStatus = (d: Daemon, name: string) =>
  d.handle.messaging.store.getAgent(clientOf(d, name).address)?.status;

export const pairingState = (d: Daemon) =>
  d.handle.a2a.store!.pairings()[0]?.state;
