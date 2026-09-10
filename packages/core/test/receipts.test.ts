import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { materializeReceipts, restoreReceipts } from '../src/receipts.js';
import { initProjectStores, openProjectStores } from '../src/storeBackend.js';
import type { ProjectStores } from '../src/storeBackend.js';

let root: string;
const opened: ProjectStores[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-receipts-'));
});

afterEach(() => {
  for (const stores of opened.splice(0)) stores.close();
  rmSync(root, { recursive: true, force: true });
});

// A database-backed project, with its database deliberately outside the
// project directory — the same separation the receipt log itself relies on.
function projectStores(name: string): ProjectStores {
  const dir = join(root, name);
  const stores = initProjectStores({
    rootDir: dir,
    backend: 'sqlite',
    dbPath: join(root, `${name}.db`),
  });
  opened.push(stores);
  return stores;
}

function receiptsDir(): string {
  return join(root, 'receipts');
}

// A project with one of everything the log is supposed to carry: an epic and a
// task under it, a finding, a ledger decision, and a run's worth of evidence.
function seed(stores: ProjectStores): {
  epicId: string;
  taskId: string;
  findingId: string;
  ledgerId: string;
} {
  const epic = stores.tasks.create({
    kind: 'epic',
    title: 'Storage spine',
    description: 'The epic body.',
  });
  const task = stores.tasks.create({
    kind: 'task',
    title: 'Receipts exporter',
    description: 'The task body, with a trailing line.',
    parent: epic.meta.id,
    labels: ['storage', 'audit'],
    priority: 'high',
  });
  const records = stores.records;
  if (records === null) throw new Error('expected a database');
  const finding = records.findings.add({
    taskId: task.meta.id,
    runId: 'r-000001',
    severity: 'important',
    title: 'Export never prunes',
    detail: 'A removed task keeps its receipt forever.',
    file: 'packages/core/src/receipts.ts',
    line: 42,
    raisedBy: 'tester',
  });
  const ledger = records.ledger.add({
    epicId: epic.meta.id,
    sourceTaskId: task.meta.id,
    kind: 'decision',
    title: 'Receipt format is the legacy layout',
    detail: 'So the migration importer is the restore path.',
    appliesTo: [task.meta.id],
    authoredBy: 'tester',
  });
  records.evidence.addCommand('r-000001', {
    command: 'bun test',
    exitCode: 0,
    durationMs: 1234,
    summary: '12 pass, 0 fail',
    at: '2026-08-24T10:00:00.000Z',
  });
  records.evidence.addCommand('r-000001', {
    command: 'bun run tsc',
    exitCode: 0,
    durationMs: 5678,
    summary: 'clean',
    at: '2026-08-24T10:01:00.000Z',
  });
  records.evidence.addMutation('r-000001', {
    guard: 'reverted the prune check',
    file: 'packages/core/src/receipts.ts',
    testsFailed: 3,
    at: '2026-08-24T10:02:00.000Z',
  });
  return {
    epicId: epic.meta.id,
    taskId: task.meta.id,
    findingId: finding.id,
    ledgerId: ledger.id,
  };
}

