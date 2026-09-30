import { TaskStore } from '@dispatch/core';
import type { Principal } from '@dispatch/memory';
import type { DeliveryEngine } from '@dispatch/protocol';
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EventBus } from '../../src/events.js';
import type { ServerEvent } from '../../src/events.js';
import { LedgerStore } from '../../src/ledger.js';
import { PROBED_CLAUDE_CODE_VERSION } from '../../src/memory/claudeModes.js';
import { openMemory, overseerMemory } from '../../src/memory/service.js';
import type { OpenMemoryDeps } from '../../src/memory/service.js';
import { GateHandlers } from '../../src/messaging/gates.js';
import { waitFor } from '../messaging/harness.js';
import { BEFORE_CUTOVER, quietDaemon, seedLedger } from './fixtures.js';

const pause = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Messaging with no gate open, enough for recover()'s stray-gate check.
function noOpenGates(): OpenMemoryDeps['messaging'] {
  const engine = new Proxy(
    {},
    {
      get: (_, prop) => {
        if (prop === 'openBlocking') return () => [];
        throw new Error('this test raises no gates');
      },
    }
  ) as DeliveryEngine;
  return { engine, gates: new GateHandlers() };
}

function setup(over: Partial<OpenMemoryDeps> = {}) {
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
    ...over,
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
    // After the first import, a row that arrives waits for a human.
    expect(t.memory.shared?.countOpenProposals()).toBe(1);
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

  // The first pass follows recover(), so it never races the gate recovery
  // and messaging replay that boot runs before it.
  it('sweeps memory.db once recover() has run, never before', async () => {
    const t = setup({ messaging: noOpenGates() });
    const bak = join(t.root, 'memory.db.bak');
    await pause(30);
    expect(existsSync(bak)).toBe(false);
    expect(t.memory.health(null).lastDecayAt).toBeNull();
    await t.memory.recover();
    await waitFor(() => existsSync(bak));
    expect(t.memory.health(null).lastDecayAt).not.toBeNull();
    t.memory.close();
  });

  it('sweeps nothing once closed', async () => {
    const t = setup();
    t.memory.close();
    const reopened = t.memory.personal.personal('self');
    await pause(30);
    expect(reopened.meta('last_decay_at')).toBeNull();
    expect(existsSync(join(t.root, 'personal', 'self.db.bak'))).toBe(false);
    t.memory.personal.close();
  });

  it('records the probed Claude Code version at boot, replacing an older one', () => {
    const t = setup();
    expect(t.memory.shared?.meta('claude-probe-passed')).toBe(
      PROBED_CLAUDE_CODE_VERSION
    );
    t.memory.shared?.setMeta('claude-probe-passed', '0.0.1');
    t.memory.close();
    const reopened = setup({ dbPath: join(t.root, 'memory.db') });
    expect(reopened.memory.shared?.meta('claude-probe-passed')).toBe(
      PROBED_CLAUDE_CODE_VERSION
    );
    reopened.memory.close();
  });

  it('forgets a recorded probe when this build has none, so export is never chosen', () => {
    const t = setup();
    t.memory.close();
    const reopened = setup({
      dbPath: join(t.root, 'memory.db'),
      probedClaudeVersion: null,
    });
    expect(reopened.memory.shared?.meta('claude-probe-passed')).toBeNull();
    reopened.memory.close();
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
      ownerCredential: true,
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

  // The same shape the MCP's memory_read returns: no revision snapshots, and
  // the body fenced as untrusted text.
  it('reads an entry without revision snapshots, its body fenced', async () => {
    const t = setup();
    const owner: Principal = {
      address: 'human:wyat',
      canDecide: true,
      kind: 'human',
      ownerCredential: true,
    };
    const saved = await t.memory.requireEngine().save(owner, {
      scope: 'team',
      kind: 'hazard',
      title: 'watch the lockfile',
      body: 'RAW-BODY-text',
    });
    if (saved.status !== 'active') throw new Error('expected an entry');
    const read = overseerMemory(t.memory).read(saved.handle) as {
      entry: Record<string, unknown>;
      body: string;
      revisions: Record<string, unknown>[];
    };
    expect(read.entry.body).toBeUndefined();
    expect(read.body).toContain('RAW-BODY-text');
    expect(read.body).not.toBe('RAW-BODY-text');
    expect(Object.keys(read.revisions[0]).sort()).toEqual([
      'at',
      'by',
      'cause',
      'rev',
    ]);
    t.memory.close();
  });
});
