import type { SqliteDatabase } from '@dispatch/core';
import { dbVersion, openSqliteDb, queryAll } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';

// messages as the shipped v1 schema created it.
const V1_MESSAGES_DDL =
  'CREATE TABLE messages (id TEXT PRIMARY KEY, thread TEXT NOT NULL, reply_to TEXT, from_addr TEXT NOT NULL, session TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, refs_json TEXT NOT NULL, data_json TEXT, urgent INTEGER NOT NULL, blocking INTEGER NOT NULL, choices_json TEXT, choice TEXT, wake TEXT NOT NULL, created_at TEXT NOT NULL)';
// v1's insert: named columns, none of the federation ones.
const V1_INSERT =
  'INSERT INTO messages (id, thread, reply_to, from_addr, session, kind, body, refs_json, data_json, urgent, blocking, choices_json, choice, wake, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';
const BOB = 'bob-0000000b';

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'human:wyat',
    to: ['human:ada'],
    kind: 'message',
    body: id,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-26T10:00:00.000Z',
    ...over,
  };
}
const hlc = (ms: number, counter = 0, replica = BOB) =>
  `${String(ms).padStart(13, '0')}.${String(counter).padStart(4, '0')}.${replica}`;

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'msg-fed-store-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the federation schema is additive', () => {
  it('adds columns and tables to a v1 file without bumping user_version', () => {
    const path = join(dir, 'messages.db');
    const raw = openSqliteDb(path);
    raw.exec(V1_MESSAGES_DDL);
    raw.exec('PRAGMA user_version = 1');
    raw.close();
    const db = openMessagesDb(path);
    const columns = queryAll<{ name: string }>(
      db,
      'PRAGMA table_info(messages)'
    ).map((c) => c.name);
    for (const c of ['origin', 'hlc', 'received_at', 'settled_as', 'idem_key'])
      expect(columns).toContain(c);
    const tables = queryAll<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type IN ('table','index')"
    ).map((t) => t.name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'remote_deliveries',
        'settlements',
        'early_settlements',
        'messages_thread_hlc',
      ])
    );
    expect(dbVersion(db)).toBe(1);
    db.close();
    openMessagesDb(path).close();
  });

  it("keeps an older build's named-column insert working, with the new columns NULL", () => {
    const db = openMessagesDb(join(dir, 'messages.db'));
    db.prepare(V1_INSERT).run(
      'm-01',
      'm-01',
      null,
      'human:wyat',
      null,
      'message',
      'hi',
      '[]',
      null,
      0,
      0,
      null,
      null,
      'none',
      '2026-09-26T10:00:00.000Z'
    );
    const m = new SqliteMessageStore(db).getMessage('m-01');
    expect(m?.origin).toBeUndefined();
    expect(m?.hlc).toBeUndefined();
    db.close();
  });
});

