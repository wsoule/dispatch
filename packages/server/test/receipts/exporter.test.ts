import {
  ActorContext,
  initProjectStores,
  loadConfig,
} from '@dispatch-foo/core';
import type { ProjectStores } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../../src/events.js';
import { receiptsDir as defaultReceiptsDir } from '../../src/orchestrator/paths.js';
import {
  receiptsEnabled,
  ReceiptsExporter,
  resolveReceiptsDir,
} from '../../src/receipts/exporter.js';
import {
  isReceiptEvent,
  ReceiptsScheduler,
} from '../../src/receipts/scheduler.js';
import type { AsyncGitRunner } from '../../src/sync/worktree.js';
import { gitReaderFor, run } from '../sync/helpers.js';

// The exporter's runner is async; the tests' own git reads stay synchronous.
const runAsync: AsyncGitRunner = (cwd, args) => Promise.resolve(run(cwd, args));

let home: string;
let previousHome: string | undefined;
let root: string;
const opened: ProjectStores[] = [];

beforeEach(() => {
  previousHome = process.env.DISPATCH_HOME;
  home = mkdtempSync(join(tmpdir(), 'dispatch-receipts-home-'));
  process.env.DISPATCH_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'dispatch-receipts-project-'));
  mkdirSync(join(root, '.dispatch'), { recursive: true });
});

