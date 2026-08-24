import type {
  GateStatus,
  LandingGate,
  LandingRow,
  LandingSnapshot,
  MergeQueueEntry,
  RepoPr,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  dedupeLandingRows,
  EMPTY_FILTERS,
  gateChipLabel,
  GROUP_LABELS,
  landedFromTasks,
  landingNavBadge,
  readLandingFilters,
  relativeTime,
  serializeLandingFilters,
  visibleLandingRows,
} from './landingView';

function pr(over: Partial<RepoPr> = {}): RepoPr {
  return {
    number: 42,
    title: 'Fix the thing',
    url: 'https://github.com/o/r/pull/42',
    headRefName: 'fix/the-thing',
    baseRefName: 'main',
    author: 'wsoule',
    isDraft: false,
    updatedAt: '2026-08-10T00:00:00.000Z',
    headRefOid: 'abc123',
    state: 'OPEN',
    isCrossRepository: false,
    headRepositoryOwner: 'o',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: { passed: 0, failed: 0, pending: 0, total: 0, runs: [] },
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    ...over,
  };
}

function queueEntry(over: Partial<MergeQueueEntry> = {}): MergeQueueEntry {
  return {
    runId: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    state: 'queued',
    enqueuedAt: '2026-08-10T00:00:00.000Z',
    ...over,
  };
}

function row(over: Partial<LandingRow> = {}): LandingRow {
  return {
    id: 'pr-42',
    kind: 'pr',
    title: 'Fix the thing',
    gate: { status: 'ready', detail: 'ready to merge' },
    ...over,
  };
}

function snapshot(rows: LandingRow[]): LandingSnapshot {
  return { rows, landed: [], generatedAt: '2026-08-10T00:00:00.000Z' };
}

