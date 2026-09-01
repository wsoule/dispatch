import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { DatabaseSync } from 'node:sqlite';

import type { AddFindingInput } from '../src/findings.js';
import { openDispatchDb, SqliteRowError } from '../src/sqliteDb.js';
import {
  SqliteEvidenceStore,
  SqliteFindingStore,
  SqliteLedgerStore,
} from '../src/sqliteRecords.js';

let db: DatabaseSync;

beforeEach(() => {
  db = openDispatchDb(':memory:');
});

afterEach(() => {
  db.close();
});

const RAISED: Pick<AddFindingInput, 'taskId' | 'runId' | 'raisedBy'> = {
  taskId: 't-abc123',
  runId: 'r-def456',
  raisedBy: 'agent:wyat/claude',
};

describe('SqliteFindingStore', () => {
  it('adds a finding with the JSONL store’s defaults and reads it back', () => {
    const store = new SqliteFindingStore(db);
    const added = store.add(
      {
        ...RAISED,
        severity: 'critical',
        title: 'Missing null check',
        detail: 'foo() throws.',
      },
      '2026-08-01T00:00:00Z'
    );
    expect(added).toEqual({
      id: added.id,
      taskId: 't-abc123',
      runId: 'r-def456',
      severity: 'critical',
      verdict: 'open',
      title: 'Missing null check',
      detail: 'foo() throws.',
      file: null,
      line: null,
      ruling: null,
      round: 0,
      createdAt: '2026-08-01T00:00:00Z',
      updatedAt: '2026-08-01T00:00:00Z',
      raisedBy: 'agent:wyat/claude',
    });
    expect(added.id).toMatch(/^f-[0-9a-f]{6}$/);
    expect(store.get(added.id)).toEqual(added);
    expect(store.get('f-000000')).toBeNull();
  });

  // `files` and `recommendation` are optional keys, not nullable fields: a
  // finding raised without them must not grow them on the way through SQLite.
  it('keeps optional keys absent and round-trips them when present', () => {
    const store = new SqliteFindingStore(db);
    const bare = store.add({
      ...RAISED,
      severity: 'minor',
      title: 'Bare',
      detail: 'd',
    });
    expect('files' in store.get(bare.id)!).toBe(false);
    expect('recommendation' in store.get(bare.id)!).toBe(false);

    const rich = store.add({
      ...RAISED,
      severity: 'important',
      title: 'Rich',
      detail: 'd',
      file: 'src/a.ts',
      line: 42,
      files: ['src/a.ts', 'src/b.ts'],
      recommendation: 'park',
      round: 2,
    });
    expect(store.get(rich.id)).toEqual({
      ...rich,
      files: ['src/a.ts', 'src/b.ts'],
      recommendation: 'park',
      file: 'src/a.ts',
      line: 42,
      round: 2,
    });
  });

  it('filters by task, verdict and severity, and openFor narrows to open ones', () => {
    const store = new SqliteFindingStore(db);
    const open = store.add({
      ...RAISED,
      severity: 'critical',
      title: 'Open',
      detail: 'd',
    });
    const other = store.add({
      ...RAISED,
      taskId: 't-other0',
      severity: 'minor',
      title: 'Other task',
      detail: 'd',
    });
    const addressed = store.add({
      ...RAISED,
      severity: 'minor',
      title: 'Addressed',
      detail: 'd',
    });
    store.update(addressed.id, { verdict: 'addressed' });

    expect(store.list()).toHaveLength(3);
    expect(store.list({ taskId: 't-abc123' }).map((f) => f.title)).toEqual([
      'Open',
      'Addressed',
    ]);
    expect(
      store
        .list({ severity: 'minor' })
        .map((f) => f.id)
        .sort()
    ).toEqual([other.id, addressed.id].sort());
    expect(store.openFor('t-abc123').map((f) => f.id)).toEqual([open.id]);
  });

  it('updates a finding in place instead of appending a second record', () => {
    const store = new SqliteFindingStore(db);
    const added = store.add(
      { ...RAISED, severity: 'critical', title: 'T', detail: 'd' },
      '2026-08-01T00:00:00Z'
    );
    const ruled = store.update(
      added.id,
      { verdict: 'parked', ruling: 'shipping without it' },
      '2026-08-02T00:00:00Z'
    );
    expect(ruled.verdict).toBe('parked');
    expect(ruled.ruling).toBe('shipping without it');
    expect(ruled.createdAt).toBe('2026-08-01T00:00:00Z');
    expect(ruled.updatedAt).toBe('2026-08-02T00:00:00Z');
    // The JSONL store would now hold two lines for one id; here there is one
    // row, and the compacted view both produce is the same.
    expect(store.list()).toEqual([ruled]);
    expect(() => store.update('f-000000', { verdict: 'addressed' })).toThrow(
      'finding not found: f-000000'
    );
  });

  // Without the re-roll, a repeated id would upsert straight over the first
  // finding — the JSONL store keeps both lines, so silence is not an option.
  it('re-rolls a colliding id and gives up after 32 attempts', () => {
    const ids = ['f-aaaaaa', 'f-aaaaaa', 'f-bbbbbb'];
    let next = 0;
    const store = new SqliteFindingStore(db, () => ids[Math.min(next++, 2)]);
    const first = store.add({
      ...RAISED,
      severity: 'minor',
      title: 'First',
      detail: 'd',
    });
    expect(first.id).toBe('f-aaaaaa');
    // The generator hands back the taken id once, then a free one.
    const second = store.add({
      ...RAISED,
      severity: 'minor',
      title: 'Second',
      detail: 'd',
    });
    expect(second.id).toBe('f-bbbbbb');
    expect(store.list()).toHaveLength(2);

    const stuck = new SqliteFindingStore(db, () => 'f-aaaaaa');
    expect(() =>
      stuck.add({ ...RAISED, severity: 'minor', title: 'Third', detail: 'd' })
    ).toThrow('could not mint an unused finding id in 32 attempts');
    expect(store.get('f-aaaaaa')!.title).toBe('First');
  });
});

