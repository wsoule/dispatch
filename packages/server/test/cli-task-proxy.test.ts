import {
  registerMergeDriverGitConfig,
  registerTeamMergeDriverGitConfig,
  writeGitAttributes,
} from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';

// `dispatch task ...` against a REAL running daemon.
//
// WHERE THIS LIVES: this is a @dispatch/cli test and belongs in
// packages/cli/test. It sits here because the scope request for that
// directory went undecided, and shipping the CLI's daemon path with no
// coverage at all was the worse option — the failure it guards against is a
// second process writing a store the daemon holds. Move it when convenient;
// nothing about it depends on being in this package.
//
// WHY THE SQLITE BACKEND: on the file backend "went through the daemon" and
// "wrote the file directly" produce an identical `.dispatch/tasks` on disk,
// so neither can be told from the other. With the daemon on sqlite the CLI
// has no way to reach the store except by asking dispatchd — the database is
// one the CLI never opens. A task that shows up there is proof of routing,
// and the refusal case below is proof the CLI does not try to open it.

const CLI_ENTRY = resolve(
  dirname(import.meta.dirname),
  '..',
  'cli',
  'src',
  'cli.ts'
);

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Runs the CLI as a child process and waits for it.
 *
 * Async `Bun.spawn`, never `Bun.spawnSync`: the daemon under test is a
 * `Bun.serve` in THIS process, and `spawnSync` blocks this process's event
 * loop — so a synchronous spawn would freeze the very server the child is
 * trying to call, and every command would sit there until its fetch timed
 * out.
 */