afterEach(() => {
  for (const stores of opened.splice(0)) stores.close();
  if (previousHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// The log always lives outside the project: ensureRepo refuses a directory
// inside rootDir, since a receipt log nested in the repo it describes would be
// swept up by that repo's own commits.
function logDir(name = 'receipts'): string {
  return join(home, name);
}

function stores(): ProjectStores {
  const s = initProjectStores({
    rootDir: root,
    backend: 'sqlite',
    dbPath: join(root, '.dispatch', 'dispatch.db'),
  });
  opened.push(s);
  return s;
}

function exporterFor(s: ProjectStores): ReceiptsExporter {
  return new ReceiptsExporter(
    s,
    ActorContext.resolve(root, gitReaderFor(root)),
    runAsync
  );
}

// The receipt log's commit subjects, newest first.
function log(dir: string): string[] {
  const result = run(dir, ['log', '--format=%s']);
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

describe('ReceiptsExporter', () => {
  it('creates the log as a git repository and commits the first export', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();

    const result = await exporterFor(s).exportOnce(dir);

    expect(result.state).toBe('committed');
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    expect(log(dir)).toHaveLength(1);
    expect(log(dir)[0]).toContain('1 task(s)');
    // Committed, not merely written: a file present in the working tree but
    // absent from HEAD is not a receipt anyone can go back and read.
    const tracked = run(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout;
    expect(tracked).toContain('.dispatch/findings.jsonl');
    expect(tracked).toContain('README.md');
    expect(tracked).toMatch(/\.dispatch\/tasks\/t-[0-9a-f]{6}-first-task\.md/);
  });

  // Task 24: an appendix (the federation audit log) is committed with the
  // export, and a later export never removes files under federation/.
  it('commits what an appendix writes and keeps it on later exports', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const appendix = (d: string) => {
      mkdirSync(join(d, 'federation'), { recursive: true });
      writeFileSync(join(d, 'federation', 'audit.jsonl'), '{"id":1}\n');
    };
    const exporter = new ReceiptsExporter(
      s,
      ActorContext.resolve(root, gitReaderFor(root)),
      runAsync,
      [],
      [appendix]
    );
    expect((await exporter.exportOnce(dir)).state).toBe('committed');
    s.tasks.create({ kind: 'task', title: 'Second task' });
    await exporterFor(s).exportOnce(dir);
    const tracked = run(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout;
    expect(tracked).toContain('federation/audit.jsonl');
  });

  it('commits nothing when the database has not changed', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    await exporter.exportOnce(dir);

    const second = await exporter.exportOnce(dir);

    expect(second.state).toBe('clean');
    expect(second.commit).toBeNull();
    expect(log(dir)).toHaveLength(1);
  });

  it('records an edit as a new commit, so git log is the task history', async () => {
    const s = stores();
    const task = s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    await exporter.exportOnce(dir);

    s.tasks.update(task.meta.id, { status: 'review' });
    const result = await exporter.exportOnce(dir);

    expect(result.state).toBe('committed');
    expect(log(dir)).toHaveLength(2);
    // The point of the whole feature: the previous state of the task is still
    // retrievable from git after the database has moved on.
    const diff = run(dir, ['show', 'HEAD']).stdout;
    expect(diff).toContain('+status: review');
    const before = run(dir, [
      'show',
      `HEAD~1:.dispatch/tasks/${task.meta.id}-first-task.md`,
    ]).stdout;
    expect(before).toContain('status: ready');
  });

  it('commits the deletion when a task leaves the database', async () => {
    const s = stores();
    const task = s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    await exporter.exportOnce(dir);

    s.tasks.remove(task.meta.id);
    const result = await exporter.exportOnce(dir);

    expect(result.state).toBe('committed');
    expect(result.removed).toBe(1);
    const deleted = run(dir, [
      'log',
      '--diff-filter=D',
      '--name-only',
      '--format=',
    ]).stdout;
    expect(deleted).toContain(`${task.meta.id}-first-task.md`);
    // Still readable at the commit before it was dropped — a deleted task is
    // not an erased one.
    const revived = run(dir, [
      'show',
      `HEAD~1:.dispatch/tasks/${task.meta.id}-first-task.md`,
    ]);
    expect(revived.status).toBe(0);
  });

  it('commits a tree left dirty by a daemon that died before committing', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    await exporter.exportOnce(dir);
    // What a kill -9 between materialize and commit leaves behind. The
    // materializer will report nothing changed, so only asking git keeps this
    // from sitting uncommitted forever.
    writeFileSync(join(dir, '.dispatch', 'stray.jsonl'), '{"orphan":true}\n');

    const result = await exporter.exportOnce(dir);

    expect(result.state).toBe('committed');
    expect(log(dir)).toHaveLength(2);
  });

  it('clears a stale git lock a killed pass left, so exports keep committing', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    await exporter.exportOnce(dir);
    // What a kill -9 inside `git add` or `git commit` leaves behind.
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    mkdirSync(join(dir, '.git', 'refs', 'heads'), { recursive: true });
    writeFileSync(join(dir, '.git', 'refs', 'heads', 'main.lock'), '');
    s.tasks.create({ kind: 'task', title: 'Second task' });

    const result = await exporter.exportOnce(dir);

    expect(result.state).toBe('committed');
    expect(existsSync(join(dir, '.git', 'index.lock'))).toBe(false);
    expect(log(dir)).toHaveLength(2);
  });

  it('reports a failure instead of throwing out of the daemon', async () => {
    const s = stores();
    // A path that cannot be a directory, so `mkdir` inside ensureRepo fails.
    const blocked = logDir('blocked');
    writeFileSync(blocked, 'not a directory');

    const result = await exporterFor(s).exportOnce(blocked);

    expect(result.state).toBe('failed');
    expect(result.commit).toBeNull();
  });
});

describe('ReceiptsExporter slicing', () => {
  it('hands the event loop back mid-pass, and gives up there when stopped', async () => {
    const s = stores();
    for (let i = 0; i < 600; i += 1) {
      s.tasks.create({ kind: 'task', title: `Task ${i}` });
    }
    const dir = logDir();

    const result = await exporterFor(s).exportOnce(dir, {}, () => true);

    expect(result.state).toBe('failed');
    expect(result.detail).toContain('stopped');
    // It yielded before the last task, and committed none of what it wrote.
    const written = readdirSync(join(dir, '.dispatch', 'tasks')).length;
    expect(written).toBeGreaterThan(0);
    expect(written).toBeLessThan(600);
    expect(log(dir)).toEqual([]);
  });
});

describe('ReceiptsExporter steps', () => {
  it('runs extra steps before staging, adds their counts, and survives one that throws', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = new ReceiptsExporter(
      s,
      ActorContext.resolve(root, gitReaderFor(root)),
      runAsync,
      [
        (d) => {
          mkdirSync(join(d, '.dispatch', 'docs'), { recursive: true });
          writeFileSync(join(d, '.dispatch', 'docs', 'a.md'), 'doc\n');
          return { changed: 1, removed: 0, problems: ['one problem'] };
        },
        () => {
          throw new Error('boom');
        },
      ]
    );

    const result = await exporter.exportOnce(dir);

    expect(result.state).toBe('committed');
    expect(result.problems).toBe(2);
    expect(
      run(dir, ['ls-files', '.dispatch/docs']).stdout.trim().split('\n')
    ).toEqual(['.dispatch/docs/a.md']);
  });
});