describe('stored federation fields', () => {
  let db: SqliteDatabase;
  let store: SqliteMessageStore;
  beforeEach(() => {
    db = openMessagesDb(':memory:');
    store = new SqliteMessageStore(db);
  });
  afterEach(() => db.close());

  it('round-trips origin and hlc, and leaves both off local messages', () => {
    store.insertMessage(
      msg('m-01', { origin: BOB, hlc: hlc(1000) }),
      undefined,
      {
        receivedAt: '2026-09-26T10:00:05.000Z',
      }
    );
    store.insertMessage(msg('m-02'));
    expect(store.getMessage('m-01')).toMatchObject({
      origin: BOB,
      hlc: hlc(1000),
    });
    expect('origin' in (store.getMessage('m-02') ?? {})).toBe(false);
  });

  it('orders a thread by hlc, with pre-federation rows first, whatever the ids say', () => {
    store.insertMessage(msg('m-05'));
    store.insertMessage(
      msg('m-01', {
        thread: 'm-05',
        replyTo: 'm-05',
        origin: BOB,
        hlc: hlc(500),
      })
    );
    store.insertMessage(
      msg('m-09', {
        thread: 'm-05',
        replyTo: 'm-05',
        hlc: hlc(400, 0, 'wyat-0000000a'),
      })
    );
    expect(store.thread('m-05').map((m) => m.id)).toEqual([
      'm-05',
      'm-09',
      'm-01',
    ]);
  });

  it('counts quotas by arrival, so a backdated remote message still counts', () => {
    store.insertMessage(
      msg('m-01', {
        from: 'run:r-00000000000a',
        urgent: true,
        createdAt: '2026-09-26T08:00:00.000Z',
        origin: BOB,
        hlc: hlc(1),
      }),
      undefined,
      { receivedAt: '2026-09-26T11:59:00.000Z' }
    );
    expect(
      store.countFrom('run:r-00000000000a', '2026-09-26T11:00:00.000Z', true)
    ).toBe(1);
  });

  it("counts one origin's agent:dispatch apart from the local system and other replicas", () => {
    const at = { receivedAt: '2026-09-26T11:59:00.000Z' };
    store.insertMessage(
      msg('m-01', {
        from: 'agent:dispatch',
        kind: 'notice',
        urgent: true,
        createdAt: '2026-09-26T11:58:00.000Z',
      })
    );
    store.insertMessage(
      msg('m-02', {
        from: 'agent:dispatch',
        kind: 'notice',
        urgent: true,
        origin: BOB,
        hlc: hlc(1),
      }),
      undefined,
      at
    );
    store.insertMessage(
      msg('m-03', {
        from: 'agent:dispatch',
        kind: 'notice',
        urgent: true,
        origin: 'cy-0000000c',
        hlc: hlc(2, 0, 'cy-0000000c'),
      }),
      undefined,
      at
    );
    expect(
      store.countFrom('agent:dispatch', '2026-09-26T11:00:00.000Z', true, BOB)
    ).toBe(1);
    expect(
      store.countFrom('agent:dispatch', '2026-09-26T11:00:00.000Z', true)
    ).toBe(3);
  });

  it('counts a remote agent:dispatch as agent-authored and the local one not', () => {
    store.insertMessage(msg('m-01'));
    store.insertMessage(
      msg('m-02', {
        thread: 'm-01',
        replyTo: 'm-01',
        from: 'agent:dispatch',
        kind: 'notice',
        origin: BOB,
        hlc: hlc(2),
      }),
      undefined,
      { receivedAt: '2026-09-26T10:00:00.000Z' }
    );
    store.insertMessage(
      msg('m-03', {
        thread: 'm-01',
        replyTo: 'm-01',
        from: 'agent:dispatch',
        kind: 'notice',
      })
    );
    expect(
      store.countAgentAuthored(
        'm-01',
        '2026-09-26T09:00:00.000Z',
        'agent:dispatch'
      )
    ).toBe(1);
  });

  it('lists recent threads by arrival and reads the root by thread id despite a skewed reply', () => {
    store.insertMessage(msg('m-10'));
    store.insertMessage(msg('m-20'));
    // Bob's clock is behind, so his reply's ulid sorts before the root.
    store.insertMessage(
      msg('m-05', {
        thread: 'm-10',
        replyTo: 'm-10',
        origin: BOB,
        hlc: hlc(9),
      })
    );
    const recent = store.recentThreads(10);
    expect(recent.map((t) => t.thread)).toEqual(['m-10', 'm-20']);
    expect(recent[0]?.root.id).toBe('m-10');
    expect(recent[0]?.last.id).toBe('m-05');
  });

  it('falls back to the earliest stored row when the root never reached this replica', () => {
    store.insertMessage(
      msg('m-31', {
        thread: 'm-29',
        replyTo: 'm-30',
        origin: BOB,
        hlc: hlc(3),
      })
    );
    expect(store.recentThreads(10)[0]?.root.id).toBe('m-31');
  });

  it('keeps remote rows apart from deliveries, with compare-and-set and refused_by', () => {
    store.insertMessage(msg('m-01'));
    const row = {
      messageId: 'm-01',
      recipient: 'human:bob',
      via: 'direct' as const,
      state: 'forwarded' as const,
      homes: [BOB],
      wakeAt: null,
      refusedBy: [],
      updatedAt: '2026-09-26T10:00:00.000Z',
    };
    expect(store.insertRemote(row)).toBe(true);
    expect(store.insertRemote(row)).toBe(false);
    expect(store.deliveries({ messageId: 'm-01' })).toEqual([]);
    expect(
      store.setRemote(
        'm-01',
        'human:bob',
        { state: 'read' },
        '2026-09-26T10:01:00.000Z',
        'pushed'
      )
    ).toBe(false);
    expect(
      store.setRemote(
        'm-01',
        'human:bob',
        { state: 'refused', refusedBy: [BOB] },
        '2026-09-26T10:01:00.000Z',
        'forwarded'
      )
    ).toBe(true);
    expect(store.remoteDeliveries({ recipient: 'human:bob' })[0]).toMatchObject(
      { state: 'refused', refusedBy: [BOB], homes: [BOB] }
    );
    expect(store.deleteRemote('m-01', 'human:bob')).toBe(true);
  });

  it('swaps settled answers without tripping the one-answer index', () => {
    store.insertMessage(
      msg('m-q', {
        kind: 'question',
        blocking: true,
        origin: BOB,
        hlc: hlc(1),
      })
    );
    store.insertMessage(
      msg('m-a1', { thread: 'm-q', replyTo: 'm-q', kind: 'answer' }),
      undefined,
      { settledAs: 'pending' }
    );
    store.insertMessage(
      msg('m-a2', {
        thread: 'm-q',
        replyTo: 'm-q',
        kind: 'message',
        origin: 'cy-0000000c',
        hlc: hlc(2),
      }),
      undefined,
      { settledAs: 'candidate' }
    );
    store.transaction(() => {
      store.setSettled('m-a1', 'message', 'superseded');
      store.setSettled('m-a2', 'answer', 'accepted');
    });
    expect(store.answersTo('m-q').map((m) => m.id)).toEqual(['m-a2']);
    expect(
      store.answerCandidates('m-q').map((c) => [c.message.id, c.settledAs])
    ).toEqual([
      ['m-a1', 'superseded'],
      ['m-a2', 'accepted'],
    ]);
    store.putSettlement({
      questionId: 'm-q',
      answerId: 'm-a2',
      closedReason: null,
      settler: BOB,
      at: '2026-09-26T10:02:00.000Z',
    });
    expect(store.settlement('m-q')?.answerId).toBe('m-a2');
  });

  it('keeps early settles per publisher, apart from settlements', () => {
    const at = '2026-09-26T10:02:00.000Z';
    store.putEarlySettlement({
      questionId: 'm-qx',
      answerId: 'm-ax',
      closedReason: null,
      settler: 'cy-0000000c',
      at,
    });
    store.putEarlySettlement({
      questionId: 'm-qx',
      answerId: 'm-ay',
      closedReason: null,
      settler: BOB,
      at,
    });
    expect(
      store
        .earlySettlements('m-qx')
        .map((s) => s.settler)
        .sort()
    ).toEqual([BOB, 'cy-0000000c']);
    expect(store.settlement('m-qx')).toBeNull();
    store.clearEarlySettlements('m-qx');
    expect(store.earlySettlements('m-qx')).toEqual([]);
  });

  it('scans local messages after a rowid watermark', () => {
    store.insertMessage(msg('m-01'));
    store.insertMessage(msg('m-02', { origin: BOB, hlc: hlc(1) }));
    store.insertMessage(msg('m-03'));
    expect(store.messagesAfter(0, 10).map((r) => r.message.id)).toEqual([
      'm-01',
      'm-03',
    ]);
    const [, third] = store.messagesAfter(0, 10);
    expect(store.messagesAfter(third?.rowid ?? 0, 10)).toEqual([]);
    expect(store.maxRowid()).toBe(3);
  });
});