async function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string>
): Promise<CliResult> {
  const proc = Bun.spawn({
    cmd: ['bun', CLI_ENTRY, ...args],
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

function initGitRepo(prefix: string): string {
  // realpathSync matters here: on macOS `mkdtempSync` returns a `/var/...`
  // path that is a symlink to `/private/var/...`, and the daemon file is
  // keyed by a hash of the root dir STRING. The daemon would register under
  // the symlink path while the spawned CLI's `process.cwd()` reports the
  // physical one, so the two would hash differently and the CLI would decide
  // no daemon was running. Real projects are already physical paths.
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
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
let cliEnv: Record<string, string>;
const originalDispatchHome = process.env.DISPATCH_HOME;

function appAuth(): Record<string, string> {
  return { authorization: `Bearer ${handle.tokens.appToken}` };
}

function listTasksViaApi(): Promise<{ meta: Record<string, string> }[]> {
  return fetch(`${baseUrl}/api/tasks`, { headers: appAuth() }).then(json);
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initGitRepo('dispatch-cli-proxy-');
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: true,
    webDistDir: null,
    storeBackend: 'sqlite',
    boardSyncPeriodicMs: 10 * 60_000,
  });
  baseUrl = `http://127.0.0.1:${handle.port}`;
  cliEnv = { DISPATCH_HOME: fakeHome };
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('dispatch task, with a database-backed daemon running', () => {
  it('creates through the daemon', async () => {
    const result = await runCli(
      root,
      ['task', 'create', 'made by the cli'],
      cliEnv
    );
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('created ');

    const tasks = await listTasksViaApi();
    expect(tasks.map((t) => t.meta.title)).toEqual(['made by the cli']);
    // Belt and braces: the CLI must not ALSO have scaffolded a markdown
    // board beside the database.
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(false);
  });

  it('lists what the daemon holds', async () => {
    await runCli(root, ['task', 'create', 'listed via daemon'], cliEnv);
    const result = await runCli(root, ['task', 'list'], cliEnv);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('listed via daemon');
  });

  it('shows one task rendered from the daemon, with no file to read', async () => {
    const created = await runCli(root, ['task', 'create', 'show me'], cliEnv);
    const id = created.stdout.trim().split(/\s+/)[1];
    const result = await runCli(root, ['task', 'show', id], cliEnv);
    expect(result.exitCode).toBe(0);
    // serializeTaskFile output: frontmatter, then the body.
    expect(result.stdout).toContain(`id: ${id}`);
    expect(result.stdout).toContain('title: show me');
  });

  it('changes status through the daemon', async () => {
    const created = await runCli(root, ['task', 'create', 'move me'], cliEnv);
    const id = created.stdout.trim().split(/\s+/)[1];
    const result = await runCli(
      root,
      ['task', 'status', id, 'in-progress'],
      cliEnv
    );
    expect(result.exitCode).toBe(0);

    const tasks = await listTasksViaApi();
    expect(tasks[0].meta.status).toBe('in-progress');
  });

  it('edits through the daemon', async () => {
    const created = await runCli(root, ['task', 'create', 'edit me'], cliEnv);
    const id = created.stdout.trim().split(/\s+/)[1];
    await runCli(root, ['task', 'edit', id, '--title', 'edited'], cliEnv);

    const tasks = await listTasksViaApi();
    expect(tasks[0].meta.title).toBe('edited');
  });

  it('reports ready work from the daemon', async () => {
    await runCli(root, ['task', 'create', 'ready one'], cliEnv);
    const result = await runCli(root, ['task', 'next'], cliEnv);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('ready one');
  });

  it('surfaces the daemon 404 for an unknown id', async () => {
    const result = await runCli(root, ['task', 'show', 't-nope00'], cliEnv);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('task not found: t-nope00');
  });
});

describe('dispatch task, database-backed with NO daemon running', () => {
  it('refuses rather than opening the database itself', async () => {
    // Stop the daemon but keep its database: exactly the state where a
    // second writer would corrupt things.
    await handle.stop();
    const emptyHome = mkdtempSync(join(tmpdir(), 'dispatch-no-daemon-home-'));
    try {
      const result = await runCli(root, ['task', 'list'], {
        DISPATCH_HOME: emptyHome,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('dispatchd is not running');
      expect(result.stderr).toContain('dispatch serve');
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
      // afterEach stops the handle again; ServerHandle.stop tolerates that.
      handle = { ...handle, stop: () => Promise.resolve() } as ServerHandle;
    }
  });
});

// `dispatch doctor` validates task FILES — malformed frontmatter, two files
// claiming one id. A database expresses none of those (its schema rejects
// them at write time), so on a database-backed project doctor used to hit its
// requireStore gate and tell a perfectly healthy project to run
// `dispatch init`.
describe('dispatch doctor on a database-backed project', () => {
  it('does not tell a healthy project to re-initialize', async () => {
    // The merge drivers are what `dispatchd --init` registers alongside the
    // database; without them doctor has real issues to report and never
    // reaches its clean-report line.
    writeGitAttributes(root);
    registerMergeDriverGitConfig(root);
    registerTeamMergeDriverGitConfig(root);
    await runCli(root, ['task', 'create', 'a real task'], cliEnv);

    const result = await runCli(root, ['doctor'], cliEnv);
    expect(result.stderr).not.toContain('not initialized');
    expect(result.stdout).toContain('1 task checked from the daemon database');
    expect(result.exitCode).toBe(0);
  });

  // The graph checks are NOT file-specific and the schema does not enforce
  // them: `blocked_by` is a JSON text column with no foreign key behind it,
  // so a database holds a broken graph just as happily as a folder of
  // markdown. Skipping them on this backend would have made doctor blind to
  // exactly the corruption it exists to find.
  it('still catches a dangling reference in the database', async () => {
    const created = await runCli(
      root,
      ['task', 'create', 'points nowhere'],
      cliEnv
    );
    const id = created.stdout.trim().split(/\s+/)[1];
    await runCli(
      root,
      ['task', 'edit', id, '--add-blocked-by', 't-ghost0'],
      cliEnv
    );

    const result = await runCli(root, ['doctor', '--json'], cliEnv);
    const report = JSON.parse(result.stdout) as {
      tasks: number;
      issues: { file: string; problem: string }[];
    };
    expect(report.tasks).toBe(1);
    expect(
      report.issues.some(
        (i) => i.file === id && i.problem.includes('dangling blocked-by')
      )
    ).toBe(true);
  });

  it('refuses rather than reporting a clean bill with no daemon', async () => {
    await handle.stop();
    const emptyHome = mkdtempSync(join(tmpdir(), 'dispatch-no-daemon-home-'));
    try {
      const result = await runCli(root, ['doctor'], {
        DISPATCH_HOME: emptyHome,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('dispatchd is not running');
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
      handle = { ...handle, stop: () => Promise.resolve() } as ServerHandle;
    }
  });
});
