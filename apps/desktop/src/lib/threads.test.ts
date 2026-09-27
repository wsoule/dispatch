import type {
  Delivery,
  DeliveryState,
  Message,
  ThreadSummary as RecentThread,
} from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  addressLabel,
  appendToThread,
  completeAddress,
  groupRail,
  summarizeThreads,
  type ThreadSummary,
} from './threads';

const ME = 'human:wyat';
const NO_GATES: ReadonlySet<string> = new Set();

function msg(id: string, overrides: Partial<Message> = {}): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'run:r-000001',
    to: [ME],
    kind: 'message',
    body: `body of ${id}`,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...overrides,
  };
}

// A reply in `root`'s thread; ids sort by time the way ulids do.
function reply(id: string, root: string, overrides: Partial<Message> = {}) {
  return msg(id, { thread: root, replyTo: root, ...overrides });
}

function answer(id: string, question: Message): Message {
  return reply(id, question.thread, {
    replyTo: question.id,
    kind: 'answer',
    from: ME,
    to: [question.from],
    choice: 'accept',
  });
}

function delivery(
  messageId: string,
  state: DeliveryState,
  recipient = ME
): Delivery {
  return {
    id: `d-${messageId}-${recipient}`,
    messageId,
    recipient,
    runId: null,
    via: 'direct',
    state,
    updatedAt: '2026-09-25T10:00:00.000Z',
  };
}

function only(summaries: ThreadSummary[]): ThreadSummary {
  expect(summaries).toHaveLength(1);
  const [summary] = summaries;
  if (summary === undefined) throw new Error('no thread summarized');
  return summary;
}

