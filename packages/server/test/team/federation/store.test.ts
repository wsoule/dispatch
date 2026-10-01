import {
  compareHlc,
  generateReplicaKeys,
  MAX_HLC_COUNTER,
  opHash,
  parseOpHlc,
  sealPayload,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncLedger } from '../../../src/team/boardSync/ledger.js';
import {
  loadOrCreateKeys,
  rekeyIfKeysLost,
} from '../../../src/team/federation/keys.js';
import {
  FedStore,
  OpTooLargeError,
} from '../../../src/team/federation/store.js';

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-store-')));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const keyBody = (keys: ReturnType<typeof generateReplicaKeys>) => ({
  handle: 'ada',
  device: 'laptop',
  build: '0.40.0',
  signPub: keys.signPub,
  sealPub: keys.sealPub,
  legacy: null,
});

describe('replica ids', () => {
  it('lowercases the handle for new ids and keeps an existing uppercase one', () => {
    const fresh = new SyncLedger(join(dir, 'a.db'), 'Ada.Lovelace');
    expect(fresh.replica).toMatch(/^ada\.lovelace-[0-9a-f]{8}$/);
    fresh.close();
    const path = join(dir, 'b.db');
    mkdirSync(dir, { recursive: true });
    const raw = new Database(path, { create: true });
    raw.exec(
      "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO meta VALUES ('replica', 'Ada-1a2b3c4d')"
    );
    raw.close();
    const kept = new SyncLedger(path, 'ada');
    expect(kept.replica).toBe('Ada-1a2b3c4d');
    kept.close();
  });
});

