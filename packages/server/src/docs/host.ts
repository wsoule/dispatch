import { hasA2AProvenance } from '@dispatch/a2a';
import type {
  DocProposal,
  DocScope,
  LinkTarget,
  PolicyRuling,
  TaskRisk,
  TaskStorePort,
} from '@dispatch/core';
import {
  isCanceledStatus,
  isCompletedStatus,
  TaskParseError,
} from '@dispatch/core';
import type { MemoryStore, MemoryStores, Operator } from '@dispatch/memory';
import type { MessageStore } from '@dispatch/protocol';

import { spawnGitSync } from '../blockingGit.js';
import type { EventBus } from '../events.js';
import { IDENTITY_PATTERN } from '../memory/identities.js';
import type { Principal } from '../messaging/principal.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { RunMeta } from '../orchestrator/types.js';
import { runKind } from '../orchestrator/types.js';
import { WorktreeManager } from '../orchestrator/worktree.js';
import { statusModelFor } from '../statuses.js';
import { DocsError } from './errors.js';

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

// What the doc gate needs from messaging, policy and the ledger; bound at boot
// step 3, before messaging.recover() replays answers.
export interface DocsGatePort {
  // Whether a human address may decide now (the owner, or a decide-tier teammate).
  canDecide(address: string): boolean;
  rule(risk: TaskRisk | undefined): PolicyRuling;
  // The gate id; an open gate for the same proposal is reused.
  raiseGate(p: DocProposal): Promise<string>;
  // False when an answer got there first.
  closeGate(gate: string, reason: string): boolean;
  // A system notice to `to`, in reply to `replyTo` when given; never throws.
  notice(to: string, replyTo: string | null, body: string): void;
  recordPolicyApproval(
    p: DocProposal,
    ruling: Extract<PolicyRuling, { mode: 'auto' }>
  ): void;
  openDocGates(): { id: string; proposal: string }[];
}

export interface DocsHost extends DocsGatePort {
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
  // Publish (v1): the project checkout, and the elevated task a publish runs as.
  readonly rootDir: string;
  createPublishTask(input: {
    title: string;
    body: string;
    writes: string[];
    risk: 'elevated';
  }): string;
  // 'landed' only once the task is done and one of its runs really merged;
  // 'dropped' when it was dropped or is gone; null while it is neither.
  publishOutcome(taskId: string): 'landed' | 'dropped' | null;
  // The newest commit on the default branch that touched `path`, or null.
  lastCommitFor(path: string): string | null;
}

// doc.changed events for amends of one doc coalesce within this window.
export const AMEND_DEBOUNCE_MS = 2_000;

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
  private a2aEvidence: ((taskId: string) => boolean) | null = null;
  private memory: DocsMemoryPort | null = null;
  private gates: DocsGatePort | null = null;
  private readonly listeners = new Set<(change: DocChange) => void>();
  private readonly endListeners = new Set<(runId: string) => void>();
  private readonly debounced = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly deps: {
      store: TaskStorePort;
      events: Pick<EventBus, 'broadcast'>;
      debounceMs?: number;
      // The project checkout publishes validate against and read git in.
      rootDir?: string;
      // Brings the daemon's task cache up to date after a task is created here.
      refreshTask?: (taskId: string) => void;
    }
  ) {}

  get rootDir(): string {
    return this.deps.rootDir ?? '';
  }

  createPublishTask(
    input: Parameters<DocsHost['createPublishTask']>[0]
  ): string {
    const task = this.deps.store.create({
      title: input.title,
      description: input.body,
      writes: input.writes,
      risk: input.risk,
    });
    this.deps.refreshTask?.(task.meta.id);
    this.deps.events.broadcast({ type: 'task.changed', ids: [task.meta.id] });
    return task.meta.id;
  }

  // A status alone never lands a publish (an agent may set any status): one of
  // the task's execute runs must carry the orchestrator's own merge record.
  publishOutcome(taskId: string): 'landed' | 'dropped' | null {
    let doc;
    try {
      doc = this.deps.store.get(taskId);
    } catch (err) {
      if (err instanceof TaskParseError) return null;
      throw err;
    }
    if (doc === null) return 'dropped';
    const model = statusModelFor(this.rootDir);
    if (isCanceledStatus(doc.meta.status, model)) return 'dropped';
    if (!isCompletedStatus(doc.meta.status, model) || this.runs === null)
      return null;
    const merged = this.runs
      .list()
      .some(
        (r) =>
          r.taskId === taskId &&
          runKind(r) === 'execute' &&
          (r.reviewAction === 'merge' || r.reviewAction === 'pr')
      );
    return merged ? 'landed' : null;
  }

  lastCommitFor(path: string): string | null {
    if (this.rootDir === '') return null;
    let base: string;
    try {
      base = new WorktreeManager(this.rootDir).defaultBaseBranch();
    } catch {
      return null;
    }
    const out = spawnGitSync(this.rootDir, [
      'log',
      '-1',
      '--format=%H',
      base,
      '--',
      path,
    ]);
    const sha = out.exitCode === 0 ? out.stdout.trim() : '';
    return sha === '' ? null : sha;
  }

  bindRuns(orchestrator: DocsRuns): void {
    this.runs = orchestrator;
    orchestrator.onRunTerminal((meta) => {
      for (const listener of this.endListeners) listener(meta.id);
    });
  }

  bindMessaging(store: DocsMessages): void {
    this.messages = store;
  }

  // The A2A bridge's evidence (a2a.db row or messages.db handoff), once it has opened.
  bindA2AOrigin(evidence: (taskId: string) => boolean): void {
    this.a2aEvidence = evidence;
  }

  bindMemory(port: DocsMemoryPort): void {
    this.memory = port;
  }

  bindGates(port: DocsGatePort): void {
    this.gates = port;
  }

  // The bound gate port; before boot step 3 a gated write answers 503.
  private gatePort(): DocsGatePort {
    if (this.gates === null)
      throw new DocsError('unavailable', 'messaging is not bound yet');
    return this.gates;
  }

  canDecide(address: string): boolean {
    return this.gatePort().canDecide(address);
  }

  rule(risk: TaskRisk | undefined): PolicyRuling {
    return this.gatePort().rule(risk);
  }

  raiseGate(p: DocProposal): Promise<string> {
    return this.gatePort().raiseGate(p);
  }

  closeGate(gate: string, reason: string): boolean {
    return this.gatePort().closeGate(gate, reason);
  }

  notice(to: string, replyTo: string | null, body: string): void {
    this.gatePort().notice(to, replyTo, body);
  }

  recordPolicyApproval(
    p: DocProposal,
    ruling: Extract<PolicyRuling, { mode: 'auto' }>
  ): void {
    this.gatePort().recordPolicyApproval(p, ruling);
  }

  openDocGates(): { id: string; proposal: string }[] {
    return this.gatePort().openDocGates();
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

  // An unreadable task file fails closed; otherwise the bridge's evidence decides,
  // and until it binds (boot), the label or provenance line does.
  a2aOrigin(taskId: string): boolean {
    let doc;
    try {
      doc = this.deps.store.get(taskId);
    } catch (err) {
      if (err instanceof TaskParseError) return true;
      throw err;
    }
    if (doc === null) return false;
    return this.a2aEvidence === null
      ? hasA2AProvenance(doc)
      : this.a2aEvidence(taskId);
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
