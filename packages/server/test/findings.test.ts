import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FindingStore } from '../src/findings';

function root(): string {
  return mkdtempSync(join(tmpdir(), 'dispatch-findings-'));
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
