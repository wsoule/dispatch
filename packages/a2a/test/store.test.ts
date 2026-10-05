import { openSqliteDb } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
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
    // A row dated after `until` (a clock that jumped) is outside the window.
    expect(
      store.relayedSince(
        'acme',
        '2026-09-25T10:30:00.000Z',
        '2026-09-25T10:45:00.000Z'
      )
    ).toBe(0);
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
    publicUrl: 'https://relay.example.com',
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

describe('push_pending', () => {
  it('keeps a retry until cleared, and goes with its config', () => {
    store.putPushConfig(push('a'));
    store.putPushConfig(push('b', { client: 'agent:wyat/a2a.other' }));
    expect(store.pushConfigTaskIds()).toEqual(['m-1']);
    store.setPushPending('m-1', 'a', 1, '2026-09-25T10:00:10.000Z');
    store.setPushPending('m-1', 'a', 2, '2026-09-25T10:01:10.000Z');
    store.setPushPending('m-1', 'b', 1, '2026-09-25T10:00:10.000Z');
    expect(store.getPushPending('m-1', 'a')).toEqual({
      tries: 2,
      nextAt: '2026-09-25T10:01:10.000Z',
    });
    store.deletePushConfig('m-1', 'a');
    expect(store.getPushPending('m-1', 'a')).toBeNull();
    store.deletePushConfigsOf('agent:wyat/a2a.other');
    expect(store.getPushPending('m-1', 'b')).toBeNull();
    store.putPushConfig(push('c'));
    store.setPushPending('m-1', 'c', 1, '2026-09-25T10:00:10.000Z');
    store.clearPushPending('m-1', 'c');
    expect(store.getPushPending('m-1', 'c')).toBeNull();
  });
});

describe('derived_tasks', () => {
  it('keeps the A2A task a clone was made from', () => {
    expect(store.derivedFrom('t-clone1')).toBeNull();
    store.markDerived('t-clone1', 't-source', '2026-09-25T10:00:00.000Z');
    store.markDerived('t-clone1', 't-other', '2026-09-25T11:00:00.000Z');
    expect(store.derivedFrom('t-clone1')).toBe('t-source');
  });
});

