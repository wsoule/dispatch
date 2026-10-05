import type { TaskDoc } from '@dispatch-foo/core/browser';
import type { DocSummary, RepoPr, RunMeta } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import type { RunQuestion } from './gates';
import type { InboxEntry } from './inbox';
import type { InboxData, InboxInput } from './inboxQueue';
import {
  buildInbox,
  buildInboxItems,
  filterInboxItems,
  groupInboxItems,
  inboxItemActor,
  inboxItemBadge,
  inboxItemState,
  inboxItemText,
  isInboxItemRead,
  loadReadIds,
  markAllItemsRead,
  saveReadIds,
  specForTask,
  unreadInboxCount,
} from './inboxQueue';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function question(over: Partial<RunQuestion> = {}): RunQuestion {
  return {
    id: 'q-1',
    runId: 'r-1',
    question: 'Which way?',
    options: [],
    askedAt: '2026-08-04T00:30:00.000Z',
    answer: null,
    ...over,
  } as RunQuestion;
}

function input(over: Partial<InboxInput> = {}): InboxInput {
  return {
    runs: [],
    tasks: [],
    epics: [],
    repoPrs: [],
    mergeQueue: null,
    pendingApprovals: new Map(),
    openQuestions: new Map(),
    openScopeRequests: new Map(),
    fixLoops: new Map(),
    ...over,
  };
}

function sectionStates(data: ReturnType<typeof buildInbox>): string[] {
  return data.sections.map((s) => s.state);
}

