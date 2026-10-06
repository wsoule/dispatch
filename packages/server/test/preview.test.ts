import type { DispatchConfig } from '@dispatch-foo/core';
import { beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { PreviewSpawn } from '../src/preview.js';
import { PreviewSupervisor } from '../src/preview.js';

// A worktree with a package.json the detector can read. `scripts` defaults to
// a vite dev script, which is the case most tests want.
function worktree(scripts: Record<string, string> = { dev: 'vite' }): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-preview-wt-'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts }));
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  return dir;
}

// Only the fields previewSettings reads; the rest of DispatchConfig never
// reaches the supervisor.
function config(preview?: Partial<DispatchConfig['preview']>): DispatchConfig {
  return { preview } as DispatchConfig;
}

/** A spawn seam that records what it was asked to run and hands back a handle
 *  whose kill() is observable. `exit` lets a test kill the process from the
 *  outside, the way a crashing dev server would. */
function fakeSpawn(): {
  spawn: PreviewSpawn;
  calls: { command: string; cwd: string; env: Record<string, string> }[];
  killed: number;
  exit: (code: number | null) => void;
} {
  const record = {
    calls: [] as {
      command: string;
      cwd: string;
      env: Record<string, string>;
    }[],
    killed: 0,
    exit: (_code: number | null) => {},
    spawn: (() => ({ kill: () => {} })) as PreviewSpawn,
  };
  record.spawn = (input) => {
    record.calls.push({
      command: input.command,
      cwd: input.cwd,
      env: input.env,
    });
    record.exit = input.onExit;
    return {
      kill: () => {
        record.killed += 1;
      },
    };
  };
  return record;
}

// A clock the test drives. `sleep` advances it, so a readiness loop that waits
// really does reach its deadline without the test waiting on a real timer.
function fakeClock(start = Date.parse('2026-09-22T12:00:00.000Z')) {
  let ms = start;
  return {
    now: () => new Date(ms),
    advance: (by: number) => {
      ms += by;
    },
    sleep: (by: number) => {
      ms += by;
      return Promise.resolve();
    },
  };
}

let port = 4400;
beforeEach(() => {
  port += 1;
});

