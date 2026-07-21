import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import type { ChildProcessByStdio } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';

// The heart of Phase 7: every test below drives the BUILT CLI
// (`dist/cli.js`, built by `bun run build` before `bun run test` — same
// assumption ../test/e2e.test.ts already makes) as real subprocesses
// against a REAL spawned dispatchd (`packages/server/src/bin.ts`, run
// directly by `bun`, never faked at this level) with
// `DISPATCH_ENABLE_FAKES=1`/`DISPATCH_FAKE_APPROVAL=1` — the Phase 7 e2e
// hook (see bin.ts's own doc comment). Nothing here imports any CLI or
// server module directly; everything goes through process boundaries and
// real HTTP/WS, exactly like a human running these commands in a terminal.

const CLI_BIN = resolve(import.meta.dirname, '../dist/cli.js');
const SERVER_BIN = resolve(import.meta.dirname, '../../server/src/bin.ts');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// `realpathSync` matters here: every CLI subprocess below is spawned with
// `cwd: repo`, and a spawned process's OWN `process.cwd()` (what
// `ctx.cwd`/`ensureDaemon`'s daemon-file hash actually key off) is always
// the kernel's canonicalized getcwd() result — `/private/var/...` on macOS,
// never the `/var/...` symlink `os.tmpdir()` itself returns. If the daemon
// were started with the UNresolved path as `--root` while the CLI computed
// its hash from the resolved one, `daemonFileKey` would differ between the
// two and every command below would silently autostart its OWN
// fakes-disabled daemon instead of finding this suite's real one.
// Resolving once, up front, and using that same resolved string everywhere
// (git commands, `--root`, and every subprocess's `cwd`) keeps both sides
// in agreement.
function initGitRepo(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  for (const args of [
    ['init', '-q', '-b', 'main'],
    ['config', 'user.email', 'test@example.com'],
    ['config', 'user.name', 'Test'],
  ]) {
    Bun.spawnSync({ cmd: ['git', ...args], cwd: dir });
  }
  return dir;
}

function commitAll(dir: string, message: string): void {
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: dir });
  Bun.spawnSync({ cmd: ['git', 'commit', '-q', '-m', message], cwd: dir });
}