describe('FedStore.append', () => {
  it('starts with the key op, continues past the v1 counter, and chains prev and hlc', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    for (let i = 0; i < 3; i++)
      ledger.commitLocal(
        { task: 't-00000a01', kind: 'put', fields: { n: i } },
        () => {}
      );
    const keys = generateReplicaKeys();
    const fed = new FedStore(ledger, keys);
    expect(() => fed.append({ type: 'task', body: {} })).toThrow(
      'the first op of a log is its key op'
    );
    const key = fed.append({ type: 'key', body: keyBody(keys) });
    const next = fed.append({
      type: 'presence',
      body: { kind: 'replica', build: '0.40.0', device: 'laptop', wall: 1 },
    });
    expect(key.seq).toBe(4);
    expect(key.prev).toBe(ZERO_HASH);
    expect(next.seq).toBe(5);
    expect(next.prev).toBe(opHash(key));
    const [a, b] = [parseOpHlc(key.hlc), parseOpHlc(next.hlc)];
    expect(a !== null && b !== null && compareHlc(b, a) > 0).toBe(true);
    expect(fed.head()).toEqual({ seq: 5, hash: opHash(next), hlc: next.hlc });
    ledger.close();
  });

  it('refuses a second key op, which every verifier would halt on', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const keys = generateReplicaKeys();
    const fed = new FedStore(ledger, keys);
    fed.append({ type: 'key', body: keyBody(keys) });
    const before = fed.head();
    expect(() => fed.append({ type: 'key', body: keyBody(keys) })).toThrow(
      'a log has one key op'
    );
    expect(fed.head()).toEqual(before);
    expect(fed.outbox()).toHaveLength(1);
    ledger.close();
  });

  it('never puts a v2 op in the v1 outbox, where an older build would push and delete it', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const keys = generateReplicaKeys();
    const fed = new FedStore(ledger, keys);
    fed.append({ type: 'key', body: keyBody(keys) });
    expect(ledger.outbox()).toEqual([]);
    expect(fed.outbox().map((o) => o.type)).toEqual(['key']);
    ledger.close();
  });

  it('gives a v1 op made after a v2 op a higher seq, so v1 readers see them rise', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const keys = generateReplicaKeys();
    const fed = new FedStore(ledger, keys);
    const key = fed.append({ type: 'key', body: keyBody(keys) });
    const v1 = ledger.commitLocal(
      { task: 't-00000a01', kind: 'put', fields: { n: 1 } },
      () => {}
    );
    expect(v1.seq).toBe(key.seq + 1);
    expect(fed.append({ type: 'task', body: {} }).seq).toBe(v1.seq + 1);
    ledger.close();
  });

  it('persists the head, so a relay-transport replica with no clone keeps its chain', () => {
    const path = join(dir, 'state.db');
    const keys = generateReplicaKeys();
    const ledger = new SyncLedger(path, 'ada');
    const first = new FedStore(ledger, keys);
    const op = first.append({ type: 'key', body: keyBody(keys) });
    first.published(op.seq);
    ledger.close();
    const again = new SyncLedger(path, 'ada');
    const reopened = new FedStore(again, keys);
    expect(reopened.outbox()).toEqual([]);
    expect(reopened.head()?.hash).toBe(opHash(op));
    again.close();
  });

  it('rolls back the op and the head together when the op is refused', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const keys = generateReplicaKeys();
    const fed = new FedStore(ledger, keys);
    fed.append({ type: 'key', body: keyBody(keys) });
    const before = fed.head();
    const stamped: number[] = [];
    const big = () =>
      fed.append({
        type: 'task',
        body: { big: 'x'.repeat(1024 * 1024) },
        onStamp: (stamp) => {
          stamped.push(stamp.seq);
          fed.setMeta('mail_rowid', String(stamp.seq));
        },
      });
    expect(big).toThrow('over MAX_OP_BYTES');
    expect(big).toThrow(OpTooLargeError);
    expect(stamped).toHaveLength(2);
    expect(fed.meta('mail_rowid')).toBeNull();
    expect(fed.head()).toEqual(before);
    expect(fed.outbox()).toHaveLength(1);
    ledger.close();
  });

  it('seals under the stamp it mints and hands the signed op to alsoV1', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const keys = generateReplicaKeys();
    const fed = new FedStore(ledger, keys);
    fed.append({ type: 'key', body: keyBody(keys) });
    const copies: string[] = [];
    const op = fed.append({
      type: 'mail',
      seal: (stamp) => ({
        to: ['bob-0000000b'],
        sealed: {
          nonce: `n${stamp.seq}`,
          ct: 'ct',
          keys: { 'bob-0000000b': { enc: 'e', ct: 'k' } },
        },
      }),
      alsoV1: (signed) => copies.push(opHash(signed)),
    });
    expect(op.to).toEqual(['bob-0000000b']);
    expect(op.sealed?.nonce).toBe(`n${op.seq}`);
    expect(copies).toEqual([opHash(op)]);
    ledger.close();
  });

  it('stamps a signable op after adopting a reading at the counter bound', () => {
    const wall = 1_790_000_000_000;
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada', () => wall);
    ledger.observe(`${wall}.${'9'.repeat(12)}.bob-0000000b`);
    const keys = generateReplicaKeys();
    const fed = new FedStore(ledger, keys);
    const op = fed.append({ type: 'key', body: keyBody(keys) });
    const clock = parseOpHlc(op.hlc);
    expect(clock).not.toBeNull();
    expect(clock !== null && clock.counter <= MAX_HLC_COUNTER).toBe(true);
    expect(clock !== null && clock.ms > wall).toBe(true);
    ledger.close();
  });
});

describe('this replica’s own log (FW-R22 M6, M-f)', () => {
  it('keeps every op it signs after publishing, and stubs a pruned one in place', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const keys = generateReplicaKeys();
    const peer = generateReplicaKeys();
    const fed = new FedStore(ledger, keys);
    fed.append({ type: 'key', body: keyBody(keys) });
    const mail = fed.append({
      type: 'mail',
      seal: (stamp) =>
        sealPayload({
          replica: ledger.replica,
          seq: stamp.seq,
          type: 'mail',
          payload: { n: 1 },
          recipients: new Map([['bob-0000000b', peer.sealPub]]),
        }),
    });
    fed.published(mail.seq);
    expect(fed.outbox()).toEqual([]);
    expect(fed.ownLog().map((e) => e.seq)).toEqual([mail.seq - 1, mail.seq]);
    fed.stubLog([mail.seq]);
    const stub = fed.ownLog().at(-1);
    expect(stub !== undefined && 'pruned' in stub).toBe(true);
    expect(stub === undefined ? null : opHash(stub)).toBe(opHash(mail));
    ledger.close();
  });
});