function supervisor(
  over: Partial<{
    cfg: DispatchConfig;
    spawn: PreviewSpawn;
    probe: (p: number) => Promise<boolean>;
    clock: ReturnType<typeof fakeClock>;
  }> = {}
) {
  const clock = over.clock ?? fakeClock();
  const spawned = fakeSpawn();
  const sup = new PreviewSupervisor({
    loadConfig: () => over.cfg ?? config(),
    spawn: over.spawn ?? spawned.spawn,
    probe: over.probe ?? (() => Promise.resolve(true)),
    allocatePort: () => port,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { sup, spawned, clock };
}

describe('PreviewSupervisor.ensure', () => {
  test('starts the detected dev server and reports it ready', async () => {
    const { sup, spawned } = supervisor();
    const dir = worktree();

    const result = await sup.ensure('r-1', dir);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.status).toBe('ready');
    // Clients get a daemon-relative URL, never the dev server's own port.
    expect(result.preview.url).toBe('/preview/r-1/');
    expect(spawned.calls).toHaveLength(1);
    expect(spawned.calls[0].cwd).toBe(dir);
    // Detected from the worktree's own package.json and lockfile.
    expect(spawned.calls[0].command).toBe(
      `pnpm run dev -- --port ${port} --strictPort`
    );
    expect(spawned.calls[0].env.PORT).toBe(String(port));
  });

  test('a second caller joins the running preview instead of starting another', async () => {
    const { sup, spawned } = supervisor();
    const dir = worktree();

    const first = await sup.ensure('r-1', dir);
    const second = await sup.ensure('r-1', dir);

    // Two reviewers opening the same run must not get two dev servers.
    expect(spawned.calls).toHaveLength(1);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.preview.port).toBe(first.preview.port);
  });

  test('prefers a configured command over detection', async () => {
    const { sup, spawned } = supervisor({
      cfg: config({ command: 'make serve' }),
    });

    await sup.ensure('r-1', worktree());

    expect(spawned.calls[0].command).toBe('make serve');
  });

  test('installs first when the fresh worktree has no node_modules', async () => {
    const { sup, spawned } = supervisor({
      cfg: config({ command: 'vite', installCommand: 'pnpm install' }),
    });

    await sup.ensure('r-1', worktree());

    // A run's worktree is a fresh checkout, so without this most dev servers
    // cannot boot at all.
    expect(spawned.calls[0].command).toBe('pnpm install && vite');
  });

  test('skips the install when the worktree already has dependencies', async () => {
    const { sup, spawned } = supervisor({
      cfg: config({ command: 'vite', installCommand: 'pnpm install' }),
    });
    const dir = worktree();
    mkdirSync(join(dir, 'node_modules'));

    await sup.ensure('r-1', dir);

    expect(spawned.calls[0].command).toBe('vite');
  });

  test('refuses when previews are switched off', async () => {
    const { sup, spawned } = supervisor({ cfg: config({ enabled: false }) });

    const result = await sup.ensure('r-1', worktree());

    expect(result).toEqual({ ok: false, refusal: { reason: 'disabled' } });
    expect(spawned.calls).toHaveLength(0);
  });

  test('refuses a repo with no dev script, without calling it a failure', async () => {
    const { sup } = supervisor();

    const result = await sup.ensure('r-1', worktree({ build: 'tsc' }));

    // An ordinary fact about a library or a non-JS repo, not a fault.
    expect(result).toEqual({ ok: false, refusal: { reason: 'no-command' } });
  });

  test('refuses a worktree that has already been cleaned up', async () => {
    const { sup } = supervisor();

    const result = await sup.ensure('r-1', join(tmpdir(), 'gone-49f2a1'));

    expect(result).toEqual({ ok: false, refusal: { reason: 'no-worktree' } });
  });

  test('fails the preview when the dev server never answers', async () => {
    const { sup, spawned } = supervisor({
      cfg: config({ readyTimeoutSec: 5 }),
      probe: () => Promise.resolve(false),
    });

    const result = await sup.ensure('r-1', worktree());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.status).toBe('failed');
    expect(result.preview.error).toContain('within 5s');
    // A preview that timed out must not leave its process running.
    expect(spawned.killed).toBe(1);
  });

  test('fails the preview when the command dies before it is ready', async () => {
    const spawned = fakeSpawn();
    const clock = fakeClock();
    const sup = new PreviewSupervisor({
      loadConfig: () => config({ readyTimeoutSec: 30 }),
      spawn: spawned.spawn,
      // Never answers, so the exit below is what ends the wait.
      probe: () => Promise.resolve(false),
      allocatePort: () => port,
      now: clock.now,
      sleep: (ms) => {
        // The dev server dies partway through the first wait.
        clock.advance(ms);
        spawned.exit(1);
        return Promise.resolve();
      },
    });

    const result = await sup.ensure('r-1', worktree());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.preview.status).toBe('failed');
    expect(result.preview.error).toBe('preview command exited with code 1');
  });

  test('a failed preview is retried by the next ensure', async () => {
    const spawned = fakeSpawn();
    const clock = fakeClock();
    let answering = false;
    const sup = new PreviewSupervisor({
      loadConfig: () => config({ readyTimeoutSec: 1 }),
      spawn: spawned.spawn,
      probe: () => Promise.resolve(answering),
      allocatePort: () => port,
      now: clock.now,
      sleep: clock.sleep,
    });
    const dir = worktree();

    const failed = await sup.ensure('r-1', dir);
    expect(failed.ok && failed.preview.status).toBe('failed');

    answering = true;
    const retried = await sup.ensure('r-1', dir);

    expect(retried.ok && retried.preview.status).toBe('ready');
    expect(spawned.calls).toHaveLength(2);
  });
});

describe('PreviewSupervisor lifecycle', () => {
  test('stop kills the process and forgets the preview', async () => {
    const { sup, spawned } = supervisor();
    await sup.ensure('r-1', worktree());

    sup.stop('r-1');

    expect(spawned.killed).toBe(1);
    expect(sup.get('r-1')).toBeUndefined();
  });

  test('stopping a run with no preview is a no-op', () => {
    const { sup } = supervisor();
    expect(() => sup.stop('r-nothing')).not.toThrow();
  });

  test('stopAll clears everything the daemon is holding', async () => {
    const { sup, spawned } = supervisor();
    await sup.ensure('r-1', worktree());
    await sup.ensure('r-2', worktree());

    sup.stopAll();

    // A dev server that outlives the daemon holds a port nothing reclaims.
    expect(spawned.killed).toBe(2);
    expect(sup.list()).toEqual([]);
  });

  test('the idle sweep stops a preview nobody is looking at', async () => {
    const clock = fakeClock();
    const { sup, spawned } = supervisor({
      cfg: config({ idleTimeoutSec: 60 }),
      clock,
    });
    await sup.ensure('r-1', worktree());

    clock.advance(61_000);
    const swept = sup.sweepIdle();

    expect(swept).toEqual(['r-1']);
    expect(spawned.killed).toBe(1);
  });

  test('touch keeps a preview someone is still using alive', async () => {
    const clock = fakeClock();
    const { sup } = supervisor({ cfg: config({ idleTimeoutSec: 60 }), clock });
    await sup.ensure('r-1', worktree());

    clock.advance(50_000);
    sup.touch('r-1');
    clock.advance(50_000);

    // 100s since it started, but only 50s since the last proxied request.
    expect(sup.sweepIdle()).toEqual([]);
    expect(sup.get('r-1')?.status).toBe('ready');
  });

  test('touching an unknown run does not invent a preview', () => {
    const { sup } = supervisor();
    sup.touch('r-nothing');
    expect(sup.list()).toEqual([]);
  });
});