describe('P5 keys and pairings', () => {
  const JWK = { kty: 'EC', crv: 'P-256', x: 'x-1', y: 'y-1' };

  it('upgrades a P4 a2a.db in place, keeping its rows and reading them as bearer', () => {
    const path = join(dir, 'p4.db');
    const old = openSqliteDb(path);
    old.exec(`CREATE TABLE clients (
      addr TEXT PRIMARY KEY, name TEXT NOT NULL, recipients_json TEXT NOT NULL,
      created_by TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE peers (
      alias TEXT PRIMARY KEY, card_url TEXT NOT NULL, interface_url TEXT NOT NULL, binding TEXT NOT NULL,
      card_json TEXT NOT NULL, etag TEXT, fetched_at TEXT NOT NULL, status TEXT NOT NULL,
      added_by TEXT NOT NULL, added_tier TEXT NOT NULL, allow_http INTEGER NOT NULL, allow_origin INTEGER NOT NULL,
      api_key_header TEXT, created_at TEXT NOT NULL);
    INSERT INTO clients VALUES ('${CLIENT}', 'a2a.acme', '[]', 'human:wyat', '2026-10-01T00:00:00.000Z');
    PRAGMA user_version = 1;`);
    old.close();
    const upgraded = new SqliteA2AStore(openA2ADb(path));
    try {
      expect(upgraded.getClient(CLIENT)).toMatchObject({
        name: 'a2a.acme',
        auth: 'bearer',
        keyThumbprint: null,
        keyJwk: null,
        pairedId: null,
      });
      // Opening twice must not add the columns twice.
      upgraded.close();
      const again = new SqliteA2AStore(openA2ADb(path));
      expect(again.getClient(CLIENT)?.auth).toBe('bearer');
      again.close();
    } finally {
      // closed above
    }
  });

  it('pins a key on a client and a peer, finds each by thumbprint, and an upsert keeps the pin', () => {
    store.putClient({
      address: CLIENT,
      name: 'a2a.acme',
      recipients: [],
      createdBy: 'human:wyat',
      createdAt: '2026-10-01T00:00:00.000Z',
    });
    store.setClientKey(CLIENT, {
      thumbprint: 'tp-1',
      jwk: JWK,
      auth: 'signature',
      pairedId: 'p-1',
    });
    expect(store.clientByThumbprint('tp-1')).toMatchObject({
      address: CLIENT,
      auth: 'signature',
      keyJwk: JWK,
      pairedId: 'p-1',
    });
    store.putClient({ ...store.getClient(CLIENT)!, recipients: ['human:ada'] });
    expect(store.getClient(CLIENT)?.keyThumbprint).toBe('tp-1');

    store.putPeer(peer('acme'));
    store.setPeerKey('acme', {
      thumbprint: 'tp-2',
      jwk: JWK,
      auth: 'signature',
      pairedId: 'p-1',
    });
    store.putPeer(peer('acme', { etag: '"v2"' }));
    expect(store.peerByThumbprint('tp-2')).toMatchObject({
      alias: 'acme',
      auth: 'signature',
      etag: '"v2"',
    });
    expect(store.clientByThumbprint('nope')).toBeNull();
  });

  it('completes a pairing once, and lists pairings without their secrets', () => {
    store.putPairing({
      id: 'p-1',
      role: 'offer',
      secretHash: 'h',
      alias: 'bob',
      reach: {
        kind: 'url',
        card: 'https://bob.example/.well-known/agent-card.json',
      },
      createdBy: 'human:wyat',
      createdTier: 'decide',
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-01T00:15:00.000Z',
      state: 'offered',
      peerThumbprint: null,
      completedAt: null,
    });
    expect(
      store.completePairing('p-1', 'tp-b', '2026-10-01T00:05:00.000Z')
    ).toBe(true);
    expect(
      store.completePairing('p-1', 'tp-c', '2026-10-01T00:06:00.000Z')
    ).toBe(false);
    expect(store.pairing('p-1')).toMatchObject({
      state: 'completed',
      peerThumbprint: 'tp-b',
      reach: { kind: 'url' },
    });
    expect(store.pairing('p-missing')).toBeNull();
    expect(store.pairings().map((p) => p.id)).toEqual(['p-1']);
  });

  it('remembers nonces until they expire, refuses a replay, and stops at the cap', () => {
    const at = (s: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, s));
    expect(store.rememberNonce('tp', 'n1', at(30), 2, at(0))).toBe('fresh');
    expect(store.rememberNonce('tp', 'n1', at(30), 2, at(1))).toBe('replay');
    expect(store.rememberNonce('tp', 'n2', at(30), 2, at(2))).toBe('fresh');
    expect(store.rememberNonce('tp', 'n3', at(30), 2, at(3))).toBe('full');
    // Another key has its own room.
    expect(store.rememberNonce('tp-other', 'n1', at(30), 2, at(3))).toBe(
      'fresh'
    );
    // Once expired, entries are pruned and room comes back.
    expect(store.rememberNonce('tp', 'n3', at(90), 2, at(31))).toBe('fresh');
  });

  it('keeps key events in order for one thumbprint', () => {
    store.recordKeyEvent({
      thumbprint: 'tp',
      event: 'pinned',
      statement: null,
      at: '2026-10-01T00:00:00.000Z',
    });
    store.recordKeyEvent({
      thumbprint: 'tp',
      event: 'rotated',
      statement: '{"v":1}',
      at: '2026-10-02T00:00:00.000Z',
    });
    expect(store.keyEvents('tp').map((e) => e.event)).toEqual([
      'pinned',
      'rotated',
    ]);
    expect(store.keyEvents('other')).toEqual([]);
  });
});

