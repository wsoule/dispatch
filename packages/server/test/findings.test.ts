import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FindingStore } from '../src/findings';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-findings-'));
}

// Writes findings.jsonl directly so a test can put lines in the file that the
// store would never mint on its own — here, two records sharing one id.
function seedLines(dir: string, records: Record<string, unknown>[]): void {
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(
    join(dir, '.dispatch', 'findings.jsonl'),
    `${records.map((r) => JSON.stringify(r)).join('\n')}\n`
  );
}

describe('FindingStore', () => {
  test('add() writes one JSONL line and returns the record', () => {
    const store = new FindingStore(root());
    const finding = store.add({
      taskId: 't-abc123',
      runId: 'r-111111',
      severity: 'important',
      title: 'withActionFeedback swallows rejections',
      detail: 'every catch downstream of it is dead code',
    });
    expect(finding.verdict).toBe('open');
    expect(finding.ruling).toBeNull();
    expect(finding.round).toBe(0);
    expect(finding.recommendation).toBeUndefined();
    expect(store.get(finding.id)).toEqual(finding);
  });

  // The reviewer's blocks-or-park call, kept separate from `ruling`, which is
  // the controller's. Absent — not null — when nobody offered one.
  test('add() carries a recommendation through a write and read-back', () => {
    const store = new FindingStore(root());
    const finding = store.add({
      taskId: 't-abc123',
      runId: 'r-111111',
      severity: 'critical',
      title: 'first sync overwrites the workspace',
      detail: 'reproduced on a scratch copy',
      recommendation: 'blocks',
    });
    expect(finding.recommendation).toBe('blocks');
    expect(store.get(finding.id)?.recommendation).toBe('blocks');
    expect(store.update(finding.id, { verdict: 'parked' }).recommendation).toBe(
      'blocks'
    );
  });

  // The whole point of the append-only design: an update never rewrites the
  // file, and a read-back must still see only the latest verdict per id.
  test('update() appends a new line rather than rewriting the file, and reads compact to the latest', () => {
    const dir = root();
    const store = new FindingStore(dir);
    const finding = store.add({
      taskId: 't-abc123',
      runId: null,
      severity: 'critical',
      title: 'a real bug',
      detail: 'detail',
    });
    store.update(finding.id, {
      verdict: 'addressed',
      ruling: 'fixed in r-222',
    });

    const file = readFileSync(join(dir, '.dispatch', 'findings.jsonl'), 'utf8');
    const lines = file.trim().split('\n');
    expect(lines).toHaveLength(2);

    const compacted = store.list();
    expect(compacted).toHaveLength(1);
    expect(compacted[0]?.verdict).toBe('addressed');
    expect(compacted[0]?.ruling).toBe('fixed in r-222');
  });

  test('update() on an unknown id throws', () => {
    const store = new FindingStore(root());
    expect(() => store.update('f-nope00', { verdict: 'parked' })).toThrow();
  });

  test('list() filters by taskId, verdict, and severity', () => {
    const store = new FindingStore(root());
    const a = store.add({
      taskId: 't-a',
      runId: null,
      severity: 'critical',
      title: 'a',
      detail: 'a',
    });
    store.add({
      taskId: 't-b',
      runId: null,
      severity: 'minor',
      title: 'b',
      detail: 'b',
    });
    store.update(a.id, { verdict: 'parked' });

    expect(store.list({ taskId: 't-a' }).map((f) => f.id)).toEqual([a.id]);
    expect(store.list({ severity: 'minor' })).toHaveLength(1);
    expect(store.list({ verdict: 'open' })).toHaveLength(1);
  });

  test('openFor() returns only the still-open findings for that task', () => {
    const store = new FindingStore(root());
    const open = store.add({
      taskId: 't-a',
      runId: null,
      severity: 'minor',
      title: 'open one',
      detail: 'd',
    });
    const addressed = store.add({
      taskId: 't-a',
      runId: null,
      severity: 'minor',
      title: 'addressed one',
      detail: 'd',
    });
    store.update(addressed.id, { verdict: 'addressed' });

    expect(store.openFor('t-a').map((f) => f.id)).toEqual([open.id]);
    expect(store.openFor('t-b')).toEqual([]);
  });

  test('a store with no file yet returns an empty list', () => {
    const store = new FindingStore(root());
    expect(store.list()).toEqual([]);
    expect(store.get('f-nope00')).toBeNull();
  });
});

