import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-terminals-api-'));
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

function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (!headers.has('content-type'))
    headers.set('content-type', 'application/json');
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

function decode(base64: string): string {
  return Buffer.from(base64, 'base64').toString('utf8');
}

// Polls the session until it reports `exited`, so no assertion races a shell.
async function waitForExit(id: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const info = await json(await apiFetch(`/api/terminals/${id}`));
    if (info.state === 'exited') break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({ rootDir: root, port: 0 });
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

interface LoopWatch {
  // The longest gap between ticks of a 5 ms timer.
  worstGap: number;
  // Time the loop spent stalled: each gap's excess over 20 ms, summed.
  stalled: number;
  // The slowest /api/health round trip.
  worstHealth: number;
}

// Watches this process's event loop (the daemon's, in-process) while `during`
// runs, with /api/health probes alongside.
async function watchLoop(during: () => Promise<void>): Promise<LoopWatch> {
  let last = performance.now();
  const watch: LoopWatch = { worstGap: 0, stalled: 0, worstHealth: 0 };
  const ticker = setInterval(() => {
    const now = performance.now();
    watch.worstGap = Math.max(watch.worstGap, now - last);
    watch.stalled += Math.max(0, now - last - 20);
    last = now;
  }, 5);
  let probing = true;
  const probe = (async () => {
    while (probing) {
      const started = performance.now();
      await apiFetch('/api/health');
      watch.worstHealth = Math.max(
        watch.worstHealth,
        performance.now() - started
      );
    }
  })();
  await during();
  probing = false;
  await probe;
  clearInterval(ticker);
  return watch;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('terminal spawn load', () => {
  // A pty spawn on the event loop stalls it ~200 ms each: 20 stalled it 3.4 s
  // in all. The daemon stalls some on its own, more on a busy runner, so the
  // bounds are relative to its idle loop just before and just after.
  it('spawns 20 sessions without blocking the event loop', async () => {
    // The first terminal starts the helper process; measure the 20 after it.
    const warm = await apiFetch('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ command: ['true'] }),
    });
    await waitForExit((await json(warm)).id as string);
    // Long enough for every spawn and exit to happen inside the window; each
    // idle window is half as long.
    const WINDOW_MS = 6000;
    const before = await watchLoop(() => sleep(WINDOW_MS / 2));
    let created: Response[] = [];
    const load = await watchLoop(async () => {
      created = await Promise.all(
        Array.from({ length: 20 }, () =>
          apiFetch('/api/terminals', {
            method: 'POST',
            body: JSON.stringify({
              command: ['sh', '-c', 'echo up; sleep 0.2'],
            }),
          })
        )
      );
      await sleep(WINDOW_MS);
    });
    const after = await watchLoop(() => sleep(WINDOW_MS / 2));
    expect(created.every((r) => r.status === 201)).toBe(true);
    for (const r of created) {
      const id = (await json(r)).id as string;
      await waitForExit(id);
      const out = await json(await apiFetch(`/api/terminals/${id}/output`));
      expect(decode(out.data as string)).toContain('up');
    }
    const idle: LoopWatch = {
      worstGap: Math.max(before.worstGap, after.worstGap),
      stalled: 2 * Math.max(before.stalled, after.stalled),
      worstHealth: Math.max(before.worstHealth, after.worstHealth),
    };
    const ms = (n: number) => Math.round(n);
    const line = (w: LoopWatch) =>
      `gap ${ms(w.worstGap)} ms, stalled ${ms(w.stalled)} ms, health ${ms(w.worstHealth)} ms`;
    console.log(`idle: ${line(idle)}; load: ${line(load)}`);
    // Stalls together stay under five spawns' worth beyond the idle loop's,
    // and no single one stands far above its worst (a lone gap is noisy).
    expect(load.stalled).toBeLessThan(1.5 * idle.stalled + 1000);
    expect(load.worstGap).toBeLessThan(2 * idle.worstGap + 250);
    expect(load.worstHealth).toBeLessThan(2 * idle.worstHealth + 500);
  }, 60_000);
});

// The terminal helper this daemon started (a child of this test process).
function helperPid(): number | null {
  const out = Bun.spawnSync([
    'pgrep',
    '-P',
    String(process.pid),
    '-f',
    'terminalHostMain',
  ])
    .stdout.toString()
    .trim();
  return out === '' ? null : Number(out.split('\n')[0]);
}

function rssMb(pid: number): number {
  const kb = Bun.spawnSync([
    'ps',
    '-o',
    'rss=',
    '-p',
    String(pid),
  ]).stdout.toString();
  return Number(kb.trim()) / 1024;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function outputOf(id: string): Promise<string> {
  const out = await json(await apiFetch(`/api/terminals/${id}/output`));
  return decode(out.data as string);
}

describe('terminal helper under floods', () => {
  it('keeps its memory bounded across 40 floods that are deleted mid-stream', async () => {
    // Eight at a time, so output arrives faster than the daemon takes it in.
    for (let round = 0; round < 5; round++) {
      const ids = await Promise.all(
        Array.from({ length: 8 }, async () => {
          const created = await apiFetch('/api/terminals', {
            method: 'POST',
            body: JSON.stringify({
              command: [
                'sh',
                '-c',
                'head -c 1600000 /dev/zero | tr "\\0" x; sleep 5',
              ],
            }),
          });
          return ((await json(created)) as { id: string }).id;
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      for (const id of ids)
        await apiFetch(`/api/terminals/${id}`, { method: 'DELETE' });
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const pid = helperPid();
    expect(pid).not.toBeNull();
    const rss = rssMb(pid ?? 0);
    console.log(`helper rss ${Math.round(rss)} MB`);
    expect(rss).toBeLessThan(150);
  }, 120_000);

  // Before output was capped and taken in turns, a flood queued without bound
  // and held a short session's output back 2-10 s. The bound scales from
  // the same session's latency beside 3 sessions that burn CPU but print
  // nothing, so a slow or busy runner moves the baseline, not the verdict.
  it("delivers a short session's output within twice its quiet-load time plus 500 ms while 3 sessions flood", async () => {
    const start = async (script: string): Promise<string> =>
      (
        (await json(
          await apiFetch('/api/terminals', {
            method: 'POST',
            body: JSON.stringify({ command: ['sh', '-c', script] }),
          })
        )) as { id: string }
      ).id;
    // Spawns `echo quick-one` and returns how long its output took to arrive.
    // The child outlives its output: on macOS a pty child exiting with output
    // unread can wedge the helper in wait4, a separate bug this does not test.
    const quickLatency = async (): Promise<number> => {
      const started = performance.now();
      const id = await start('echo quick-one; sleep 1');
      let seen = '';
      while (
        !seen.includes('quick-one') &&
        performance.now() - started < 10_000
      ) {
        seen = await outputOf(id);
        await sleep(20);
      }
      expect(seen).toContain('quick-one');
      return performance.now() - started;
    };
    // Starts three sessions running `script` and lets them run for 2 s: an
    // unbounded queue grows with a flood's length, a fair one does not.
    const three = async (script: string): Promise<string[]> => {
      const ids = await Promise.all([1, 2, 3].map(() => start(script)));
      await sleep(2000);
      return ids;
    };
    const stop = async (ids: string[]): Promise<void> => {
      for (const id of ids)
        await apiFetch(`/api/terminals/${id}`, { method: 'DELETE' });
    };
    // The burners also start the helper; the better of two is the baseline.
    const burners = await three('yes flood > /dev/null');
    const quiet = Math.min(await quickLatency(), await quickLatency());
    await stop(burners);
    const floods = await three('yes flood');
    const flooded = await quickLatency();
    await stop(floods);
    console.log(
      `quick output: ${Math.round(quiet)} ms beside quiet load, ${Math.round(flooded)} ms beside floods`
    );
    expect(flooded).toBeLessThan(2 * quiet + 500);
  }, 60_000);
});

describe('stubborn sessions', () => {
  const stubborn = async (): Promise<{ id: string; pid: number }> => {
    const created = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({
          command: ['sh', '-c', 'trap "" TERM HUP; echo pid=$$; sleep 60'],
        }),
      })
    );
    let text = '';
    for (let i = 0; i < 200 && !/pid=\d+/.test(text); i++) {
      text = await outputOf(created.id as string);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      id: created.id as string,
      pid: Number(/pid=(\d+)/.exec(text)?.[1]),
    };
  };
  const goneWithin = async (pid: number, ms: number): Promise<boolean> => {
    const deadline = performance.now() + ms;
    while (performance.now() < deadline) {
      if (!alive(pid)) return true;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return !alive(pid);
  };

  it('a DELETE kills a session that ignores TERM and HUP', async () => {
    const { id, pid } = await stubborn();
    expect(alive(pid)).toBe(true);
    await apiFetch(`/api/terminals/${id}`, { method: 'DELETE' });
    expect(await goneWithin(pid, 5000)).toBe(true);
  }, 30_000);

  it('a stopped daemon takes such a session down with it', async () => {
    const { pid } = await stubborn();
    await handle.stop();
    handle = await startServer({ rootDir: root, port: 0 });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    expect(await goneWithin(pid, 5000)).toBe(true);
  }, 30_000);
});

describe('terminal routes', () => {
  it('opens a session in the project root and lists it', async () => {
    const created = await apiFetch('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({
        command: ['sh', '-c', 'echo ready'],
        title: 'probe',
      }),
    });
    expect(created.status).toBe(201);
    const info = await json(created);
    expect(info.cwd).toBe(root);
    expect(info.title).toBe('probe');

    const listed = await json(await apiFetch('/api/terminals'));
    expect(listed.map((t: { id: string }) => t.id)).toEqual([info.id]);
  });

  it('serves output from a cursor and advances it', async () => {
    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ command: ['sh', '-c', 'echo marker-one'] }),
      })
    );
    await waitForExit(info.id);

    const first = await json(
      await apiFetch(`/api/terminals/${info.id}/output?since=0`)
    );
    expect(decode(first.data)).toContain('marker-one');
    expect(first.more).toBe(false);

    // Resuming from the end of the last read returns nothing new.
    const second = await json(
      await apiFetch(`/api/terminals/${info.id}/output?since=${first.next}`)
    );
    expect(decode(second.data)).toBe('');
  });

  it('accepts keystrokes and echoes them back through the shell', async () => {
    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ command: ['sh'] }),
      })
    );
    const typed = await apiFetch(`/api/terminals/${info.id}/input`, {
      method: 'POST',
      body: JSON.stringify({ data: 'echo typed-it-in\n' }),
    });
    expect(typed.status).toBe(200);

    let seen = '';
    for (let i = 0; i < 200; i++) {
      const out = await json(
        await apiFetch(`/api/terminals/${info.id}/output?since=0`)
      );
      seen = decode(out.data);
      if (seen.includes('typed-it-in')) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(seen).toContain('typed-it-in');
  });

  it('records a resize', async () => {
    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ command: ['sh'], cols: 80, rows: 24 }),
      })
    );
    const resized = await json(
      await apiFetch(`/api/terminals/${info.id}/resize`, {
        method: 'POST',
        body: JSON.stringify({ cols: 160, rows: 48 }),
      })
    );
    expect(resized.cols).toBe(160);
    expect(resized.rows).toBe(48);
  });

  it('409s input to a session that has already exited', async () => {
    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ command: ['sh', '-c', 'exit 0'] }),
      })
    );
    await waitForExit(info.id);
    const res = await apiFetch(`/api/terminals/${info.id}/input`, {
      method: 'POST',
      body: JSON.stringify({ data: 'ls\n' }),
    });
    // Not a 404: the id is real, there is just nothing on the other end.
    expect(res.status).toBe(409);
  });

  it('deletes a session and forgets its scrollback', async () => {
    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ command: ['sh'] }),
      })
    );
    expect(
      (await apiFetch(`/api/terminals/${info.id}`, { method: 'DELETE' })).status
    ).toBe(200);
    expect((await apiFetch(`/api/terminals/${info.id}`)).status).toBe(404);
  });

  it('404s an unknown id', async () => {
    expect((await apiFetch('/api/terminals/nope')).status).toBe(404);
    expect((await apiFetch('/api/terminals/nope/output')).status).toBe(404);
  });

  it('rejects a cwd outside the project', async () => {
    const res = await apiFetch('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ cwd: '../../etc', command: ['sh'] }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('inside the project');
  });

  it('rejects a run with no worktree on disk', async () => {
    const res = await apiFetch('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ runId: 'run-that-never-was' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('no worktree');
  });

  it('validates the body', async () => {
    const badCommand = await apiFetch('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ command: 'sh' }),
    });
    expect(badCommand.status).toBe(400);

    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ command: ['sh'] }),
      })
    );
    const badInput = await apiFetch(`/api/terminals/${info.id}/input`, {
      method: 'POST',
      body: JSON.stringify({ data: 42 }),
    });
    expect(badInput.status).toBe(400);
  });

  // The security property these routes are built around: a terminal is
  // arbitrary command execution, so the agent token must not reach it.
  it('refuses the agent token and accepts only the app token', async () => {
    const withAgentToken = await rawFetch(`${baseUrl}/api/terminals`, {
      headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
    });
    expect(withAgentToken.status).toBe(403);

    const withAppToken = await rawFetch(`${baseUrl}/api/terminals`, {
      headers: { authorization: `Bearer ${handle.tokens.appToken}` },
    });
    expect(withAppToken.status).toBe(200);

    const spawnAttempt = await rawFetch(`${baseUrl}/api/terminals`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${handle.tokens.agentToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ command: ['sh'] }),
    });
    expect(spawnAttempt.status).toBe(403);
  });
});

