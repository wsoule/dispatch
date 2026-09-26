import type { SqliteDatabase } from '@dispatch/core';
import { dbVersion, openSqliteDb, queryAll } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Message } from '../src/envelope.js';
import { openMessagesDb, SqliteMessageStore } from '../src/sqliteStore.js';

// The messages table as the shipped v1 schema created it.
const V1_MESSAGES_DDL =
  'CREATE TABLE messages (id TEXT PRIMARY KEY, thread TEXT NOT NULL, reply_to TEXT, from_addr TEXT NOT NULL, session TEXT, kind TEXT NOT NULL, body TEXT NOT NULL, refs_json TEXT NOT NULL, data_json TEXT, urgent INTEGER NOT NULL, blocking INTEGER NOT NULL, choices_json TEXT, choice TEXT, wake TEXT NOT NULL, created_at TEXT NOT NULL)';
// A v1 build's insert: named columns, no idem_key.
const V1_INSERT =
  'INSERT INTO messages (id, thread, reply_to, from_addr, session, kind, body, refs_json, data_json, urgent, blocking, choices_json, choice, wake, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)';

function msg(
  id: string,
  from: string,
  kind: Message['kind'],
  createdAt: string
): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from,
    to: ['human:wyat'],
    kind,
    body: id,
    refs: [],
    urgent: false,
    blocking: kind === 'question',
    wake: 'none',
    createdAt,
  };
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'msg-store-reads-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the idem_key column', () => {
  it('is added to a v1 file without bumping user_version, and reopening is a no-op', () => {
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
    expect(columns).toContain('idem_key');
    expect(dbVersion(db)).toBe(1);
    db.close();
    openMessagesDb(path).close();
  });

  it('accepts a v1 build writing into a migrated file', () => {
    const db = openMessagesDb(join(dir, 'messages.db'));
    const row = [
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
      '2026-09-25T00:00:00.000Z',
    ] as const;
    db.prepare(V1_INSERT).run('m-01', 'm-01', null, ...row);
    db.prepare(V1_INSERT).run('m-02', 'm-02', null, ...row);
    expect(new SqliteMessageStore(db).getMessage('m-02')?.body).toBe('hi');
    db.close();
  });
});

describe('store reads', () => {
  let db: SqliteDatabase;
  let store: SqliteMessageStore;
  beforeEach(() => {
    db = openMessagesDb(':memory:');
    store = new SqliteMessageStore(db);
  });
  afterEach(() => db.close());

  it('finds a message by sender and key', () => {
    store.insertMessage(
      msg('m-1', 'agent:wyat/a2a.acme', 'question', '2026-09-25T10:00:00.000Z'),
      'client-1'
    );
    expect(store.byIdemKey('agent:wyat/a2a.acme', 'client-1')?.id).toBe('m-1');
    expect(store.byIdemKey('agent:wyat/a2a.other', 'client-1')).toBeNull();
  });

  it('maps ids to their keys and skips keyless messages', () => {
    store.insertMessage(
      msg('m-1', 'agent:wyat/a2a.acme', 'question', '2026-09-25T10:00:00.000Z'),
      'client-1'
    );
    store.insertMessage(
      msg('m-2', 'human:wyat', 'answer', '2026-09-25T10:01:00.000Z')
    );
    expect([...store.idemKeysFor(['m-1', 'm-2', 'm-3'])]).toEqual([
      ['m-1', 'client-1'],
    ]);
  });

  it('lists a sender’s messages since a time, optionally by kind', () => {
    const from = 'agent:wyat/a2a.acme';
    store.insertMessage(
      msg('m-1', from, 'question', '2026-09-25T09:00:00.000Z'),
      'a'
    );
    store.insertMessage(
      msg('m-2', from, 'message', '2026-09-25T10:00:00.000Z'),
      'b'
    );
    store.insertMessage(
      msg('m-3', from, 'handoff', '2026-09-25T11:00:00.000Z'),
      'c'
    );
    expect(
      store.messagesFrom(from, '2026-09-25T09:30:00.000Z').map((m) => m.id)
    ).toEqual(['m-2', 'm-3']);
    expect(
      store
        .messagesFrom(from, '2026-09-25T00:00:00.000Z', ['question', 'handoff'])
        .map((m) => m.id)
    ).toEqual(['m-1', 'm-3']);
  });
});
