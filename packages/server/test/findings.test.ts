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
      raisedBy: '',
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
      raisedBy: '',
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
      raisedBy: '',
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
      raisedBy: '',
    });
    store.add({
      taskId: 't-b',
      runId: null,
      severity: 'minor',
      title: 'b',
      detail: 'b',
      raisedBy: '',
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
      raisedBy: '',
    });
    const addressed = store.add({
      taskId: 't-a',
      runId: null,
      severity: 'minor',
      title: 'addressed one',
      detail: 'd',
      raisedBy: '',
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

// A well-formed line, so a test only has to say what it wants to be wrong.
function findingLine(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 'f-good01',
    taskId: 't-a',
    runId: null,
    severity: 'important',
    verdict: 'open',
    title: 'a real one',
    detail: 'detail',
    file: null,
    line: null,
    ruling: null,
    round: 0,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('FindingStore malformed lines', () => {
  test('a line that is not JSON costs itself, not the rest of the store', () => {
    const dir = root();
    mkdirSync(join(dir, '.dispatch'), { recursive: true });
    writeFileSync(
      join(dir, '.dispatch', 'findings.jsonl'),
      [
        JSON.stringify(findingLine()),
        '{"id": "f-trunc0", "taskId": "t-a"',
        JSON.stringify(findingLine({ id: 'f-good02' })),
      ].join('\n') + '\n'
    );

    const store = new FindingStore(dir);
    expect(store.list().map((f) => f.id)).toEqual(['f-good01', 'f-good02']);
  });

  test('a parseable line that is not a finding is dropped rather than served as a ghost', () => {
    const dir = root();
    const { id: _dropped, ...idLess } = findingLine({ title: 'the ghost' });
    seedLines(dir, [idLess, findingLine()]);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const store = new FindingStore(dir);
      expect(store.list().map((f) => f.id)).toEqual(['f-good01']);
      expect(store.openFor('t-a').map((f) => f.title)).toEqual(['a real one']);

      // The call a fix round makes with a ghost in hand: update(finding.id),
      // where the id is undefined and matches the ghost's own missing one.
      const ghostId = store.openFor('t-a').find((f) => f.title === 'the ghost')
        ?.id as string;
      expect(() => store.update(ghostId, { verdict: 'addressed' })).toThrow();

      // Logged once for the damaged line, not once per read.
      store.list();
      store.get('f-good01');
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain('the ghost');
    } finally {
      errors.mockRestore();
    }
  });

  test('two id-less lines cannot collide into one another', () => {
    const dir = root();
    const { id: _a, ...first } = findingLine({ title: 'ghost one' });
    const { id: _b, ...second } = findingLine({ title: 'ghost two' });
    seedLines(dir, [first, second]);
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(new FindingStore(dir).list()).toEqual([]);
    } finally {
      errors.mockRestore();
    }
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
      raisedBy: '',
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
      raisedBy: '',
    });
    const second = store.add({
      taskId: 't-b',
      runId: null,
      severity: 'minor',
      title: 'second',
      detail: 'd',
      raisedBy: '',
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
      raisedBy: '',
    });
    expect(() =>
      store.add({
        taskId: 't-b',
        runId: null,
        severity: 'minor',
        title: 'second',
        detail: 'd',
        raisedBy: '',
      })
    ).toThrow(/unused finding id/);
  });
});

describe('FindingStore attribution', () => {
  test('round-trips the actor that raised a finding', () => {
    const root_ = root();
    const store = new FindingStore(root_);
    const written = store.add({
      taskId: 't-abc123',
      runId: null,
      severity: 'important',
      title: 'x',
      detail: 'y',
      raisedBy: 'agent:wyat/claude',
    });
    expect(new FindingStore(root_).list()).toContainEqual(
      expect.objectContaining({ id: written.id, raisedBy: 'agent:wyat/claude' })
    );
  });

  // findings.jsonl is append-only and pre-dates raisedBy, so a legacy line
  // must still load with the field defaulted rather than undefined.
  test('defaults raisedBy on a record written before attribution existed', () => {
    const dir = root();
    seedLines(dir, [
      {
        id: 'f-legacy',
        taskId: 't-abc123',
        runId: null,
        severity: 'minor',
        verdict: 'open',
        title: 'old',
        detail: '',
        file: null,
        line: null,
        ruling: null,
        round: 0,
        createdAt: '2026-08-01T00:00:00.000Z',
        updatedAt: '2026-08-01T00:00:00.000Z',
      },
    ]);
    expect(new FindingStore(dir).list()[0]?.raisedBy).toBe('');
  });
});