// Remote sessions. The ssh invocation itself is covered in ssh.test.ts; this
// is about the route accepting a remote, validating it against config, and
// recording the session as remote.
describe('remote terminals', () => {
  function writeRemotesConfig(body: string): void {
    writeFileSync(join(root, '.dispatch', 'config.yml'), body);
  }

  it('lists no remotes when none are configured', async () => {
    expect(await json(await apiFetch('/api/remotes'))).toEqual([]);
  });

  it('lists configured remotes without leaking the identity file', async () => {
    // A key path is a local detail of whoever runs the daemon.
    writeRemotesConfig(
      'remotes:\n  box:\n    host: build-box\n    user: ci\n    path: /srv/repo\n    identityFile: /keys/id\n'
    );
    const remotes = await json(await apiFetch('/api/remotes'));
    expect(remotes).toEqual([
      {
        name: 'box',
        host: 'build-box',
        user: 'ci',
        port: null,
        path: '/srv/repo',
      },
    ]);
    expect(JSON.stringify(remotes)).not.toContain('/keys/id');
  });

  it('400s a remote that is not configured, naming the ones that are', async () => {
    writeRemotesConfig('remotes:\n  box:\n    host: build-box\n');
    const res = await apiFetch('/api/terminals', {
      method: 'POST',
      body: JSON.stringify({ remote: 'nonesuch' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('box');
  });

  it('opens a session against a configured remote and records it as remote', async () => {
    // `build-box` does not resolve, so the ssh process fails — which is fine:
    // what is asserted here is that the route built a remote session at all.
    writeRemotesConfig(
      'remotes:\n  box:\n    host: build-box\n    path: /srv/repo\n'
    );
    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ remote: 'box' }),
      })
    );
    expect(info.remote).toBe('box');
    expect(info.command[0]).toBe('ssh');
    // ssh allocates the pty on the far side, so the command is NOT wrapped in
    // `script` — two nested ptys would double every echo.
    expect(info.command).not.toContain('script');
    expect(info.command.join(' ')).toContain('build-box');
    expect(info.title).toBe('box');
  });

  it('runs a named command on the remote instead of a login shell', async () => {
    // Passing a command alongside a remote must not be silently dropped.
    writeRemotesConfig('remotes:\n  box:\n    host: build-box\n');
    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ remote: 'box', command: ['pnpm', 'test'] }),
      })
    );
    expect(info.command[0]).toBe('ssh');
    expect(info.command.join(' ')).toContain("'pnpm' 'test'");
    expect(info.title).toContain('pnpm test');
  });

  it('marks a local session as not remote', async () => {
    const info = await json(
      await apiFetch('/api/terminals', {
        method: 'POST',
        body: JSON.stringify({ command: ['sh'] }),
      })
    );
    expect(info.remote).toBeNull();
  });
});
