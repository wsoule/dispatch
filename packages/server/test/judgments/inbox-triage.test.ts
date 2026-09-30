import type { TaskDoc } from '@dispatch/core';
import { defaultTaskFields } from '@dispatch/core';
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { InboxItem } from '../../src/inbox';
import type { JudgmentClient } from '../../src/judgments/client';
import {
  InboxTriageSnapshotStore,
  interpretTriage,
  triageCandidates,
  triageEpics,
  triageHash,
  triageInbox,
  triageQuestions,
  untriagedForClustering,
} from '../../src/judgments/inboxTriage';

function item(
  id: string,
  text: string,
  over: Partial<InboxItem> = {}
): InboxItem {
  return {
    id,
    kind: 'note',
    text,
    done: false,
    linkedTaskId: null,
    createdByRunId: null,
    created: '2026-09-20T00:00:00.000Z',
    ...over,
  };
}

function task(
  id: string,
  title: string,
  over: Partial<TaskDoc['meta']> = {},
  body = ''
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      risk: 'routine',
      model: null,
      selfReview: true,
      writes: [],
      external: null,
      exercised: false,
      ...defaultTaskFields(),
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-01T00:00:00.000Z',
      ...over,
    },
    body,
  };
}

// A client that answers every request with `answers` and records the questions asked.
function stubClient(answers: Record<string, unknown>): {
  client: JudgmentClient;
  asked: Record<string, unknown>[];
} {
  const asked: Record<string, unknown>[] = [];
  const client: JudgmentClient = {
    model: 'jev-test',
    judge: (_state, questions) => {
      asked.push(questions);
      return Promise.resolve({
        model: 'jev-test',
        answers,
        usage: { input_tokens: 1, output_tokens: 0 },
      } as never);
    },
  };
  return { client, asked };
}

describe('triageCandidates', () => {
  test('ranks by word overlap, skips the item itself, and caps the list', () => {
    const me = item('i1', 'board drag and drop loses the card');
    const others = [
      item('i2', 'drag and drop on the board drops cards'),
      item('i3', 'totally unrelated release notes'),
      me,
    ];
    const tasks = [
      task('t1', 'Fix board drag and drop'),
      task('t2', 'Write release notes'),
      task('t3', 'Board card drop bug', { status: 'landed' }),
    ];
    const got = triageCandidates(me, tasks, others, 2);
    expect(got.map((c) => c.id)).toEqual(['i2', 't1']);
    expect(got.every((c) => c.id !== 'i1')).toBe(true);
  });

  test('offers nothing when nothing overlaps', () => {
    expect(
      triageCandidates(item('i1', 'zebra'), [task('t1', 'apples')], [])
    ).toEqual([]);
  });
});

describe('triageEpics', () => {
  test('lists open epics with a one-line summary', () => {
    const epics = triageEpics([
      task('e1', 'Landing', { kind: 'milestone' }, 'First line.\n\nMore.'),
      task('e2', 'Old', { kind: 'milestone', status: 'landed' }),
      task('t1', 'Not an epic'),
    ]);
    expect(epics).toEqual([
      { id: 'e1', title: 'Landing', summary: 'First line.' },
    ]);
  });
});

describe('triageQuestions', () => {
  test('asks kind, epic with a none option, and one duplicate noul per candidate', () => {
    const q = triageQuestions(
      [{ id: 'e1', title: 'Landing', summary: 'ship it' }],
      [
        { id: 't1', title: 'A' },
        { id: 'i2', title: 'B' },
      ]
    );
    expect(Object.keys(q)).toEqual(['kind', 'epic', 'dup_t1', 'dup_i2']);
    expect(q.kind.type).toBe('choice');
    expect(Object.keys(q.kind.criteria)).toEqual([
      'bug',
      'idea',
      'task',
      'note',
      'noise',
    ]);
    expect(q.epic?.type).toBe('choice');
    expect(Object.keys(q.epic?.criteria ?? {})).toEqual(['e1', 'none']);
    expect(q.dup_t1.type).toBe('noul');
  });

  test('skips the epic question when there are no epics', () => {
    const q = triageQuestions([], []);
    expect(Object.keys(q)).toEqual(['kind']);
  });
});