describe('visibleLandingRows', () => {
  test('groups in fixed order and omits empty groups', () => {
    const rows: LandingRow[] = [
      row({
        id: 'pr-1',
        title: 'Open one',
        gate: { status: 'ready', detail: 'ready to merge' },
      }),
      row({
        id: 'pr-2',
        title: 'Conflicted one',
        gate: { status: 'conflicts', detail: 'conflicts with base branch' },
      }),
    ];
    const result = visibleLandingRows(snapshot(rows), EMPTY_FILTERS);
    expect(result).toEqual([
      { type: 'group', id: 'needs-you', label: 'Needs you', count: 1 },
      { type: 'row', row: rows[1] },
      { type: 'group', id: 'open', label: 'Open', count: 1 },
      { type: 'row', row: rows[0] },
    ]);
  });

  test('an empty snapshot produces no rows at all', () => {
    expect(visibleLandingRows(snapshot([]), EMPTY_FILTERS)).toEqual([]);
  });

  test('in-queue groups rows behind a queue-position, verifying, merging or blocked gate', () => {
    const rows: LandingRow[] = [
      row({
        id: 'run-1',
        kind: 'queue-local',
        title: 'Queued one',
        queue: { position: 1, entry: queueEntry() },
        gate: { status: 'queue-position', detail: '#1 in queue' },
      }),
    ];
    const result = visibleLandingRows(snapshot(rows), EMPTY_FILTERS);
    expect(result[0]).toEqual({
      type: 'group',
      id: 'in-queue',
      label: 'In queue',
      count: 1,
    });
  });

  test('a failing-checks PR groups under needs-you, a pending-checks one under waiting-github', () => {
    const failing = row({
      id: 'pr-1',
      title: 'Failing checks',
      pr: pr({
        number: 1,
        checks: { passed: 0, failed: 1, pending: 0, total: 1, runs: [] },
      }),
      gate: { status: 'waiting-checks', detail: '1 check failing' },
    });
    const pending = row({
      id: 'pr-2',
      title: 'Pending checks',
      pr: pr({
        number: 2,
        checks: { passed: 0, failed: 0, pending: 1, total: 1, runs: [] },
      }),
      gate: { status: 'waiting-checks', detail: 'waiting on CI · 1 running' },
    });
    const result = visibleLandingRows(
      snapshot([failing, pending]),
      EMPTY_FILTERS
    );
    expect(result.map((r) => (r.type === 'group' ? r.id : r.row.id))).toEqual([
      'needs-you',
      'pr-1',
      'waiting-github',
      'pr-2',
    ]);
  });

  test('a draft PR groups under waiting-github', () => {
    const rows: LandingRow[] = [
      row({
        id: 'pr-1',
        title: 'Draft one',
        pr: pr({ isDraft: true }),
        gate: { status: 'draft', detail: 'draft PR' },
      }),
    ];
    const result = visibleLandingRows(snapshot(rows), EMPTY_FILTERS);
    expect(result[0]).toEqual({
      type: 'group',
      id: 'waiting-github',
      label: 'Waiting on GitHub',
      count: 1,
    });
  });

  test('the query filter matches title, author, headRef, and #number (with or without #)', () => {
    const rows: LandingRow[] = [
      row({
        id: 'pr-1',
        title: 'Add the sprocket',
        pr: pr({ number: 7, author: 'alice', headRefName: 'feat/sprocket' }),
      }),
      row({
        id: 'pr-2',
        title: 'Unrelated change',
        pr: pr({ number: 9, author: 'bob', headRefName: 'fix/other' }),
      }),
    ];

    const byTitle = visibleLandingRows(snapshot(rows), {
      ...EMPTY_FILTERS,
      query: 'sprocket',
    });
    expect(byTitle.filter((r) => r.type === 'row')).toHaveLength(1);

    const byAuthor = visibleLandingRows(snapshot(rows), {
      ...EMPTY_FILTERS,
      query: 'alice',
    });
    expect(byAuthor.filter((r) => r.type === 'row')).toHaveLength(1);

    const byBranch = visibleLandingRows(snapshot(rows), {
      ...EMPTY_FILTERS,
      query: 'fix/other',
    });
    expect(byBranch.filter((r) => r.type === 'row')).toHaveLength(1);

    const byHash = visibleLandingRows(snapshot(rows), {
      ...EMPTY_FILTERS,
      query: '#7',
    });
    expect(
      (byHash.find((r) => r.type === 'row') as { type: 'row'; row: LandingRow })
        .row.id
    ).toBe('pr-1');

    const byBareNumber = visibleLandingRows(snapshot(rows), {
      ...EMPTY_FILTERS,
      query: '9',
    });
    expect(
      (
        byBareNumber.find((r) => r.type === 'row') as {
          type: 'row';
          row: LandingRow;
        }
      ).row.id
    ).toBe('pr-2');
  });

  test('the author facet chip narrows to rows whose PR author matches exactly', () => {
    const rows: LandingRow[] = [
      row({ id: 'pr-1', pr: pr({ number: 1, author: 'alice' }) }),
      row({ id: 'pr-2', pr: pr({ number: 2, author: 'bob' }) }),
    ];
    const result = visibleLandingRows(snapshot(rows), {
      ...EMPTY_FILTERS,
      author: 'alice',
    });
    expect(result.filter((r) => r.type === 'row')).toHaveLength(1);
  });

  test('the gate facet chip narrows to rows with that exact gate status', () => {
    const rows: LandingRow[] = [
      row({ id: 'pr-1', gate: { status: 'draft', detail: 'draft PR' } }),
      row({ id: 'pr-2', gate: { status: 'ready', detail: 'ready to merge' } }),
    ];
    const result = visibleLandingRows(snapshot(rows), {
      ...EMPTY_FILTERS,
      gate: 'draft',
    });
    expect(result.filter((r) => r.type === 'row')).toHaveLength(1);
  });

  test('filters compose: query and facet chips must all match', () => {
    const rows: LandingRow[] = [
      row({
        id: 'pr-1',
        title: 'Add sprocket',
        pr: pr({ number: 1, author: 'alice' }),
        gate: { status: 'draft', detail: 'draft PR' },
      }),
      row({
        id: 'pr-2',
        title: 'Add sprocket too',
        pr: pr({ number: 2, author: 'bob' }),
        gate: { status: 'draft', detail: 'draft PR' },
      }),
    ];
    const result = visibleLandingRows(snapshot(rows), {
      query: 'sprocket',
      author: 'alice',
      gate: 'draft',
    });
    expect(result.filter((r) => r.type === 'row')).toHaveLength(1);
  });
});

describe('GROUP_LABELS', () => {
  test('has exactly the four documented labels', () => {
    expect(GROUP_LABELS).toEqual({
      'needs-you': 'Needs you',
      'in-queue': 'In queue',
      'waiting-github': 'Waiting on GitHub',
      open: 'Open',
    });
  });
});

