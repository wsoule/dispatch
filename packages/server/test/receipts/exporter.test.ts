import { ActorContext, initProjectStores, loadConfig } from '@dispatch/core';
import type { ProjectStores } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
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
import { gitReaderFor, run } from '../sync/helpers.js';

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
    run
  );
}

// The receipt log's commit subjects, newest first.
function log(dir: string): string[] {
  const result = run(dir, ['log', '--format=%s']);
  return result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
}

describe('ReceiptsExporter', () => {
  it('creates the log as a git repository and commits the first export', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();

    const result = exporterFor(s).exportOnce(dir);

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

  it('commits nothing when the database has not changed', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    exporter.exportOnce(dir);

    const second = exporter.exportOnce(dir);

    expect(second.state).toBe('clean');
    expect(second.commit).toBeNull();
    expect(log(dir)).toHaveLength(1);
  });

  it('records an edit as a new commit, so git log is the task history', () => {
    const s = stores();
    const task = s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    exporter.exportOnce(dir);

    s.tasks.update(task.meta.id, { status: 'review' });
    const result = exporter.exportOnce(dir);

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

  it('commits the deletion when a task leaves the database', () => {
    const s = stores();
    const task = s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    exporter.exportOnce(dir);

    s.tasks.remove(task.meta.id);
    const result = exporter.exportOnce(dir);

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

  it('commits a tree left dirty by a daemon that died before committing', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    exporter.exportOnce(dir);
    // What a kill -9 between materialize and commit leaves behind. The
    // materializer will report nothing changed, so only asking git keeps this
    // from sitting uncommitted forever.
    writeFileSync(join(dir, '.dispatch', 'stray.jsonl'), '{"orphan":true}\n');

    const result = exporter.exportOnce(dir);

    expect(result.state).toBe('committed');
    expect(log(dir)).toHaveLength(2);
  });

  it('reports a failure instead of throwing out of the daemon', () => {
    const s = stores();
    // A path that cannot be a directory, so `mkdir` inside ensureRepo fails.
    const blocked = logDir('blocked');
    writeFileSync(blocked, 'not a directory');

    const result = exporterFor(s).exportOnce(blocked);

    expect(result.state).toBe('failed');
    expect(result.commit).toBeNull();
  });
});

describe('ReceiptsExporter ownership', () => {
  it('refuses to adopt a directory it did not create', () => {
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

    const result = exporterFor(s).exportOnce(theirs);

    expect(result.state).toBe('failed');
    expect(result.detail).toContain('not created by dispatch');
    // Their work is untouched: no new commit, file intact, nothing staged.
    expect(run(theirs, ['rev-parse', 'HEAD']).stdout.trim()).toBe(before);
    expect(readFileSync(join(theirs, 'NOTES.md'), 'utf8')).toBe('my notes\n');
    expect(existsSync(join(theirs, '.dispatch'))).toBe(false);
    expect(run(theirs, ['status', '--porcelain']).stdout.trim()).toBe('');
  });

  it('refuses a log inside the project repo', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });

    // `receipts.dir: .` — the most damaging plausible typo.
    const result = exporterFor(s).exportOnce(root);

    expect(result.state).toBe('failed');
    expect(result.detail).toContain('inside the project itself');
    expect(existsSync(join(root, 'README.md'))).toBe(false);
  });

  it('refuses a log that belongs to a different project', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    expect(exporterFor(s).exportOnce(dir).state).toBe('committed');
    // The same directory, now claimed by a second project — two boards pruning
    // each other's task files and committing the deletions.
    const otherRoot = mkdtempSync(join(tmpdir(), 'dispatch-other-project-'));
    const other = initProjectStores({
      rootDir: otherRoot,
      backend: 'sqlite',
      dbPath: join(otherRoot, 'db.sqlite'),
    });
    opened.push(other);

    const result = new ReceiptsExporter(
      other,
      ActorContext.resolve(root, gitReaderFor(root)),
      run
    ).exportOnce(dir);

    expect(result.state).toBe('failed');
    expect(result.detail).toContain('receipt log for');
    rmSync(otherRoot, { recursive: true, force: true });
  });

  it('adopts a log it created before, and one whose .git was deleted', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    const exporter = exporterFor(s);
    expect(exporter.exportOnce(dir).state).toBe('committed');

    // Second pass: the marker proves ownership, so it is adopted, not refused.
    expect(exporter.exportOnce(dir).state).toBe('clean');

    // The marker, not the repository, is what proves ownership — a log whose
    // .git someone deleted is still ours to rebuild.
    rmSync(join(dir, '.git'), { recursive: true, force: true });
    const rebuilt = exporter.exportOnce(dir);
    expect(rebuilt.state).toBe('committed');
    expect(log(dir)).toHaveLength(1);
  });

  it('reports rather than throws when git is not on PATH', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    // Bun.spawnSync THROWS on a missing executable rather than returning a
    // non-zero status, and every caller of exportOnce is a timer callback or
    // the boot path — an escaping throw there takes the daemon down.
    const missingGit: typeof run = (cwd, args) => {
      const result = Bun.spawnSync(['definitely-not-git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return {
        status: result.exitCode,
        stdout: result.stdout.toString('utf8'),
        stderr: result.stderr.toString('utf8'),
      };
    };
    const exporter = new ReceiptsExporter(
      s,
      ActorContext.resolve(root, gitReaderFor(root)),
      missingGit
    );

    let result: ReturnType<typeof exporter.exportOnce> | undefined;
    expect(() => {
      result = exporter.exportOnce(logDir());
    }).not.toThrow();
    expect(result?.state).toBe('failed');
  });

  it('does not stall on a machine-global commit signing policy', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    expect(exporterFor(s).exportOnce(dir).state).toBe('committed');
    // gpgsign forced off per-command, so a global `commit.gpgsign = true`
    // cannot make the daemon wait on a GPG agent for a passphrase.
    expect(run(dir, ['config', '--get', 'commit.gpgsign']).stdout.trim()).toBe(
      ''
    );
    expect(run(dir, ['log', '--format=%G?', '-1']).stdout.trim()).toBe('N');
  });

  it('attributes commits without writing identity into the repo config', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const dir = logDir();
    expect(exporterFor(s).exportOnce(dir).state).toBe('committed');

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
  function schedulerFor(s: ProjectStores, debounceMs = 5): ReceiptsScheduler {
    return new ReceiptsScheduler({
      rootDir: root,
      stores: s,
      actor: ActorContext.resolve(root, gitReaderFor(root)),
      run,
      events: new EventBus(),
      debounceMs,
      // Large enough never to fire: these tests assert exact commit counts, and
      // a background sweep landing mid-assertion would add one of its own.
      sweepMs: 60 * 60_000,
    });
  }

  it('exports once at boot', () => {
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const scheduler = schedulerFor(s);

    const result = scheduler.exportNow();

    expect(result?.state).toBe('committed');
    expect(log(defaultReceiptsDir(root))).toHaveLength(1);
    scheduler.stop();
  });

  it('coalesces a burst of changes into a single commit', async () => {
    const s = stores();
    const scheduler = schedulerFor(s, 10);
    scheduler.exportNow();
    const dir = defaultReceiptsDir(root);
    const before = log(dir).length;

    for (let i = 0; i < 5; i += 1) {
      s.tasks.create({ kind: 'task', title: `Task ${i}` });
      scheduler.notifyChanged();
    }
    await Bun.sleep(60);

    expect(log(dir).length).toBe(before + 1);
    expect(log(dir)[0]).toContain('5 task(s)');
    scheduler.stop();
  });

  it('exports a finding raised with no task edit at all', async () => {
    const s = stores();
    const scheduler = schedulerFor(s, 10);
    scheduler.exportNow();
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
    scheduler.notifyChanged();
    await Bun.sleep(60);

    expect(log(dir).length).toBe(before + 1);
    expect(log(dir)[0]).toContain('1 finding(s)');
    scheduler.stop();
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
      run,
      events: new EventBus(),
      debounceMs: 10,
      sweepMs: 15,
    });
    scheduler.exportNow();
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
    await Bun.sleep(80);
    scheduler.stop();

    expect(log(dir).length).toBeGreaterThan(before);
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

    expect(scheduler.exportNow()).toBeNull();
    scheduler.notifyChanged();
    await Bun.sleep(40);

    expect(existsSync(defaultReceiptsDir(root))).toBe(false);
    scheduler.stop();
  });

  it('picks up a config edit that re-enables it, without a restart', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: false\n'
    );
    const s = stores();
    s.tasks.create({ kind: 'task', title: 'First task' });
    const scheduler = schedulerFor(s);
    expect(scheduler.exportNow()).toBeNull();

    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'receipts:\n  enabled: true\n'
    );
    scheduler.notifyChanged();
    await Bun.sleep(40);

    expect(log(defaultReceiptsDir(root))).toHaveLength(1);
    scheduler.stop();
  });

  it('stands down on an unreadable config instead of taking the daemon down', () => {
    writeFileSync(join(root, '.dispatch', 'config.yml'), 'receipts: [oh no\n');
    const s = stores();
    const scheduler = schedulerFor(s);

    expect(() => scheduler.exportNow()).not.toThrow();
    expect(scheduler.exportNow()).toBeNull();
    scheduler.stop();
  });

  it('makes no further commits after stop()', async () => {
    const s = stores();
    const scheduler = schedulerFor(s, 10);
    scheduler.exportNow();
    const dir = defaultReceiptsDir(root);
    const before = log(dir).length;

    s.tasks.create({ kind: 'task', title: 'Late task' });
    scheduler.notifyChanged();
    scheduler.stop();
    await Bun.sleep(40);

    expect(log(dir).length).toBe(before);
  });
});