describe('pins, cursors, problems and the audit log', () => {
  it('pins a key once and reports a conflicting one', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const fed = new FedStore(ledger, generateReplicaKeys());
    const pin = {
      replica: 'bob-0000000b',
      handle: 'bob',
      device: 'desk',
      build: '0.40.0',
      signPub: 'S',
      sealPub: 'X',
      fingerprint: 'FP',
      keySeq: 1,
      legacy: null,
    };
    expect(fed.pin(pin)).toBe('pinned');
    expect(fed.pin(pin)).toBe('same');
    expect(fed.pin({ ...pin, signPub: 'T' })).toBe('conflict');
    expect(fed.pin({ ...pin, invite: { id: 'i-1', sig: 's' } })).toBe(
      'conflict'
    );
    expect(fed.pinned('bob-0000000b')?.signPub).toBe('S');
    expect(fed.pinned('cy-0000000c')).toBeNull();
    const withHistory = {
      ...pin,
      replica: 'cy-0000000c',
      legacy: { throughSeq: 4, digest: 'd'.repeat(64) },
      invite: { id: 'i-2', sig: 'sig' },
    };
    expect(fed.pin(withHistory)).toBe('pinned');
    expect(fed.pins()).toEqual([pin, withHistory]);
    ledger.close();
  });

  it('stores a cursor, a halted one with no head included', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const fed = new FedStore(ledger, generateReplicaKeys());
    expect(fed.cursor('bob-0000000b')).toEqual({ head: null, halted: null });
    const head = {
      seq: 3,
      hash: 'h'.repeat(64),
      hlc: '1790000000000.0000.bob-0000000b',
    };
    fed.setCursor('bob-0000000b', { head, halted: null });
    expect(fed.cursor('bob-0000000b')).toEqual({ head, halted: null });
    fed.setCursor('cy-0000000c', { head: null, halted: 'a bad key op' });
    expect(fed.cursor('cy-0000000c')).toEqual({
      head: null,
      halted: 'a bad key op',
    });
    ledger.close();
  });

  it('keeps one current problem per subject and an append-only audit log', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const fed = new FedStore(ledger, generateReplicaKeys());
    fed.problem('replica:bob-0000000b', 'first');
    fed.problem('replica:bob-0000000b', 'second');
    fed.problem('team', 'paused');
    expect(fed.problems().map((p) => p.message)).toEqual(['second', 'paused']);
    fed.clearProblem('team');
    expect(fed.problems().map((p) => p.subject)).toEqual([
      'replica:bob-0000000b',
    ]);
    fed.audit('admission', 'bob-0000000b', { by: 'ada-0000000a' });
    fed.audit('revocation', 'bob-0000000b', { afterSeq: 9 });
    const rows = fed.db
      .query<{ kind: string; detail_json: string }, []>(
        'SELECT kind, detail_json FROM fed_audit ORDER BY id'
      )
      .all();
    expect(rows.map((r) => r.kind)).toEqual(['admission', 'revocation']);
    expect(JSON.parse(rows[1]?.detail_json ?? 'null')).toEqual({ afterSeq: 9 });
    ledger.close();
  });

  it('refuses an audit kind outside AUDIT_KINDS', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const fed = new FedStore(ledger, generateReplicaKeys());
    const kind = JSON.parse('"gossip"') as 'founding';
    expect(() => fed.audit(kind, 'x', {})).toThrow('not an audit kind');
    ledger.close();
  });

  it('reads, writes and clears meta keys', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const fed = new FedStore(ledger, generateReplicaKeys());
    expect(fed.meta('team_id')).toBeNull();
    fed.setMeta('team_id', 'team-1');
    expect(fed.meta('team_id')).toBe('team-1');
    fed.setMeta('team_id', null);
    expect(fed.meta('team_id')).toBeNull();
    ledger.close();
  });

  it('keeps every verified roster op as it came, a dismiss with its level included', () => {
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    const fed = new FedStore(ledger, generateReplicaKeys());
    const body = {
      rv: 1,
      action: 'dismiss',
      replica: 'bob-0000000b',
      seq: 7,
      hash: 'b'.repeat(64),
      level: 1,
    };
    fed.db
      .query(
        'INSERT INTO fed_roster (replica, seq, hlc, hash, body_json) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        'ada-0000000a',
        9,
        '1790000000000.0000.ada-0000000a',
        'a'.repeat(64),
        JSON.stringify(body)
      );
    const row = fed.db
      .query<{ body_json: string }, []>('SELECT body_json FROM fed_roster')
      .get();
    expect(JSON.parse(row?.body_json ?? 'null')).toEqual(body);
    ledger.close();
  });
});