describe('gateChipLabel', () => {
  test('position 1 reads Ready · next', () => {
    const r = row({
      queue: { position: 1, entry: queueEntry() },
      gate: { status: 'queue-position', detail: '#1 in queue' },
    });
    expect(gateChipLabel(r)).toBe('Ready · next');
  });

  test('position >1 reads #N · behind <ahead task title>, given the ordered queue rows', () => {
    const ahead = row({
      id: 'run-ahead',
      title: 'Ahead task',
      queue: { position: 2, entry: queueEntry({ runId: 'r-ahead' }) },
      gate: { status: 'queue-position', detail: '#2 in queue' },
    });
    const behind = row({
      id: 'run-behind',
      title: 'Behind task',
      queue: { position: 3, entry: queueEntry({ runId: 'r-behind' }) },
      gate: { status: 'queue-position', detail: '#3 in queue' },
    });
    expect(gateChipLabel(behind, [ahead, behind])).toBe(
      '#3 · behind Ahead task'
    );
  });

  test('falls back to gate.detail when the ahead row is not supplied', () => {
    const behind = row({
      queue: { position: 3, entry: queueEntry() },
      gate: { status: 'queue-position', detail: '#3 in queue' },
    });
    expect(gateChipLabel(behind, [])).toBe('#3 in queue');
  });

  test('pending checks read Waiting on CI · N running', () => {
    const r = row({
      pr: pr({
        checks: { passed: 0, failed: 0, pending: 2, total: 2, runs: [] },
      }),
      gate: { status: 'waiting-checks', detail: 'waiting on CI · 2 running' },
    });
    expect(gateChipLabel(r)).toBe('Waiting on CI · 2 running');
  });

  test('failing checks fall back to gate.detail', () => {
    const r = row({
      pr: pr({
        checks: { passed: 0, failed: 2, pending: 0, total: 2, runs: [] },
      }),
      gate: { status: 'waiting-checks', detail: '2 checks failing' },
    });
    expect(gateChipLabel(r)).toBe('2 checks failing');
  });

  test('verifying derives passed/total from queue.entry.steps', () => {
    const r = row({
      queue: {
        position: 1,
        entry: queueEntry({
          state: 'verifying',
          steps: [
            { name: 'typecheck', status: 'passed' },
            { name: 'tests', status: 'passed' },
            { name: 'lint', status: 'running' },
            { name: 'build', status: 'pending' },
          ],
        }),
      },
      gate: { status: 'verifying', detail: 'running verify pipeline' },
    });
    expect(gateChipLabel(r)).toBe('Verifying · 2/4');
  });

  test('verifying with no recorded steps falls back to gate.detail', () => {
    const r = row({
      queue: { position: 1, entry: queueEntry({ state: 'verifying' }) },
      gate: { status: 'verifying', detail: 'running verify pipeline' },
    });
    expect(gateChipLabel(r)).toBe('running verify pipeline');
  });

  test('conflicts reads Conflicts', () => {
    const r = row({
      gate: { status: 'conflicts', detail: 'conflicts with base branch' },
    });
    expect(gateChipLabel(r)).toBe('Conflicts');
  });

  test('draft reads Draft', () => {
    const r = row({ gate: { status: 'draft', detail: 'draft PR' } });
    expect(gateChipLabel(r)).toBe('Draft');
  });

  test.each([
    ['waiting-review', 'awaiting review'],
    ['merging', 'merging now'],
    ['blocked', 'blocked on the main checkout'],
    ['ready', 'ready to merge'],
    ['none', ''],
  ] as [GateStatus, string][])(
    'everything else falls back to gate.detail (%s)',
    (status, detail) => {
      const gate: LandingGate = { status, detail };
      expect(gateChipLabel(row({ gate }))).toBe(detail);
    }
  );
});

describe('landingNavBadge', () => {
  test('counts only rows whose gate buckets into needs-you', () => {
    const rows: LandingRow[] = [
      row({ id: 'pr-1', gate: { status: 'conflicts', detail: '' } }),
      row({
        id: 'pr-2',
        pr: pr({
          checks: { passed: 0, failed: 1, pending: 0, total: 1, runs: [] },
        }),
        gate: { status: 'waiting-checks', detail: '1 check failing' },
      }),
      row({ id: 'pr-3', gate: { status: 'ready', detail: 'ready to merge' } }),
    ];
    expect(landingNavBadge(snapshot(rows))).toBe(2);
  });

  test('an empty snapshot badges zero', () => {
    expect(landingNavBadge(snapshot([]))).toBe(0);
  });
});

