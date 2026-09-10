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
import { join, resolve } from 'node:path';

import {
  formatRetireReport,
  receiptLogDir,
  retireLegacySources,
} from '../src/retire.js';
import { writeProjectBackend } from '../src/storage.js';
import { ensureProjectGitignore } from '../src/store.js';
import { initProjectStores } from '../src/storeBackend.js';

let root: string;
let log: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-retire-'));
  log = mkdtempSync(join(tmpdir(), 'dispatch-receipts-'));
  // Every test but the "refuses on the file backend" one starts from a project
  // that has already moved, since that is the only state retirement applies to.
  writeProjectBackend(root, 'sqlite');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(log, { recursive: true, force: true });
});

// A task file with the frontmatter parseTaskFile actually requires.
function taskFile(id: string, title: string): string {
  return [
    '---',
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    'status: todo',
    'kind: task',
    'created: 2026-01-02T03:04:05.000Z',
    'updated: 2026-01-02T03:04:05.000Z',
    '---',
    '',
  ].join('\n');
}

// Writes a task into a project root (the source) or a receipt log — the two
// are the same layout, which is the whole point of the receipt format.
function writeTask(dir: string, id: string, title = 'a task'): void {
  const tasks = join(dir, '.dispatch', 'tasks');
  mkdirSync(tasks, { recursive: true });
  writeFileSync(join(tasks, `${id}-slug.md`), taskFile(id, title));
}

function writeJsonl(dir: string, name: string, records: unknown[]): void {
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(
    join(dir, '.dispatch', name),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
  );
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f-aaa111',
    taskId: 't-abc123',
    severity: 'major',
    verdict: 'open',
    title: 'a finding',
    detail: 'detail',
    createdAt: '2026-01-02T03:04:05.000Z',
    ...over,
  };
}

function ledgerEntry(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'l-aaa111',
    kind: 'decision',
    title: 'a decision',
    detail: 'detail',
    appliesTo: ['t-abc123'],
    createdAt: '2026-01-02T03:04:05.000Z',
    ...over,
  };
}

// Clears the marker and the ignore file, so a test can assert what a project
// looks like BEFORE it becomes database-backed. `beforeEach` records the
// marker for the retire tests, and recording it now also writes the
// sqlite-only ignore rules.
function resetToFileBacked(): void {
  rmSync(join(root, '.dispatch', 'storage.json'), { force: true });
  rmSync(join(root, '.dispatch', '.gitignore'), { force: true });
}

function retire(dryRun = false) {
  return retireLegacySources(root, { receiptsDir: log, dryRun });
}

function sourceFor(
  report: ReturnType<typeof retire>,
  name: string
): { records: number; removed: boolean; blocked: string | null } {
  const hit = report.sources.find((s) => s.source.endsWith(name));
  if (hit === undefined) throw new Error(`no source entry for ${name}`);
  return hit;
}

describe('retireLegacySources refusals', () => {
  it('refuses on a file-backed project, whose files ARE the board', () => {
    rmSync(join(root, '.dispatch', 'storage.json'));
    writeTask(root, 't-abc123');
    expect(() => retire()).toThrow(/still keeps its tasks as files/);
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(true);
  });

  it('refuses when there is no receipt log to fall back on', () => {
    writeTask(root, 't-abc123');
    expect(() => retire()).toThrow(/no receipt log at/);
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(true);
  });

  it('reports nothing to do when the legacy state is already gone', () => {
    writeTask(log, 't-abc123');
    const report = retire();
    expect(report.sources).toEqual([]);
    expect(formatRetireReport(report)).toContain('Nothing to retire');
  });
});