describe('buildInbox', () => {
  test('a finished, un-reviewed run lands in a review section', () => {
    const data = buildInbox(input({ runs: [run()] }));
    expect(sectionStates(data)).toEqual(['review']);
    expect(data.sections[0].rows.map((r) => r.runId)).toEqual(['r-1']);
    expect(data.total).toBe(1);
  });

  test('a run awaiting approval lands in approve', () => {
    const data = buildInbox(
      input({ runs: [run({ state: 'awaiting-approval' })] })
    );
    expect(sectionStates(data)).toEqual(['approve']);
  });

  test('a run blocked on an unanswered question lands in answer', () => {
    const data = buildInbox(
      input({
        runs: [run({ state: 'running' })],
        openQuestions: new Map([['r-1', [question()]]]),
      })
    );
    expect(sectionStates(data)).toEqual(['answer']);
  });

  test("an ended run's open question still lands in answer", () => {
    const data = buildInbox(
      input({
        runs: [run({ state: 'failed' })],
        openQuestions: new Map([['r-1', [question()]]]),
      })
    );
    expect(sectionStates(data)).toEqual(['answer']);
  });

  test("an ended run's open scope gate lands in answer", () => {
    const data = buildInbox(
      input({
        runs: [run()],
        openScopeRequests: new Map([['r-1', { paths: ['a.ts'] }]]),
      })
    );
    expect(sectionStates(data)).toEqual(['answer']);
  });

  test('a failed run lands in failed — the old rules dropped these', () => {
    const data = buildInbox(
      input({ runs: [run({ state: 'failed', error: 'boom' })] })
    );
    expect(sectionStates(data)).toEqual(['failed']);
    expect(data.sections[0].rows[0].attention?.reason).toBe('boom');
  });

  test('one row per task: only the newest settled round speaks for it', () => {
    const data = buildInbox(
      input({
        runs: [
          run({ id: 'r-old', createdAt: '2026-08-01T00:00:00.000Z' }),
          run({ id: 'r-new', createdAt: '2026-08-03T00:00:00.000Z' }),
        ],
      })
    );
    expect(data.total).toBe(1);
    expect(data.sections[0].rows.map((r) => r.runId)).toEqual(['r-new']);
  });

  test('a live run suppresses its task’s settled review rows', () => {
    const data = buildInbox(
      input({
        runs: [
          run({ id: 'r-reviewed', createdAt: '2026-08-01T00:00:00.000Z' }),
          run({
            id: 'r-live',
            state: 'running',
            createdAt: '2026-08-03T00:00:00.000Z',
          }),
        ],
      })
    );
    // The live run itself is calm (machine tier), so nothing is urgent at all.
    expect(data.total).toBe(0);
  });

  test('a reviewed run leaves the urgent sections for ready-to-land', () => {
    const data = buildInbox(
      input({ runs: [run({ reviewedAt: '2026-08-04T01:00:00.000Z' })] })
    );
    expect(data.sections).toHaveLength(0);
    expect(data.readyToLand.map((r) => r.runId)).toEqual(['r-1']);
    expect(data.total).toBe(1);
  });

  test('a calm running run appears nowhere', () => {
    const data = buildInbox(input({ runs: [run({ state: 'running' })] }));
    expect(data.total).toBe(0);
  });

  test('an unclaimed repo PR lands in prs; a run-claimed one does not', () => {
    const claimed = {
      number: 7,
      url: 'https://github.com/x/y/pull/7',
      title: 'Claimed',
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as RepoPr;
    const standalone = {
      number: 9,
      url: 'https://github.com/x/y/pull/9',
      title: 'Standalone',
      updatedAt: '2026-08-04T00:00:00.000Z',
    } as RepoPr;
    const data = buildInbox(
      input({
        runs: [run({ prUrl: claimed.url })],
        repoPrs: [claimed, standalone],
      })
    );
    expect(data.prs.map((pr) => pr.number)).toEqual([9]);
    // review row for the claimed run + one standalone PR.
    expect(data.total).toBe(2);
  });
});

describe('readyToLand', () => {
  test('a reviewed, unlanded run surfaces; queued/PR/landed-task ones do not', () => {
    const reviewed = (over: Partial<RunMeta>) =>
      run({ reviewedAt: '2026-08-04T01:00:00.000Z', ...over });
    const data = buildInbox(
      input({
        runs: [
          reviewed({ id: 'r-land', taskId: 't-land' }),
          reviewed({
            id: 'r-queued',
            taskId: 't-queued',
          }),
          reviewed({
            id: 'r-pr',
            taskId: 't-pr',
            prUrl: 'https://github.com/x/y/pull/3',
          }),
        ],
        mergeQueue: {
          entries: [{ runId: 'r-queued', state: 'queued' }],
        } as unknown as InboxInput['mergeQueue'],
      })
    );
    expect(data.readyToLand.map((r) => r.runId)).toEqual(['r-land']);
    expect(data.readyToLand[0].activity).toBe('Reviewed, not landed');
    // r-land + the PR-backed run's own review row is gone (reviewed), and the
    // claimed PR isn't in repoPrs here — so the total is just the one row.
    expect(data.total).toBe(1);
  });

  test('only the newest reviewed run speaks for a task', () => {
    const data = buildInbox(
      input({
        runs: [
          run({
            id: 'r-old',
            reviewedAt: '2026-08-01T01:00:00.000Z',
            createdAt: '2026-08-01T00:00:00.000Z',
          }),
          run({
            id: 'r-new',
            reviewedAt: '2026-08-03T01:00:00.000Z',
            createdAt: '2026-08-03T00:00:00.000Z',
          }),
        ],
      })
    );
    expect(data.readyToLand.map((r) => r.runId)).toEqual(['r-new']);
  });
});

describe('inbox items', () => {
  test('derives one Inbox item per conflicted team doc, counted in the badge', () => {
    const doc = {
      id: 'doc-1',
      handle: 'auth',
      title: 'Auth refactor',
      scope: 'team',
      conflicted: true,
      updatedAt: '2026-09-26T10:00:00.000Z',
    } as unknown as DocSummary;
    const data = buildInbox(input({ conflictedDocs: [doc] }));
    expect(data.total).toBe(1);
    const items = buildInboxItems(data, []);
    expect(items).toEqual([
      { kind: 'doc', key: 'doc:doc-1', ts: '2026-09-26T10:00:00.000Z', doc },
    ]);
    expect(filterInboxItems(items, 'needs-you')).toHaveLength(1);
    expect(inboxItemText(items[0])).toEqual({
      id: 'auth',
      title: 'Conflict markers in Auth refactor',
      subtitle: 'Resolve them in the doc',
    });
    expect(buildInbox(input()).docs ?? []).toEqual([]);
  });

  const reviewRow = () => ({
    runId: 'r-1',
    taskId: 't-1',
    title: 'Do the thing',
    state: 'review' as const,
    epicTitle: null,
    priority: null,
    since: '2026-08-04T00:00:00.000Z',
    activity: '3 turns',
    attention: null,
    fixLoop: null,
  });
  const entry = (over: Partial<InboxEntry> = {}): InboxEntry => ({
    id: 'n-1',
    ts: '2026-08-03T00:00:00.000Z',
    title: 'Run finished',
    body: 'Earlier task',
    target: { kind: 'run', runId: 'r-old' },
    read: false,
    ...over,
  });
  const data = (): InboxData => ({
    sections: [{ state: 'review', rows: [reviewRow()] }],
    readyToLand: [
      { ...reviewRow(), runId: 'r-2', taskId: 't-2', state: 'landing' },
    ],
    prs: [
      {
        number: 9,
        url: 'https://github.com/x/y/pull/9',
        title: 'Standalone',
        author: 'octocat',
        updatedAt: '2026-08-02T00:00:00.000Z',
      } as RepoPr,
    ],
    total: 3,
  });

  test('asks come first, then ready-to-land, PRs and the record', () => {
    const items = buildInboxItems(data(), [entry()]);
    expect(items.map((i) => i.kind)).toEqual([
      'ask',
      'landing',
      'pr',
      'notification',
    ]);
    expect(items.map((i) => i.key)).toEqual([
      'review:t-1:r-1',
      'landing:t-2:r-2',
      'pr:9',
      'notification:n-1',
    ]);
  });

  test('the filter splits live asks from the record', () => {
    const items = buildInboxItems(data(), [entry()]);
    expect(filterInboxItems(items, 'needs-you').map((i) => i.kind)).toEqual([
      'ask',
      'landing',
      'pr',
    ]);
    expect(filterInboxItems(items, 'earlier').map((i) => i.kind)).toEqual([
      'notification',
    ]);
    expect(filterInboxItems(items, 'all')).toHaveLength(4);
  });

  test('read state: a live key is read once seen, a notification carries its own flag', () => {
    const items = buildInboxItems(data(), [entry({ read: true })]);
    const none = new Set<string>();
    expect(unreadInboxCount(items, none)).toBe(3);
    expect(isInboxItemRead(items[3], none)).toBe(true);
    const seen = new Set(['review:t-1:r-1']);
    expect(isInboxItemRead(items[0], seen)).toBe(true);
    expect(unreadInboxCount(items, seen)).toBe(2);
  });

  test('a notification read on the page is read by key before its record catches up', () => {
    const items = buildInboxItems(data(), [entry({ read: false })]);
    const notification = items[3];
    if (notification?.kind !== 'notification')
      throw new Error('no notification');
    expect(isInboxItemRead(notification, new Set())).toBe(false);
    expect(isInboxItemRead(notification, new Set([notification.key]))).toBe(
      true
    );
  });

  test('a row that changes state comes back unread', () => {
    const before = buildInboxItems(data(), []);
    const read = markAllItemsRead(before, new Set());
    const failed = data();
    failed.sections = [
      { state: 'failed', rows: [{ ...reviewRow(), state: 'failed' }] },
    ];
    const after = buildInboxItems(failed, []);
    expect(isInboxItemRead(after[0], read)).toBe(false);
  });

  test('mark-all adds every live key and leaves the record to its seam', () => {
    const items = buildInboxItems(data(), [entry()]);
    const read = markAllItemsRead(items, new Set());
    expect([...read]).toEqual(['review:t-1:r-1', 'landing:t-2:r-2', 'pr:9']);
    // Nothing new to add returns the same set.
    expect(markAllItemsRead(items, read)).toBe(read);
  });

  test('grouping by kind labels each group in feed order', () => {
    const groups = groupInboxItems(buildInboxItems(data(), [entry()]));
    expect(groups.map((g) => [g.id, g.label, g.items.length])).toEqual([
      ['review', 'Review', 1],
      ['landing', 'Ready to land', 1],
      ['pr', 'Pull requests', 1],
      ['earlier', 'Earlier', 1],
    ]);
  });

  test('the row anatomy: badge, state glyph, actor, title and subtitle', () => {
    const [ask, landing, pr, note] = buildInboxItems(data(), [
      entry({
        title: 'Merge blocked. Action needed.',
        target: { kind: 'queue' },
      }),
    ]);
    expect(inboxItemBadge(ask)).toBe('check');
    expect(inboxItemBadge(landing)).toBe('merge');
    expect(inboxItemBadge(pr)).toBe('pr');
    expect(inboxItemBadge(note)).toBe('alert');
    expect(inboxItemState(note)).toBe('unblock');
    expect(inboxItemActor(note)).toBe('Merge queue');
    expect(inboxItemActor(pr)).toBe('octocat');
    expect(inboxItemText(ask)).toEqual({
      id: 't-1',
      title: 'Do the thing',
      subtitle: 'Review · 3 turns',
    });
    expect(inboxItemText(pr).subtitle).toBe('Pull request by octocat');
  });

  test('read ids round-trip through storage and forget keys no longer listed', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    };
    saveReadIds(
      '/repo',
      new Set(['review:t-1:r-1', 'review:t-9:r-9']),
      new Set(['review:t-1:r-1']),
      storage
    );
    expect([...loadReadIds('/repo', storage)]).toEqual(['review:t-1:r-1']);
    expect(loadReadIds('/other', storage).size).toBe(0);
    store.set('dispatch:inbox-read:/broken', '{not json');
    expect(loadReadIds('/broken', storage).size).toBe(0);
  });
});