describe('SqliteLedgerStore', () => {
  const AUTHORED = { authoredBy: 'human:wyat' };

  it('adds an entry with the JSONL store’s defaults', () => {
    const store = new SqliteLedgerStore(db);
    const entry = store.add(
      {
        ...AUTHORED,
        kind: 'constraint',
        title: 'Auth tokens are opaque',
        detail: 'Never decode the session token client-side.',
      },
      '2026-08-01T00:00:00Z'
    );
    expect(entry).toEqual({
      id: entry.id,
      epicId: null,
      sourceTaskId: null,
      kind: 'constraint',
      title: 'Auth tokens are opaque',
      detail: 'Never decode the session token client-side.',
      appliesTo: [],
      createdAt: '2026-08-01T00:00:00Z',
      authoredBy: 'human:wyat',
    });
    expect(entry.id).toMatch(/^l-[0-9a-f]{6}$/);
    expect(store.get(entry.id)).toEqual(entry);
  });

  // A decision is a ledger entry with kind 'decision', which is why the schema
  // has no decisions table of its own.
  it('stores a decision as a ledger entry of that kind', () => {
    const store = new SqliteLedgerStore(db);
    const decision = store.add({
      ...AUTHORED,
      epicId: 'e-99e113',
      sourceTaskId: 't-7cc78a',
      kind: 'decision',
      title: 'SQLite via node:sqlite',
      detail: 'No new dependency; ships with the runtime.',
      appliesTo: ['t-7cc78a'],
    });
    expect(store.list({ epicId: 'e-99e113' })).toEqual([decision]);
    expect(store.list().filter((e) => e.kind === 'decision')).toEqual([
      decision,
    ]);
  });

  // `epicId: null` is a real filter (project-wide entries) and is not the same
  // question as an omitted filter (everything) — SQL's `= NULL` never matches.
  it('separates an omitted epic filter from an explicitly null one', () => {
    const store = new SqliteLedgerStore(db);
    const projectWide = store.add({
      ...AUTHORED,
      kind: 'hazard',
      title: 'Project-wide',
      detail: 'd',
    });
    const scoped = store.add({
      ...AUTHORED,
      epicId: 'e-99e113',
      kind: 'hazard',
      title: 'Epic-scoped',
      detail: 'd',
    });
    expect(store.list().map((e) => e.id)).toEqual([projectWide.id, scoped.id]);
    expect(store.list({ epicId: null }).map((e) => e.id)).toEqual([
      projectWide.id,
    ]);
    expect(store.list({ epicId: 'e-99e113' }).map((e) => e.id)).toEqual([
      scoped.id,
    ]);
    expect(store.list({ epicId: 'e-other0' })).toEqual([]);
  });

  it('entriesFor returns targeted entries plus untargeted ones in scope', () => {
    const store = new SqliteLedgerStore(db);
    const projectWide = store.add({
      ...AUTHORED,
      kind: 'constraint',
      title: 'Project-wide',
      detail: 'd',
    });
    const sameEpic = store.add({
      ...AUTHORED,
      epicId: 'e-99e113',
      kind: 'constraint',
      title: 'Same epic',
      detail: 'd',
    });
    const otherEpic = store.add({
      ...AUTHORED,
      epicId: 'e-other0',
      kind: 'constraint',
      title: 'Other epic',
      detail: 'd',
    });
    const targeted = store.add({
      ...AUTHORED,
      epicId: 'e-other0',
      kind: 'handoff',
      title: 'Aimed at this task',
      detail: 'd',
      appliesTo: ['t-7cc78a'],
    });

    expect(store.entriesFor('t-7cc78a', 'e-99e113').map((e) => e.id)).toEqual([
      projectWide.id,
      sameEpic.id,
      targeted.id,
    ]);
    // An entry targeting someone else is invisible even inside its own epic.
    expect(store.entriesFor('t-nobody', 'e-other0').map((e) => e.id)).toEqual([
      projectWide.id,
      otherEpic.id,
    ]);
  });

  it('re-rolls a colliding id and gives up after 32 attempts', () => {
    const stuck = new SqliteLedgerStore(db, () => 'l-aaaaaa');
    const first = stuck.add({
      ...AUTHORED,
      kind: 'hazard',
      title: 'First',
      detail: 'd',
    });
    expect(first.id).toBe('l-aaaaaa');
    expect(() =>
      stuck.add({ ...AUTHORED, kind: 'hazard', title: 'Second', detail: 'd' })
    ).toThrow('could not mint an unused ledger id in 32 attempts');
    expect(stuck.get('l-aaaaaa')!.title).toBe('First');
  });
});