describe('retireLegacySources coverage checks', () => {
  it('removes each source the receipt log already covers', () => {
    writeTask(root, 't-abc123');
    writeJsonl(root, 'findings.jsonl', [finding()]);
    writeJsonl(root, 'ledger.jsonl', [ledgerEntry()]);
    writeTask(log, 't-abc123');
    writeJsonl(log, 'findings.jsonl', [finding()]);
    writeJsonl(log, 'ledger.jsonl', [ledgerEntry()]);

    const report = retire();

    expect(report.sources.map((s) => s.removed)).toEqual([true, true, true]);
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(false);
    expect(existsSync(join(root, '.dispatch', 'findings.jsonl'))).toBe(false);
    expect(existsSync(join(root, '.dispatch', 'ledger.jsonl'))).toBe(false);
    // The committable config is exactly what survives.
    writeFileSync(join(root, '.dispatch', 'config.yml'), 'autoCommit: true\n');
    expect(existsSync(join(root, '.dispatch', 'config.yml'))).toBe(true);
  });

  it('keeps a task the log has not caught up with, and says which', () => {
    writeTask(root, 't-abc123');
    writeTask(root, 't-def456');
    writeTask(log, 't-abc123');

    const tasks = sourceFor(retire(), 'tasks');

    expect(tasks.removed).toBe(false);
    expect(tasks.blocked).toContain('t-def456');
    expect(tasks.blocked).not.toContain('t-abc123');
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(true);
  });

  it('keeps a findings file whose log copy is missing a record', () => {
    writeJsonl(root, 'findings.jsonl', [
      finding(),
      finding({ id: 'f-bbb222' }),
    ]);
    writeJsonl(log, 'findings.jsonl', [finding()]);

    const findings = sourceFor(retire(), 'findings.jsonl');

    expect(findings.removed).toBe(false);
    expect(findings.blocked).toContain('f-bbb222');
    expect(existsSync(join(root, '.dispatch', 'findings.jsonl'))).toBe(true);
  });

  it('treats a re-created id as uncovered — the key is id AND createdAt', () => {
    // The JSONL stores compact on `id + createdAt`, so two records sharing an
    // id but not a timestamp are two distinct surviving records. A log holding
    // only one of them does not cover the other, and keying on id alone would
    // wrongly call this safe to delete.
    writeJsonl(root, 'ledger.jsonl', [
      ledgerEntry(),
      ledgerEntry({ createdAt: '2026-09-09T09:09:09.000Z' }),
    ]);
    writeJsonl(log, 'ledger.jsonl', [ledgerEntry()]);

    const ledger = sourceFor(retire(), 'ledger.jsonl');

    expect(ledger.records).toBe(2);
    expect(ledger.removed).toBe(false);
    expect(existsSync(join(root, '.dispatch', 'ledger.jsonl'))).toBe(true);
  });

  it('retires the covered sources even when another one is blocked', () => {
    writeTask(root, 't-abc123');
    writeJsonl(root, 'findings.jsonl', [finding()]);
    writeTask(log, 't-abc123');
    // No findings.jsonl in the log at all.

    const report = retire();

    expect(sourceFor(report, 'tasks').removed).toBe(true);
    expect(sourceFor(report, 'findings.jsonl').removed).toBe(false);
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(false);
    expect(existsSync(join(root, '.dispatch', 'findings.jsonl'))).toBe(true);
  });

  it('keeps a task file that will not parse, since it has no id to check', () => {
    writeTask(root, 't-abc123');
    writeFileSync(
      join(root, '.dispatch', 'tasks', 'broken.md'),
      '---\nnot: a task\n---\n'
    );
    writeTask(log, 't-abc123');

    const tasks = sourceFor(retire(), 'tasks');

    expect(tasks.removed).toBe(false);
    expect(tasks.blocked).toContain('will not parse');
    expect(existsSync(join(root, '.dispatch', 'tasks', 'broken.md'))).toBe(
      true
    );
  });

  it('keeps a damaged findings line rather than deleting it unrecorded', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch', 'findings.jsonl'),
      `${JSON.stringify(finding())}\nnot json at all\n`
    );
    writeJsonl(log, 'findings.jsonl', [finding()]);

    const findings = sourceFor(retire(), 'findings.jsonl');

    expect(findings.removed).toBe(false);
    expect(findings.blocked).toContain('do not read back as records');
    expect(existsSync(join(root, '.dispatch', 'findings.jsonl'))).toBe(true);
  });

  it('keeps the tasks directory when it holds something that is not a task', () => {
    // `rm -r` on the directory would take this with it, and nothing exported
    // it, so its presence stops the removal.
    writeTask(root, 't-abc123');
    writeFileSync(join(root, '.dispatch', 'tasks', 'notes.txt'), 'mine\n');
    writeTask(log, 't-abc123');

    const tasks = sourceFor(retire(), 'tasks');

    expect(tasks.removed).toBe(false);
    expect(tasks.blocked).toContain('not task files');
    expect(existsSync(join(root, '.dispatch', 'tasks', 'notes.txt'))).toBe(
      true
    );
  });

  it('deletes nothing on a dry run but reports what it would take', () => {
    writeTask(root, 't-abc123');
    writeTask(log, 't-abc123');

    const report = retire(true);

    expect(sourceFor(report, 'tasks').blocked).toBeNull();
    expect(sourceFor(report, 'tasks').removed).toBe(false);
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(true);
    expect(formatRetireReport(report)).toContain('Would retire');
  });

  it('never touches the sources with no table in the schema', () => {
    writeTask(root, 't-abc123');
    writeTask(log, 't-abc123');
    writeJsonl(root, 'fix-loops.jsonl', [{ taskId: 't-abc123' }]);
    writeFileSync(join(root, '.dispatch', 'notes.json'), '[]\n');
    mkdirSync(join(root, '.dispatch', 'inbox'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch', 'inbox', 'me.md'),
      '- [ ] a thought\n'
    );

    const report = retire();

    expect(existsSync(join(root, '.dispatch', 'fix-loops.jsonl'))).toBe(true);
    expect(existsSync(join(root, '.dispatch', 'notes.json'))).toBe(true);
    expect(existsSync(join(root, '.dispatch', 'inbox', 'me.md'))).toBe(true);
    // And they are named in the report, so nobody reads "retired" as "all of
    // it moved" and deletes them by hand afterwards.
    const printed = formatRetireReport(report);
    expect(printed).toContain('fix-loops.jsonl');
    expect(printed).toContain('notes.json');
    expect(printed).toContain('inbox');
  });
});