describe('materializeReceipts', () => {
  it('writes the log as a file-backed project layout', () => {
    const stores = projectStores('project');
    const ids = seed(stores);
    const dir = receiptsDir();

    const report = materializeReceipts(stores, dir);

    expect(report.tally).toEqual({
      tasks: 2,
      findings: 1,
      ledger: 1,
      runs: 1,
      commands: 2,
      mutations: 1,
    });
    expect(report.problems).toEqual([]);
    expect(existsSync(join(dir, '.dispatch', 'findings.jsonl'))).toBe(true);
    expect(existsSync(join(dir, '.dispatch', 'ledger.jsonl'))).toBe(true);
    expect(
      existsSync(join(dir, '.dispatch', 'evidence', 'r-000001.jsonl'))
    ).toBe(true);
    expect(existsSync(join(dir, 'README.md'))).toBe(true);

    const taskFiles = readdirSync(join(dir, '.dispatch', 'tasks')).sort();
    expect(taskFiles).toEqual([
      `${ids.epicId}-storage-spine.md`,
      `${ids.taskId}-receipts-exporter.md`,
    ]);
    // The task file is the same document the file backend would have written,
    // frontmatter and all — that is what makes `cp -r` a real restore route.
    const taskFile = readFileSync(
      join(dir, '.dispatch', 'tasks', `${ids.taskId}-receipts-exporter.md`),
      'utf8'
    );
    expect(taskFile).toStartWith('---\n');
    expect(taskFile).toContain(`id: ${ids.taskId}`);
    expect(taskFile).toContain('The task body, with a trailing line.');
  });

  it('is idempotent: a second pass against an unchanged database changes nothing', () => {
    const stores = projectStores('project');
    seed(stores);
    const dir = receiptsDir();

    const first = materializeReceipts(stores, dir);
    expect(first.changed.length).toBeGreaterThan(0);

    const second = materializeReceipts(stores, dir);
    expect(second.changed).toEqual([]);
    expect(second.removed).toEqual([]);
    expect(second.tally).toEqual(first.tally);
  });

  it('reports only the files a change actually touched', () => {
    const stores = projectStores('project');
    const ids = seed(stores);
    const dir = receiptsDir();
    materializeReceipts(stores, dir);

    stores.tasks.update(ids.taskId, { status: 'review' });
    const report = materializeReceipts(stores, dir);

    expect(report.changed).toEqual([
      `.dispatch/tasks/${ids.taskId}-receipts-exporter.md`,
    ]);
    expect(report.removed).toEqual([]);
  });

  it('deletes the receipt of a task the database dropped', () => {
    const stores = projectStores('project');
    const ids = seed(stores);
    const dir = receiptsDir();
    materializeReceipts(stores, dir);

    expect(stores.tasks.remove(ids.taskId)).toBe(true);
    const report = materializeReceipts(stores, dir);

    expect(report.removed).toEqual([
      `.dispatch/tasks/${ids.taskId}-receipts-exporter.md`,
    ]);
    expect(
      existsSync(
        join(dir, '.dispatch', 'tasks', `${ids.taskId}-receipts-exporter.md`)
      )
    ).toBe(false);
    // The epic is untouched — pruning removes what left the database, not
    // everything it did not write this pass.
    expect(
      existsSync(
        join(dir, '.dispatch', 'tasks', `${ids.epicId}-storage-spine.md`)
      )
    ).toBe(true);
  });

  it('names a row it cannot read instead of failing the whole export', () => {
    const stores = projectStores('project');
    seed(stores);
    const records = stores.records;
    if (records === null) throw new Error('expected a database');
    // Enum columns are validated on the way OUT of SQLite, so a severity
    // outside the set inserts happily and then throws on every read — the same
    // trap the one-time migration documents. The export has to survive one.
    records.db
      .prepare('UPDATE findings SET severity = ? WHERE id = ?')
      .run('catastrophic', records.findings.list({})[0]?.id ?? '');

    const report = materializeReceipts(stores, receiptsDir());

    expect(report.tally.findings).toBe(0);
    expect(report.tally.tasks).toBe(2);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.detail).toContain('severity');
  });

  it('keeps the last good receipt of a task it can no longer serialize', () => {
    const stores = projectStores('project');
    const ids = seed(stores);
    const dir = receiptsDir();
    materializeReceipts(stores, dir);
    const records = stores.records;
    if (records === null) throw new Error('expected a database');
    // A slug that is not a slug makes toMarkdown throw, so this pass produces
    // no file for the task. Its previous receipt must survive that: the row is
    // still in the database, so deleting it would turn one damaged column into
    // the loss of the only copy of that task's history.
    records.db
      .prepare('UPDATE tasks SET slug = ? WHERE id = ?')
      .run('../escaped', ids.taskId);

    const report = materializeReceipts(stores, dir);

    expect(report.problems).toHaveLength(1);
    expect(report.removed).toEqual([]);
    expect(
      existsSync(
        join(dir, '.dispatch', 'tasks', `${ids.taskId}-receipts-exporter.md`)
      )
    ).toBe(true);
  });

  it('refuses to let a run id escape the evidence directory', () => {
    const stores = projectStores('project');
    seed(stores);
    const records = stores.records;
    if (records === null) throw new Error('expected a database');
    // run_id reaches this database from the orchestrator and is never checked
    // on the way in, so the export is the last place to catch one that would
    // write outside the log.
    records.db
      .prepare('UPDATE evidence SET run_id = ? WHERE run_id = ?')
      .run('../../escaped', 'r-000001');
    records.db
      .prepare('UPDATE mutations SET run_id = ? WHERE run_id = ?')
      .run('../../escaped', 'r-000001');
    const dir = receiptsDir();

    const report = materializeReceipts(stores, dir);

    expect(report.tally.runs).toBe(0);
    // The tally states what the LOG holds, so a rejected run contributes
    // nothing to it — otherwise it would claim evidence nobody can read.
    expect(report.tally.commands).toBe(0);
    expect(report.tally.mutations).toBe(0);
    expect(
      report.problems.some((p) => p.detail.includes('not a usable run id'))
    ).toBe(true);
    expect(existsSync(join(root, 'escaped.jsonl'))).toBe(false);
    expect(existsSync(join(dir, '..', '..', 'escaped.jsonl'))).toBe(false);
  });

  it('keeps the receipt of a task row listSafe could not read at all', () => {
    const stores = projectStores('project');
    const ids = seed(stores);
    const dir = receiptsDir();
    materializeReceipts(stores, dir);
    const records = stores.records;
    if (records === null) throw new Error('expected a database');
    // `priority` is enum-validated on the way out, so a value outside the set
    // makes listSafe report the row as damaged rather than returning it — it
    // never reaches the toMarkdown loop at all. The row is still in the
    // database, so its file must survive: pruning it would commit the deletion
    // of a task that did not go anywhere. (`status` is deliberately NOT used
    // here: statuses are project-configurable, so that column is free-form.)
    records.db
      .prepare('UPDATE tasks SET priority = ? WHERE id = ?')
      .run('extremely-high', ids.taskId);

    const report = materializeReceipts(stores, dir);

    expect(report.removed).toEqual([]);
    expect(report.problems.some((p) => p.detail.includes(ids.taskId))).toBe(
      true
    );
    expect(
      existsSync(
        join(dir, '.dispatch', 'tasks', `${ids.taskId}-receipts-exporter.md`)
      )
    ).toBe(true);
  });

  it('keeps the exported line of a finding it can no longer read', () => {
    const stores = projectStores('project');
    const ids = seed(stores);
    const dir = receiptsDir();
    materializeReceipts(stores, dir);
    const findingsFile = join(dir, '.dispatch', 'findings.jsonl');
    expect(readFileSync(findingsFile, 'utf8')).toContain(ids.findingId);
    const records = stores.records;
    if (records === null) throw new Error('expected a database');
    records.db
      .prepare('UPDATE findings SET severity = ? WHERE id = ?')
      .run('catastrophic', ids.findingId);

    const report = materializeReceipts(stores, dir);

    // Rewriting the file from the readable rows alone would have dropped this
    // line and committed the deletion of a finding that still exists.
    expect(readFileSync(findingsFile, 'utf8')).toContain(ids.findingId);
    expect(report.changed).not.toContain('.dispatch/findings.jsonl');
  });

  it('drops a finding that genuinely left the database', () => {
    const stores = projectStores('project');
    const ids = seed(stores);
    const dir = receiptsDir();
    materializeReceipts(stores, dir);
    const records = stores.records;
    if (records === null) throw new Error('expected a database');
    records.db.prepare('DELETE FROM findings WHERE id = ?').run(ids.findingId);

    materializeReceipts(stores, dir);

    // The carry-forward above must not turn into "never delete anything":
    // a deleted record has to leave the log so the commit records it.
    expect(
      readFileSync(join(dir, '.dispatch', 'findings.jsonl'), 'utf8')
    ).not.toContain(ids.findingId);
  });

  it('refuses to export a file-backed project', () => {
    const files = openProjectStores({ rootDir: join(root, 'files') });
    opened.push(files);
    expect(() => materializeReceipts(files, receiptsDir())).toThrow(
      /files backend/
    );
  });
});