describe('readLandingFilters / serializeLandingFilters', () => {
  test('round-trips a real filter set', () => {
    const filters = {
      query: 'sprocket',
      author: 'alice',
      gate: 'draft' as const,
    };
    expect(readLandingFilters(serializeLandingFilters(filters))).toEqual(
      filters
    );
  });

  test('null input returns EMPTY_FILTERS', () => {
    expect(readLandingFilters(null)).toEqual(EMPTY_FILTERS);
  });

  test('garbage JSON returns EMPTY_FILTERS', () => {
    expect(readLandingFilters('not json{{{')).toEqual(EMPTY_FILTERS);
  });

  test('valid JSON with the wrong shape returns EMPTY_FILTERS', () => {
    expect(readLandingFilters('42')).toEqual(EMPTY_FILTERS);
    expect(readLandingFilters('null')).toEqual(EMPTY_FILTERS);
    expect(readLandingFilters('[]')).toEqual(EMPTY_FILTERS);
  });

  test('an unrecognized gate value is dropped without discarding the rest', () => {
    const result = readLandingFilters(
      JSON.stringify({ query: 'sprocket', author: 'alice', gate: 'not-a-gate' })
    );
    expect(result).toEqual({ query: 'sprocket', author: 'alice', gate: null });
  });
});

describe('relativeTime', () => {
  const now = new Date('2026-08-10T12:00:00.000Z').getTime();

  test('under an hour reads Nm ago', () => {
    expect(relativeTime('2026-08-10T11:55:00.000Z', now)).toBe('5m ago');
  });

  test('under a day reads Nh ago', () => {
    expect(relativeTime('2026-08-10T09:00:00.000Z', now)).toBe('3h ago');
  });

  test('under a week reads Nd ago', () => {
    expect(relativeTime('2026-08-08T12:00:00.000Z', now)).toBe('2d ago');
  });

  test('a week or more falls back to a locale date', () => {
    const iso = '2026-07-01T12:00:00.000Z';
    expect(relativeTime(iso, now)).toBe(new Date(iso).toLocaleDateString());
  });

  test('an unparseable timestamp falls back to an em dash', () => {
    expect(relativeTime('not a date', now)).toBe('—');
  });
});

describe('dedupeLandingRows', () => {
  const row = (over: Partial<LandingRow>): LandingRow =>
    ({
      id: over.runId ?? 'row',
      kind: 'queue-local',
      title: 'T',
      gate: { status: 'none', detail: '' },
      ...over,
    }) as LandingRow;

  test('only the newest run speaks for a task, extras counted', () => {
    const created = new Map([
      ['r-old', '2026-08-01T00:00:00.000Z'],
      ['r-new', '2026-08-03T00:00:00.000Z'],
    ]);
    const result = dedupeLandingRows(
      [
        row({ taskId: 't-1', runId: 'r-old' }),
        row({ taskId: 't-1', runId: 'r-new' }),
      ],
      created
    );
    expect(result.rows.map((r) => r.runId)).toEqual(['r-new']);
    expect(result.extraRunsByTask.get('t-1')).toBe(1);
  });

  test('a queue-backed row wins over its task’s plain rows', () => {
    const result = dedupeLandingRows(
      [
        row({ taskId: 't-1', runId: 'r-plain' }),
        row({
          taskId: 't-1',
          runId: 'r-queued',
          queue: { position: 1, entry: {} },
        } as Partial<LandingRow>),
      ],
      new Map()
    );
    expect(result.rows.map((r) => r.runId)).toEqual(['r-queued']);
    expect(result.extraRunsByTask.get('t-1')).toBe(1);
  });

  test('bare PR rows pass through untouched', () => {
    const result = dedupeLandingRows([row({ runId: undefined })], new Map());
    expect(result.rows).toHaveLength(1);
  });
});

describe('landedFromTasks', () => {
  const task = (
    id: string,
    status: string,
    updated: string,
    kind = 'task'
  ) => ({
    meta: { id, title: id, status, kind, updated },
  });

  test('landed tasks only, newest first, epics excluded, capped', () => {
    const rows = landedFromTasks(
      [
        task('t-old', 'landed', '2026-08-01T00:00:00.000Z'),
        task('t-new', 'landed', '2026-08-03T00:00:00.000Z'),
        task('t-open', 'ready', '2026-08-04T00:00:00.000Z'),
        task('e-1', 'landed', '2026-08-05T00:00:00.000Z', 'epic'),
      ],
      1
    );
    expect(rows.map((r) => r.id)).toEqual(['t-new']);
  });
});
