import { openDispatchDb, SqliteTaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SyncLedger } from '../../src/team/boardSync/ledger.js';
import { SyncedTaskStore } from '../../src/team/boardSync/syncedStore.js';

let root: string;
const closers: (() => void)[] = [];

// One replica: its own task database and sync ledger.
function replica(handle: string): {
  store: SyncedTaskStore;
  ledger: SyncLedger;
} {
  const db = openDispatchDb(':memory:');
  const ledger = new SyncLedger(join(root, `${handle}.db`), handle);
  closers.push(
    () => db.close(),
    () => ledger.close()
  );
  return {
    store: new SyncedTaskStore(new SqliteTaskStore(root, db), ledger),
    ledger,
  };
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'board-risk-')));
});
afterEach(() => {
  for (const close of closers.splice(0)) close();
  rmSync(root, { recursive: true, force: true });
});

describe("a teammate's synced risk change on a publishing task", () => {
  it('is not applied, and is reported once per change while the task publishes', () => {
    const alice = replica('alice');
    const bob = replica('bob');
    const task = alice.store.create({
      title: 'Publish doc spec',
      risk: 'elevated',
    });
    for (const op of alice.ledger.outbox()) bob.store.applyRemote(op);
    const lowered: string[] = [];
    bob.store.setRiskGuard({
      publishing: (id) => id === task.meta.id,
      riskChanged: (id) => lowered.push(id),
    });
    const sent = alice.ledger.outbox().length;
    alice.store.update(task.meta.id, { risk: 'routine', title: 'Publish it' });
    const ops = alice.ledger.outbox().slice(sent);
    for (const op of ops) bob.store.applyRemote(op);
    const held = bob.store.get(task.meta.id);
    expect(held?.meta.risk).toBe('elevated');
    // Other fields in the same change still land.
    expect(held?.meta.title).toBe('Publish it');
    expect(lowered).toEqual([task.meta.id]);
  });

  it('applies risk changes to tasks that are not publishing', () => {
    const alice = replica('alice');
    const bob = replica('bob');
    bob.store.setRiskGuard({ publishing: () => false, riskChanged: () => {} });
    const task = alice.store.create({ title: 'Plain', risk: 'elevated' });
    alice.store.update(task.meta.id, { risk: 'routine' });
    for (const op of alice.ledger.outbox()) bob.store.applyRemote(op);
    expect(bob.store.get(task.meta.id)?.meta.risk).toBe('routine');
  });
});
