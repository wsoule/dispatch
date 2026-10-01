import {
  describePolicyAuthorization,
  parseTeam,
  untrustedInline,
} from '@dispatch/core';
import type { PolicyRuling, TaskDoc, TaskStorePort } from '@dispatch/core';
import { isA2AAgent } from '@dispatch/memory';
import type {
  IndexContext,
  MemoryChange,
  MemoryEngine,
  MemoryEntry,
  MemoryHost,
  MemoryProposal,
  MemoryStore,
  Operator,
  Principal,
} from '@dispatch/memory';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { EventBus } from '../events.js';
import type { LedgerStorePort } from '../ledger.js';
import type { Messaging } from '../messaging/service.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import type { RunMeta } from '../orchestrator/types.js';
import { runOperator } from '../orchestrator/types.js';
import { consultProjectPolicy } from '../policyEngine.js';
import { memoryGateKind, raiseMemoryGate } from './gate.js';
import type { MemoryIdentities } from './identities.js';
import { notifyLiveRuns } from './liveNotify.js';

// The identity a human resolves to when their handle's roster email changed
// since it was bound; every personal store call refuses it with 409.
export const REUSED_HANDLE_IDENTITY = '!reused-handle';
// The identity of a human named as the owner without the owner's credential.
export const NOT_OWNER_IDENTITY = '!not-owner';
// The identity every human resolves to while identities.db will not open.
export const IDENTITIES_DOWN_IDENTITY = '!identities-down';

const REJECTION_REASON_CHARS = 80;

export interface DaemonMemoryHostDeps {
  projectKey: string;
  rootDir: string;
  ownerRef: string;
  store: TaskStorePort;
  orchestrator: Pick<
    Orchestrator,
    'taskIdOfRun' | 'list' | 'notifyRun' | 'isRunLive' | 'isA2ATask'
  >;
  events: Pick<EventBus, 'broadcast'>;
  messaging: Pick<Messaging, 'engine'> & {
    store: Pick<Messaging['store'], 'getAgent'>;
  };
  ledgerStore: Pick<LedgerStorePort, 'add'>;
  appendPolicyActivity: (taskId: string, text: string) => void;
  /** Null while identities.db will not open. */
  identities: MemoryIdentities | null;
  shared: () => MemoryStore;
  engine: () => MemoryEngine;
  now?: () => Date;
}

// The roster email behind `handle` in .dispatch/team.yml, read per call;
// null when the file is absent, unreadable or has no such member.
export function rosterEmailOf(rootDir: string, handle: string): string | null {
  const file = join(rootDir, '.dispatch', 'team.yml');
  try {
    if (!existsSync(file)) return null;
    const member = parseTeam(readFileSync(file, 'utf8')).find(
      (m) => m.handle === handle
    );
    return member?.email ?? null;
  } catch {
    return null;
  }
}

// The human an agent:<handle>/<name> address is attributed to, or null.
function agentHuman(address: string): string | null {
  const match = /^agent:([^/]+)\//.exec(address);
  return match === null ? null : `human:${match[1]}`;
}

// A corrupt task file reads as "no task", never as a failed memory call.
function safeTask(store: TaskStorePort, taskId: string): TaskDoc | null {
  try {
    return store.get(taskId);
  } catch {
    return null;
  }
}

// dispatchd's MemoryHost: principals and their operators, the memory gate
// through messaging, policy receipts and live notify.
export class DaemonMemoryHost implements MemoryHost {
  constructor(private readonly deps: DaemonMemoryHostDeps) {}

  // A human acts for itself; a run for its RunMeta.operator; an
  // agent:<op>/<name> for human:<op>, the owner only on the owner's credential
  // or the owner's app-token approval; agent:dispatch and A2A clients for no one.
  operatorOf(principal: Principal): Operator | null {
    if (isA2AAgent(principal.address)) return null;
    if (principal.kind === 'human')
      return this.bind(principal.address, principal.ownerCredential === true);
    if (principal.kind === 'run') {
      const run = this.runOf(principal);
      const op = run === undefined ? null : runOperator(run);
      return op === null ? null : this.bind(op, true);
    }
    const human = agentHuman(principal.address);
    if (human === null) return null;
    return this.bind(
      human,
      human !== this.deps.ownerRef ||
        principal.ownerCredential === true ||
        this.ownerApproved(principal.address)
    );
  }

  // Called after any approve or revoke of `address`: an owner-attributed agent
  // keeps an owner approval only while the owner approved it with the app token.
  agentDecided(address: string, ownerCredential: boolean): void {
    const identities = this.deps.identities;
    if (identities === null || agentHuman(address) !== this.deps.ownerRef)
      return;
    const agent = this.deps.messaging.store.getAgent(address);
    try {
      if (
        ownerCredential &&
        agent?.status === 'approved' &&
        agent.approvedBy === this.deps.ownerRef
      )
        identities.recordOwnerApproval({
          projectKey: this.deps.projectKey,
          agent: address,
          tokenHash: agent.tokenHash,
          approvedBy: agent.approvedBy,
        });
      else identities.dropOwnerApproval(this.deps.projectKey, address);
    } catch (err) {
      console.error(`memory: could not record who approved ${address}`, err);
    }
  }

  projectKey(): string {
    return this.deps.projectKey;
  }

  taskContext(taskId: string): IndexContext | null {
    const task = safeTask(this.deps.store, taskId);
    if (task === null) return null;
    return {
      taskId,
      title: task.meta.title,
      body: task.body,
      writes: task.meta.writes,
      epic: task.meta.parent,
      risk: task.meta.risk,
      a2a: this.deps.orchestrator.isA2ATask(taskId),
    };
  }