describe('specForTask', () => {
  test('projects a task doc onto the spec view shape', () => {
    const doc = {
      meta: {
        id: 't-1',
        title: 'Cache the index',
        status: 'ready',
        priority: 'high',
        writes: ['src/cache.ts'],
        risk: 'elevated',
        blockedBy: ['t-0', 't-missing'],
      },
      body: '## Description\n\nMake it fast.\n\n## Acceptance Criteria\n\n- [ ] warm start\n- [x] cold start\n\n## Activity\n',
    } as unknown as TaskDoc;
    const blocker = {
      meta: { id: 't-0', title: 'Pick a store' },
    } as unknown as TaskDoc;
    expect(specForTask(doc, [doc, blocker])).toEqual({
      title: 'Cache the index',
      status: 'ready',
      priority: 'high',
      description: 'Make it fast.',
      acceptanceCriteria: ['warm start', 'cold start'],
      writes: ['src/cache.ts'],
      risk: 'elevated',
      blockedBy: [
        { key: 't-0', title: 'Pick a store' },
        { key: 't-missing', title: 't-missing' },
      ],
    });
  });
});

describe('whose attention', () => {
  const mine = run({ id: 'r-mine', taskId: 't-1', dispatchedBy: 'human:wyat' });
  const adas = run({
    id: 'r-ada',
    taskId: 't-2',
    taskTitle: "Ada's thing",
    dispatchedBy: 'human:ada',
  });

  test("a teammate's ask is listed but not counted against you", () => {
    const data = buildInbox(input({ runs: [mine, adas], me: 'human:wyat' }));

    // Both are still in the sections — Ada's is visible to everyone.
    expect(
      data.sections.flatMap((s) => s.rows.map((r) => r.runId)).sort()
    ).toEqual(['r-ada', 'r-mine']);
    // Only yours drives the badge.
    expect(data.total).toBe(1);
  });

  test('Needs you and Teammates split the same list', () => {
    const data = buildInbox(input({ runs: [mine, adas], me: 'human:wyat' }));
    const items = buildInboxItems(data, []);

    expect(filterInboxItems(items, 'needs-you').map((i) => i.key)).toEqual([
      expect.stringContaining('r-mine'),
    ]);
    const theirs = filterInboxItems(items, 'teammates');
    expect(theirs).toHaveLength(1);
    expect(theirs[0]).toMatchObject({ owner: 'human:ada' });
  });

  test("a solo project is unchanged: no me, nothing is a teammate's", () => {
    const data = buildInbox(input({ runs: [mine, adas] }));
    expect(data.total).toBe(2);
    expect(filterInboxItems(buildInboxItems(data, []), 'teammates')).toEqual(
      []
    );
  });

  test('a run is the human it acts for, not who dispatched it (XH-R9)', () => {
    const forAda = run({
      id: 'r-for-ada',
      taskId: 't-4',
      dispatchedBy: 'human:wyat',
      operator: 'human:ada',
    });
    const data = buildInbox(input({ runs: [forAda], me: 'human:wyat' }));
    expect(data.total).toBe(0);
    expect(data.teammateOwners?.get('r-for-ada')).toBe('human:ada');
  });

  test("a gate a teammate's run addressed to you is yours", () => {
    const data = buildInbox(
      input({
        runs: [mine, adas],
        me: 'human:wyat',
        asksMe: new Set(['r-ada']),
      })
    );
    expect(data.total).toBe(2);
    const items = buildInboxItems(data, []);
    expect(filterInboxItems(items, 'teammates')).toEqual([]);
  });

  test("a run nobody dispatched by hand is everyone's, so yours", () => {
    const auto = run({ id: 'r-auto', taskId: 't-3' });
    const data = buildInbox(input({ runs: [auto], me: 'human:wyat' }));
    expect(data.total).toBe(1);
  });
});
