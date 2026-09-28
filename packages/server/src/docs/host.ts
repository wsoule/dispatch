import type {
  DocScope,
  LinkTarget,
  TaskRisk,
  TaskStorePort,
} from '@dispatch/core';
import { TaskParseError } from '@dispatch/core';
import type { MemoryStore, MemoryStores, Operator } from '@dispatch/memory';
import type { MessageStore } from '@dispatch/protocol';

import type { EventBus } from '../events.js';
import { IDENTITY_PATTERN } from '../memory/identities.js';
import type { Principal } from '../messaging/principal.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { RunMeta } from '../orchestrator/types.js';
import { runKind } from '../orchestrator/types.js';

// How DocsService reaches the rest of the daemon, so its tests run against a
// recording fake.

export interface DocsTaskFacts {
  id: string;
  title: string;
  body: string;
  parent: string | null;
  risk: TaskRisk;
  labels: string[];
}

type DocChangeKind =
  | 'created'
  | 'revised'
  | 'amended'
  | 'sealed'
  | 'meta'
  | 'deleted';

export interface DocChange {
  doc: string;
  scope: DocScope;
  kind: DocChangeKind;
  author: string;
  rev: string | null;
  summary: string;
}

export interface DocsHost {
  operatorOf(principal: Principal): Operator | null;
  // The task of an execute run; null for every other principal.
  taskOfPrincipal(principal: Principal): string | null;
  // The task of any run, whatever its kind; null for every other principal.
  runTaskOf(principal: Principal): string | null;
  runKind(principal: Principal): 'execute' | 'review' | 'verify' | null;
  task(id: string): DocsTaskFacts | null;
  // Whether an A2A client asked for the task. Fails closed: never false because a2a.db is down.
  a2aOrigin(taskId: string): boolean;
  // Whether a task, run, thread root or memory entry exists; docs are checked by the service.
  exists(target: LinkTarget): boolean;
  inThread(threadId: string, principal: Principal): boolean;
  memoryScope(id: string): 'personal' | 'project' | 'team' | null;
  memoryVisible(id: string, principal: Principal): boolean;
  // Called after a write commits: events, receipts and notices hang off it.
  changed(change: DocChange): void;
  // Live execute runs (running or awaiting approval), each with its task.
  liveExecuteRuns(): { runId: string; taskId: string }[];
  // One line into a live run's context; throws for a run that cannot take it.
  notifyRun(runId: string, line: string): void;
  now(): Date;
}

// doc.changed events for amends of one doc coalesce within this window.
export const AMEND_DEBOUNCE_MS = 2_000;

// How the line the A2A bridge writes into each task a client asks for begins.
const A2A_PROVENANCE_PREFIX = 'Requested over A2A by ';

type DocsRuns = Pick<
  Orchestrator,
  'list' | 'notifyRun' | 'onRunTerminal' | 'taskIdOfRun'
>;
type DocsMessages = Pick<MessageStore, 'getMessage' | 'thread' | 'deliveries'>;
type MemoryEntryScope = 'personal' | 'project' | 'team';

// What docs need from memory: operators, and which entries exist and who sees them.
interface DocsMemoryPort {
  operatorOf(principal: Principal): Operator | null;
  entryScope(id: string): MemoryEntryScope | null;
  // Memory's own rule: shared entries, or the principal's operator's personal ones.
  entryVisible(id: string, principal: Principal): boolean;
}

// The memory service as docs reach it. A sentinel identity (identities.db down,
// a reused handle) is shared by many humans, so it gets no personal scope.
export function docsMemoryPort(memory: {
  host: Pick<DocsMemoryPort, 'operatorOf'>;
  shared: Pick<MemoryStore, 'getEntry'> | null;
  stores: Pick<MemoryStores, 'locatePersonal'>;
}): DocsMemoryPort {
  const operatorOf = (principal: Principal): Operator | null => {
    const op = memory.host.operatorOf(principal);
    return op !== null && IDENTITY_PATTERN.test(op.identity) ? op : null;
  };
  const owner = (id: string): string | null =>
    memory.stores.locatePersonal?.(id) ?? null;
  return {
    operatorOf,
    entryScope: (id) => {
      const shared = memory.shared?.getEntry(id) ?? null;
      if (shared !== null) return shared.scope;
      return owner(id) === null ? null : 'personal';
    },
    entryVisible: (id, principal) => {
      if ((memory.shared?.getEntry(id) ?? null) !== null) return true;
      const identity = owner(id);
      return identity !== null && operatorOf(principal)?.identity === identity;
    },
  };
}

