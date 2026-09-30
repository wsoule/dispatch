import { isContainerKind, isDoneStatus } from '@dispatch/core';
import type {
  PolicyRuling as CorePolicyRuling,
  StatusModel,
  TaskDoc,
  TaskStorePort,
} from '@dispatch/core';
import type {
  Address,
  ExternalAdmission,
  ExternalKind,
  ExternalTarget,
  Message,
  MessagingHost,
  PolicyRequest,
  PolicyRuling,
  Sender,
  WakeResult,
} from '@dispatch/protocol';

import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { actingOperator } from '../orchestrator/types.js';
import { consultProjectPolicy } from '../policyEngine.js';
import { statusModelFor } from '../statuses.js';
import type { GateHandlers } from './gates.js';
import { answeredWithOwnerCredential } from './gates.js';

// Who caused a wake, and whether with the owner's app token: the sender of a
// direct wake, or the human who approved a gated one.
export interface WakeActor {
  actor: Address;
  ownerCredential: boolean;
}

export interface DaemonHostDeps {
  rootDir: string;
  orchestrator: Pick<
    Orchestrator,
    | 'liveRunIdForTask'
    | 'isRunLive'
    | 'taskIdOfRun'
    | 'deliverToRun'
    | 'notifyRun'
    | 'wakeTask'
    | 'wakeRun'
  >;
  // Read-only: task parent/kind/status/risk lookups for wake policy and
  // epic channel membership.
  store: TaskStorePort;
  ownerRef: string;
  gates: GateHandlers;
  onHumanMessage: (actor: string, message: Message) => void;
  // Told when a wake could not start a run, so the caller can retry it later.
  onWakeFailed?: (target: Address, message: Message, acting: WakeActor) => void;
  now?: () => Date;
}

// An epic channel's implicit members: every task parented to its epic, as
// `task:<id>`. `childrenOf` lets a bulk caller reuse one task listing.
export function implicitEpicMembers(
  childrenOf: (epicId: string) => { meta: { id: string } }[],
  channel: string
): Address[] {
  const match = /^epic\/(.+)$/.exec(channel);
  if (match === null) return [];
  return childrenOf(match[1]).map((task) => `task:${task.meta.id}`);
}

// Runs a synchronous step as a Promise-returning hook, so anything it throws
// reaches the caller as a rejection rather than a synchronous throw.
export function settle<T>(call: () => T): Promise<T> {
  try {
    return Promise.resolve(call());
  } catch (err) {
    return Promise.reject(err);
  }
}

// Why `task` can never be woken ('an epic', or its done status's name under the
// project's `model`), or null. Checked when a wake gate is raised and when it runs.
export function wakeRefusal(task: TaskDoc, model: StatusModel): string | null {
  if (isContainerKind(task.meta.kind)) return 'an epic';
  if (isDoneStatus(task.meta.status, model)) return task.meta.status;
  return null;
}

// Who counts as external and what may reach them, as the A2A bridge decides.
export type ExternalPolicy = Required<
  Pick<MessagingHost, 'external' | 'admitExternal'>
>;

// dispatchd's MessagingHost: live runs and wakes from the orchestrator, policy
// and epic membership from the task store, gate effects from GateHandlers.
export class DaemonMessagingHost implements MessagingHost {
  private externalPolicy: ExternalPolicy | null = null;

  constructor(private readonly deps: DaemonHostDeps) {}

  // Installed by the A2A bridge; without one nothing is external.
  setExternalPolicy(policy: ExternalPolicy | null): void {
    this.externalPolicy = policy;
  }

  external(address: Address): ExternalKind | null {
    return this.externalPolicy?.external(address) ?? null;
  }

  admitExternal(
    target: ExternalTarget,
    sender: Sender,
    replyTarget: Message | null,
    message: Message
  ): ExternalAdmission {
    return (
      this.externalPolicy?.admitExternal(
        target,
        sender,
        replyTarget,
        message
      ) ?? 'deliver'
    );
  }