describe('interpretTriage', () => {
  const candidates = [
    { id: 't1', title: 'A' },
    { id: 'i2', title: 'B' },
  ];

  const epics = [{ id: 'e1', title: 'Landing', summary: '' }];

  test('keeps a confident epic and confident duplicates, sorted', () => {
    const got = interpretTriage('i1', 'h', epics, candidates, {
      kind: {
        type: 'choice',
        choice: 'task',
        confidence: 0.8,
        probabilities: {},
      },
      epic: {
        type: 'choice',
        choice: 'e1',
        confidence: 0.9,
        probabilities: {},
      },
      dup_t1: { type: 'noul', noul: 0.72 },
      dup_i2: { type: 'noul', noul: 0.95 },
    });
    expect(got).toEqual({
      itemId: 'i1',
      hash: 'h',
      kind: 'task',
      kindConfidence: 0.8,
      epicId: 'e1',
      epicTitle: 'Landing',
      epicConfidence: 0.9,
      duplicates: [
        { id: 'i2', probability: 0.95 },
        { id: 't1', probability: 0.72 },
      ],
    });
  });

  test('drops an epic below 0.6, a none answer, and weak duplicates', () => {
    const low = interpretTriage('i1', 'h', epics, candidates, {
      kind: {
        type: 'choice',
        choice: 'note',
        confidence: 0.5,
        probabilities: {},
      },
      epic: {
        type: 'choice',
        choice: 'e1',
        confidence: 0.5,
        probabilities: {},
      },
      dup_t1: { type: 'noul', noul: 0.69 },
      dup_i2: { type: 'noul', noul: 0.1 },
    });
    expect(low.epicId).toBeNull();
    expect(low.epicTitle).toBeNull();
    expect(low.duplicates).toEqual([]);

    const none = interpretTriage('i1', 'h', epics, [], {
      kind: {
        type: 'choice',
        choice: 'note',
        confidence: 0.5,
        probabilities: {},
      },
      epic: {
        type: 'choice',
        choice: 'none',
        confidence: 0.99,
        probabilities: {},
      },
    });
    expect(none.epicId).toBeNull();
  });
});

describe('triageInbox', () => {
  test('returns null and asks nothing without a client', async () => {
    expect(await triageInbox(null, [item('i1', 'x')], [], null)).toBeNull();
  });

  test('judges open items, reuses entries whose text is unchanged', async () => {
    const items = [
      item('i1', 'fix the board'),
      item('i2', 'done thing', { done: true }),
      item('i3', 'new'),
    ];
    const previous = {
      items: {
        i1: {
          itemId: 'i1',
          hash: triageHash(items[0]),
          kind: 'task' as const,
          kindConfidence: 1,
          epicId: 'e1',
          epicTitle: 'E1',
          epicConfidence: 1,
          duplicates: [],
        },
      },
      updatedAt: 'then',
    };
    const { client, asked } = stubClient({
      kind: {
        type: 'choice',
        choice: 'idea',
        confidence: 0.7,
        probabilities: {},
      },
    });
    const snapshot = await triageInbox(client, items, [], previous);
    expect(asked).toHaveLength(1);
    expect(Object.keys(snapshot!.items).sort()).toEqual(['i1', 'i3']);
    expect(snapshot!.items.i1.epicId).toBe('e1');
    expect(snapshot!.items.i3.kind).toBe('idea');
  });

  test('a failing client yields null so the caller falls back', async () => {
    const client: JudgmentClient = {
      model: 'jev-test',
      judge: () => Promise.reject(new Error('down')),
    };
    expect(await triageInbox(client, [item('i1', 'x')], [], null)).toBeNull();
  });
});

describe('untriagedForClustering', () => {
  test('keeps items with no confident epic', () => {
    const items = [item('i1', 'a'), item('i2', 'b'), item('i3', 'c')];
    const snapshot = {
      items: {
        i1: {
          itemId: 'i1',
          hash: 'h',
          kind: 'task' as const,
          kindConfidence: 1,
          epicId: 'e1',
          epicTitle: 'E1',
          epicConfidence: 1,
          duplicates: [],
        },
        i2: {
          itemId: 'i2',
          hash: 'h',
          kind: 'task' as const,
          kindConfidence: 1,
          epicId: null,
          epicTitle: null,
          epicConfidence: 0,
          duplicates: [],
        },
      },
      updatedAt: 'now',
    };
    expect(untriagedForClustering(items, snapshot).map((i) => i.id)).toEqual([
      'i2',
      'i3',
    ]);
    expect(untriagedForClustering(items, null)).toEqual(items);
  });
});

describe('InboxTriageSnapshotStore', () => {
  test('round-trips and reads a missing file as null', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-triage-'));
    const store = new InboxTriageSnapshotStore(root);
    expect(store.load()).toBeNull();
    const snapshot = { items: {}, updatedAt: 'now' };
    store.save(snapshot);
    expect(store.load()).toEqual(snapshot);
  });
});
