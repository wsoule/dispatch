import { TaskStore } from '@dispatch/core';
import type { Principal } from '@dispatch/memory';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../../src/events.js';
import type { ServerEvent } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { openMemory, overseerMemory } from '../../src/memory/service.js';
import { BEFORE_CUTOVER, quietDaemon, seedLedger } from './fixtures.js';

function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-service-')));
  const store = TaskStore.init(root);
  const events = new EventBus();
  const seen: ServerEvent[] = [];
  events.subscribe((e) => seen.push(e));
  const ledgerStore = new LedgerStore(root);
  const memory = openMemory({
    rootDir: root,
    store,
    events,
    ledgerStore,
    ...quietDaemon(root),
    dbPath: join(root, 'memory.db'),
  });
  return { root, memory, ledgerStore, events, seen };
}

describe('openMemory', () => {
  it('imports at boot and again on ledger.changed, announcing a team change', () => {
    const t = setup();
    expect(t.memory.importLedger()?.outcome).toBe('ok');
    seedLedger(
      t.root,
      {
        kind: 'hazard',
        title: 'lesson',
        detail: 'd',
        authoredBy: 'human:wyat',
      },
      BEFORE_CUTOVER
    );
    t.events.broadcast({ type: 'ledger.changed' });
    expect(t.memory.shared?.countEntries()).toBe(1);
    expect(t.seen).toContainEqual({ type: 'memory.changed', scope: 'team' });
    t.memory.close();
  });

  it('keeps the last import across a reopen, and a dry run never replaces it', () => {
    const t = setup();
    seedLedger(
      t.root,
      {
        kind: 'hazard',
        title: 'lesson',
        detail: 'd',
        authoredBy: 'human:wyat',
      },
      BEFORE_CUTOVER
    );
    expect(t.memory.importLedger()?.memory.imported).toBe(1);
    expect(t.memory.importLedger({ dryRun: true })?.outcome).toBe('dry-run');
    expect(t.memory.lastLedgerImport()?.outcome).toBe('ok');
    t.memory.close();
    const reopened = openMemory({
      rootDir: t.root,
      store: TaskStore.init(t.root),
      events: new EventBus(),
      ledgerStore: t.ledgerStore,
      ...quietDaemon(t.root),
      dbPath: join(t.root, 'memory.db'),
    });
    expect(reopened.lastLedgerImport()).toMatchObject({
      outcome: 'ok',
      memory: { imported: 1 },
    });
    expect(reopened.health(null)).toMatchObject({
      available: true,
      entries: 1,
      openProposals: 0,
      ledgerImport: { outcome: 'ok' },
    });
    reopened.close();
  });

  it('reports memory unavailable, and never throws, when memory.db will not open', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'memory-service-')));
    const dbPath = join(root, 'memory.db');
    mkdirSync(dbPath); // a directory where the database file should be cannot be opened
    const memory = openMemory({
      rootDir: root,
      store: TaskStore.init(root),
      events: new EventBus(),
      ledgerStore: new LedgerStore(root),
      ...quietDaemon(root),
      dbPath,
    });
    expect(memory.engine).toBeNull();
    expect(memory.health(null)).toMatchObject({ available: false });
    expect(() => memory.requireEngine()).toThrow(/unavailable|will not open/);
    expect(memory.importLedger()).toBeNull();
    memory.close();
  });

  it('never announces personal ids', () => {
    const t = setup();
    t.memory.host.changed({ scope: 'personal', id: 'mem-secret' });
    expect(t.seen).toContainEqual({
      type: 'memory.changed',
      scope: 'personal',
    });
    expect(JSON.stringify(t.seen)).not.toContain('mem-secret');
    t.memory.close();
  });
});

describe('overseerMemory', () => {
  it('reads project and team memory, never its owner’s personal entries', async () => {
    const t = setup();
    const engine = t.memory.requireEngine();
    const owner: Principal = {
      address: 'human:wyat',
      canDecide: true,
      kind: 'human',
    };
    const personal = await engine.save(owner, {
      scope: 'personal',
      kind: 'fact',
      title: 'SECRET-OVERSEER-title',
      body: 'SECRET-OVERSEER-body',
    });
    if (personal.status !== 'active') throw new Error('expected an entry');
    await engine.save(owner, {
      scope: 'project',
      kind: 'convention',
      title: 'overseer-visible convention',
      body: 'b',
    });
    const port = overseerMemory(t.memory);
    const all = JSON.stringify(port.search({ query: '' }));
    expect(all).toContain('overseer-visible convention');
    expect(all).not.toContain('SECRET-OVERSEER-title');
    expect(JSON.stringify(port.search({ query: 'SECRET' }))).not.toContain(
      personal.id
    );
    for (const ref of [personal.id, personal.handle])
      expect(() => port.read(ref)).toThrow(/you can see/);
    t.memory.close();
  });
});