  liveRunFor(taskId: string): string | null {
    return this.deps.orchestrator.liveRunIdForTask(taskId);
  }

  isLiveRun(runId: string): boolean {
    return this.deps.orchestrator.isRunLive(runId);
  }

  taskOfRun(runId: string): string | null {
    return this.deps.orchestrator.taskIdOfRun(runId);
  }

  // Delivers into the run's conversation; a run that cannot take it rejects,
  // and the engine then holds the message.
  push(runId: string, rendered: string, message: Message): Promise<void> {
    return settle(() =>
      this.deps.orchestrator.deliverToRun(runId, rendered, {
        label: message.from,
        messageId: message.id,
        human: message.from.startsWith('human:'),
      })
    );
  }

  notify(runId: string, digest: string, message: Message): Promise<void> {
    return settle(() =>
      this.deps.orchestrator.notifyRun(runId, digest, message.id)
    );
  }

  notifyHuman(actor: Address, message: Message): void {
    this.deps.onHumanMessage(actor, message);
  }

  // Wakes a task as its local human sender (who may continue a finished run) or
  // as the system, or continues the one run a local human names; a throw fails.
  // The run acts for `acting` (by default the sender, on this request's token).
  async wake(
    target: Address,
    message: Message,
    acting: WakeActor = {
      actor: message.from,
      ownerCredential: answeredWithOwnerCredential(),
    }
  ): Promise<WakeResult> {
    // A remote sender's wake runs as the system and continues nothing.
    const human =
      message.origin === undefined && message.from.startsWith('human:');
    // A remote sender's own wake acts for no one; a local approver's for them.
    const operator =
      message.origin !== undefined && acting.actor === message.from
        ? null
        : actingOperator(
            acting.actor,
            acting.ownerCredential,
            this.deps.ownerRef
          );
    if (target.startsWith('run:') && human) {
      try {
        const meta = this.deps.orchestrator.wakeRun(
          target.slice('run:'.length),
          { actor: message.from, operator }
        );
        return { ok: true, runId: meta.id };
      } catch (err) {
        return {
          ok: false,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    }
    if (!target.startsWith('task:'))
      return { ok: false, reason: `cannot wake ${target}` };
    const taskId = target.slice('task:'.length);
    try {
      const meta = await this.deps.orchestrator.wakeTask(taskId, {
        actor: human ? message.from : 'agent:dispatch',
        continueFinished: human,
        operator,
      });
      return { ok: true, runId: meta.id };
    } catch (err) {
      this.deps.onWakeFailed?.(target, message, acting);
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Allows a local human's wake of a dispatchable task or of a run; any other
  // task wake follows the project's 'wake' policy, capped by the task's risk.
  decide(request: PolicyRequest): PolicyRuling {
    const target = request.target;
    const human =
      request.origin === undefined && request.message.from.startsWith('human:');
    if (target.startsWith('run:')) return human ? 'allow' : 'deny';
    if (!target.startsWith('task:')) return 'deny';
    const task = this.deps.store.get(target.slice('task:'.length));
    if (
      task === null ||
      wakeRefusal(task, statusModelFor(this.deps.rootDir)) !== null
    )
      return 'deny';
    // A local human's wake is their own call, so policy never gates it.
    if (human) return 'allow';
    const ruling: CorePolicyRuling = consultProjectPolicy(
      this.deps.rootDir,
      'wake',
      task.meta.risk
    );
    return ruling.mode === 'auto' ? 'allow' : 'ask';
  }

  owner(): Address {
    return this.deps.ownerRef;
  }

  // Only `epic/<id>` channels have implicit members: the epic's child tasks,
  // with no membership kept by hand.
  implicitMembers(channel: string): Address[] {
    return implicitEpicMembers(
      (epicId) => this.deps.store.list({ parent: epicId }),
      channel
    );
  }

  async onAnswered(question: Message, answer: Message): Promise<void> {
    await this.deps.gates.handle(question, answer);
  }

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