describe('FindingStore id collisions', () => {
  // Two findings minted the same 6-hex id. Keying compaction by id alone drops
  // the older one, which is how a standing block can vanish without a trace.
  test('two records sharing an id both survive compaction', () => {
    const dir = root();
    seedLines(dir, [
      {
        id: 'f-abc123',
        taskId: 't-older',
        runId: null,
        severity: 'critical',
        verdict: 'blocked',
        title: 'the older finding',
        detail: 'still blocking t-older',
        file: null,
        line: null,
        ruling: 'stands until the API is versioned',
        round: 0,
        createdAt: '2026-07-01T00:00:00.000Z',
        updatedAt: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'f-abc123',
        taskId: 't-newer',
        runId: null,
        severity: 'minor',
        verdict: 'open',
        title: 'the newer finding',
        detail: 'unrelated task',
        file: null,
        line: null,
        ruling: null,
        round: 0,
        createdAt: '2026-07-02T00:00:00.000Z',
        updatedAt: '2026-07-02T00:00:00.000Z',
      },
    ]);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new FindingStore(dir);
      expect(store.list()).toHaveLength(2);
      expect(
        store.list({ taskId: 't-older', verdict: 'blocked' })
      ).toHaveLength(1);
      expect(store.openFor('t-newer')).toHaveLength(1);
      // The older record keeps the id, so anything already referencing it —
      // a prompt, a desktop link — still resolves to the same finding.
      expect(store.get('f-abc123')?.taskId).toBe('t-older');
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain('f-abc123');
    } finally {
      errors.mockRestore();
    }
  });

  // Both lines are the same record's history, not two records, so the file's
  // last word still wins — the property the collision fix must not break.
  test('an update of one record still compacts to the latest line', () => {
    const dir = root();
    const store = new FindingStore(dir);
    const finding = store.add({
      taskId: 't-a',
      runId: null,
      severity: 'critical',
      title: 'a real bug',
      detail: 'detail',
    });
    store.update(finding.id, { verdict: 'addressed' });
    expect(store.list()).toHaveLength(1);
    expect(store.get(finding.id)?.verdict).toBe('addressed');
  });

  test('add() re-mints when the generator hands back an id the file already holds', () => {
    const dir = root();
    const minted = ['f-dupdup', 'f-dupdup', 'f-fresh1'];
    let next = 0;
    const store = new FindingStore(dir, () => minted[next++] ?? 'f-exhaust');
    const first = store.add({
      taskId: 't-a',
      runId: null,
      severity: 'minor',
      title: 'first',
      detail: 'd',
    });
    const second = store.add({
      taskId: 't-b',
      runId: null,
      severity: 'minor',
      title: 'second',
      detail: 'd',
    });

    expect(first.id).toBe('f-dupdup');
    expect(second.id).toBe('f-fresh1');
    expect(store.list()).toHaveLength(2);
  });

  test('add() throws rather than reusing an id when every attempt is taken', () => {
    const dir = root();
    const store = new FindingStore(dir, () => 'f-always');
    store.add({
      taskId: 't-a',
      runId: null,
      severity: 'minor',
      title: 'first',
      detail: 'd',
    });
    expect(() =>
      store.add({
        taskId: 't-b',
        runId: null,
        severity: 'minor',
        title: 'second',
        detail: 'd',
      })
    ).toThrow(/unused finding id/);
  });
});