describe('a lost key file', () => {
  it('starts over as a new replica when the key file is lost but state.db is not', () => {
    const statePath = join(dir, 'state.db');
    const ledger = new SyncLedger(statePath, 'ada');
    const old = ledger.replica;
    const fed = new FedStore(ledger, loadOrCreateKeys(dir, old));
    fed.append({ type: 'key', body: keyBody(fed.keys) });
    fed.append({
      type: 'task',
      body: { task: 't-00000a01', kind: 'put', fields: { n: 1 } },
    });
    ledger.commitLocal(
      { task: 't-00000a01', kind: 'put', fields: { n: 2 } },
      () => {}
    );
    ledger.close();
    rmSync(join(dir, 'keys', 'replica.json'));

    expect(rekeyIfKeysLost(dir, statePath, 'ada')).toBe(old);
    const reopened = new SyncLedger(statePath, 'ada');
    expect(reopened.replica).not.toBe(old);
    expect(reopened.replica).toMatch(/^ada-[0-9a-f]{8}$/);
    expect(reopened.outbox().map((o) => o.replica)).toEqual([reopened.replica]);
    const fresh = new FedStore(
      reopened,
      loadOrCreateKeys(dir, reopened.replica)
    );
    expect(fresh.head()).toBeNull();
    expect(fresh.outbox()).toEqual([]);
    expect(
      fresh
        .problems()
        .some(
          (p) =>
            p.subject === `replica:${old}` &&
            p.message.includes(`revoke ${old}`)
        )
    ).toBe(true);
    const key = fresh.append({ type: 'key', body: keyBody(fresh.keys) });
    expect(key.seq).toBe(4);
    expect(key.prev).toBe(ZERO_HASH);
    reopened.close();
  });

  it('starts over as a new replica when the key file names another replica', () => {
    const statePath = join(dir, 'state.db');
    const ledger = new SyncLedger(statePath, 'ada');
    const old = ledger.replica;
    const oldKeys = loadOrCreateKeys(dir, old);
    const fed = new FedStore(ledger, oldKeys);
    fed.append({ type: 'key', body: keyBody(fed.keys) });
    ledger.close();
    // A lost state.db made this machine another replica, then a backup came back.
    const between = new SyncLedger(join(dir, 'lost.db'), 'ada');
    loadOrCreateKeys(dir, between.replica);
    between.close();

    expect(rekeyIfKeysLost(dir, statePath, 'ada')).toBe(old);
    const reopened = new SyncLedger(statePath, 'ada');
    expect([old, between.replica]).not.toContain(reopened.replica);
    const fresh = new FedStore(
      reopened,
      loadOrCreateKeys(dir, reopened.replica)
    );
    expect(fresh.keys.signPub).not.toBe(oldKeys.signPub);
    expect(fresh.head()).toBeNull();
    expect(readdirSync(join(dir, 'keys')).sort()).toEqual(
      [
        `replica-${old}.retired.json`,
        `replica-${between.replica}.retired.json`,
        'replica.json',
      ].sort()
    );
    const problem = fresh
      .problems()
      .find((p) => p.subject === `replica:${old}`);
    expect(problem?.message).toContain(`revoke ${old} and ${between.replica}`);
    reopened.close();
  });

  it('forgets what its dropped ops said and what it published under the old id', () => {
    const statePath = join(dir, 'state.db');
    const ledger = new SyncLedger(statePath, 'ada');
    const old = ledger.replica;
    const fed = new FedStore(ledger, loadOrCreateKeys(dir, old));
    fed.append({ type: 'key', body: keyBody(fed.keys) });
    const insertRoster = fed.db.query(
      'INSERT INTO fed_roster (replica, seq, hlc, hash, body_json) VALUES (?, ?, ?, ?, ?)'
    );
    const roster = (target: string) => {
      const op = fed.append({
        type: 'roster',
        body: { rv: 1, action: 'admit', replica: target },
      });
      insertRoster.run(op.replica, op.seq, op.hlc, opHash(op), '{}');
      return op;
    };
    const sent = roster('bob-0000000b');
    fed.published(sent.seq);
    const unsent = roster('cy-0000000c');
    insertRoster.run(
      'bob-0000000b',
      unsent.seq,
      unsent.hlc,
      'b'.repeat(64),
      '{}'
    );
    fed.db
      .query(
        "INSERT INTO fed_published (kind, ref, hash) VALUES ('agent', 'agent:ada', 'h')"
      )
      .run();
    ledger.close();
    rmSync(join(dir, 'keys', 'replica.json'));

    expect(rekeyIfKeysLost(dir, statePath, 'ada')).toBe(old);
    const db = new Database(statePath);
    expect(
      db.query('SELECT replica, seq FROM fed_roster ORDER BY replica').all()
    ).toEqual([
      { replica: old, seq: sent.seq },
      { replica: 'bob-0000000b', seq: unsent.seq },
    ]);
    expect(db.query('SELECT kind FROM fed_published').all()).toEqual([]);
    db.close();
  });

  it('keeps the id and its own retired keys for a replica that never started a chain', () => {
    const statePath = join(dir, 'state.db');
    const ledger = new SyncLedger(statePath, 'ada');
    const replica = ledger.replica;
    const keys = loadOrCreateKeys(dir, replica);
    ledger.close();
    loadOrCreateKeys(dir, 'ada-ffffffff');

    expect(rekeyIfKeysLost(dir, statePath, 'ada')).toBeNull();
    const reopened = new SyncLedger(statePath, 'ada');
    expect(reopened.replica).toBe(replica);
    expect(loadOrCreateKeys(dir, replica)).toEqual(keys);
    reopened.close();
  });

  it('changes nothing for a new machine, or one whose key file is there', () => {
    const statePath = join(dir, 'state.db');
    expect(rekeyIfKeysLost(dir, statePath, 'ada')).toBeNull();
    const ledger = new SyncLedger(statePath, 'ada');
    const fed = new FedStore(ledger, loadOrCreateKeys(dir, ledger.replica));
    fed.append({ type: 'key', body: keyBody(fed.keys) });
    const replica = ledger.replica;
    ledger.close();
    expect(rekeyIfKeysLost(dir, statePath, 'ada')).toBeNull();
    const reopened = new SyncLedger(statePath, 'ada');
    expect(reopened.replica).toBe(replica);
    reopened.close();
  });

  it('changes nothing for a replica that never started a signed chain', () => {
    const statePath = join(dir, 'state.db');
    const ledger = new SyncLedger(statePath, 'ada');
    const replica = ledger.replica;
    new FedStore(ledger, generateReplicaKeys());
    ledger.close();
    expect(rekeyIfKeysLost(dir, statePath, 'ada')).toBeNull();
    const reopened = new SyncLedger(statePath, 'ada');
    expect(reopened.replica).toBe(replica);
    reopened.close();
  });
});