// Runs the built CLI once as a subprocess and returns its full result —
// callers decide whether a non-zero exit is expected.
function runCli(
  args: string[],
  env: { cwd: string; dispatchHome: string; extra?: Record<string, string> }
): { stdout: string; stderr: string; code: number } {
  const proc = Bun.spawnSync({
    cmd: ['node', CLI_BIN, ...args],
    cwd: env.cwd,
    env: {
      ...process.env,
      DISPATCH_HOME: env.dispatchHome,
      ...env.extra,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
    code: proc.exitCode ?? 1,
  };
}

// Spawns a real dispatchd, waits for it to print its listening port, and
// returns the child process handle plus that port.
async function spawnDaemon(
  rootDir: string,
  dispatchHome: string,
  extraEnv: Record<string, string> = {}
): Promise<{
  proc: ChildProcessByStdio<null, Readable, Readable>;
  port: number;
}> {
  const proc = spawn('bun', [SERVER_BIN, '--root', rootDir, '--port', '0'], {
    env: { ...process.env, DISPATCH_HOME: dispatchHome, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const port = await new Promise<number>((resolvePort, reject) => {
    let buf = '';
    const timer = setTimeout(
      () => reject(new Error('dispatchd did not report a port in time')),
      10_000
    );
    proc.stdout.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const match = buf.match(/listening on http:\/\/127\.0\.0\.1:(\d+)/);
      if (match !== null) {
        clearTimeout(timer);
        resolvePort(Number(match[1]));
      }
    });
    proc.on('error', reject);
  });
  return { proc, port };
}

// Runs the built CLI once as a subprocess with a hard timeout: if the
// process is still alive once `timeoutMs` elapses, it's force-killed and
// `timedOut` comes back true — used by the C1/I2 regression tests below so
// a reintroduced hang fails the test itself (quickly) instead of hanging
// the whole test run indefinitely.
async function runCliBounded(
  args: string[],
  env: { cwd: string; dispatchHome: string; extra?: Record<string, string> },
  timeoutMs: number
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
}> {
  const proc = Bun.spawn({
    cmd: ['node', CLI_BIN, ...args],
    cwd: env.cwd,
    env: { ...process.env, DISPATCH_HOME: env.dispatchHome, ...env.extra },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { stdout, stderr, code, timedOut };
}

interface RunMetaLike {
  id: string;
  taskId: string;
  state: string;
  reviewedAt?: string;
}

interface EpicProgressLike {
  active: boolean;
  children: { id: string; status: string }[];
  liveRuns: RunMetaLike[];
}

// ---------------------------------------------------------------------------
// Suite 1: the full headless loop against a shared long-lived fakes-enabled
// daemon — DISPATCH_ENABLE_FAKES=1 + DISPATCH_FAKE_APPROVAL=1, so every
// dispatched fake run pauses at exactly one approval gate before finishing.
// ---------------------------------------------------------------------------
describe('headless dispatcher loop (real daemon, built CLI subprocess)', () => {
  let repo: string;
  let dispatchHome: string;
  let daemon: ChildProcessByStdio<null, Readable, Readable>;

  function cli(...args: string[]): string {
    const result = runCli(args, { cwd: repo, dispatchHome });
    if (result.code !== 0) {
      const detail = result.stderr.length > 0 ? result.stderr : result.stdout;
      throw new Error(
        `dispatch ${args.join(' ')} exited ${result.code}: ${detail}`
      );
    }
    return result.stdout.trim();
  }

  beforeAll(async () => {
    repo = initGitRepo('dispatch-cli-e2e-');
    dispatchHome = mkdtempSync(join(tmpdir(), 'dispatch-cli-e2e-home-'));
    cli('init');
    commitAll(repo, 'init');

    const { proc } = await spawnDaemon(repo, dispatchHome, {
      DISPATCH_ENABLE_FAKES: '1',
      DISPATCH_FAKE_APPROVAL: '1',
    });
    daemon = proc;
  }, 20_000);

  afterAll(() => {
    daemon?.kill();
    rmSync(repo, { recursive: true, force: true });
    rmSync(dispatchHome, { recursive: true, force: true });
  });

  it('create -> run --watch (approval mid-run) -> diff -> review merge -> task done', async () => {
    const task = JSON.parse(
      cli('task', 'create', 'Headless widget', '--json')
    ) as { meta: { id: string } };
    const taskId = task.meta.id;

    const watch = spawn(
      'node',
      [CLI_BIN, 'run', taskId, '--executor', 'fake', '--watch'],
      {
        cwd: repo,
        env: { ...process.env, DISPATCH_HOME: dispatchHome },
      }
    );
    let stdout = '';
    watch.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    const deadline = Date.now() + 10_000;
    while (!stdout.includes('approval requested') && Date.now() < deadline) {
      await sleep(50);
    }
    expect(stdout).toContain('approval requested');
    const runIdMatch = stdout.match(/dispatched (r-[0-9a-f]+)/);
    expect(runIdMatch).not.toBeNull();
    const runId = runIdMatch![1];
    expect(stdout).toContain(`dispatch approve ${runId} fake-approval-1`);
    expect(stdout).toContain(
      `dispatch approve ${runId} fake-approval-1 --deny`
    );
    expect(stdout).toContain('[assistant] Looking at the task');

    // The scripted approval round-trip: a SECOND CLI invocation, entirely
    // separate from the still-running --watch subprocess above.
    expect(cli('approve', runId, 'fake-approval-1')).toBe(
      `${runId} approved (fake-approval-1)`
    );

    const exitCode = await new Promise<number>((resolveExit) => {
      watch.on('exit', (code) => resolveExit(code ?? -1));
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[assistant] Writing a change and committing it.');

    const diff = cli('diff', runId);
    expect(diff).toContain('FAKE_OUTPUT.txt');
    expect(diff).toContain('new file mode');

    const files = cli('diff', runId, '--files');
    expect(files).toContain('FAKE_OUTPUT.txt');

    expect(cli('review', runId, 'merge')).toBe(`${runId} reviewed: merge`);

    const tasks = JSON.parse(cli('task', 'list', '--json')) as {
      meta: { id: string; status: string };
    }[];
    const found = tasks.find((t) => t.meta.id === taskId);
    expect(found?.meta.status).toBe('done');
  }, 20_000);

  it('plan --planner fake --yes -> epic start -> completion', async () => {
    const planOut = JSON.parse(
      cli('plan', 'build something', '--planner', 'fake', '--yes', '--json')
    ) as { confirm: { epicId?: string; taskIds: string[] } };
    const epicId = planOut.confirm.epicId;
    expect(epicId).toBeDefined();
    expect(planOut.confirm.taskIds).toHaveLength(2);

    cli('epic', 'start', epicId!, '--executor', 'fake', '--concurrency', '2');

    // Drives the epic to completion by approving every awaiting-approval
    // live run and merging every finished-but-unreviewed one, exactly what
    // a human running these same commands by hand would do — until the
    // dispatch session reports itself inactive (spec: "no children left to
    // dispatch").
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const progress = JSON.parse(
        cli('epic', 'status', epicId!, '--json')
      ) as EpicProgressLike;
      if (!progress.active) break;

      for (const liveRun of progress.liveRuns) {
        if (liveRun.state === 'awaiting-approval') {
          cli('approve', liveRun.id, 'fake-approval-1');
        }
      }
      const runs = JSON.parse(cli('runs', '--json')) as RunMetaLike[];
      const childIds = new Set(progress.children.map((c) => c.id));
      for (const r of runs) {
        if (
          r.state === 'finished' &&
          r.reviewedAt === undefined &&
          childIds.has(r.taskId)
        ) {
          cli('review', r.id, 'merge');
        }
      }
      await sleep(300);
    }

    const finalProgress = JSON.parse(
      cli('epic', 'status', epicId!, '--json')
    ) as EpicProgressLike;
    expect(finalProgress.active).toBe(false);
    expect(finalProgress.children.every((c) => c.status === 'done')).toBe(true);
  }, 20_000);

  it('renders a 409 verbatim when reviewing an already-reviewed run', () => {
    const task = JSON.parse(
      cli('task', 'create', 'Double review me', '--json')
    ) as { meta: { id: string } };
    const meta = JSON.parse(
      cli('run', task.meta.id, '--executor', 'fake', '--json')
    ) as { id: string };
    const runId = meta.id;

    // Approve the one scripted gate, wait for it to finish, then review it
    // twice — the second call must surface the orchestrator's own 409
    // message verbatim, not a generic CLI error.
    cli('approve', runId, 'fake-approval-1');
    const deadline = Date.now() + 5000;
    let finished = false;
    while (Date.now() < deadline && !finished) {
      const detail = JSON.parse(cli('run', 'show', runId, '--json')) as {
        meta: { state: string };
      };
      finished = detail.meta.state === 'finished';
      if (!finished) Bun.sleepSync(50);
    }
    expect(finished).toBe(true);

    expect(cli('review', runId, 'discard')).toContain('reviewed: discard');
    const second = runCli(['review', runId, 'discard'], {
      cwd: repo,
      dispatchHome,
    });
    expect(second.code).not.toBe(0);
    expect(second.stderr).toContain('run has already been reviewed');
  }, 10_000);

  it("rejects an unknown executor with the server's own 400 message", () => {
    const task = JSON.parse(
      cli('task', 'create', 'Bogus executor', '--json')
    ) as { meta: { id: string } };
    const result = runCli(['run', task.meta.id, '--executor', 'wombat'], {
      cwd: repo,
      dispatchHome,
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      'invalid executor: wombat (expected claude|fake)'
    );
  });

  it('--json shapes: runs, run show, and task list are all valid parseable JSON', () => {
    const runs = JSON.parse(cli('runs', '--json'));
    expect(Array.isArray(runs)).toBe(true);
    expect(runs.length).toBeGreaterThan(0);
    const detail = JSON.parse(cli('run', 'show', runs[0].id, '--json'));
    expect(detail.meta.id).toBe(runs[0].id);
    expect(Array.isArray(detail.entries)).toBe(true);
  });

  // C1 regression: `run --watch` used to hang forever on a dispatch
  // failure (createRun rejecting a 4xx) because the WS connection it opens
  // BEFORE calling createRun was never disposed on that path — an open
  // socket/reconnect timer keeps node's event loop (and so the process)
  // alive regardless of the thrown error already having set an exit code.
  // `runCliBounded` force-kills the subprocess if it's still alive past
  // the timeout, so a reintroduced hang fails this test in ~8s instead of
  // hanging the whole suite.
  it('run --watch exits promptly (not hung) when dispatching a nonexistent task', async () => {
    const result = await runCliBounded(
      ['run', 't-doesnotexist', '--executor', 'fake', '--watch'],
      { cwd: repo, dispatchHome },
      8000
    );
    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('task not found: t-doesnotexist');
  }, 12_000);

  // M6: `dispatch plan show <plan-id>` renders the same proposal `dispatch
  // plan` itself would have, for checking back on a plan later (the whole
  // point of the not-settled message pointing at it — see plan-poll.test.ts
  // for the timeout/message logic itself). `--timeout` is validated here
  // end-to-end against the real daemon: a normal (fast) value still works,
  // and a non-positive one is rejected before ever calling the server.
  it('plan show renders a ready proposal, and --timeout is validated', () => {
    const record = JSON.parse(
      cli('plan', 'a prompt for plan show', '--planner', 'fake', '--json')
    ) as { id: string; state: string };
    expect(record.state).toBe('ready');

    const shown = cli('plan', 'show', record.id);
    expect(shown).toContain('Fake planned epic');

    const withTimeout = JSON.parse(
      cli(
        'plan',
        'another prompt',
        '--planner',
        'fake',
        '--timeout',
        '5',
        '--json'
      )
    ) as { state: string };
    expect(withTimeout.state).toBe('ready');

    const badTimeout = runCli(
      ['plan', 'a third prompt', '--planner', 'fake', '--timeout', '0'],
      { cwd: repo, dispatchHome }
    );
    expect(badTimeout.code).not.toBe(0);
    expect(badTimeout.stderr).toContain('invalid --timeout');
  });
});

// ---------------------------------------------------------------------------
// Suite 3 (I2): a daemon that dies mid-`--watch` must be detected and
// reported cleanly — never an infinite reconnect loop, never a hang. Needs
// its OWN daemon (killed partway through), so it can't share Suite 1's.
// ---------------------------------------------------------------------------
describe('lost connection mid-watch (I2)', () => {
  it('run --watch exits 1 with a lost-connection message once dispatchd dies', async () => {
    const repo = initGitRepo('dispatch-cli-e2e-lostconn-');
    const dispatchHome = mkdtempSync(
      join(tmpdir(), 'dispatch-cli-e2e-lostconn-home-')
    );
    const init = runCli(['init'], { cwd: repo, dispatchHome });
    expect(init.code).toBe(0);
    commitAll(repo, 'init');

    const { proc: daemon } = await spawnDaemon(repo, dispatchHome, {
      DISPATCH_ENABLE_FAKES: '1',
      DISPATCH_FAKE_APPROVAL: '1',
    });

    try {
      const task = JSON.parse(
        runCli(['task', 'create', 'Lost connection test', '--json'], {
          cwd: repo,
          dispatchHome,
        }).stdout
      ) as { meta: { id: string } };

      const watch = spawn(
        'node',
        [CLI_BIN, 'run', task.meta.id, '--executor', 'fake', '--watch'],
        { cwd: repo, env: { ...process.env, DISPATCH_HOME: dispatchHome } }
      );
      let stdout = '';
      let stderr = '';
      watch.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      watch.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Wait until the watch is genuinely live and connected (paused at
      // the scripted approval gate) before pulling the rug out.
      const connectedDeadline = Date.now() + 10_000;
      while (
        !stdout.includes('approval requested') &&
        Date.now() < connectedDeadline
      ) {
        await sleep(50);
      }
      expect(stdout).toContain('approval requested');

      // SIGKILL: bypasses bin.ts's graceful-shutdown entirely, so the
      // socket the CLI is holding open just goes dead with no close
      // frame — the realistic "the daemon's process vanished" case, not a
      // clean disconnect.
      daemon.kill('SIGKILL');

      // Bounded wait for the watch subprocess to give up and exit on its
      // own — force-kill it if the fix regresses, so this fails fast
      // instead of hanging the suite.
      const killTimer = setTimeout(() => watch.kill('SIGKILL'), 15_000);
      const code = await new Promise<number>((resolveExit) => {
        watch.on('exit', (exitCode) => resolveExit(exitCode ?? -1));
      });
      clearTimeout(killTimer);

      expect(code).toBe(1);
      expect(stderr).toContain('lost connection to dispatchd');
    } finally {
      daemon.kill('SIGKILL');
      rmSync(repo, { recursive: true, force: true });
      rmSync(dispatchHome, { recursive: true, force: true });
    }
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Suite 2: failure paths that need their OWN daemon-less project, so the
// CLI's ensureDaemon auto-start path actually has something to prove — a
// project that already has a daemon running (Suite 1's) would just reuse
// it via the daemon file, never exercising the spawn-a-fresh-one branch.
// ---------------------------------------------------------------------------
describe('no daemon + autostart', () => {
  it('a read-only command with no daemon running spawns one and succeeds', () => {
    const repo = initGitRepo('dispatch-cli-e2e-autostart-');
    const dispatchHome = mkdtempSync(
      join(tmpdir(), 'dispatch-cli-e2e-autostart-home-')
    );
    try {
      const init = runCli(['init'], { cwd: repo, dispatchHome });
      expect(init.code).toBe(0);
      commitAll(repo, 'init');

      // No daemon has been spawned for this rootDir/DISPATCH_HOME pair yet
      // — `dispatch runs` must autostart one via ensureDaemon and still
      // succeed, printing the empty-table sentinel rather than failing.
      const result = runCli(['runs'], { cwd: repo, dispatchHome });
      expect(result.code).toBe(0);
      expect(result.stdout.trim()).toBe('(none)');

      // A second invocation must reuse the daemon the first one just
      // spawned (via the daemon file) rather than spawning a second one —
      // observable as this call being fast and equally successful.
      const second = runCli(['runs', '--json'], { cwd: repo, dispatchHome });
      expect(second.code).toBe(0);
      expect(JSON.parse(second.stdout)).toEqual([]);
    } finally {
      // Best-effort: kill whatever daemon ensureDaemon spawned for this
      // isolated DISPATCH_HOME so it doesn't linger past the test.
      const daemonsDir = join(dispatchHome, '.dispatch', 'daemons');
      const files = Bun.spawnSync({
        cmd: ['ls', daemonsDir],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      for (const name of files.stdout.toString().split('\n').filter(Boolean)) {
        try {
          const info = JSON.parse(
            Bun.spawnSync({
              cmd: ['cat', join(daemonsDir, name)],
              stdout: 'pipe',
            }).stdout.toString()
          ) as { pid: number };
          process.kill(info.pid);
        } catch {
          // Already gone, or unparsable — nothing more to clean up.
        }
      }
      rmSync(repo, { recursive: true, force: true });
      rmSync(dispatchHome, { recursive: true, force: true });
    }
  }, 15_000);
});
