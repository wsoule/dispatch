import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { CommentStorePort } from '../src/comments.js';
import { FileCommentStore, SqliteCommentStore } from '../src/commentStore.js';
import { openDispatchDb } from '../src/sqliteDb.js';

const TASK = 't-abc123';

function exercise(store: CommentStorePort): void {
  const first = store.add(
    { taskId: TASK, author: 'human:wyat', body: 'first' },
    '2026-01-01T00:00:00.000Z'
  );
  expect(first.id).toMatch(/^c-[0-9a-f]{8}$/);
  expect(first.updated).toBe(first.created);
  const reply = store.add(
    { taskId: TASK, author: 'agent', body: 'reply', parentId: first.id },
    '2026-01-02T00:00:00.000Z'
  );
  const nested = store.add(
    { taskId: TASK, author: 'human:ada', body: 'nested', parentId: reply.id },
    '2026-01-03T00:00:00.000Z'
  );
  const other = store.add(
    { taskId: TASK, author: 'human:ada', body: 'other', external: 'linear:x' },
    '2026-01-04T00:00:00.000Z'
  );
  expect(store.list(TASK).map((c) => c.body)).toEqual([
    'first',
    'reply',
    'nested',
    'other',
  ]);
  expect(store.list('t-ffffff')).toEqual([]);

  const edited = store.update(
    TASK,
    first.id,
    { body: 'first, edited' },
    '2026-02-01T00:00:00.000Z'
  );
  expect(edited).toMatchObject({
    body: 'first, edited',
    created: '2026-01-01T00:00:00.000Z',
    updated: '2026-02-01T00:00:00.000Z',
  });
  expect(store.get(TASK, first.id)).toEqual(edited);
  expect(() => store.update(TASK, 'c-00000000', { body: 'x' })).toThrow();

  // Deleting a comment takes its whole reply subtree, nothing else.
  expect(store.remove(TASK, first.id).sort()).toEqual(
    [first.id, reply.id, nested.id].sort()
  );
  expect(store.list(TASK)).toEqual([other]);
  expect(store.remove(TASK, first.id)).toEqual([]);
}

describe('comment stores', () => {
  it('file backend: CRUD and threads, one JSONL file per task', () => {
    const root = mkdtempSync(join(tmpdir(), 'dispatch-comments-'));
    const store = new FileCommentStore(root);
    exercise(store);
    const file = join(root, '.dispatch', 'comments', `${TASK}.jsonl`);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(1);
    store.remove(TASK, store.list(TASK)[0].id);
    expect(existsSync(file)).toBe(false);
    expect(() => store.list('../../etc')).toThrow();
  });

  it('sqlite backend: CRUD and threads', () => {
    const db = openDispatchDb(':memory:');
    exercise(new SqliteCommentStore(db));
    db.close();
  });
});