describe('receiptLogDir', () => {
  it('defaults under DISPATCH_HOME, keyed per project', () => {
    const previous = process.env.DISPATCH_HOME;
    process.env.DISPATCH_HOME = log;
    try {
      const dir = receiptLogDir(root, { receipts: { enabled: true } } as never);
      expect(dir.startsWith(join(log, '.dispatch', 'projects'))).toBe(true);
      expect(dir.endsWith('receipts')).toBe(true);
      // Two projects never share a log.
      const other = receiptLogDir(`${root}-other`, {
        receipts: { enabled: true },
      } as never);
      expect(other).not.toBe(dir);
    } finally {
      if (previous === undefined) delete process.env.DISPATCH_HOME;
      else process.env.DISPATCH_HOME = previous;
    }
  });

  it('resolves a relative config override against the project, not the cwd', () => {
    const dir = receiptLogDir(root, {
      receipts: { enabled: true, dir: '../audit' },
    } as never);
    expect(dir).toBe(resolve(root, '../audit'));
  });

  it('takes an absolute config override as given', () => {
    const dir = receiptLogDir(root, {
      receipts: { enabled: true, dir: '/tmp/somewhere' },
    } as never);
    expect(dir).toBe('/tmp/somewhere');
  });
});

describe('ensureProjectGitignore', () => {
  it('keeps the database out of a database-backed project', () => {
    const stores = initProjectStores({
      rootDir: root,
      backend: 'sqlite',
      dbPath: join(root, 'db', 'dispatch.db'),
    });
    stores.close();
    // The sqlite-only rules land when the project BECOMES database-backed,
    // not when a database is merely opened — `dispatch migrate` opens one and
    // can still fail. beforeEach already recorded the marker; this is the
    // write that adds them.
    writeProjectBackend(root, 'sqlite');

    const ignored = readFileSync(join(root, '.dispatch', '.gitignore'), 'utf8');
    expect(ignored).toContain('dispatch.db');
    expect(ignored).toContain('dispatch.db-wal');
    expect(ignored).toContain('dispatch.db-shm');
    // The state with no table yet is local working state on this backend.
    expect(ignored).toContain('fix-loops.jsonl');
    expect(ignored).toContain('notes.json');
    expect(ignored).toContain('inbox/');
    // The marker is per-machine too: a clone carrying it without the database
    // it names reads as a board that is confidently empty (t-880ce2).
    expect(ignored).toContain('storage.json');
  });

  it('leaves a file-backed project committing its own board', () => {
    resetToFileBacked();
    initProjectStores({ rootDir: root, backend: 'files' }).close();

    const ignored = readFileSync(join(root, '.dispatch', '.gitignore'), 'utf8');
    expect(ignored).toContain('dispatch.db');
    // git IS the sync layer here, so an inbox arriving with a pull is the
    // behaviour these projects already have.
    expect(ignored).not.toContain('inbox/');
    expect(ignored).not.toContain('fix-loops.jsonl');
  });

  it('tops up an existing file without dropping anything a user added', () => {
    resetToFileBacked();
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    const path = join(root, '.dispatch', '.gitignore');
    writeFileSync(path, '# mine\nscratch/\n');

    ensureProjectGitignore(root, 'sqlite');

    const ignored = readFileSync(path, 'utf8');
    expect(ignored).toContain('scratch/');
    expect(ignored).toContain('dispatch.db');
    expect(ignored).toContain('inbox/');
  });

  it('is idempotent — a second call adds nothing', () => {
    ensureProjectGitignore(root, 'sqlite');
    const path = join(root, '.dispatch', '.gitignore');
    const first = readFileSync(path, 'utf8');

    ensureProjectGitignore(root, 'sqlite');

    expect(readFileSync(path, 'utf8')).toBe(first);
  });

  it('upgrades a files-backed ignore file when the project moves', () => {
    resetToFileBacked();
    ensureProjectGitignore(root, 'files');
    const path = join(root, '.dispatch', '.gitignore');
    expect(readFileSync(path, 'utf8')).not.toContain('inbox/');

    ensureProjectGitignore(root, 'sqlite');

    const ignored = readFileSync(path, 'utf8');
    expect(ignored).toContain('inbox/');
    // Without re-appending anything it already had. Every line, not just the
    // rules: the first version of this appended the machine-local COMMENT a
    // second time, which the rules-only assertion below did not catch.
    const duplicated = ignored
      .split('\n')
      .filter((line) => line.trim() !== '')
      .filter((line, index, all) => all.indexOf(line) !== index);
    expect(duplicated).toEqual([]);
  });
});

