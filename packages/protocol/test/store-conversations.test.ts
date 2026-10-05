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

const at = '2026-10-05T10:00:00.000Z';
function msg(over: Partial<Message> & { id: string }): Message {
  return {
    thread: over.id,
    replyTo: null,
    from: 'human:wyat',
    to: ['human:sam'],
    kind: 'message',
    body: 'hi',
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: at,
    ...over,
  };
}

const ids = (messages: Message[]) => messages.map((m) => m.id);

describe('message_refs', () => {
  it('indexes each ref on insert', () => {
    store.insertMessage(
      msg({
        id: 'm-01',
        refs: [
          { type: 'doc', id: 'd-1' },
          { type: 'file', id: 'a.ts', at: 'abc' },
        ],
      })
    );
    expect(
      queryAll<{ message_id: string; type: string; ref_id: string }>(
        db,
        'SELECT message_id, type, ref_id FROM message_refs ORDER BY type'
      )
    ).toEqual([
      { message_id: 'm-01', type: 'doc', ref_id: 'd-1' },
      { message_id: 'm-01', type: 'file', ref_id: 'a.ts' },
    ]);
  });

  it('backfills rows written before the index existed, once', () => {
    const dir = mkdtempSync(join(tmpdir(), 'message-refs-'));
    try {
      const path = join(dir, 'messages.db');
      const first = openMessagesDb(path);
      new SqliteMessageStore(first).insertMessage(
        msg({ id: 'm-01', refs: [{ type: 'doc', id: 'd-1' }] })
      );
      // As an older build left it: no index table.
      first.exec('DROP TABLE message_refs');
      first.close();
      const again = openMessagesDb(path);
      const reopened = new SqliteMessageStore(again);
      expect(
        ids(reopened.conversation({ kind: 'ref', type: 'doc', id: 'd-1' }, {}))
      ).toEqual(['m-01']);
      again.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('conversation', () => {
  it('pages a pair newest first with before', () => {
    store.insertMessage(msg({ id: 'm-01' }));
    store.insertMessage(
      msg({ id: 'm-02', from: 'human:sam', to: ['human:wyat'] })
    );
    store.insertMessage(msg({ id: 'm-03', to: ['human:other'] }));
    store.insertMessage(
      msg({ id: 'm-04', from: 'human:carl', to: ['human:wyat', 'human:sam'] })
    );
    const pair = { kind: 'pair', a: 'human:wyat', b: 'human:sam' } as const;
    expect(ids(store.conversation(pair, { limit: 10 }))).toEqual([
      'm-04',
      'm-02',
      'm-01',
    ]);
    expect(ids(store.conversation(pair, { before: 'm-04', limit: 1 }))).toEqual(
      ['m-02']
    );
  });

  it('finds every message in a thread about an address', () => {
    store.insertMessage(msg({ id: 'm-01', to: ['task:t-1'] }));
    store.insertMessage(
      msg({
        id: 'm-02',
        thread: 'm-01',
        replyTo: 'm-01',
        from: 'human:sam',
        to: ['human:wyat'],
      })
    );
    store.insertMessage(msg({ id: 'm-03', to: ['task:t-2'] }));
    store.insertMessage(msg({ id: 'm-04', to: ['channel:release'] }));
    expect(
      ids(store.conversation({ kind: 'about', addresses: ['task:t-1'] }, {}))
    ).toEqual(['m-02', 'm-01']);
    expect(
      ids(
        store.conversation(
          { kind: 'about', addresses: ['channel:release'] },
          {}
        )
      )
    ).toEqual(['m-04']);
  });

  it('finds the threads that reference a doc', () => {
    store.insertMessage(
      msg({ id: 'm-01', refs: [{ type: 'doc', id: 'd-1' }] })
    );
    store.insertMessage(
      msg({ id: 'm-02', thread: 'm-01', replyTo: 'm-01', from: 'human:sam' })
    );
    store.insertMessage(
      msg({ id: 'm-03', refs: [{ type: 'doc', id: 'd-2' }] })
    );
    expect(
      ids(store.conversation({ kind: 'ref', type: 'doc', id: 'd-1' }, {}))
    ).toEqual(['m-02', 'm-01']);
  });

  it('lists only roots when asked', () => {
    store.insertMessage(msg({ id: 'm-01' }));
    store.insertMessage(
      msg({ id: 'm-02', thread: 'm-01', replyTo: 'm-01', from: 'human:sam' })
    );
    store.insertMessage(msg({ id: 'm-03' }));
    const pair = { kind: 'pair', a: 'human:wyat', b: 'human:sam' } as const;
    expect(ids(store.conversation(pair, { rootsOnly: true }))).toEqual([
      'm-03',
      'm-01',
    ]);
  });
});