describe('SqliteEvidenceStore', () => {
  it('keeps each run’s commands in the order they were recorded', () => {
    const store = new SqliteEvidenceStore(db);
    const build = {
      command: 'bun run build',
      exitCode: 0,
      durationMs: 1200,
      summary: 'ok',
      at: '2026-08-01T00:00:00Z',
    };
    const test = {
      command: 'bun test',
      exitCode: 1,
      durationMs: 3400.5,
      summary: '158 pass, 1 fail',
      at: '2026-08-01T00:01:00Z',
    };
    store.addCommand('r-aaaaaa', build);
    store.addCommand('r-bbbbbb', {
      ...build,
      command: 'other run',
    });
    store.addCommand('r-aaaaaa', test);

    expect(store.commandsFor('r-aaaaaa')).toEqual([build, test]);
    expect(store.commandsFor('r-bbbbbb')).toHaveLength(1);
    expect(store.commandsFor('r-nobody')).toEqual([]);
  });

  it('records mutation results per run', () => {
    const store = new SqliteEvidenceStore(db);
    const dead = {
      guard: 'id collision check',
      file: 'packages/core/src/sqliteTaskStore.ts',
      testsFailed: 0,
      at: '2026-08-01T00:00:00Z',
    };
    const live = { ...dead, guard: 'null check', testsFailed: 3 };
    store.addMutation('r-aaaaaa', dead);
    store.addMutation('r-aaaaaa', live);
    expect(store.mutationsFor('r-aaaaaa')).toEqual([dead, live]);
    expect(store.mutationsFor('r-bbbbbb')).toEqual([]);
  });

  // The two tables share a run id but number themselves independently, so a
  // run that records evidence first must not shift its mutations' sequence.
  it('numbers evidence and mutations independently', () => {
    const store = new SqliteEvidenceStore(db);
    store.addCommand('r-aaaaaa', {
      command: 'bun test',
      exitCode: 0,
      durationMs: 1,
      summary: 'ok',
      at: '2026-08-01T00:00:00Z',
    });
    store.addMutation('r-aaaaaa', {
      guard: 'g',
      file: 'f',
      testsFailed: 2,
      at: '2026-08-01T00:01:00Z',
    });
    expect(store.commandsFor('r-aaaaaa')).toHaveLength(1);
    expect(store.mutationsFor('r-aaaaaa')).toHaveLength(1);
  });
});

