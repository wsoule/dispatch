import { generateReplicaKeys } from '@dispatch/protocol/federation';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncLedger } from '../../../src/team/boardSync/ledger.js';
import { FedStore } from '../../../src/team/federation/store.js';
import { MemoryRemote } from './helpers/memoryTransport.js';
import { messagingReplica, settleAll } from './helpers/messagingReplica.js';
import type { MessagingReplica } from './helpers/messagingReplica.js';
import { MemoryV1 } from './helpers/serviceReplica.js';

// The F2 approval's two minors: each repro, as a test.
let open: MessagingReplica[] = [];
const dirs: string[] = [];
afterEach(() => {
  for (const r of open) r.close();
  open = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

type SeenRow = { replica: string; seq: number; hash: Uint8Array };
const seenRows = (r: MessagingReplica): SeenRow[] =>
  r.fed.db
    .query<SeenRow, []>('SELECT replica, seq, hash FROM fed_mail_seen')
    .all();

// ada founds and admits cy; bob reads the team's logs while still pending.
async function pendingReader() {
  const remote = new MemoryRemote();
  const v1 = new MemoryV1();
  const [ada, cy, bob] = ['ada', 'cy', 'bob'].map((h) =>
    messagingReplica(h, remote, v1)
  );
  open.push(ada, cy, bob);
  ada.roster.found('acme');
  await settleAll([ada, cy]);
  const { fingerprint } = await import('@dispatch/protocol/federation');
  ada.roster.admit(cy.fed.replica, {
    fingerprint: fingerprint(cy.fed.keys.signPub, cy.fed.keys.sealPub),
  });
  await settleAll([ada, cy]);
  await ada.engine.send(
    { to: ['human:cy'], kind: 'message', body: 'hello' },
    { address: 'human:ada', canDecide: true }
  );
  await ada.service.syncNow();
  return { ada, cy, bob };
}

describe('M1: every verified mail op is recorded before it waits', () => {
  it('records a mail op read while this machine is not yet ready for mail', async () => {
    const { ada, bob } = await pendingReader();
    await bob.settleWith(ada);
    expect(bob.roster.mailReady()).toBe(false);
    const mail = ada.fed.db
      .query<{ seq: number }, []>(
        "SELECT seq FROM fed_log WHERE json_extract(op_json, '$.type') = 'mail'"
      )
      .all()
      .map((r) => r.seq);
    expect(mail.length).toBeGreaterThan(0);
    expect(
      seenRows(bob)
        .filter((r) => r.replica === ada.fed.replica)
        .map((r) => r.seq)
    ).toEqual(mail);
  });
});

describe('M2: fed_mail_seen keeps a 32-byte hash and no time', () => {
  it('stores each hash as a 32-byte blob in a table with no at column', async () => {
    const { ada, cy } = await pendingReader();
    await cy.settleWith(ada);
    const kinds = cy.fed.db
      .query<{ t: string; n: number }, []>(
        'SELECT typeof(hash) AS t, length(hash) AS n FROM fed_mail_seen'
      )
      .all();
    expect(kinds.length).toBeGreaterThan(0);
    for (const k of kinds) expect(k).toEqual({ t: 'blob', n: 32 });
    expect(
      cy.fed.db
        .query<{ name: string }, []>(
          "SELECT name FROM pragma_table_info('fed_mail_seen')"
        )
        .all()
        .map((c) => c.name)
    ).toEqual(['replica', 'seq', 'hash']);
  });

  it('moves an older table forward, keeping its hashes as bytes', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-seen-')));
    dirs.push(dir);
    const hex = 'ab'.repeat(32);
    const ledger = new SyncLedger(join(dir, 'state.db'), 'ada');
    ledger.database.exec(
      'CREATE TABLE fed_mail_seen (replica TEXT NOT NULL, seq INTEGER NOT NULL, hash TEXT NOT NULL, at TEXT NOT NULL, PRIMARY KEY (replica, seq))'
    );
    ledger.database
      .query('INSERT INTO fed_mail_seen VALUES (?, ?, ?, ?)')
      .run('bob-0000000b', 7, hex, '2026-10-01T00:00:00.000Z');
    const fed = new FedStore(ledger, generateReplicaKeys());
    const rows = fed.db
      .query<SeenRow, []>('SELECT replica, seq, hash FROM fed_mail_seen')
      .all();
    expect(
      rows.map((r) => [r.replica, r.seq, Buffer.from(r.hash).toString('hex')])
    ).toEqual([['bob-0000000b', 7, hex]]);
    expect(
      fed.db
        .query<{ name: string }, []>(
          "SELECT name FROM pragma_table_info('fed_mail_seen')"
        )
        .all()
        .map((c) => c.name)
    ).toEqual(['replica', 'seq', 'hash']);
    ledger.close();
  });
});