describe('ReceiptsExporter ownership', () => {
  it('refuses to adopt a directory it did not create', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    // Someone's real repository: `receipts.dir` pointed at a checkout, or at
    // notes they keep in git. Adopting it would mean `git add -A` plus a
    // pruning commit over their work every time a task changed.
    const theirs = logDir('their-repo');
    mkdirSync(theirs, { recursive: true });
    writeFileSync(join(theirs, 'NOTES.md'), 'my notes\n');
    run(theirs, ['init']);
    run(theirs, ['add', '-A']);
    run(theirs, [
      '-c',
      'user.name=T',
      '-c',
      'user.email=t@e',
      'commit',
      '-m',
      'mine',
    ]);
    const before = run(theirs, ['rev-parse', 'HEAD']).stdout.trim();

    const result = await exporterFor(s).exportOnce(theirs);

    expect(result.state).toBe('failed');
    expect(result.detail).toContain('not created by dispatch');
    // Their work is untouched: no new commit, file intact, nothing staged.
    expect(run(theirs, ['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
    expect(readFileSync(join(theirs, 'NOTES.md'), 'utf8')).toBe('my notes\n');
    expect(existsSync(join(theirs, '.dispatch'))).toBe(false);
    expect(run(theirs, ['status', '--porcelain']).stdout.trim()).toBe('');
  });

  it('refuses a log inside the project repo', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });

    // `receipts.dir: .` — the most damaging plausible typo.
    const result = await exporterFor(s).exportOnce(root);

    expect(result.state).toBe('failed');
    expect(result.detail).toContain('inside the project itself');
    expect(existsSync(join(root, 'README.md'))).toBe(false);
  });

  it('refuses a log that belongs to a different project', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    expect((await exporterFor(s).exportOnce(dir)).state).toBe('committed');
    // The same directory, now claimed by a second project — two boards pruning
    // each other's task files and committing the deletions.
    const otherRoot = mkdtempSync(join(tmpdir(), 'dispatch-other-project-'));
    const other = initProjectStores({
      rootDir: otherRoot,
      backend: 'sqlite',
      dbPath: join(otherRoot, 'db.sqlite'),
    });
    opened.push(other);

    const result = await new ReceiptsExporter(
      other,
      ActorContext.resolve(root, gitReaderFor(root)),
      runAsync
    ).exportOnce(dir);

    expect(result.state).toBe('failed');
    expect(result.detail).toContain('receipt log for');
    rmSync(otherRoot, { recursive: true, force: true });
  });

  it('adopts a log it created before, and one whose .git was deleted', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    expect((await exporter.exportOnce(dir)).state).toBe('committed');

    // Second pass: the marker proves ownership, so it is adopted, not refused.
    expect((await exporter.exportOnce(dir)).state).toBe('clean');

    // The marker, not the repository, is what proves ownership — a log whose
    // .git someone deleted is still ours to rebuild.
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    const rebuilt = await exporter.exportOnce(dir);
    expect(rebuilt.state).toBe('committed');
    expect(log(dir)).toHaveLength(1);
  });

  it('reports rather than rejects when git is not on PATH', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    // Spawning THROWS on a missing executable rather than returning a non-zero
    // status, and every caller of exportOnce is a timer callback or the boot
    // path — an escaping rejection there takes the daemon down.
    const missingGit: AsyncGitRunner = (cwd, args) => {
      const result = Bun.spawnSync(['definitely-not-git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return Promise.resolve({
        status: result.exitCode,
        stdout: result.stdout.toString('utf8'),
        stderr: result.stderr.toString('utf8'),
      });
    };
    const exporter = new ReceiptsExporter(
      s,
      ActorContext.resolve(root, gitReaderFor(root)),
      missingGit
    );

    const result = await exporter.exportOnce(logDir());
    expect(result.state).toBe('failed');
  });

  it('does not stall on a machine-global commit signing policy', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();

    // Stand in for a machine-global policy rather than assuming the host
    // running the suite has none: signing required, through a gpg binary that
    // does not exist. Every git the exporter spawns inherits process.env, so
    // GIT_CONFIG_GLOBAL is what its `git commit` reads. Should the exporter
    // ever stop forcing gpgsign off per-command, the commit fails loudly here
    // ("cannot exec") instead of hanging on a passphrase prompt.
    const gitconfig = join(home, 'gitconfig');
    writeFileSync(
      gitconfig,
      [
        '[user]',
        '\tname = Signing Policy',
        '\temail = signing@example.com',
        '[commit]',
        '\tgpgsign = true',
        '[gpg]',
        '\tprogram = /nonexistent/dispatch-test-gpg',
        '',
      ].join('\n')
    );
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = gitconfig;
    try {
      expect((await exporterFor(s).exportOnce(dir)).state).toBe('committed');
      // The policy really is in effect for the log — and stays in effect,
      // because the override rides on each command rather than being written
      // into the log's own config, where it could drift or be lost.
      expect(
        run(dir, ['config', '--get', 'commit.gpgsign']).stdout.trim()
      ).toBe('true');
      expect(
        run(dir, ['config', '--local', '--get', 'commit.gpgsign']).stdout.trim()
      ).toBe('');
      expect(run(dir, ['log', '--format=%G?', '-1']).stdout.trim()).toBe('N');
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    }
  });

  it('attributes commits without writing identity into the repo config', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    expect((await exporterFor(s).exportOnce(dir)).state).toBe('committed');

    const author = run(dir, ['log', '--format=%an <%ae>', '-1']).stdout.trim();
    expect(author).not.toBe('');
    expect(author).not.toContain('unknown');
    // Passed per-command rather than persisted, so it cannot drift or be lost
    // if someone rewrites the log's .git/config, and needs no repair path.
    expect(
      run(dir, ['config', '--local', '--get', 'user.name']).stdout.trim()
    ).toBe('');
  });
});