describe('record stores reject rows they cannot trust', () => {
  const RAISED_MIN = {
    ...RAISED,
    severity: 'minor' as const,
    title: 'T',
    detail: 'd',
  };

  it('throws on a finding enum outside its set', () => {
    const store = new SqliteFindingStore(db);
    const finding = store.add(RAISED_MIN);
    for (const [column, bad] of [
      ['severity', 'catastrophic'],
      ['verdict', 'maybe'],
      ['recommendation', 'shrug'],
    ]) {
      db.prepare(`UPDATE findings SET ${column} = ? WHERE id = ?`).run(
        bad,
        finding.id
      );
      expect(() => store.get(finding.id)).toThrow(SqliteRowError);
      expect(() => store.get(finding.id)).toThrow(column);
      expect(() => store.list()).toThrow(SqliteRowError);
      // Put it back so the next column is tested on its own.
      db.prepare(`UPDATE findings SET ${column} = ? WHERE id = ?`).run(
        column === 'recommendation'
          ? null
          : column === 'verdict'
            ? 'open'
            : 'minor',
        finding.id
      );
    }
  });

  it('throws rather than defaulting a damaged files column', () => {
    const store = new SqliteFindingStore(db);
    const finding = store.add({ ...RAISED_MIN, files: ['a.ts', 'b.ts'] });
    db.prepare('UPDATE findings SET files = ? WHERE id = ?').run(
      'not json',
      finding.id
    );
    expect(() => store.get(finding.id)).toThrow('files');
  });

  // The worst of the coerce-to-[] failures: a ledger entry aimed at one task
  // reads as an entry aimed at every task under its epic, so a damaged column
  // silently broadcasts a handoff meant for someone else.
  it('throws rather than broadcasting a damaged applies_to', () => {
    const store = new SqliteLedgerStore(db);
    const entry = store.add({
      authoredBy: 'human:wyat',
      epicId: 'e-99e113',
      kind: 'handoff',
      title: 'For one task only',
      detail: 'd',
      appliesTo: ['t-7cc78a'],
    });
    db.prepare('UPDATE ledger_entries SET applies_to = ? WHERE id = ?').run(
      'null',
      entry.id
    );
    expect(() => store.get(entry.id)).toThrow('applies_to');
    expect(() => store.entriesFor('t-nobody', 'e-99e113')).toThrow(
      SqliteRowError
    );
  });

  it('throws on a ledger kind outside its set', () => {
    const store = new SqliteLedgerStore(db);
    const entry = store.add({
      authoredBy: 'human:wyat',
      kind: 'constraint',
      title: 'T',
      detail: 'd',
    });
    db.prepare('UPDATE ledger_entries SET kind = ? WHERE id = ?').run(
      'vibe',
      entry.id
    );
    expect(() => store.get(entry.id)).toThrow('kind');
  });
});