describe('summarizeThreads', () => {
  test('folds each thread to its root, newest message and distinct count', () => {
    const root = msg('m-001');
    const second = reply('m-002', 'm-001', { from: ME, to: ['run:r-000001'] });
    const third = reply('m-003', 'm-001');
    // The same message arriving from two sources (mailbox + thread) counts once.
    const summary = only(
      summarizeThreads([third, root, second, third], [], ME, NO_GATES)
    );
    expect(summary.thread).toBe('m-001');
    expect(summary.root.id).toBe('m-001');
    expect(summary.last.id).toBe('m-003');
    expect(summary.count).toBe(3);
  });

  test('lists threads newest last message first', () => {
    const older = msg('m-001');
    const newer = msg('m-002');
    const revived = reply('m-003', 'm-001');
    const ids = summarizeThreads([older, newer, revived], [], ME, NO_GATES).map(
      (s) => s.thread
    );
    expect(ids).toEqual(['m-001', 'm-002']);
  });

  test('counts unread as my held, notified and pushed deliveries', () => {
    const messages = ['m-001', 'm-002', 'm-003', 'm-004', 'm-005', 'm-006'].map(
      (id, i) => (i === 0 ? msg(id) : reply(id, 'm-001'))
    );
    const deliveries = [
      delivery('m-001', 'held'),
      delivery('m-002', 'notified'),
      delivery('m-003', 'pushed'),
      delivery('m-004', 'read'),
      delivery('m-005', 'answered'),
      delivery('m-006', 'sending'),
      // Someone else's unread copy is not mine.
      delivery('m-004', 'held', 'human:ada'),
    ];
    const summary = only(summarizeThreads(messages, deliveries, ME, NO_GATES));
    expect(summary.unread).toBe(3);
  });

  test('ignores deliveries for messages it was not given', () => {
    const summary = only(
      summarizeThreads(
        [msg('m-001')],
        [delivery('m-999', 'held')],
        ME,
        NO_GATES
      )
    );
    expect(summary.unread).toBe(0);
  });

  describe('needsYou', () => {
    const gate = reply('m-002', 'm-001', {
      from: 'agent:dispatch',
      to: [ME],
      kind: 'question',
      blocking: true,
      choices: ['allow', 'deny'],
      data: {
        type: 'tool-approval',
        requestId: 'q-1',
        tool: 'Bash',
        input: {},
      },
    });

    test('is set by an open gate addressed to me', () => {
      const summary = only(
        summarizeThreads([msg('m-001'), gate], [], ME, new Set(['m-002']))
      );
      expect(summary.needsYou).toBe(true);
    });

    test('ignores an open gate addressed to another human', () => {
      const theirs = { ...gate, to: ['human:ada'] };
      const summary = only(
        summarizeThreads([msg('m-001'), theirs], [], ME, new Set(['m-002']))
      );
      expect(summary.needsYou).toBe(false);
    });

    test('drops a gate once its answer is in the thread', () => {
      // The open-decisions list lags the answer that message.new just delivered.
      const summary = only(
        summarizeThreads(
          [msg('m-001'), gate, answer('m-003', gate)],
          [],
          ME,
          new Set(['m-002'])
        )
      );
      expect(summary.needsYou).toBe(false);
    });

    test('ignores a question that is not an open gate', () => {
      const summary = only(
        summarizeThreads([msg('m-001'), gate], [], ME, NO_GATES)
      );
      expect(summary.needsYou).toBe(false);
    });

    const handoff = msg('m-010', {
      kind: 'handoff',
      choices: ['accept', 'decline'],
      body: 'Take over the export pipeline',
    });

    test('is set by an unanswered handoff addressed to me', () => {
      const summary = only(summarizeThreads([handoff], [], ME, NO_GATES));
      expect(summary.needsYou).toBe(true);
    });

    test('is set by a handoff addressed to one of my tasks', () => {
      const toTask = { ...handoff, to: ['task:t-1a2b'] };
      const mine = only(
        summarizeThreads([toTask], [], ME, NO_GATES, {
          myTaskIds: new Set(['t-1a2b']),
        })
      );
      expect(mine.needsYou).toBe(true);
      const notMine = only(
        summarizeThreads([toTask], [], ME, NO_GATES, {
          myTaskIds: new Set(['t-9f9f']),
        })
      );
      expect(notMine.needsYou).toBe(false);
    });

    test('drops a handoff once answered, by message or by delivery state', () => {
      const byMessage = only(
        summarizeThreads([handoff, answer('m-011', handoff)], [], ME, NO_GATES)
      );
      expect(byMessage.needsYou).toBe(false);
      const byDelivery = only(
        summarizeThreads(
          [handoff],
          [delivery('m-010', 'answered')],
          ME,
          NO_GATES
        )
      );
      expect(byDelivery.needsYou).toBe(false);
    });
  });

  test('takes the channel from the root, as a bare name', () => {
    const root = msg('m-001', { to: ['channel:epic/e-c25f9c', 'task:t-1a2b'] });
    const inChannel = only(summarizeThreads([root], [], ME, NO_GATES));
    expect(inChannel.channel).toBe('epic/e-c25f9c');
    const direct = only(summarizeThreads([msg('m-002')], [], ME, NO_GATES));
    expect(direct.channel).toBeNull();
  });

  test('lists participants once, first seen first, without me or channels', () => {
    const root = msg('m-001', {
      from: 'run:r-000001',
      to: ['channel:auth-refactor', ME],
    });
    const second = reply('m-002', 'm-001', {
      from: ME,
      to: ['run:r-000001', 'task:t-1a2b'],
    });
    const third = reply('m-003', 'm-001', {
      from: 'agent:wyat/claude',
      to: ['task:t-1a2b'],
    });
    const summary = only(
      summarizeThreads([third, second, root], [], ME, NO_GATES)
    );
    expect(summary.participants).toEqual([
      'run:r-000001',
      'task:t-1a2b',
      'agent:wyat/claude',
    ]);
  });

  test('keeps the server count and ends for recent threads fetched in part', () => {
    const root = msg('m-001', { to: ['channel:auth-refactor'] });
    const last = reply('m-009', 'm-001');
    const recent: RecentThread[] = [{ thread: 'm-001', root, last, count: 9 }];
    // Only a middle message came through the mailbox.
    const middle = reply('m-005', 'm-001');
    const summary = only(
      summarizeThreads([middle], [], ME, NO_GATES, { recent })
    );
    expect(summary.root.id).toBe('m-001');
    expect(summary.last.id).toBe('m-009');
    expect(summary.count).toBe(9);
    expect(summary.channel).toBe('auth-refactor');
  });

  test('adds messages newer than the recent listing to its count', () => {
    const root = msg('m-001');
    const last = reply('m-005', 'm-001');
    const recent: RecentThread[] = [{ thread: 'm-001', root, last, count: 5 }];
    const fresh = reply('m-006', 'm-001');
    const summary = only(
      summarizeThreads([last, fresh], [], ME, NO_GATES, { recent })
    );
    expect(summary.last.id).toBe('m-006');
    expect(summary.count).toBe(6);
  });
});

