import { DEFAULT_MEMORY } from '@dispatch/core';
import type { PolicyRuling } from '@dispatch/core';
import {
  createMemoryIds,
  MemoryEngine,
  newProposal,
  openMemoryDb,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type {
  IndexContext,
  MemoryChange,
  MemoryEntry,
  MemoryHost,
  MemoryProposal,
  MemoryStores,
  Operator,
  Principal,
  ValidMemoryInput,
} from '@dispatch/memory';
import type { DeliveryEngine } from '@dispatch/protocol';
import { join } from 'node:path';

import type { OpenMemoryDeps } from '../../src/memory/service.js';
import { GateHandlers } from '../../src/messaging/gates.js';

// openMemory's daemon deps for a test with no live runs that raises no gate:
// the delivery engine throws on first use, and personal files stay under `root`.
export function quietDaemon(
  root: string,
  orchestrator: Partial<OpenMemoryDeps['orchestrator']> = {}
): Pick<
  OpenMemoryDeps,
  | 'orchestrator'
  | 'messaging'
  | 'ownerRef'
  | 'appendPolicyActivity'
  | 'personalDir'
> {
  const noGates = new Proxy(
    {},
    {
      get: () => {
        throw new Error('this test raises no gates');
      },
    }
  ) as DeliveryEngine;
  return {
    orchestrator: {
      taskIdOfRun: () => null,
      list: () => [],
      notifyRun: () => {},
      isRunLive: () => false,
      isA2ATask: () => false,
      ...orchestrator,
    },
    messaging: { engine: noGates, gates: new GateHandlers() },
    ownerRef: 'human:wyat',
    appendPolicyActivity: () => {},
    personalDir: join(root, 'personal'),
  };
}

// A MemoryHost whose world is plain maps; `raise` is how a test sends gates.
export class TestMemoryHost implements MemoryHost {
  operators = new Map<string, Operator>();
  tasks = new Map<string, IndexContext>();
  runTasks = new Map<string, string>();
  changes: MemoryChange[] = [];
  activated: { entry: MemoryEntry; authorRun: string | null }[] = [];
  rejected: MemoryProposal[] = [];
  ruling: PolicyRuling = { mode: 'block' };
  raise: (p: MemoryProposal) => Promise<string> = () =>
    Promise.reject(new Error('this test sends no gates'));
  clock: () => Date = () => new Date();

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
    return this.clock();
  }
  rule(): PolicyRuling {
    return this.ruling;
  }
  raiseGate(p: MemoryProposal): Promise<string> {
    return this.raise(p);
  }
  recordPolicyApproval(): void {}
  entryActivated(entry: MemoryEntry, authorRun: string | null): void {
    this.activated.push({ entry, authorRun });
  }
  proposalRejected(p: MemoryProposal): void {
    this.rejected.push(p);
  }
}

// An engine over memory.db at `dbPath` (or in memory), with in-memory personal
// stores unless the caller supplies its own resolver.
export function testEngine(
  opts: {
    host?: TestMemoryHost;
    dbPath?: string;
    personal?: MemoryStores['personal'];
  } = {}
) {
  const host = opts.host ?? new TestMemoryHost();
  const shared = new SqliteMemoryStore(openMemoryDb(opts.dbPath ?? ':memory:'));
  const personal = new Map<string, SqliteMemoryStore>();
  const stores: MemoryStores = {
    shared: () => shared,
    personal:
      opts.personal ??
      ((identity) => {
        let store = personal.get(identity);
        if (store === undefined) {
          store = new SqliteMemoryStore(openMemoryDb(':memory:'));
          personal.set(identity, store);
        }
        return store;
      }),
  };
  return {
    engine: new MemoryEngine({ stores, host, config: () => DEFAULT_MEMORY }),
    host,
    shared,
    stores,
  };
}

export const AGENT: Principal = {
  address: 'agent:wyat/claude-code',
  canDecide: false,
  kind: 'agent',
};

export function teamHazard(title: string): ValidMemoryInput {
  return {
    scope: 'team',
    kind: 'hazard',
    title,
    body: 'b',
    refs: [],
    epic: null,
    appliesTo: [],
    projectKey: null,
  };
}

// An open proposal row with no gate yet, as a crash between store and raise leaves it.
export function storedProposal(
  shared: SqliteMemoryStore,
  title: string
): MemoryProposal {
  const c = teamHazard(title);
  const content = {
    kind: c.kind,
    title: c.title,
    body: c.body,
    refs: c.refs,
    epic: c.epic,
    appliesTo: c.appliesTo,
  };
  const p = newProposal(
    {
      action: 'add',
      scope: 'team',
      author: AGENT.address,
      authorTrust: 'agent',
      content,
    },
    createMemoryIds().proposal(Date.now()),
    new Date().toISOString()
  );
  shared.insertProposal(p);
  return p;
}