describe('round trip', () => {
  it('rebuilds every record from the log alone after the database is lost', () => {
    const source = projectStores('project');
    const ids = seed(source);
    const dir = receiptsDir();
    materializeReceipts(source, dir);

    // Everything the original database held, read out before it goes away.
    const sourceRecords = source.records;
    if (sourceRecords === null) throw new Error('expected a database');
    const originalTasks = source.tasks.list();
    const originalFindings = sourceRecords.findings.list({});
    const originalLedger = sourceRecords.ledger.list({});
    const originalCommands = sourceRecords.evidence.commandsFor('r-000001');
    const originalMutations = sourceRecords.evidence.mutationsFor('r-000001');

    // The database is lost. Only the receipt log survives.
    source.close();
    opened.splice(opened.indexOf(source), 1);
    rmSync(join(root, 'project.db'), { force: true });
    rmSync(join(root, 'project'), { recursive: true, force: true });

    const rebuilt = projectStores('rebuilt');
    const restore = restoreReceipts(dir, rebuilt);

    expect(restore.problems).toEqual([]);
    expect(restore.migration.problems).toEqual([]);
    expect(restore.runs).toBe(1);
    expect(restore.commands).toBe(2);
    expect(restore.mutations).toBe(1);

    const rebuiltRecords = rebuilt.records;
    if (rebuiltRecords === null) throw new Error('expected a database');
    // Record for record, ids and timestamps included — a restore that minted
    // fresh ids would still "work" and would still have lost the history.
    expect(rebuilt.tasks.list()).toEqual(originalTasks);
    expect(rebuiltRecords.findings.list({})).toEqual(originalFindings);
    expect(rebuiltRecords.ledger.list({})).toEqual(originalLedger);
    expect(rebuiltRecords.evidence.commandsFor('r-000001')).toEqual(
      originalCommands
    );
    expect(rebuiltRecords.evidence.mutationsFor('r-000001')).toEqual(
      originalMutations
    );
    expect(rebuilt.tasks.get(ids.taskId)?.meta.parent).toBe(ids.epicId);
  });

  it('re-exports from a restored database to a byte-identical log', () => {
    const source = projectStores('project');
    seed(source);
    const dir = receiptsDir();
    materializeReceipts(source, dir);
    const before = snapshot(dir);

    const rebuilt = projectStores('rebuilt');
    restoreReceipts(dir, rebuilt);
    const again = join(root, 'receipts-again');
    materializeReceipts(rebuilt, again);

    expect(snapshot(again)).toEqual(before);
  });

  it('restoring twice does not duplicate evidence', () => {
    const source = projectStores('project');
    seed(source);
    const dir = receiptsDir();
    materializeReceipts(source, dir);

    const rebuilt = projectStores('rebuilt');
    restoreReceipts(dir, rebuilt);
    const second = restoreReceipts(dir, rebuilt);

    expect(second.commands).toBe(0);
    expect(second.mutations).toBe(0);
    expect(second.skippedRuns).toBe(1);
    const records = rebuilt.records;
    if (records === null) throw new Error('expected a database');
    expect(records.evidence.commandsFor('r-000001')).toHaveLength(2);
    expect(records.evidence.mutationsFor('r-000001')).toHaveLength(1);
  });

  it('costs an unreadable evidence file itself and finishes the rebuild', () => {
    const source = projectStores('project');
    const ids = seed(source);
    const dir = receiptsDir();
    materializeReceipts(source, dir);
    // A directory where a file should be: readFileSync throws EISDIR. This is
    // the path someone reaches for when the database is already gone, so one
    // unreadable run must not abandon the rest of the rebuild.
    const evidence = join(dir, '.dispatch', 'evidence', 'r-000001.jsonl');
    rmSync(evidence, { force: true });
    mkdirSync(evidence, { recursive: true });

    const rebuilt = projectStores('rebuilt');
    const restore = restoreReceipts(dir, rebuilt);

    expect(restore.problems).toHaveLength(1);
    expect(restore.problems[0]?.detail).toContain('could not be read');
    // The tasks, findings and ledger still landed.
    expect(rebuilt.tasks.get(ids.taskId)).not.toBeNull();
    expect(restore.migration.findings.imported).toBe(1);
  });

  it('rolls a run back whole when its import fails partway', () => {
    const source = projectStores('project');
    seed(source);
    const dir = receiptsDir();
    materializeReceipts(source, dir);

    const rebuilt = projectStores('rebuilt');
    const records = rebuilt.records;
    if (records === null) throw new Error('expected a database');
    // Fails after the two commands have been inserted but before the run is
    // finished — exactly the shape of a rebuild interrupted midway.
    const realAddMutation = records.evidence.addMutation.bind(records.evidence);
    records.evidence.addMutation = () => {
      throw new Error('interrupted');
    };
    const partial = restoreReceipts(dir, rebuilt);

    expect(partial.runs).toBe(0);
    expect(partial.problems[0]?.detail).toContain('rolled back');
    // Nothing survived the rollback. Without the transaction the two commands
    // would still be here, and the whole-run idempotency guard would then read
    // them as "already restored" and skip this run forever — truncating its
    // evidence permanently and reporting the loss as an ordinary skip.
    expect(records.evidence.commandsFor('r-000001')).toHaveLength(0);

    records.evidence.addMutation = realAddMutation;
    const retry = restoreReceipts(dir, rebuilt);

    expect(retry.skippedRuns).toBe(0);
    expect(retry.runs).toBe(1);
    expect(records.evidence.commandsFor('r-000001')).toHaveLength(2);
    expect(records.evidence.mutationsFor('r-000001')).toHaveLength(1);
  });

  it('names a damaged evidence line instead of abandoning the rebuild', () => {
    const source = projectStores('project');
    seed(source);
    const dir = receiptsDir();
    materializeReceipts(source, dir);
    const file = join(dir, '.dispatch', 'evidence', 'r-000001.jsonl');
    writeFileSync(file, `{ not json\n${readFileSync(file, 'utf8')}`);

    const rebuilt = projectStores('rebuilt');
    const restore = restoreReceipts(dir, rebuilt);

    expect(restore.problems).toHaveLength(1);
    expect(restore.problems[0]?.detail).toContain('not valid JSON');
    expect(restore.commands).toBe(2);
    expect(restore.mutations).toBe(1);
  });
});

// Every file in the log, keyed by its path relative to the log root, so two
// exports can be compared byte for byte rather than field by field.
function snapshot(dir: string): Record<string, string> {
  const files: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name)
    )) {
      const path = join(current, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) walk(path, relative);
      else files[relative] = readFileSync(path, 'utf8');
    }
  };
  walk(dir, '');
  return files;
}
