import { DEFAULT_MEMORY } from '@dispatch/core';

import { MemoryEngine } from '../src/engine.js';
import { MemoryError } from '../src/errors.js';
import type { MemoryHost, MemoryStores } from '../src/host.js';
import { openMemoryDb } from '../src/schema.js';
import { SqliteMemoryStore } from '../src/sqliteStore.js';
import type {
  IndexContext,
  MemoryChange,
  Operator,
  Principal,
} from '../src/types.js';

// A host whose world is plain maps; `changes` records every changed() call.
export class FakeMemoryHost implements MemoryHost {
  operators = new Map<string, Operator>();
  tasks = new Map<string, IndexContext>();
  runTasks = new Map<string, string>();
  changes: MemoryChange[] = [];
  clock = new Date('2026-09-25T10:00:00.000Z');

  operatorOf(principal: Principal): Operator | null {
    return this.operators.get(principal.address) ?? null;
  }
  projectKey(): string {
    return 'aaaaaaaaaaaa';
  }
  taskContext(taskId: string): IndexContext | null {
    return this.tasks.get(taskId) ?? null;
  }
  taskOfPrincipal(principal: Principal): string | null {
    return principal.kind === 'run'
      ? (this.runTasks.get(principal.address.slice('run:'.length)) ?? null)
      : null;
  }
  changed(change: MemoryChange): void {
    this.changes.push(change);
  }
  now(): Date {
    return this.clock;
  }
}

// In-memory shared and personal stores; `down` makes an identity unavailable.
export function fakeStores(fts: 'auto' | 'off' = 'auto') {
  const shared = new SqliteMemoryStore(openMemoryDb(':memory:', { fts }));
  const personal = new Map<string, SqliteMemoryStore>();
  const down = new Set<string>();
  const stores: MemoryStores = {
    shared: () => shared,
    personal(identity) {
      if (down.has(identity))
        throw new MemoryError(
          'unavailable',
          `personal memory for ${identity} is unavailable`,
          'store'
        );
      let store = personal.get(identity);
      if (store === undefined) {
        store = new SqliteMemoryStore(openMemoryDb(':memory:', { fts }));
        personal.set(identity, store);
      }
      return store;
    },
    locatePersonal(id) {
      for (const [identity, store] of personal)
        if (store.getEntry(id) !== null) return identity;
      return null;
    },
  };
  return { stores, shared, personal, down };
}

export function engineWith(
  host = new FakeMemoryHost(),
  fts: 'auto' | 'off' = 'auto'
) {
  const s = fakeStores(fts);
  const engine = new MemoryEngine({
    stores: s.stores,
    host,
    config: () => DEFAULT_MEMORY,
  });
  return { engine, host, ...s };
}

export const RUN: Principal = {
  address: 'run:r-9f2c01',
  canDecide: false,
  kind: 'run',
};
export const OWNER: Principal = {
  address: 'human:wyat',
  canDecide: true,
  kind: 'human',
};
export const ADA: Principal = {
  address: 'human:ada',
  canDecide: true,
  kind: 'human',
};
export const A2A: Principal = {
  address: 'agent:wyat/a2a.acme',
  canDecide: false,
  kind: 'agent',
};