describe('groupRail', () => {
  function summary(
    thread: string,
    lastId: string,
    overrides: Partial<ThreadSummary> = {}
  ): ThreadSummary {
    const root = msg(thread);
    return {
      thread,
      root,
      last: reply(lastId, thread),
      count: 1,
      unread: 0,
      needsYou: false,
      channel: null,
      participants: [],
      ...overrides,
    };
  }

  test('puts needs-you first and each thread in exactly one group', () => {
    const rail = groupRail([
      summary('m-001', 'm-001', { channel: 'auth-refactor' }),
      summary('m-002', 'm-002'),
      summary('m-003', 'm-003', { needsYou: true, channel: 'auth-refactor' }),
      summary('m-004', 'm-004', { needsYou: true }),
    ]);
    expect(Object.keys(rail)).toEqual(['needs-you', 'channels', 'direct']);
    expect(rail['needs-you'].map((s) => s.thread)).toEqual(['m-004', 'm-003']);
    expect(rail.channels.map((s) => s.thread)).toEqual(['m-001']);
    expect(rail.direct.map((s) => s.thread)).toEqual(['m-002']);
  });

  test('orders each group newest last message first', () => {
    const rail = groupRail([
      summary('m-001', 'm-007'),
      summary('m-002', 'm-003'),
      summary('m-004', 'm-009'),
    ]);
    expect(rail.direct.map((s) => s.thread)).toEqual([
      'm-004',
      'm-001',
      'm-002',
    ]);
  });

  test('returns empty groups for no threads', () => {
    expect(groupRail([])).toEqual({
      'needs-you': [],
      channels: [],
      direct: [],
    });
  });
});

describe('appendToThread', () => {
  const thread = [msg('m-001'), reply('m-002', 'm-001')];

  test('appends a newer message without touching the original', () => {
    const next = appendToThread(thread, reply('m-003', 'm-001'));
    expect(next.map((m) => m.id)).toEqual(['m-001', 'm-002', 'm-003']);
    expect(thread).toHaveLength(2);
  });

  test('returns the same array for a message it already holds', () => {
    expect(appendToThread(thread, reply('m-002', 'm-001'))).toBe(thread);
  });

  test('keeps id order for a message that arrives late', () => {
    const current = [msg('m-001'), reply('m-003', 'm-001')];
    const next = appendToThread(current, reply('m-002', 'm-001'));
    expect(next.map((m) => m.id)).toEqual(['m-001', 'm-002', 'm-003']);
  });

  test('ignores a message from another thread', () => {
    expect(appendToThread(thread, msg('m-050'))).toBe(thread);
  });

  test('starts an empty thread with the message', () => {
    const first = msg('m-001');
    expect(appendToThread([], first)).toEqual([first]);
  });
});

describe('completeAddress', () => {
  const known = {
    tasks: [
      { id: 'x-0002', title: 'Retire the t-shirt size field' },
      { id: 't-1a2b', title: 'Export pipeline' },
      { id: 't-3c4d', title: 'Auth refactor' },
      { id: 'x-0001', title: 'Pipeline export audit' },
    ],
    channels: ['auth-refactor', 'epic/e-c25f9c', 'releases'],
    agents: ['agent:wyat/claude', 'agent:ada/codex'],
    humans: ['human:wyat', 'human:ada'],
  };

  const addresses = (prefix: string, k = known) =>
    completeAddress(prefix, k).map((c) => c.address);

  test('matches a task id prefix', () => {
    expect(completeAddress('@t-1', known)).toEqual([
      { address: 'task:t-1a2b', label: 't-1a2b · Export pipeline' },
    ]);
  });

  test('matches a title substring, case-insensitively', () => {
    expect(addresses('@EXPORT')).toEqual(['task:t-1a2b', 'task:x-0001']);
  });

  test('ranks matches at the start of an id or title first', () => {
    // `t-` starts two ids and sits inside the first-listed task's title.
    expect(addresses('@t-')).toEqual([
      'task:t-1a2b',
      'task:t-3c4d',
      'task:x-0002',
    ]);
    expect(addresses('@pipeline')).toEqual(['task:x-0001', 'task:t-1a2b']);
  });

  test('lists channels for # and channel:', () => {
    const all = [
      'channel:auth-refactor',
      'channel:epic/e-c25f9c',
      'channel:releases',
    ];
    expect(addresses('@#')).toEqual(all);
    expect(addresses('@channel:')).toEqual(all);
    expect(completeAddress('@#epic', known)).toEqual([
      { address: 'channel:epic/e-c25f9c', label: '#epic/e-c25f9c' },
    ]);
  });

  test('scopes to one actor kind by its scheme', () => {
    expect(addresses('@human:')).toEqual(['human:wyat', 'human:ada']);
    expect(addresses('@agent:ada')).toEqual(['agent:ada/codex']);
  });

  test('searches every kind for a bare word', () => {
    expect(addresses('@auth')).toEqual([
      'task:t-3c4d',
      'channel:auth-refactor',
    ]);
    // `ada` names the human exactly, so the human leads the agent it only starts.
    expect(completeAddress('@ada', known)).toEqual([
      { address: 'human:ada', label: 'ada' },
      { address: 'agent:ada/codex', label: 'ada/codex' },
    ]);
  });

  test('puts an exactly typed name ahead of longer names it starts', () => {
    const people = {
      ...known,
      agents: [],
      humans: ['human:adam', 'human:ada'],
    };
    expect(addresses('@human:ada', people)).toEqual([
      'human:ada',
      'human:adam',
    ]);
    expect(addresses('@ada', people)).toEqual(['human:ada', 'human:adam']);
    expect(addresses('@#releases')).toEqual(['channel:releases']);
    expect(addresses('@T-1A2B')).toEqual(['task:t-1a2b']);
  });

  test('returns the top five of each kind for a bare @', () => {
    const many = {
      tasks: Array.from({ length: 7 }, (_, i) => ({
        id: `t-00${i}`,
        title: `Task ${i}`,
      })),
      channels: Array.from({ length: 6 }, (_, i) => `room-${i}`),
      agents: ['agent:wyat/claude'],
      humans: ['human:wyat', 'human:ada'],
    };
    expect(addresses('@', many)).toEqual([
      'task:t-000',
      'task:t-001',
      'task:t-002',
      'task:t-003',
      'task:t-004',
      'channel:room-0',
      'channel:room-1',
      'channel:room-2',
      'channel:room-3',
      'channel:room-4',
      'agent:wyat/claude',
      'human:wyat',
      'human:ada',
    ]);
  });

  test('accepts channel and actor entries with or without their scheme', () => {
    const loose = {
      tasks: [],
      channels: ['channel:releases'],
      agents: ['wyat/claude'],
      humans: ['ada'],
    };
    expect(addresses('@', loose)).toEqual([
      'channel:releases',
      'agent:wyat/claude',
      'human:ada',
    ]);
  });

  test('returns nothing when nothing matches', () => {
    expect(completeAddress('@zzz', known)).toEqual([]);
    expect(completeAddress('@run:', known)).toEqual([]);
  });
});