describe('key pins (review M5)', () => {
  const JWK = { kty: 'EC', crv: 'P-256', x: 'x-1', y: 'y-1' };
  const client = (address: string) =>
    store.putClient({
      address,
      name: address.split('/')[1],
      recipients: [],
      createdBy: 'human:wyat',
      createdAt: '2026-10-01T00:00:00.000Z',
    });

  it('(b, d) pins one key to one row per table, and says whether a pin took', () => {
    client('agent:wyat/a2a.one');
    client('agent:wyat/a2a.two');
    const pin = {
      thumbprint: 'tp-1',
      jwk: JWK,
      auth: 'signature' as const,
      pairedId: null,
    };
    expect(store.setClientKey('agent:wyat/a2a.one', pin)).toBe(true);
    expect(store.setClientKey('agent:wyat/a2a.two', pin)).toBe(false);
    expect(
      store.setClientKey('agent:wyat/a2a.missing', {
        ...pin,
        thumbprint: 'tp-9',
      })
    ).toBe(false);
    expect(store.clientByThumbprint('tp-1')?.address).toBe(
      'agent:wyat/a2a.one'
    );
    // The same key may be a peer as well as a client: one row in each table.
    store.putPeer(peer('one'));
    expect(store.setPeerKey('one', pin)).toBe(true);
    store.putPeer(peer('two'));
    expect(store.setPeerKey('two', pin)).toBe(false);
  });

  it('(a, c) reads an unknown auth or a damaged key as no key at all', () => {
    client('agent:wyat/a2a.one');
    store.setClientKey('agent:wyat/a2a.one', {
      thumbprint: 'tp-1',
      jwk: JWK,
      auth: 'signature',
      pairedId: null,
    });
    const raw = openSqliteDb(join(dir, 'a2a.db'));
    raw.exec(
      "UPDATE clients SET auth = 'telepathy' WHERE addr = 'agent:wyat/a2a.one'"
    );
    raw.close();
    expect(store.getClient('agent:wyat/a2a.one')).toMatchObject({
      auth: 'signature',
      keyThumbprint: null,
      keyJwk: null,
    });
    const again = openSqliteDb(join(dir, 'a2a.db'));
    again.exec(
      "UPDATE clients SET auth = 'signature', key_jwk = '{not json' WHERE addr = 'agent:wyat/a2a.one'"
    );
    again.exec(
      "UPDATE clients SET key_thumbprint = 'tp-2' WHERE addr = 'agent:wyat/a2a.one'"
    );
    again.close();
    expect(store.getClient('agent:wyat/a2a.one')).toMatchObject({
      keyThumbprint: null,
      keyJwk: null,
    });
    const third = openSqliteDb(join(dir, 'a2a.db'));
    third.exec(
      `UPDATE clients SET key_jwk = '{"kty":7}' WHERE addr = 'agent:wyat/a2a.one'`
    );
    third.close();
    expect(store.getClient('agent:wyat/a2a.one')?.keyJwk).toBeNull();
  });
});

describe('review N5', () => {
  const pairingRow = (id: string) => ({
    id,
    role: 'offer' as const,
    secretHash: 'mac-key',
    alias: 'bob',
    reach: { kind: 'url' as const, card: 'https://bob.example/card' },
    createdBy: 'human:wyat',
    createdTier: 'decide' as const,
    createdAt: '2026-10-01T00:00:00.000Z',
    expiresAt: '2026-10-01T00:15:00.000Z',
    state: 'offered' as const,
    peerThumbprint: null,
    completedAt: null,
  });

  it('drops the MAC key once a pairing leaves offered', () => {
    store.putPairing(pairingRow('p-1'));
    store.putPairing(pairingRow('p-2'));
    store.completePairing('p-1', 'tp', '2026-10-01T00:05:00.000Z');
    store.setPairingState('p-2', 'canceled');
    expect(store.pairing('p-1')?.secretHash).toBeNull();
    expect(store.pairing('p-2')?.secretHash).toBeNull();
  });

  it('clears duplicate pins with a warning instead of refusing to open', () => {
    const path = join(dir, 'dup.db');
    const first = new SqliteA2AStore(openA2ADb(path));
    first.close();
    const raw = openSqliteDb(path);
    raw.exec('DROP INDEX IF EXISTS clients_key_unique');
    for (const a of ['agent:wyat/a2a.one', 'agent:wyat/a2a.two'])
      raw.exec(
        `INSERT INTO clients (addr, name, recipients_json, created_by, created_at, key_thumbprint, key_jwk, auth) VALUES ('${a}', 'x', '[]', 'h', 't', 'tp-dup', '{"kty":"EC","crv":"P-256","x":"a","y":"b"}', 'signature')`
      );
    raw.close();
    const warned: string[] = [];
    const spy = spyOn(console, 'warn').mockImplementation((...a: unknown[]) => {
      warned.push(a.map(String).join(' '));
    });
    let reopened: SqliteA2AStore;
    try {
      reopened = new SqliteA2AStore(openA2ADb(path));
    } finally {
      spy.mockRestore();
    }
    expect(warned.join('\n')).toContain('tp-dup');
    expect(reopened.getClient('agent:wyat/a2a.one')?.keyThumbprint).toBeNull();
    expect(reopened.getClient('agent:wyat/a2a.two')?.keyThumbprint).toBeNull();
    reopened.close();
  });
});