  taskOfPrincipal(principal: Principal): string | null {
    return principal.kind === 'run'
      ? this.deps.orchestrator.taskIdOfRun(
          principal.address.slice('run:'.length)
        )
      : null;
  }

  runTaskOf(principal: Principal): string | null {
    return this.runOf(principal)?.taskId ?? null;
  }

  // A run principal's RunMeta, whatever its kind; undefined for anyone else.
  private runOf(principal: Principal): RunMeta | undefined {
    if (principal.kind !== 'run') return undefined;
    const runId = principal.address.slice('run:'.length);
    return this.deps.orchestrator.list().find((r) => r.id === runId);
  }

  // A bare refetch signal; personal changes never carry an id (spec, Privacy).
  changed(change: MemoryChange): void {
    if (change.scope === 'personal') {
      this.deps.events.broadcast({ type: 'memory.changed', scope: 'personal' });
      return;
    }
    this.deps.events.broadcast({
      type: 'memory.changed',
      scope: change.scope,
      ...(change.id === undefined ? {} : { id: change.id }),
    });
  }

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // Policy for the memory gate; a proposal with no task reads as elevated,
  // which caps it below the gate's rung, and an A2A task's always waits.
  rule(p: MemoryProposal): PolicyRuling {
    if (p.taskId !== null && this.deps.orchestrator.isA2ATask(p.taskId))
      return { mode: 'block' };
    const task = p.taskId === null ? null : safeTask(this.deps.store, p.taskId);
    return consultProjectPolicy(
      this.deps.rootDir,
      'memory',
      task?.meta.risk ?? 'elevated'
    );
  }

  raiseGate(p: MemoryProposal): Promise<string> {
    return raiseMemoryGate(
      this.deps.messaging.engine,
      this.deps.ownerRef,
      p,
      memoryGateKind(p, this.deps.shared())
    );
  }

  // The ledger receipt and [policy] Activity line of a policy approval: the
  // handle, never the title.
  recordPolicyApproval(
    p: MemoryProposal,
    ruling: Extract<PolicyRuling, { mode: 'auto' }>
  ): void {
    const shared = this.deps.shared();
    const entry = p.result === null ? null : shared.getEntry(p.result);
    const handle = entry === null ? '' : ` ${entry.handle}`;
    const title = `Memory approved: ${p.scope} ${memoryGateKind(p, shared)}${handle}`;
    const authorization = describePolicyAuthorization(ruling);
    const task = p.taskId === null ? null : safeTask(this.deps.store, p.taskId);
    this.deps.ledgerStore.add({
      kind: 'decision',
      title,
      detail: `proposal ${p.id} from ${p.author} — ${authorization}`,
      authoredBy: this.deps.ownerRef,
      epicId: task?.meta.parent ?? null,
      sourceTaskId: p.taskId,
    });
    this.deps.events.broadcast({ type: 'ledger.changed' });
    if (p.taskId !== null)
      this.deps.appendPolicyActivity(
        p.taskId,
        `[policy] ${title} — ${authorization}`
      );
  }

  entryActivated(entry: MemoryEntry, authorRun: string | null): void {
    notifyLiveRuns(
      {
        orchestrator: this.deps.orchestrator,
        engine: this.deps.engine(),
        host: this,
      },
      entry,
      authorRun
    );
  }

  // A rejected proposal's author run, if still live, hears it at its next step.
  proposalRejected(p: MemoryProposal): void {
    if (p.runId === null || !this.deps.orchestrator.isRunLive(p.runId)) return;
    const reason =
      p.decisionReason === null
        ? ''
        : `: ${Array.from(untrustedInline(p.decisionReason)).slice(0, REJECTION_REASON_CHARS).join('')}`;
    try {
      this.deps.orchestrator.notifyRun(
        p.runId,
        `🧠 memory · proposal ${p.id} was rejected by ${p.decidedBy ?? 'a human'}${reason}`
      );
    } catch (err) {
      console.error(
        `memory: could not tell run ${p.runId} its proposal was rejected`,
        err
      );
    }
  }

  // Whether the owner approved this owner-attributed agent, at its current
  // token, with the app token; false whenever that cannot be read.
  private ownerApproved(address: string): boolean {
    const identities = this.deps.identities;
    const agent = this.deps.messaging.store.getAgent(address);
    if (
      identities === null ||
      agent?.status !== 'approved' ||
      agent.approvedBy !== this.deps.ownerRef
    )
      return false;
    try {
      return identities.ownerApproved(
        this.deps.projectKey,
        address,
        agent.tokenHash
      );
    } catch (err) {
      console.error(`memory: could not read who approved ${address}`, err);
      return false;
    }
  }

  // The identity behind `human`; the owner is always `self`. A handle bound
  // to someone else, the owner's handle without the owner's credential, or
  // identities.db down, resolves to a refusing sentinel.
  private bind(human: string, ownerCredential: boolean): Operator {
    if (human === this.deps.ownerRef && !ownerCredential)
      return { human, identity: NOT_OWNER_IDENTITY };
    const identities = this.deps.identities;
    if (identities === null)
      return { human, identity: IDENTITIES_DOWN_IDENTITY };
    const handle = human.slice('human:'.length);
    try {
      const resolved = identities.resolve({
        projectKey: this.deps.projectKey,
        handle,
        isOwner: human === this.deps.ownerRef,
        rosterEmail: rosterEmailOf(this.deps.rootDir, handle),
      });
      return {
        human,
        identity: resolved.ok ? resolved.identity : REUSED_HANDLE_IDENTITY,
      };
    } catch (err) {
      console.error(`memory: could not resolve ${human}'s identity`, err);
      return { human, identity: IDENTITIES_DOWN_IDENTITY };
    }
  }
}
