import { openSqliteDb } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openA2ADb, SqliteA2AStore } from '../src/store/sqlite.js';
import type { TaskRow } from '../src/store/sqlite.js';

const CLIENT = 'agent:wyat/a2a.acme';
let dir: string;
let store: SqliteA2AStore;

function row(id: string, over: Partial<TaskRow> = {}): TaskRow {
  return {
    id,
    client: CLIENT,
    contextId: id,
    skill: 'ask',
    dispatchTask: null,
    gate: null,
    state: 'WORKING',
    statusAt: '2026-09-25T10:00:00.000Z',
    canceledAt: null,
    declinedAt: null,
    createdAt: '2026-09-25T09:00:00.000Z',
    ...over,
  };
}

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'a2a-store-')));
  store = new SqliteA2AStore(openA2ADb(join(dir, 'a2a.db')));
});
afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('openA2ADb', () => {
  it('creates the file with mode 0600', () => {
    expect(statSync(join(dir, 'a2a.db')).mode & 0o777).toBe(0o600);
  });

  it('refuses a file written by a newer schema', () => {
    const path = join(dir, 'newer.db');
    const raw = openSqliteDb(path);
    raw.exec('PRAGMA user_version = 99');
    raw.close();
    expect(() => openA2ADb(path)).toThrow(/newer schema/);
  });
});

describe('SqliteA2AStore', () => {
  it('stores clients with their recipients', () => {
    store.putClient({
      address: CLIENT,
      name: 'a2a.acme',
      recipients: ['human:wyat', 'human:alice'],
      createdBy: 'human:wyat',
      createdAt: '2026-09-25T09:00:00.000Z',
    });
    expect(store.getClient(CLIENT)?.recipients).toEqual([
      'human:wyat',
      'human:alice',
    ]);
    expect(store.clients()).toHaveLength(1);
  });

  it('inserts a task once and patches it', () => {
    expect(store.insertTask(row('m-1'))).toBe(true);
    expect(store.insertTask(row('m-1'))).toBe(false);
    store.updateTask('m-1', {
      state: 'COMPLETED',
      statusAt: '2026-09-25T11:00:00.000Z',
    });
    expect(store.getTask('m-1')).toMatchObject({
      state: 'COMPLETED',
      statusAt: '2026-09-25T11:00:00.000Z',
    });
  });

  it('clears a column on null and leaves an undefined field alone', () => {
    store.insertTask(row('m-1', { gate: 'm-gate', dispatchTask: 't-a1b2c3' }));
    store.updateTask('m-1', { gate: null, state: undefined });
    expect(store.getTask('m-1')).toMatchObject({
      gate: null,
      dispatchTask: 't-a1b2c3',
      state: 'WORKING',
    });
  });

  it('counts open tasks, recent tasks by skill, and the newest', () => {
    store.insertTask(row('m-1'));
    store.insertTask(
      row('m-2', { state: 'COMPLETED', createdAt: '2026-09-25T09:30:00.000Z' })
    );
    store.insertTask(
      row('m-3', {
        skill: 'handoff',
        dispatchTask: 't-a1b2c3',
        createdAt: '2026-09-25T09:45:00.000Z',
      })
    );
    expect(store.countOpen(CLIENT)).toBe(2);
    expect(
      store.countSince(CLIENT, 'handoff', '2026-09-25T09:40:00.000Z')
    ).toBe(1);
    expect(store.newestTaskAt(CLIENT)).toBe('2026-09-25T09:45:00.000Z');
    expect(
      store
        .openTasks()
        .map((t) => t.id)
        .sort()
    ).toEqual(['m-1', 'm-3']);
    expect(store.taskForDispatchTask('t-a1b2c3')?.id).toBe('m-3');
  });

  it('filters by context, state and a later status time', () => {
    store.insertTask(
      row('m-1', { contextId: 'c-a', statusAt: '2026-09-25T10:00:00.000Z' })
    );
    store.insertTask(
      row('m-2', {
        contextId: 'c-b',
        statusAt: '2026-09-25T12:00:00.000Z',
        state: 'COMPLETED',
      })
    );
    expect(
      store
        .listTasks({ client: CLIENT, contextId: 'c-a', limit: 10 })
        .rows.map((r) => r.id)
    ).toEqual(['m-1']);
    expect(
      store
        .listTasks({ client: CLIENT, state: 'COMPLETED', limit: 10 })
        .rows.map((r) => r.id)
    ).toEqual(['m-2']);
    expect(
      store.listTasks({
        client: CLIENT,
        after: '2026-09-25T11:00:00.000Z',
        limit: 10,
      }).total
    ).toBe(1);
  });

  it('never lists another client’s tasks', () => {
    store.insertTask(row('m-1', { client: 'agent:wyat/a2a.other' }));
    expect(store.listTasks({ client: CLIENT, limit: 10 })).toEqual({
      rows: [],
      total: 0,
    });
  });

  // Reconciling at boot rewrites many rows with one status_at.
  it('pages through tasks that share one status_at, each exactly once', () => {
    for (const id of ['m-a', 'm-b', 'm-c', 'm-d', 'm-e']) {
      store.insertTask(row(id));
    }
    const seen: string[] = [];
    let cursor: { statusAt: string; id: string } | undefined;
    for (let page = 0; page < 10; page++) {
      const { rows, total } = store.listTasks({
        client: CLIENT,
        limit: 2,
        cursor,
      });
      expect(total).toBe(5);
      seen.push(...rows.map((r) => r.id));
      if (rows.length < 2) break;
      const last = rows[rows.length - 1];
      cursor = { statusAt: last.statusAt, id: last.id };
    }
    expect(seen).toEqual(['m-e', 'm-d', 'm-c', 'm-b', 'm-a']);
  });
});
