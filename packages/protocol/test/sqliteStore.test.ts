import { queryAll } from '@dispatch/core';
import type { SqliteDatabase } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';

let db: SqliteDatabase;
let store: SqliteMessageStore;
beforeEach(() => {
  db = openMessagesDb(':memory:');
  store = new SqliteMessageStore(db);
});
afterEach(() => db.close());

const at = '2026-09-23T10:00:00.000Z';
function msg(over: Partial<Message> = {}): Message {
  return {
    id: 'm-01',
    thread: 'm-01',
    replyTo: null,
    from: 'run:r-000001',
    to: ['task:t-000002', 'human:wyat'],
    kind: 'message',
    body: 'hi',
    refs: [{ type: 'file', id: 'src/a.ts', at: 'abc' }],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: at,
    ...over,
  };
}

describe('SqliteMessageStore', () => {
  it('round-trips a message with its recipients in order', () => {
    const m = msg({
      data: { type: 'x', n: 1 },
      choices: ['a', 'b'],
      kind: 'question',
      session: 's1',
    });
    store.insertMessage(m);
    expect(store.getMessage('m-01')).toEqual(m);
    expect(store.getMessage('m-nope')).toBeNull();
  });

  it('lists a thread in id order and finds answers', () => {
    store.insertMessage(msg({ id: 'm-01', kind: 'question', blocking: true }));
    store.insertMessage(
      msg({
        id: 'm-03',
        thread: 'm-01',
        replyTo: 'm-01',
        kind: 'answer',
        from: 'human:wyat',
      })
    );
    store.insertMessage(msg({ id: 'm-02', thread: 'm-01', replyTo: 'm-01' }));
    expect(store.thread('m-01').map((m) => m.id)).toEqual([
      'm-01',
      'm-02',
      'm-03',
    ]);
    expect(store.answersTo('m-01').map((m) => m.id)).toEqual(['m-03']);
  });

  it('openBlocking excludes answered questions', () => {
    store.insertMessage(msg({ id: 'm-01', kind: 'question', blocking: true }));
    store.insertMessage(
      msg({ id: 'm-02', thread: 'm-02', kind: 'question', blocking: true })
    );
    store.insertMessage(
      msg({ id: 'm-03', thread: 'm-01', replyTo: 'm-01', kind: 'answer' })
    );
    expect(store.openBlocking().map((m) => m.id)).toEqual(['m-02']);
  });

  it('filters and updates deliveries', () => {
    store.insertMessage(msg());
    store.insertDelivery({
      id: 'd-1',
      messageId: 'm-01',
      recipient: 'task:t-000002',
      runId: null,
      via: 'direct',
      state: 'held',
      updatedAt: at,
    });
    store.insertDelivery({
      id: 'd-2',
      messageId: 'm-01',
      recipient: 'human:wyat',
      runId: null,
      via: 'direct',
      state: 'notified',
      updatedAt: at,
    });
    expect(
      store
        .deliveries({ recipient: 'task:t-000002', states: ['held'] })
        .map((d) => d.id)
    ).toEqual(['d-1']);
    store.setDelivery('d-1', 'sending', 'r-000009', at);
    expect(store.getDelivery('d-1')).toMatchObject({
      state: 'sending',
      runId: 'r-000009',
    });
    expect(store.deliveries({ runId: 'r-000009' })).toHaveLength(1);
    expect(store.deliveries({ messageId: 'm-01' })).toHaveLength(2);
  });

  it('setDelivery with an expected state only moves from that state', () => {
    store.insertMessage(msg());
    store.insertDelivery({
      id: 'd-1',
      messageId: 'm-01',
      recipient: 'task:t-000002',
      runId: 'r-000002',
      via: 'direct',
      state: 'sending',
      updatedAt: at,
    });
    expect(store.setDelivery('d-1', 'answered', 'r-000002', at)).toBe(true);
    expect(store.setDelivery('d-1', 'pushed', 'r-000002', at, 'sending')).toBe(
      false
    );
    expect(store.getDelivery('d-1')?.state).toBe('answered');
    expect(store.setDelivery('d-1', 'read', 'r-000002', at, 'answered')).toBe(
      true
    );
    expect(store.getDelivery('d-1')?.state).toBe('read');
  });

  it('allows only one answer per question', () => {
    store.insertMessage(msg({ id: 'm-01', kind: 'question' }));
    store.insertMessage(
      msg({ id: 'm-02', thread: 'm-01', replyTo: 'm-01', kind: 'answer' })
    );
    expect(() =>
      store.insertMessage(
        msg({ id: 'm-03', thread: 'm-01', replyTo: 'm-01', kind: 'answer' })
      )
    ).toThrow();
    store.insertMessage(msg({ id: 'm-04', thread: 'm-01', replyTo: 'm-01' }));
    expect(store.thread('m-01')).toHaveLength(3);
  });

  it('lists answered gates until their effect is marked applied', () => {
    const gateData = {
      type: 'tool-approval',
      requestId: 'req-1',
      runId: 'r-000001',
      tool: 'Bash',
      input: {},
    };
    store.insertMessage(
      msg({
        id: 'm-01',
        kind: 'question',
        data: gateData,
        from: 'agent:dispatch',
      })
    );
    store.insertMessage(
      msg({
        id: 'm-02',
        thread: 'm-01',
        replyTo: 'm-01',
        kind: 'answer',
        choice: 'approve',
      })
    );
    store.insertMessage(
      msg({
        id: 'm-03',
        thread: 'm-03',
        kind: 'question',
        data: gateData,
        from: 'agent:dispatch',
      })
    );
    store.insertMessage(
      msg({
        id: 'm-04',
        thread: 'm-03',
        replyTo: 'm-03',
        kind: 'answer',
        data: { type: 'x-closed', reason: 'gone' },
        from: 'agent:dispatch',
      })
    );
    store.insertMessage(
      msg({
        id: 'm-05',
        thread: 'm-05',
        kind: 'question',
        data: { type: 'x-poll' },
      })
    );
    store.insertMessage(
      msg({ id: 'm-06', thread: 'm-05', replyTo: 'm-05', kind: 'answer' })
    );
    expect(
      store
        .unappliedAnsweredGates()
        .map(({ question, answer }) => [question.id, answer.id])
    ).toEqual([['m-01', 'm-02']]);
    store.markGateApplied('m-01', at);
    store.markGateApplied('m-01', at);
    expect(store.unappliedAnsweredGates()).toEqual([]);
  });

  it('lists a gate whose x-closed answer did not come from the system', () => {
    store.insertMessage(
      msg({
        id: 'm-01',
        kind: 'question',
        data: { type: 'wake', target: 'task:t-000001', message: 'm-00' },
        from: 'agent:dispatch',
      })
    );
    store.insertMessage(
      msg({
        id: 'm-02',
        thread: 'm-01',
        replyTo: 'm-01',
        kind: 'answer',
        choice: 'approve',
        data: { type: 'x-closed', reason: 'forged' },
        from: 'human:wyat',
      })
    );
    expect(
      store
        .unappliedAnsweredGates()
        .map(({ question, answer }) => [question.id, answer.id])
    ).toEqual([['m-01', 'm-02']]);
  });

  it('counts sends for quotas', () => {
    store.insertMessage(msg({ id: 'm-01', urgent: true }));
    store.insertMessage(
      msg({
        id: 'm-02',
        thread: 'm-01',
        urgent: false,
        createdAt: '2026-09-23T10:30:00.000Z',
      })
    );
    store.insertMessage(
      msg({ id: 'm-03', thread: 'm-01', from: 'agent:dispatch' })
    );
    expect(
      store.countFrom('run:r-000001', '2026-09-23T09:00:00.000Z', true)
    ).toBe(1);
    expect(
      store.countFrom('run:r-000001', '2026-09-23T10:15:00.000Z', false)
    ).toBe(1);
    expect(
      store.countAgentAuthored(
        'm-01',
        '2026-09-23T09:00:00.000Z',
        'agent:dispatch'
      )
    ).toBe(2);
  });

  it('rolls back a failed transaction', () => {
    expect(() =>
      store.transaction(() => {
        store.insertMessage(msg());
        throw new Error('boom');
      })
    ).toThrow('boom');
    expect(store.getMessage('m-01')).toBeNull();
  });

  it('manages channels and members', () => {
    store.ensureChannel('auth', at, false);
    store.ensureChannel('auth', at, false);
    store.addMember('auth', 'task:t-000001', at);
    store.addMember('auth', 'task:t-000001', at);
    expect(store.members('auth')).toEqual(['task:t-000001']);
    expect(store.channelsOf('task:t-000001')).toEqual(['auth']);
    expect(store.removeMember('auth', 'task:t-000001')).toBe(true);
    expect(store.removeMember('auth', 'task:t-000001')).toBe(false);
    expect(store.channels()).toEqual([
      { name: 'auth', createdAt: at, auto: false },
    ]);
  });

  it('stores agents and finds them by token hash', () => {
    const agent = {
      address: 'agent:wyat/claude-code.macbook',
      displayName: 'claude-code.macbook',
      client: 'claude-code 2.1',
      tokenHash: 'h1',
      status: 'pending' as const,
      muted: false,
      approvedBy: null,
      createdAt: at,
    };
    store.putAgent(agent);
    expect(store.agentByTokenHash('h1')).toEqual(agent);
    store.putAgent({ ...agent, status: 'approved', approvedBy: 'human:wyat' });
    expect(store.getAgent(agent.address)?.status).toBe('approved');
    expect(store.agents()).toHaveLength(1);
  });

  it('lists recent threads by their last message, with root and count', () => {
    store.insertMessage(msg({ id: 'm-01', thread: 'm-01' }));
    store.insertMessage(
      msg({ id: 'm-02', thread: 'm-01', replyTo: 'm-01', from: 'human:wyat' })
    );
    store.insertMessage(msg({ id: 'm-03', thread: 'm-03' }));

    const threads = store.recentThreads(10);
    expect(threads).toEqual([
      {
        thread: 'm-03',
        root: store.getMessage('m-03')!,
        last: store.getMessage('m-03')!,
        count: 1,
      },
      {
        thread: 'm-01',
        root: store.getMessage('m-01')!,
        last: store.getMessage('m-02')!,
        count: 2,
      },
    ]);
  });

  it('caps recentThreads at the given limit, newest thread first', () => {
    store.insertMessage(msg({ id: 'm-01', thread: 'm-01' }));
    store.insertMessage(msg({ id: 'm-02', thread: 'm-02' }));
    store.insertMessage(msg({ id: 'm-03', thread: 'm-03' }));

    expect(store.recentThreads(1).map((t) => t.thread)).toEqual(['m-03']);
  });

  it('narrows recentThreads to threads a set of addresses took part in', () => {
    store.insertMessage(
      msg({
        id: 'm-01',
        thread: 'm-01',
        from: 'run:r-000001',
        to: ['human:wyat'],
      })
    );
    store.insertMessage(
      msg({
        id: 'm-02',
        thread: 'm-02',
        from: 'human:wyat',
        to: ['task:t-000002'],
      })
    );
    store.insertMessage(
      msg({
        id: 'm-03',
        thread: 'm-03',
        from: 'human:wyat',
        to: ['channel:general'],
      })
    );
    store.insertDelivery({
      id: 'd-03',
      messageId: 'm-03',
      recipient: 'task:t-000002',
      runId: null,
      via: 'channel',
      state: 'held',
      updatedAt: at,
    });
    store.insertMessage(
      msg({
        id: 'm-04',
        thread: 'm-04',
        from: 'human:wyat',
        to: ['agent:wyat/x'],
      })
    );
    store.insertMessage(
      msg({
        id: 'm-05',
        thread: 'm-05',
        from: 'human:wyat',
        to: ['task:t-000009'],
      })
    );
    store.insertDelivery({
      id: 'd-05',
      messageId: 'm-05',
      recipient: 'task:t-000009',
      runId: 'r-000001',
      via: 'direct',
      state: 'pushed',
      updatedAt: at,
    });

    expect(
      store
        .recentThreads(10, ['task:t-000002', 'run:r-000001'])
        .map((t) => t.thread)
    ).toEqual(['m-05', 'm-03', 'm-02', 'm-01']);
    expect(store.recentThreads(10, [])).toEqual([]);
    expect(store.recentThreads(10).map((t) => t.thread)).toEqual([
      'm-05',
      'm-04',
      'm-03',
      'm-02',
      'm-01',
    ]);
  });

  it('looks a recipient address up by index, so narrowing threads scans no whole table', () => {
    const plan = queryAll<{ detail: string }>(
      db,
      'EXPLAIN QUERY PLAN SELECT message_id FROM recipients WHERE addr = ?',
      ['task:t-000002']
    );
    expect(plan.map((row) => row.detail).join('\n')).toContain(
      'INDEX recipients_addr'
    );
  });

  it('refuses a messages.db written by a newer schema', () => {
    const dir = mkdtempSync(join(tmpdir(), 'msgdb-'));
    try {
      const path = join(dir, 'messages.db');
      const first = openMessagesDb(path);
      first.exec('PRAGMA user_version = 99');
      first.close();
      expect(() => openMessagesDb(path)).toThrow(/newer schema/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
