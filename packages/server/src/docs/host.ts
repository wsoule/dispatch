import type {
  DocScope,
  LinkTarget,
  TaskRisk,
  TaskStorePort,
} from '@dispatch/core';
import { TaskParseError } from '@dispatch/core';
import type { Operator } from '@dispatch/memory';
import type { MessageStore } from '@dispatch/protocol';

import type { EventBus } from '../events.js';
import type { Principal } from '../messaging/principal.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
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
  runKind(principal: Principal): 'execute' | 'review' | 'verify' | null;
  task(id: string): DocsTaskFacts | null;
  // Whether a task, run, thread root or memory entry exists; docs are checked by the service.
  exists(target: LinkTarget): boolean;
  inThread(threadId: string, principal: Principal): boolean;
  memoryScope(id: string): 'personal' | 'project' | 'team' | null;
  memoryVisible(id: string, principal: Principal): boolean;
  // Called after a write commits: events, receipts and notices hang off it.
  changed(change: DocChange): void;
  now(): Date;
}

// doc.changed events for amends of one doc coalesce within this window.
export const AMEND_DEBOUNCE_MS = 2_000;

type DocsRuns = Pick<Orchestrator, 'list' | 'taskIdOfRun'>;
type DocsMessages = Pick<MessageStore, 'getMessage' | 'thread' | 'deliveries'>;

// The daemon's DocsHost. The orchestrator and messaging are bound late (boot
// order); until then runs resolve to nothing and threads do not exist.
export class DaemonDocsHost implements DocsHost {
  private runs: DocsRuns | null = null;
  private messages: DocsMessages | null = null;
  private readonly listeners = new Set<(change: DocChange) => void>();
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
  }

  bindMessaging(store: DocsMessages): void {
    this.messages = store;
  }

  onChange(listener: (change: DocChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  operatorOf(_principal: Principal): Operator | null {
    return null;
  }

  runKind(principal: Principal): 'execute' | 'review' | 'verify' | null {
    if (principal.kind !== 'run' || this.runs === null) return null;
    const id = principal.address.slice('run:'.length);
    const meta = this.runs.list().find((r) => r.id === id);
    return meta === undefined ? null : runKind(meta);
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
      default:
        // Memory entries arrive with personal scope; docs are the service's.
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

  memoryScope(_id: string): 'personal' | 'project' | 'team' | null {
    return null;
  }

  // No memory entry is visible until memory's personal scope binds here.
  memoryVisible(_id: string, _principal: Principal): boolean {
    return false;
  }

  // doc.changed is a bare refetch signal; amends coalesce per doc, and a
  // personal doc's event never carries its id.
  changed(change: DocChange): void {
    for (const listener of this.listeners) listener(change);
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
