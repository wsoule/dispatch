import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  formatMigrationReport,
  hasLegacyState,
  importLegacyProject,
  totalImported,
} from '../src/migrate.js';
import type { MigrationReport } from '../src/migrate.js';
import { TaskStore } from '../src/store.js';
import { initProjectStores, openProjectStores } from '../src/storeBackend.js';
import type { ProjectStores } from '../src/storeBackend.js';

let root: string;
const opened: ProjectStores[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-migrate-'));
});

afterEach(() => {
  for (const stores of opened.splice(0)) stores.close();
  rmSync(root, { recursive: true, force: true });
});

// The database is kept out of the project directory in these tests so the
// legacy-state scan and the import target never share a parent — the same
// separation the storage plan is heading for.
function sqliteStores(): ProjectStores {
  const stores = initProjectStores({
    rootDir: root,
    backend: 'sqlite',
    dbPath: join(root, 'db', 'dispatch.db'),
  });
  opened.push(stores);
  return stores;
}

function writeTaskFile(filename: string, frontmatter: string, body = ''): void {
  const dir = join(root, '.dispatch', 'tasks');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), `---\n${frontmatter}\n---\n${body}`);
}

// A realistic task file: every required frontmatter key, distinct created and
// updated stamps, and a blocked-by edge — the three things the import promises
// to preserve.
function legacyTask(
  id: string,
  title: string,
  extra: Record<string, string> = {}
): string {
  const lines = [
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    'status: in-progress',
    `kind: ${id.startsWith('e-') ? 'epic' : 'task'}`,
    'created: 2026-01-02T03:04:05.000Z',
    'updated: 2026-05-06T07:08:09.000Z',
    ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`),
  ];
  return lines.join('\n');
}

function writeJsonl(name: string, records: unknown[]): void {
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(
    join(root, '.dispatch', name),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
  );
}

function finding(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f-aaa111',
    taskId: 't-abc123',
    runId: 'r-111111',
    severity: 'important',
    verdict: 'open',
    title: 'Null deref',
    detail: 'It explodes',
    file: 'src/a.ts',
    line: 12,
    ruling: null,
    round: 0,
    createdAt: '2026-02-02T00:00:00.000Z',
    updatedAt: '2026-02-03T00:00:00.000Z',
    raisedBy: 'agent:claude',
    ...over,
  };
}

function ledgerEntry(
  over: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'l-aaa111',
    epicId: 'e-def456',
    sourceTaskId: 't-abc123',
    kind: 'decision',
    title: 'Use SQLite',
    detail: 'Because a file cannot hold a transaction',
    appliesTo: ['t-abc123'],
    createdAt: '2026-02-02T00:00:00.000Z',
    authoredBy: 'human:wyat',
    ...over,
  };
}

describe('hasLegacyState', () => {
  it('is false for a project with no .dispatch at all', () => {
    expect(hasLegacyState(root)).toBe(false);
  });

  // An inbox on its own is not legacy state: this import does not move it, so
  // reporting it here would make the daemon log an all-zeroes report forever.
  it('ignores sources the import deliberately does not move', () => {
    mkdirSync(join(root, '.dispatch', 'inbox'), { recursive: true });
    writeFileSync(join(root, '.dispatch', 'notes.json'), '[]');
    expect(hasLegacyState(root)).toBe(false);
  });

  it('is true once there is a tasks directory, a findings log, or a ledger', () => {
    writeJsonl('ledger.jsonl', [ledgerEntry()]);
    expect(hasLegacyState(root)).toBe(true);
  });
});

describe('importLegacyProject', () => {
  it('refuses to run against the file backend', () => {
    const stores = initProjectStores({ rootDir: root });
    opened.push(stores);
    expect(() => importLegacyProject(stores)).toThrow(
      /cannot import into the files backend/
    );
  });

  it('preserves ids, timestamps, blocked-by edges and the body verbatim', () => {
    writeTaskFile(
      't-abc123-fix-login.md',
      legacyTask('t-abc123', 'Fix login', {
        'blocked-by': '\n  - t-999999\n  - e-def456',
        labels: '\n  - auth',
        priority: 'high',
        risk: 'elevated',
        exercised: 'true',
      }),
      '\n## Description\n\nIt is broken.\n'
    );
    const stores = sqliteStores();
    const report = importLegacyProject(stores);

    expect(report.tasks.found).toBe(1);
    expect(report.tasks.imported).toBe(1);
    const doc = stores.tasks.get('t-abc123');
    expect(doc?.meta.created).toBe('2026-01-02T03:04:05.000Z');
    expect(doc?.meta.updated).toBe('2026-05-06T07:08:09.000Z');
    expect(doc?.meta.blockedBy).toEqual(['t-999999', 'e-def456']);
    expect(doc?.meta.labels).toEqual(['auth']);
    expect(doc?.meta.priority).toBe('high');
    expect(doc?.meta.risk).toBe('elevated');
    expect(doc?.meta.exercised).toBe(true);
    expect(doc?.body).toBe('\n## Description\n\nIt is broken.\n');
  });

  // The filename, not the title, is where the slug comes from: a task retitled
  // after its file was created keeps the old filename on the file backend, and
  // a migration must not quietly rename it.
  it('keeps the slug the task file was named with, not one recomputed from the title', () => {
    writeTaskFile(
      't-abc123-the-original-slug.md',
      legacyTask('t-abc123', 'A completely different title now')
    );
    const stores = sqliteStores();
    importLegacyProject(stores);
    const exported = (
      stores.tasks as unknown as {
        toMarkdown(id: string): { filename: string } | null;
      }
    ).toMarkdown('t-abc123');
    expect(exported?.filename).toBe('t-abc123-the-original-slug.md');
  });

  it('counts epics separately from tasks', () => {
    writeTaskFile('t-abc123-a.md', legacyTask('t-abc123', 'A task'));
    writeTaskFile('e-def456-b.md', legacyTask('e-def456', 'An epic'));
    const report = importLegacyProject(sqliteStores());
    expect(report.tasks.found).toBe(1);
    expect(report.epics.found).toBe(1);
    expect(report.rowsAfter.tasks).toBe(1);
    expect(report.rowsAfter.epics).toBe(1);
  });

  it('imports findings and ledger entries with their own ids and stamps', () => {
    writeJsonl('findings.jsonl', [finding()]);
    writeJsonl('ledger.jsonl', [ledgerEntry()]);
    const stores = sqliteStores();
    const report = importLegacyProject(stores);

    expect(report.findings.imported).toBe(1);
    expect(report.ledger.imported).toBe(1);
    const imported = stores.records?.findings.get('f-aaa111');
    expect(imported?.createdAt).toBe('2026-02-02T00:00:00.000Z');
    expect(imported?.updatedAt).toBe('2026-02-03T00:00:00.000Z');
    expect(imported?.raisedBy).toBe('agent:claude');
    expect(stores.records?.ledger.get('l-aaa111')?.appliesTo).toEqual([
      't-abc123',
    ]);
  });

  // The JSONL stores are append-only: an update is a fresh line. Only the
  // latest state of each id should reach the database.
  it('takes the last line for an id, not the first', () => {
    writeJsonl('findings.jsonl', [
      finding(),
      finding({ verdict: 'addressed', ruling: 'fixed in round 2' }),
    ]);
    const stores = sqliteStores();
    const report = importLegacyProject(stores);
    expect(report.findings.found).toBe(1);
    expect(stores.records?.findings.get('f-aaa111')?.verdict).toBe('addressed');
  });

  it('rolls the whole import back on a dry run but still reports what it did', () => {
    writeTaskFile('t-abc123-a.md', legacyTask('t-abc123', 'A task'));
    writeJsonl('findings.jsonl', [finding()]);
    const stores = sqliteStores();
    const report = importLegacyProject(stores, { dryRun: true });

    expect(report.dryRun).toBe(true);
    expect(report.tasks.imported).toBe(1);
    expect(report.findings.imported).toBe(1);
    // The counts are read inside the transaction, so they describe the import
    // that happened — and then the rollback undoes it.
    expect(report.rowsAfter.tasks).toBe(1);
    expect(stores.tasks.get('t-abc123')).toBeNull();
    expect(stores.records?.findings.get('f-aaa111')).toBeNull();
  });

  it('is idempotent: a second run imports nothing and changes nothing', () => {
    writeTaskFile('t-abc123-a.md', legacyTask('t-abc123', 'A task'));
    writeJsonl('findings.jsonl', [finding()]);
    writeJsonl('ledger.jsonl', [ledgerEntry()]);
    const stores = sqliteStores();
    const first = importLegacyProject(stores);
    const second = importLegacyProject(stores);

    expect(totalImported(first)).toBe(3);
    expect(totalImported(second)).toBe(0);
    expect(second.tasks.skipped).toBe(1);
    expect(second.findings.skipped).toBe(1);
    expect(second.ledger.skipped).toBe(1);
    expect(second.rowsBefore).toEqual(second.rowsAfter);
  });

  // The point of insert-if-absent. Once the daemon owns a task, a stale
  // markdown file left on disk must not be able to reinstate the old status.
  it('never overwrites a record the daemon has already moved on from', () => {
    writeTaskFile('t-abc123-a.md', legacyTask('t-abc123', 'A task'));
    const stores = sqliteStores();
    importLegacyProject(stores);
    stores.tasks.update('t-abc123', { status: 'done' });
    importLegacyProject(stores);
    expect(stores.tasks.get('t-abc123')?.meta.status).toBe('landed');
  });

  it('leaves every source file exactly where it was', () => {
    writeTaskFile('t-abc123-a.md', legacyTask('t-abc123', 'A task'));
    writeJsonl('findings.jsonl', [finding()]);
    writeJsonl('ledger.jsonl', [ledgerEntry()]);
    importLegacyProject(sqliteStores());
    expect(existsSync(join(root, '.dispatch', 'tasks', 't-abc123-a.md'))).toBe(
      true
    );
    expect(existsSync(join(root, '.dispatch', 'findings.jsonl'))).toBe(true);
    expect(existsSync(join(root, '.dispatch', 'ledger.jsonl'))).toBe(true);
    expect(new TaskStore(root).get('t-abc123')?.meta.title).toBe('A task');
  });

  it('reports a damaged task file without losing the good ones beside it', () => {
    writeTaskFile('t-abc123-a.md', legacyTask('t-abc123', 'A task'));
    writeTaskFile('t-bad999-b.md', 'id: t-bad999\ntitle: no kind here');
    const report = importLegacyProject(sqliteStores());
    expect(report.tasks.imported).toBe(1);
    expect(report.tasks.damaged).toBe(1);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.detail).toContain('t-bad999-b.md');
  });

  // A row is validated on the way back OUT of SQLite, so importing an
  // out-of-set enum would mint a row nothing can ever read again.
  it('rejects a finding whose severity is outside the set rather than minting an unreadable row', () => {
    writeJsonl('findings.jsonl', [
      finding({ id: 'f-bbb222', severity: 'catastrophic' }),
      finding(),
    ]);
    const stores = sqliteStores();
    const report = importLegacyProject(stores);
    expect(report.findings.imported).toBe(1);
    expect(report.findings.damaged).toBe(1);
    expect(stores.records?.findings.get('f-bbb222')).toBeNull();
    // Every surviving row reads back cleanly — that is what the rejection buys.
    expect(stores.records?.findings.list()).toHaveLength(1);
  });

  // A ledger entry that reads back with an empty appliesTo stops being aimed at
  // one task and starts applying to every task under its epic.
  it('rejects a ledger entry whose appliesTo is not a list of strings', () => {
    writeJsonl('ledger.jsonl', [ledgerEntry({ appliesTo: 't-abc123' })]);
    const report = importLegacyProject(sqliteStores());
    expect(report.ledger.imported).toBe(0);
    expect(report.ledger.damaged).toBe(1);
  });

  it('skips an unparsable JSONL line and keeps the rest of the file', () => {
    mkdirSync(join(root, '.dispatch'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch', 'findings.jsonl'),
      `${JSON.stringify(finding())}\n{not json\n`
    );
    const report = importLegacyProject(sqliteStores());
    expect(report.findings.imported).toBe(1);
    expect(report.findings.damaged).toBe(1);
    expect(report.problems[0]?.detail).toContain('not valid JSON');
  });

  // Two records sharing an id with different timestamps both survive in a
  // JSONL file; a primary key cannot hold both, and the one that loses has to
  // be named rather than vanish.
  it('reports the record it could not fit when one id covers two records', () => {
    writeJsonl('findings.jsonl', [
      finding({ createdAt: '2026-02-02T00:00:00.000Z' }),
    ]);
    const stores = sqliteStores();
    importLegacyProject(stores);
    // A second file-level record under the same id, written after the first
    // import already claimed the row.
    writeJsonl('findings.jsonl', [
      finding({
        title: 'A different finding',
        createdAt: '2026-09-09T00:00:00.000Z',
      }),
    ]);
    const second = importLegacyProject(stores);
    expect(second.findings.skipped).toBe(1);
    expect(stores.records?.findings.get('f-aaa111')?.title).toBe('Null deref');
  });

  // The same collision WITHIN one file. This is the case a primary key cannot
  // represent at all, so one of the two records is unrecoverably dropped —
  // and counting that as `skipped` would report a real data loss with the
  // number that otherwise means "already there, nothing to do".
  it('names both records when one file holds two under a single id', () => {
    writeJsonl('findings.jsonl', [
      finding({ createdAt: '2026-02-02T00:00:00.000Z' }),
      finding({
        title: 'A different finding',
        createdAt: '2026-09-09T00:00:00.000Z',
      }),
    ]);
    const stores = sqliteStores();
    const report = importLegacyProject(stores);

    expect(report.findings.imported).toBe(1);
    expect(report.findings.damaged).toBe(1);
    expect(report.findings.skipped).toBe(0);
    const problem = report.problems.find((p) => p.detail.includes('f-aaa111'));
    // Both stamps named, so the dropped record can actually be found again.
    expect(problem?.detail).toContain('2026-02-02T00:00:00.000Z');
    expect(problem?.detail).toContain('2026-09-09T00:00:00.000Z');
    expect(formatMigrationReport(report)).toContain('f-aaa111');
  });

  // A hand-written id that parseTaskFile accepts (it only checks the field is
  // present) but put() rejects. Before this, the throw escaped into the
  // transaction's catch, rolled the entire import back, and — on the daemon's
  // boot path — stopped dispatchd starting at all.
  it('costs one unimportable task file itself, not the whole migration', () => {
    writeTaskFile('t-abc123-good.md', legacyTask('t-abc123', 'A good task'));
    writeTaskFile(
      'not-an-id.md',
      [
        'id: my-hand-written-id',
        'title: "Hand written"',
        'status: in-progress',
        'kind: task',
        'created: 2026-01-02T03:04:05.000Z',
        'updated: 2026-01-02T03:04:05.000Z',
      ].join('\n')
    );
    const stores = sqliteStores();
    const report = importLegacyProject(stores);

    expect(report.tasks.imported).toBe(1);
    expect(report.tasks.damaged).toBe(1);
    expect(stores.tasks.get('t-abc123')).not.toBeNull();
    expect(
      report.problems.some((p) => p.detail.includes('my-hand-written-id'))
    ).toBe(true);
  });

  it('defaults the fields older lines predate instead of dropping the record', () => {
    writeJsonl('findings.jsonl', [
      {
        id: 'f-ccc333',
        taskId: 't-abc123',
        severity: 'minor',
        verdict: 'open',
        title: 'Ancient',
        detail: 'From before raisedBy existed',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    ]);
    const stores = sqliteStores();
    expect(importLegacyProject(stores).findings.imported).toBe(1);
    const imported = stores.records?.findings.get('f-ccc333');
    expect(imported?.raisedBy).toBe('');
    expect(imported?.round).toBe(0);
    expect(imported?.updatedAt).toBe('2025-01-01T00:00:00.000Z');
    // Absent stays absent, so the record keeps the shape it had on disk.
    expect(imported?.files).toBeUndefined();
    expect(imported?.recommendation).toBeUndefined();
  });
});

describe('the sources the import deliberately leaves alone', () => {
  function reportWithRetained(): MigrationReport {
    mkdirSync(join(root, '.dispatch', 'inbox'), { recursive: true });
    writeFileSync(
      join(root, '.dispatch', 'inbox', 'wyat.md'),
      '# Inbox\n\n## Open\n\n- [ ] (bug) one ^in-aaa111\n- [x] (task) two ^in-bbb222\n\nnot an item\n'
    );
    writeFileSync(
      join(root, '.dispatch', 'notes.json'),
      JSON.stringify([{ title: 'a note' }, { title: 'another' }])
    );
    writeJsonl('fix-loops.jsonl', [
      { taskId: 't-abc123', round: 1 },
      { taskId: 't-abc123', round: 2 },
      { taskId: 't-def456', round: 1 },
    ]);
    return importLegacyProject(sqliteStores());
  }

  it('counts them all and says why each stayed', () => {
    const bySource = new Map(
      reportWithRetained().retained.map((r) => [r.source, r])
    );
    // Compacted the way FixLoopStore compacts: two loops, not three writes.
    expect(bySource.get('.dispatch/fix-loops.jsonl')?.found).toBe(2);
    expect(bySource.get('.dispatch/notes.json')?.found).toBe(2);
    expect(bySource.get('.dispatch/inbox')?.found).toBe(2);
    for (const retained of bySource.values()) {
      expect(retained.reason).not.toBe('');
    }
  });

  it('names them in the printed report rather than omitting them', () => {
    const text = formatMigrationReport(reportWithRetained());
    expect(text).toContain('.dispatch/fix-loops.jsonl');
    expect(text).toContain('.dispatch/notes.json');
    expect(text).toContain('.dispatch/inbox');
    expect(text).toContain('~/.dispatch/runs/<project>/*.jsonl');
    expect(text).toContain('nothing was deleted, moved, or rewritten');
  });

  it('leaves their files untouched', () => {
    reportWithRetained();
    expect(existsSync(join(root, '.dispatch', 'inbox', 'wyat.md'))).toBe(true);
    expect(existsSync(join(root, '.dispatch', 'notes.json'))).toBe(true);
    expect(existsSync(join(root, '.dispatch', 'fix-loops.jsonl'))).toBe(true);
  });
});

describe('formatMigrationReport', () => {
  it('prints a row-parity line per table and flags a mismatch', () => {
    writeTaskFile('t-abc123-a.md', legacyTask('t-abc123', 'A task'));
    const report = importLegacyProject(sqliteStores());
    expect(formatMigrationReport(report)).not.toContain('MISMATCH');

    const lying: MigrationReport = {
      ...report,
      tasks: { ...report.tasks, imported: 99 },
    };
    expect(formatMigrationReport(lying)).toContain('MISMATCH');
  });

  it('says plainly that a dry run wrote nothing', () => {
    const text = formatMigrationReport(
      importLegacyProject(sqliteStores(), { dryRun: true })
    );
    expect(text).toContain('Dry run — nothing was written');
  });
});

describe('importing into an attached database', () => {
  // The daemon opens the database once at boot and holds it; a later import
  // through a second handle on the same file has to see the same rows.
  it('sees rows a previous import committed through another handle', () => {
    writeTaskFile('t-abc123-a.md', legacyTask('t-abc123', 'A task'));
    const dbPath = join(root, 'db', 'dispatch.db');
    const first = initProjectStores({
      rootDir: root,
      backend: 'sqlite',
      dbPath,
    });
    importLegacyProject(first);
    first.close();

    const second = openProjectStores({
      rootDir: root,
      backend: 'sqlite',
      dbPath,
    });
    opened.push(second);
    const report = importLegacyProject(second);
    expect(report.tasks.imported).toBe(0);
    expect(report.tasks.skipped).toBe(1);
  });
});
