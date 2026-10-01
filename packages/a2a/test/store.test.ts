import { openSqliteDb } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openA2ADb, SqliteA2AStore } from '../src/store/sqlite.js';
import type {
  HostRow,
  OutboundRow,
  PeerRow,
  PushConfigRow,
  TaskRow,
} from '../src/store/sqlite.js';

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

function peer(alias: string, over: Partial<PeerRow> = {}): PeerRow {
  return {
    alias,
    cardUrl: 'https://agent.example.com/.well-known/agent-card.json',
    interfaceUrl: 'https://agent.example.com/a2a/v1',
    binding: 'HTTP+JSON',
    cardJson: '{"name":"Acme"}',
    etag: '"v1"',
    fetchedAt: '2026-09-25T10:00:00.000Z',
    status: 'active',
    addedBy: 'human:wyat',
    addedTier: 'decide',
    allowHttp: false,
    allowOrigin: false,
    apiKeyHeader: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

describe('peers', () => {
  it('stores, updates, lists and deletes peers', () => {
    store.putPeer(peer('beta'));
    store.putPeer(peer('acme', { allowHttp: true, apiKeyHeader: 'X-API-Key' }));
    expect(store.peers().map((p) => p.alias)).toEqual(['acme', 'beta']);
    expect(store.getPeer('acme')).toMatchObject({
      allowHttp: true,
      allowOrigin: false,
      apiKeyHeader: 'X-API-Key',
    });
    store.setPeerStatus('acme', 'auth-failed');
    expect(store.getPeer('acme')?.status).toBe('auth-failed');
    store.putPeer({ ...peer('acme'), etag: '"v2"' });
    expect(store.getPeer('acme')?.etag).toBe('"v2"');
    expect(store.deletePeer('acme')).toBe(true);
    expect(store.deletePeer('acme')).toBe(false);
    expect(store.getPeer('acme')).toBeNull();
  });

  it('keeps who added a peer, and at which tier, across an upsert', () => {
    store.putPeer(peer('acme', { addedTier: 'operator' }));
    store.putPeer(peer('acme', { addedBy: 'human:eve', addedTier: 'decide' }));
    expect(store.getPeer('acme')).toMatchObject({
      addedBy: 'human:wyat',
      addedTier: 'operator',
    });
  });
});

function outbound(
  messageId: string,
  over: Partial<OutboundRow> = {}
): OutboundRow {
  return {
    messageId,
    alias: 'acme',
    thread: 'm-thread',
    remoteTaskId: null,
    remoteContextId: null,
    state: 'queued',
    attempts: 0,
    firstAttemptAt: '2026-09-25T10:00:00.000Z',
    nextAttemptAt: null,
    lastError: null,
    updatedAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

describe('outbound', () => {
  it('upserts rows by message and alias, and lists them by state', () => {
    store.putOutbound(outbound('m-1'));
    store.putOutbound(
      outbound('m-1', {
        state: 'open',
        remoteTaskId: 'pt-1',
        remoteContextId: 'pc-1',
        attempts: 1,
      })
    );
    store.putOutbound(outbound('m-1', { alias: 'beta' }));
    expect(store.getOutbound('m-1', 'acme')).toMatchObject({
      state: 'open',
      remoteTaskId: 'pt-1',
      attempts: 1,
    });
    expect(store.outboundIn(['open']).map((r) => r.alias)).toEqual(['acme']);
    expect(store.outboundOf('beta', ['queued'])).toHaveLength(1);
    expect(store.outboundIn([])).toEqual([]);
  });

  it('finds the peer’s context for a thread and counts relays per peer since a time', () => {
    store.putOutbound(
      outbound('m-1', {
        state: 'done',
        remoteContextId: 'pc-old',
        updatedAt: '2026-09-25T10:00:00.000Z',
      })
    );
    store.putOutbound(
      outbound('m-2', {
        state: 'open',
        remoteContextId: 'pc-new',
        updatedAt: '2026-09-25T11:00:00.000Z',
        firstAttemptAt: '2026-09-25T11:00:00.000Z',
      })
    );
    store.putOutbound(
      outbound('m-3', {
        state: 'queued',
        firstAttemptAt: '2026-09-25T11:30:00.000Z',
      })
    );
    expect(store.contextFor('acme', 'm-thread')).toBe('pc-new');
    expect(store.contextFor('acme', 'm-other')).toBeNull();
    expect(store.relayedSince('acme', '2026-09-25T10:30:00.000Z')).toBe(1);
  });
});

function push(id: string, over: Partial<PushConfigRow> = {}): PushConfigRow {
  return {
    id,
    taskId: 'm-1',
    client: CLIENT,
    url: 'https://hooks.example.com/a2a',
    token: 'tok',
    authScheme: 'Bearer',
    authCredentials: 'cred',
    failures: 0,
    disabledAt: null,
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

describe('push_configs of a client', () => {
  it('deletes every config of one client', () => {
    store.putPushConfig(push('a'));
    store.putPushConfig(push('b', { client: 'agent:wyat/a2a.other' }));
    expect(store.deletePushConfigsOf(CLIENT)).toBe(1);
    expect(store.getPushConfig('m-1', 'a')).toBeNull();
    expect(store.getPushConfig('m-1', 'b')).not.toBeNull();
  });
});

describe('push_configs', () => {
  it('counts, records results, disables at ten failures and deletes once', () => {
    store.insertTask(row('m-1'));
    store.putPushConfig(push('a'));
    store.putPushConfig(push('b'));
    store.putPushConfig(push('gone', { taskId: 'm-missing' }));
    expect(store.countPushConfigs(CLIENT)).toBe(2);
    expect(store.getPushConfig('m-1', 'a')).toMatchObject({
      token: 'tok',
      authCredentials: 'cred',
    });
    for (let i = 0; i < 5; i++)
      store.recordPushResult('m-1', 'a', false, '2026-09-25T10:00:00.000Z');
    expect(
      store.recordPushResult('m-1', 'a', true, '2026-09-25T10:00:00.000Z')
        ?.failures
    ).toBe(0);
    let last: PushConfigRow | null = null;
    for (let i = 0; i < 10; i++)
      last = store.recordPushResult(
        'm-1',
        'a',
        false,
        '2026-09-25T11:00:00.000Z'
      );
    expect(last?.disabledAt).toBe('2026-09-25T11:00:00.000Z');
    // A disabled config keeps no secrets.
    expect(last).toMatchObject({ token: null, authCredentials: null });
    expect(store.pushConfigsOf('m-1').map((c) => c.id)).toEqual(['b']);
    expect(store.countPushConfigs(CLIENT)).toBe(1);
    store.updateTask('m-1', { state: 'COMPLETED' });
    expect(store.countPushConfigs(CLIENT)).toBe(0);
    store.disablePushConfig('m-1', 'b', '2026-09-25T12:00:00.000Z');
    expect(store.pushConfigsOf('m-1')).toEqual([]);
    expect(store.getPushConfig('m-1', 'b')).toMatchObject({
      token: null,
      authCredentials: null,
    });
    expect(store.deletePushConfig('m-1', 'a')).toBe(true);
    expect(store.deletePushConfig('m-1', 'a')).toBe(false);
    expect(
      store.recordPushResult('m-1', 'a', true, '2026-09-25T12:00:00.000Z')
    ).toBeNull();
  });
});

describe('hosts', () => {
  const host = (id: string, over: Partial<HostRow> = {}): HostRow => ({
    id,
    name: 'relay',
    tokenHash: `hash-${id}`,
    createdBy: 'human:wyat',
    createdAt: '2026-09-25T10:00:00.000Z',
    revokedAt: null,
    ...over,
  });

  it('stores, finds by token hash, revokes once, and keeps the revoked row', () => {
    store.putHost(host('h-1'));
    store.putHost(host('h-2', { createdAt: '2026-09-25T11:00:00.000Z' }));
    expect(store.hostByTokenHash('hash-h-1')?.id).toBe('h-1');
    expect(store.hostByTokenHash('nope')).toBeNull();
    expect(store.revokeHost('h-1', '2026-09-25T12:00:00.000Z')).toBe(true);
    expect(store.revokeHost('h-1', '2026-09-25T13:00:00.000Z')).toBe(false);
    expect(store.revokeHost('h-missing', '2026-09-25T13:00:00.000Z')).toBe(
      false
    );
    expect(store.hosts().map((h) => [h.id, h.revokedAt])).toEqual([
      ['h-1', '2026-09-25T12:00:00.000Z'],
      ['h-2', null],
    ]);
  });
});