describe('retireLegacySources shared-repo gate', () => {
  // A GitReader that reports whatever remotes the test wants.
  function gitWith(remotes: string): (args: string[]) => string | null {
    return (args) => (args[0] === 'remote' ? remotes : null);
  }

  it('refuses in a repo with a remote, naming the teammate hazard', () => {
    writeTask(root, 't-abc123');
    writeTask(log, 't-abc123');

    expect(() =>
      retireLegacySources(root, {
        receiptsDir: log,
        git: gitWith('origin'),
      })
    ).toThrow(/teammate|shared/i);
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(true);
  });

  it('proceeds with --force-solo', () => {
    writeTask(root, 't-abc123');
    writeTask(log, 't-abc123');

    retireLegacySources(root, {
      receiptsDir: log,
      git: gitWith('origin'),
      forceSolo: true,
    });

    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(false);
  });

  it('proceeds with no remote configured', () => {
    writeTask(root, 't-abc123');
    writeTask(log, 't-abc123');

    retireLegacySources(root, { receiptsDir: log, git: gitWith('') });

    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(false);
  });

  it('still rehearses a shared repo, so you can see what you would ask for', () => {
    writeTask(root, 't-abc123');
    writeTask(log, 't-abc123');

    const report = retireLegacySources(root, {
      receiptsDir: log,
      git: gitWith('origin'),
      dryRun: true,
    });

    expect(sourceFor(report, 'tasks').blocked).toBeNull();
    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(true);
  });

  it('treats an unusable git as not-shared rather than blocking on it', () => {
    writeTask(root, 't-abc123');
    writeTask(log, 't-abc123');

    retireLegacySources(root, { receiptsDir: log, git: () => null });

    expect(existsSync(join(root, '.dispatch', 'tasks'))).toBe(false);
  });
});

describe('evidence reaches the receipt log', () => {
  // Finding: nothing wrote the evidence/mutations tables — the orchestrator
  // appended to run transcripts only — so materializeReceipts swept an
  // always-empty pair of tables and the log's `.dispatch/evidence/` was
  // permanently empty while the README claimed the log could rebuild a
  // project's history. The orchestrator now mirrors both into the database;
  // this pins the export half of that path.
  it('materializes evidence written through the database stores', async () => {
    const { initProjectStores } = await import('../src/storeBackend.js');
    const { materializeReceipts } = await import('../src/receipts.js');
    const stores = initProjectStores({
      rootDir: root,
      backend: 'sqlite',
      dbPath: join(root, 'db', 'dispatch.db'),
    });
    try {
      const records = stores.records;
      if (records === null) throw new Error('expected database-backed stores');
      records.evidence.addCommand('r-abc123', {
        command: 'bun test',
        exitCode: 0,
        durationMs: 12,
        summary: 'all green',
        at: '2026-03-03T03:03:03.000Z',
      });
      records.evidence.addMutation('r-abc123', {
        guard: 'refuses without a receipt log',
        file: 'packages/core/src/retire.ts',
        testsFailed: 1,
        at: '2026-03-03T03:03:04.000Z',
      });

      const out = materializeReceipts(stores, log);

      expect(out.tally.commands).toBe(1);
      expect(out.tally.mutations).toBe(1);
      const written = readFileSync(
        join(log, '.dispatch', 'evidence', 'r-abc123.jsonl'),
        'utf8'
      );
      expect(written).toContain('bun test');
      expect(written).toContain('refuses without a receipt log');
    } finally {
      stores.close();
    }
  });
});

describe('a failed migration leaves the file-backed rules alone', () => {
  it('does not pre-ignore inbox/notes/fix-loops just for opening a database', () => {
    // `dispatch migrate` opens the database before importing. If the import
    // fails the project is still file-backed — and on that backend the inbox
    // and fix-loop state are committed, not ignored. Writing the sqlite rules
    // at open time silently stopped git tracking them for a migration that
    // never completed.
    resetToFileBacked();
    initProjectStores({
      rootDir: root,
      backend: 'sqlite',
      dbPath: join(root, 'db', 'dispatch.db'),
    }).close();

    const ignored = readFileSync(join(root, '.dispatch', '.gitignore'), 'utf8');
    expect(ignored).toContain('dispatch.db');
    expect(ignored).not.toContain('inbox/');
    expect(ignored).not.toContain('fix-loops.jsonl');
  });
});
