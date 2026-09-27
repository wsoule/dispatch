import { TaskStore } from '@dispatch/core';
import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../../src/events.js';
import type { ServerEvent } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { openMemory } from '../../src/memory/service.js';

const noRuns = { taskIdOfRun: () => null, getRun: () => null };

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
    orchestrator: noRuns,
    dbPath: join(root, 'memory.db'),
  });
  return { root, memory, ledgerStore, events, seen };
}

describe('openMemory', () => {
  it('imports at boot and again on ledger.changed, announcing a team change', () => {
    const t = setup();
    expect(t.memory.importLedger()?.outcome).toBe('ok');
    t.ledgerStore.add({
      kind: 'hazard',
      title: 'lesson',
      detail: 'd',
      authoredBy: 'human:wyat',
    });
    t.events.broadcast({ type: 'ledger.changed' });
    expect(t.memory.shared?.countEntries()).toBe(1);
    expect(t.seen).toContainEqual({ type: 'memory.changed', scope: 'team' });
    t.memory.close();
  });

  it('keeps the last import across a reopen, and a dry run never replaces it', () => {
    const t = setup();
    t.ledgerStore.add({
      kind: 'hazard',
      title: 'lesson',
      detail: 'd',
      authoredBy: 'human:wyat',
    });
    expect(t.memory.importLedger()?.memory.imported).toBe(1);
    expect(t.memory.importLedger({ dryRun: true })?.outcome).toBe('dry-run');
    expect(t.memory.lastLedgerImport()?.outcome).toBe('ok');
    t.memory.close();
    const reopened = openMemory({
      rootDir: t.root,
      store: TaskStore.init(t.root),
      events: new EventBus(),
      ledgerStore: t.ledgerStore,
      orchestrator: noRuns,
      dbPath: join(t.root, 'memory.db'),
    });
    expect(reopened.lastLedgerImport()).toMatchObject({
      outcome: 'ok',
      memory: { imported: 1 },
    });
    expect(reopened.health()).toMatchObject({
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
      orchestrator: noRuns,
      dbPath,
    });
    expect(memory.engine).toBeNull();
    expect(memory.health()).toMatchObject({ available: false });
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