describe('resolveReceiptsDir', () => {
  it('defaults to the per-project directory under DISPATCH_HOME', () => {
    const dir = resolveReceiptsDir(root, loadConfig(root));
    expect(dir).toBe(defaultReceiptsDir(root));
    expect(dir).toStartWith(home);
    // Outside the project repo — the whole point of the location.
    expect(dir).not.toStartWith(root);
  });

  it('honours an absolute receipts.dir', () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  dir: /tmp/dispatch-audit\n'
    );
    expect(resolveReceiptsDir(root, loadConfig(root))).toBe(
      '/tmp/dispatch-audit'
    );
  });

  it('resolves a relative receipts.dir against the project, not the cwd', () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  dir: audit-log\n'
    );
    expect(resolveReceiptsDir(root, loadConfig(root))).toBe(
      join(root, 'audit-log')
    );
  });

  it('is enabled by default and switchable off', () => {
    expect(receiptsEnabled(loadConfig(root))).toBe(true);
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: false\n'
    );
    expect(receiptsEnabled(loadConfig(root))).toBe(false);
  });
});

describe('isReceiptEvent', () => {
  // The log carries findings and ledger entries as well as tasks, and those
  // announce themselves on their own events. Keyed on `task.changed` alone,
  // a review raising twenty findings put nothing in the audit trail until an
  // unrelated task edit came along — which makes the log's own README
  // ("committed on every change") false.
  it('covers every record type the log carries that emits an event', () => {
    expect(isReceiptEvent({ type: 'task.changed' })).toBe(true);
    expect(isReceiptEvent({ type: 'finding.changed' })).toBe(true);
    expect(isReceiptEvent({ type: 'ledger.changed' })).toBe(true);
  });

  it('ignores events that change nothing the log holds', () => {
    expect(isReceiptEvent({ type: 'run.changed' })).toBe(false);
    expect(isReceiptEvent({ type: 'git.changed' })).toBe(false);
    expect(isReceiptEvent({ type: 'inbox.changed' })).toBe(false);
    expect(isReceiptEvent({ type: 'hello', version: '1' })).toBe(false);
  });
});