// The daemon's DocsHost. Runs, messaging and memory bind after boot; until
// then no run, thread, memory entry or operator resolves.
export class DaemonDocsHost implements DocsHost {
  private runs: DocsRuns | null = null;
  private messages: DocsMessages | null = null;
  private memory: DocsMemoryPort | null = null;
  private readonly listeners = new Set<(change: DocChange) => void>();
  private readonly endListeners = new Set<(runId: string) => void>();
  private readonly debounced = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: {
      store: TaskStorePort;
      events: Pick<EventBus, 'broadcast'>;
      debounceMs?: number;
    }
  ) {}

  bindRuns(orchestrator: DocsRuns): void {
    this.runs = orchestrator;
    orchestrator.onRunTerminal((meta) => {
      for (const listener of this.endListeners) listener(meta.id);
    });
  }

  bindMessaging(store: DocsMessages): void {
    this.messages = store;
  }

  bindMemory(port: DocsMemoryPort): void {
    this.memory = port;
  }

  onChange(listener: (change: DocChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  // Hears each run's id once it reaches a terminal state, after runs bind.
  onRunEnded(listener: (runId: string) => void): () => void {
    this.endListeners.add(listener);
    return () => this.endListeners.delete(listener);
  }

  operatorOf(principal: Principal): Operator | null {
    return this.memory?.operatorOf(principal) ?? null;
  }

  private runMeta(principal: Principal): RunMeta | undefined {
    if (principal.kind !== 'run' || this.runs === null) return undefined;
    const id = principal.address.slice('run:'.length);
    return this.runs.list().find((r) => r.id === id);
  }

  runKind(principal: Principal): 'execute' | 'review' | 'verify' | null {
    const meta = this.runMeta(principal);
    return meta === undefined ? null : runKind(meta);
  }

  runTaskOf(principal: Principal): string | null {
    return this.runMeta(principal)?.taskId ?? null;
  }

  taskOfPrincipal(principal: Principal): string | null {
    if (principal.kind !== 'run' || this.runs === null) return null;
    return this.runs.taskIdOfRun(principal.address.slice('run:'.length));
  }

  // A task file that does not parse reads as a missing task.
  task(id: string): DocsTaskFacts | null {
    let doc;
    try {
      doc = this.deps.store.get(id);
    } catch (err) {
      if (err instanceof TaskParseError) return null;
      throw err;
    }
    if (doc === null) return null;
    return {
      id,
      title: doc.meta.title,
      body: doc.body,
      parent: doc.meta.parent,
      risk: doc.meta.risk,
      labels: doc.meta.labels,
    };
  }

  // The a2a label or the bridge's provenance line marks a task an A2A client asked
  // for, and so does a task file that does not parse; none needs a bound bridge.
  a2aOrigin(taskId: string): boolean {
    let doc;
    try {
      doc = this.deps.store.get(taskId);
    } catch (err) {
      if (err instanceof TaskParseError) return true;
      throw err;
    }
    return (
      doc !== null &&
      (doc.meta.labels.includes('a2a') ||
        doc.body.includes(A2A_PROVENANCE_PREFIX))
    );
  }

  exists(target: LinkTarget): boolean {
    switch (target.type) {
      case 'task':
        return this.task(target.id) !== null;
      case 'run':
        return this.runs?.list().some((r) => r.id === target.id) ?? false;
      case 'thread': {
        const root = this.messages?.getMessage(target.id) ?? null;
        return root !== null && root.thread === root.id;
      }
      case 'memory':
        return this.memoryScope(target.id) !== null;
      default:
        // Docs are checked by the service.
        return false;
    }
  }

  // A run takes part in a thread when it, or its task, sent or received a message in it.
  inThread(threadId: string, principal: Principal): boolean {
    const messages = this.messages;
    if (messages === null) return false;
    const task = this.taskOfPrincipal(principal);
    const selves = new Set([
      principal.address,
      ...(task === null ? [] : [`task:${task}`]),
    ]);
    return messages
      .thread(threadId)
      .some(
        (m) =>
          selves.has(m.from) ||
          messages
            .deliveries({ messageId: m.id })
            .some((d) => selves.has(d.recipient))
      );
  }

  memoryScope(id: string): MemoryEntryScope | null {
    return this.memory?.entryScope(id) ?? null;
  }

  // No memory entry is visible until memory binds here.
  memoryVisible(id: string, principal: Principal): boolean {
    return this.memory?.entryVisible(id, principal) ?? false;
  }

  liveExecuteRuns(): ReturnType<DocsHost['liveExecuteRuns']> {
    return (this.runs?.list() ?? [])
      .filter(
        (r) =>
          (r.state === 'running' || r.state === 'awaiting-approval') &&
          runKind(r) === 'execute'
      )
      .map((r) => ({ runId: r.id, taskId: r.taskId }));
  }

  notifyRun(runId: string, line: string): void {
    if (this.runs === null) throw new Error('runs are not bound yet');
    this.runs.notifyRun(runId, line);
  }

  // doc.changed is a bare refetch signal; amends coalesce per doc, and a
  // personal doc's event never carries its id. A failing listener skips only itself.
  changed(change: DocChange): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch (err) {
        console.error('docs: change listener failed', err);
      }
    }
    const event =
      change.scope === 'team'
        ? {
            type: 'doc.changed' as const,
            scope: 'team' as const,
            id: change.doc,
          }
        : { type: 'doc.changed' as const, scope: 'personal' as const };
    if (change.kind !== 'amended') {
      this.deps.events.broadcast(event);
      return;
    }
    if (this.debounced.has(change.doc)) return;
    this.debounced.set(
      change.doc,
      setTimeout(() => {
        this.debounced.delete(change.doc);
        this.deps.events.broadcast(event);
      }, this.deps.debounceMs ?? AMEND_DEBOUNCE_MS)
    );
  }

  now(): Date {
    return new Date();
  }
}