describe('record stores claim ids by writing', () => {
  // Same property the task store has: the id is claimed by the INSERT, so a
  // record that appears after the id was minted keeps it.
  it('re-rolls instead of overwriting a row that appeared first', () => {
    const ids = ['f-aaaaaa', 'f-bbbbbb'];
    let next = 0;
    const other = new SqliteFindingStore(db, () => 'f-aaaaaa');
    const store = new SqliteFindingStore(db, () => {
      const id = ids[Math.min(next, ids.length - 1)];
      next += 1;
      if (id === 'f-aaaaaa') {
        other.add({
          ...RAISED,
          severity: 'critical',
          title: 'Theirs',
          detail: 'd',
        });
      }
      return id;
    });
    const mine = store.add({
      ...RAISED,
      severity: 'minor',
      title: 'Mine',
      detail: 'd',
    });
    expect(mine.id).toBe('f-bbbbbb');
    expect(store.get('f-aaaaaa')!.title).toBe('Theirs');
  });

  // A verdict change is three columns. Rewriting all sixteen from a record
  // read moments earlier is what makes a concurrent edit disappear.
  //
  // Comparing values before and after cannot see this: an upsert that writes
  // `title` back unchanged looks identical to one that never touched it. A
  // trigger declared `AFTER UPDATE OF <column>` fires on the statement naming
  // the column, whatever value it carries, so it reports what was written
  // rather than what changed.
  it('update writes only verdict, ruling and updated_at', () => {
    const store = new SqliteFindingStore(db);
    const finding = store.add(
      { ...RAISED, severity: 'critical', title: 'T', detail: 'd', round: 3 },
      '2026-08-01T00:00:00Z'
    );
    db.exec('CREATE TEMP TABLE touched (column_name TEXT)');
    for (const column of [
      'task_id',
      'title',
      'detail',
      'round',
      'created_at',
    ]) {
      db.exec(
        `CREATE TEMP TRIGGER touch_${column} AFTER UPDATE OF ${column} ON findings
         BEGIN INSERT INTO touched VALUES ('${column}'); END`
      );
    }

    store.update(
      finding.id,
      { verdict: 'parked', ruling: 'shipping without it' },
      '2026-08-02T00:00:00Z'
    );

    expect(db.prepare('SELECT column_name FROM touched').all()).toEqual([]);
  });

  it('update leaves every column but verdict, ruling and updated_at alone', () => {
    const store = new SqliteFindingStore(db);
    const finding = store.add(
      {
        ...RAISED,
        severity: 'critical',
        title: 'T',
        detail: 'd',
        file: 'src/a.ts',
        line: 42,
        files: ['src/a.ts'],
        recommendation: 'blocks',
        round: 3,
      },
      '2026-08-01T00:00:00Z'
    );
    const before = db
      .prepare('SELECT * FROM findings WHERE id = ?')
      .get(finding.id) as Record<string, unknown>;

    store.update(
      finding.id,
      { verdict: 'parked', ruling: 'shipping without it' },
      '2026-08-02T00:00:00Z'
    );

    const after = db
      .prepare('SELECT * FROM findings WHERE id = ?')
      .get(finding.id) as Record<string, unknown>;
    const changed = Object.keys(after).filter((k) => after[k] !== before[k]);
    expect(changed.sort()).toEqual(['ruling', 'updated_at', 'verdict']);
  });
});

describe('SqliteEvidenceStore sequencing', () => {
  // seq is computed inside the INSERT rather than read first, so two writers
  // on one run cannot both read the same MAX and collide on the primary key.
  // What is observable single-threaded is that the numbering stays dense and
  // per-run across many writes.
  it('numbers a run densely from zero', () => {
    const store = new SqliteEvidenceStore(db);
    for (let i = 0; i < 5; i += 1) {
      store.addCommand('r-aaaaaa', {
        command: `cmd ${i}`,
        exitCode: 0,
        durationMs: i,
        summary: 'ok',
        at: '2026-08-01T00:00:00Z',
      });
      store.addCommand('r-bbbbbb', {
        command: `other ${i}`,
        exitCode: 0,
        durationMs: i,
        summary: 'ok',
        at: '2026-08-01T00:00:00Z',
      });
    }
    const seqs = db
      .prepare('SELECT seq FROM evidence WHERE run_id = ? ORDER BY seq')
      .all('r-aaaaaa')
      .map((r) => (r as { seq: number }).seq);
    expect(seqs).toEqual([0, 1, 2, 3, 4]);
    expect(store.commandsFor('r-aaaaaa').map((c) => c.command)).toEqual([
      'cmd 0',
      'cmd 1',
      'cmd 2',
      'cmd 3',
      'cmd 4',
    ]);
    expect(store.commandsFor('r-bbbbbb')).toHaveLength(5);
  });
});