describe('addressLabel', () => {
  const lookups = {
    taskTitle: (id: string) => (id === 't-1a2b' ? 'Export pipeline' : null),
  };

  test('names a task by id and title', () => {
    expect(addressLabel('task:t-1a2b', lookups)).toBe(
      't-1a2b · Export pipeline'
    );
    expect(addressLabel('task:t-9f9f', lookups)).toBe('t-9f9f');
  });

  test('drops the scheme from actors and runs, and hashes channels', () => {
    expect(addressLabel('human:wyat', lookups)).toBe('wyat');
    expect(addressLabel('agent:wyat/claude', lookups)).toBe('wyat/claude');
    expect(addressLabel('run:r-9f2c01', lookups)).toBe('r-9f2c01');
    expect(addressLabel('channel:epic/e-c25f9c', lookups)).toBe(
      '#epic/e-c25f9c'
    );
  });

  test('shows an unrecognized address as written', () => {
    expect(addressLabel('mystery', lookups)).toBe('mystery');
    expect(addressLabel('pager:support', lookups)).toBe('pager:support');
  });
});

describe('behaviors the thread surfaces rely on', () => {
  const m = (id: string, over: Partial<Message> = {}): Message => ({
    id,
    thread: 'm-01',
    replyTo: null,
    from: 'run:r-000001',
    to: ['human:wyat'],
    kind: 'message',
    body: id,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  });

  test('uses the earliest fetched message as root when the root itself was not fetched', () => {
    const [summary] = summarizeThreads(
      [m('m-03', { replyTo: 'm-01' }), m('m-02', { replyTo: 'm-01' })],
      [],
      'human:wyat',
      new Set()
    );
    expect(summary?.thread).toBe('m-01');
    expect(summary?.root.id).toBe('m-02');
    expect(summary?.last.id).toBe('m-03');
  });

  test('a plain blocking question whose id is in the open set needs me, like a gate', () => {
    const question = m('m-01', {
      kind: 'question',
      blocking: true,
      choices: ['a', 'b'],
    });
    const [summary] = summarizeThreads(
      [question],
      [],
      'human:wyat',
      new Set(['m-01'])
    );
    expect(summary?.needsYou).toBe(true);
  });

  test('appending keeps the existing message objects, so rendered rows keep their identity', () => {
    const a = m('m-01');
    const next = appendToThread([a], m('m-02'));
    expect(next[0]).toBe(a);
  });
});