describe('ReceiptsScheduler', () => {
  function schedulerFor(
    s: ProjectStores,
    debounceMs = 5,
    git: AsyncGitRunner = runAsync
  ): ReceiptsScheduler {
    return new ReceiptsScheduler({
      rootDir: root,
      stores: s,
      actor: ActorContext.resolve(root, gitReaderFor(root)),
      run: git,
      events: new EventBus(),
      debounceMs,
      // Large enough never to fire: these tests assert exact commit counts, and
      // a background sweep landing mid-assertion would add one of its own.
      sweepMs: 60 * 60_000,
    });
  }

  // Polls until the log holds `count` commits. An export's git runs as child
  // processes, so no fixed sleep outlasts it on a loaded machine.
  async function waitForCommits(dir: string, count: number): Promise<void> {
    for (let i = 0; i < 400; i++) {
      if (existsSync(join(dir, '.git')) && log(dir).length >= count) return;
      await Bun.sleep(25);
    }
    throw new Error(`the receipt log never reached ${count} commit(s)`);
  }

  it('retries a failed export on a backoff instead of waiting for the sweep', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    let failures = 2;
    const flaky: AsyncGitRunner = (cwd, args) => {
      if (args.includes('commit') && failures > 0) {
        failures -= 1;
        return Promise.resolve({
          status: 1,
          stdout: '',
          stderr: 'disk hiccup',
        });
      }
      return runAsync(cwd, args);
    };
    const scheduler = new ReceiptsScheduler({
      rootDir: root,
      stores: s,
      actor: ActorContext.resolve(root, gitReaderFor(root)),
      run: flaky,
      events: new EventBus(),
      debounceMs: 5,
      sweepMs: 60 * 60_000,
      retryMs: [20, 40, 60],
    });
    expect((await scheduler.exportNow())?.state).toBe('failed');
    await waitForCommits(defaultReceiptsDir(root), 1);
    expect(failures).toBe(0);
    expect(scheduler.lastResult()?.state).toBe('committed');
    await scheduler.stop();
  });

  it('exports once at boot', async () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const scheduler = schedulerFor(s);

    const result = await scheduler.exportNow();

    expect(result?.state).toBe('committed');
    expect(log(defaultReceiptsDir(root))).toHaveLength(1);
    await scheduler.stop();
  });

  it('coalesces a burst of changes into a single commit', async () => {
    const s = stores();
    const scheduler = schedulerFor(s, 10);
    await scheduler.exportNow();
    const dir = defaultReceiptsDir(root);
    const before = log(dir).length;

    for (let i = 0; i < 5; i += 1) {
      s.tasks.create({ kind: 'task', title: `Task ${i}` });
      scheduler.notifyChanged();
    }
    await waitForCommits(dir, before + 1);
    await Bun.sleep(100);

    expect(log(dir).length).toBe(before + 1);
    expect(log(dir)[0]).toContain('5 task(s)');
    await scheduler.stop();
  });

  it('exports just the tasks a change names, until a full pass', async () => {
    const s = stores();
    const named = s.tasks.create({ kind: 'task', title: 'Named' });
    const other = s.tasks.create({ kind: 'task', title: 'Other' });
    const scheduler = schedulerFor(s, 10);
    await scheduler.exportNow();
    const dir = defaultReceiptsDir(root);
    const before = log(dir).length;
    const otherFile = `.dispatch/tasks/${other.meta.id}-other.md`;

    s.tasks.update(named.meta.id, { status: 'review' });
    s.tasks.update(other.meta.id, { status: 'review' });
    scheduler.notifyChanged({ type: 'task.changed', ids: [named.meta.id] });
    await waitForCommits(dir, before + 1);

    // Tasks only: the records were not rewritten, so they are not counted.
    expect(log(dir)[0]).toBe('receipts: 2 task(s)');
    const touched = run(dir, ['show', '--name-only', '--format=', 'HEAD']);
    expect(touched.stdout.trim()).toBe(
      `.dispatch/tasks/${named.meta.id}-named.md`
    );
    expect(run(dir, ['show', `HEAD:${otherFile}`]).stdout).toContain(
      'status: ready'
    );

    await scheduler.exportNow();
    expect(run(dir, ['show', `HEAD:${otherFile}`]).stdout).toContain(
      'status: review'
    );
    await scheduler.stop();
  });

  it('holds a change that arrives mid-pass for the next pass', async () => {
    const s = stores();
    const first = s.tasks.create({ kind: 'task', title: 'First' });
    // Parks the first pass at its `git add` until the test lets it go.
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let gated = false;
    const git: AsyncGitRunner = async (cwd, args) => {
      if (args[0] === 'add' && !gated) {
        gated = true;
        await gate;
      }
      return run(cwd, args);
    };
    const scheduler = schedulerFor(s, 5, git);
    const dir = defaultReceiptsDir(root);
    const booting = scheduler.exportNow();
    while (!gated) await Bun.sleep(5);

    const late = s.tasks.create({ kind: 'task', title: 'Late' });
    scheduler.notifyChanged({ type: 'task.changed', ids: [late.meta.id] });
    await Bun.sleep(30);
    release();
    await booting;
    await waitForCommits(dir, 2);

    const tracked = run(dir, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout;
    expect(tracked).toContain(`${first.meta.id}-first.md`);
    expect(tracked).toContain(`${late.meta.id}-late.md`);
    await scheduler.stop();
  });

  it('exports a finding raised with no task edit at all', async () => {
    const s = stores();
    const scheduler = schedulerFor(s, 10);
    await scheduler.exportNow();
    const dir = defaultReceiptsDir(root);
    const before = log(dir).length;
    const records = s.records;
    if (records === null) throw new Error('expected a database');

    records.findings.add({
      taskId: 't-000001',
      runId: null,
      severity: 'important',
      title: 'Found something',
      detail: 'A review raised this.',
      raisedBy: 'reviewer',
    });
    // What the daemon does on `finding.changed` — no task was touched.
    scheduler.notifyChanged({ type: 'finding.changed' });
    await waitForCommits(dir, before + 1);

    expect(log(dir)[0]).toContain('1 finding(s)');
    await scheduler.stop();
  });

  it('sweeps up evidence, which changes without emitting any event', async () => {
    const s = stores();
    // Evidence is written straight into the database through the MCP tools and
    // has no event to subscribe to, so the periodic sweep is the only thing
    // that ever puts it in the log.
    const scheduler = new ReceiptsScheduler({
      rootDir: root,
      stores: s,
      actor: ActorContext.resolve(root, gitReaderFor(root)),
      run: runAsync,
      events: new EventBus(),
      debounceMs: 10,
      sweepMs: 15,
    });
    await scheduler.exportNow();
    const dir = defaultReceiptsDir(root);
    const before = log(dir).length;
    const records = s.records;
    if (records === null) throw new Error('expected a database');

    records.evidence.addCommand('r-000009', {
      command: 'bun test',
      exitCode: 0,
      durationMs: 10,
      summary: '1 pass',
      at: '2026-09-01T10:00:00.000Z',
    });
    await waitForCommits(dir, before + 1);
    await scheduler.stop();

    expect(
      existsSync(join(dir, '.dispatch', 'evidence', 'r-000009.jsonl'))
    ).toBe(true);
  });

  it('does nothing while receipts are disabled', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: false\n'
    );
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const scheduler = schedulerFor(s);

    expect(await scheduler.exportNow()).toBeNull();
    scheduler.notifyChanged();
    await Bun.sleep(100);

    expect(existsSync(defaultReceiptsDir(root))).toBe(false);
    await scheduler.stop();
  });

  it('picks up a config edit that re-enables it, without a restart', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: false\n'
    );
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const scheduler = schedulerFor(s);
    expect(await scheduler.exportNow()).toBeNull();

    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: true\n'
    );
    scheduler.notifyChanged();
    await waitForCommits(defaultReceiptsDir(root), 1);

    expect(log(defaultReceiptsDir(root))).toHaveLength(1);
    await scheduler.stop();
  });

  // The files a log's HEAD holds.
  function tracked(dir: string): string[] {
    return run(dir, ['ls-tree', '-r', '--name-only', 'HEAD'])
      .stdout.trim()
      .split('\n');
  }
  const taskFiles = (dir: string): string[] =>
    tracked(dir).filter((f) => f.startsWith('.dispatch/tasks/'));

  it('writes the whole board when a change re-enables it, not just that change', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: false\n'
    );
    const s = stores();
    const edited = s.tasks.create({ kind: 'task', title: 'Edited' });
    s.tasks.create({ kind: 'task', title: 'Untouched' });
    s.tasks.create({ kind: 'task', title: 'Also untouched' });
    const scheduler = schedulerFor(s);
    expect(await scheduler.exportNow()).toBeNull();

    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: true\n'
    );
    s.tasks.update(edited.meta.id, { status: 'review' });
    // What the daemon broadcasts for an ordinary edit.
    scheduler.notifyChanged({ type: 'task.changed', ids: [edited.meta.id] });
    const dir = defaultReceiptsDir(root);
    await waitForCommits(dir, 1);

    expect(taskFiles(dir)).toHaveLength(3);
    expect(tracked(dir)).toContain('README.md');
    await scheduler.stop();
  });

  it('rebuilds a log deleted under it whole, from a change naming one task', async () => {
    const s = stores();
    const edited = s.tasks.create({ kind: 'task', title: 'Edited' });
    s.tasks.create({ kind: 'task', title: 'Untouched' });
    const scheduler = schedulerFor(s);
    await scheduler.exportNow();
    const dir = defaultReceiptsDir(root);
    rmSync(dir, { recursive: true, force: true });

    s.tasks.update(edited.meta.id, { status: 'review' });
    scheduler.notifyChanged({ type: 'task.changed', ids: [edited.meta.id] });
    await waitForCommits(dir, 1);

    expect(taskFiles(dir)).toHaveLength(2);
    expect(tracked(dir)).toContain('README.md');
    await scheduler.stop();
    // A whole rebuild under load can outlast the 5 s default; waitForCommits
    // polls for 10 s on its own.
  }, 20_000);

  it('writes the whole board when receipts.dir points back at an older log', async () => {
    const s = stores();
    const edited = s.tasks.create({ kind: 'task', title: 'Edited' });
    const other = s.tasks.create({ kind: 'task', title: 'Other' });
    const scheduler = schedulerFor(s);
    await scheduler.exportNow();
    const first = defaultReceiptsDir(root);
    const otherFile = `.dispatch/tasks/${other.meta.id}-other.md`;

    // Away to another log, where the other task moves on.
    const second = logDir('elsewhere');
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      `receipts:\n  dir: ${second}\n`
    );
    s.tasks.update(other.meta.id, { status: 'review' });
    scheduler.notifyChanged({ type: 'task.changed', ids: [other.meta.id] });
    await waitForCommits(second, 1);

    // And back: a change naming only the edited task still brings the
    // first log's copy of the other one up to date.
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: true\n'
    );
    s.tasks.update(edited.meta.id, { status: 'review' });
    scheduler.notifyChanged({ type: 'task.changed', ids: [edited.meta.id] });
    await waitForCommits(first, 2);

    expect(run(first, ['show', `HEAD:${otherFile}`]).stdout).toContain(
      'status: review'
    );
    await scheduler.stop();
  });

  it('stands down on an unreadable config instead of taking the daemon down', async () => {
    writeFileSync(join(root, '.dispatch', 'config.yml'), 'receipts: [oh no\n');
    const s = stores();
    const scheduler = schedulerFor(s);

    expect(await scheduler.exportNow()).toBeNull();
    expect(await scheduler.exportNow()).toBeNull();
    await scheduler.stop();
  });

  it('makes no further commits after stop()', async () => {
    const s = stores();
    const scheduler = schedulerFor(s, 10);
    await scheduler.exportNow();
    const dir = defaultReceiptsDir(root);
    const before = log(dir).length;

    s.tasks.create({ kind: 'task', title: 'Late task' });
    scheduler.notifyChanged();
    await scheduler.stop();
    await Bun.sleep(60);

    expect(log(dir).length).toBe(before);
  });
});
