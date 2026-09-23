import type {
  PolicyRuling as CorePolicyRuling,
  TaskStorePort,
} from '@dispatch/core';
import type {
  Address,
  Message,
  MessagingHost,
  PolicyRequest,
  PolicyRuling,
  WakeResult,
} from '@dispatch/protocol';

import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { consultProjectPolicy } from '../policyEngine.js';
import type { GateHandlers } from './gates.js';

export interface DaemonHostDeps {
  rootDir: string;
  orchestrator: Pick<
    Orchestrator,
    | 'liveRunIdForTask'
    | 'isRunLive'
    | 'taskIdOfRun'
    | 'deliverToRun'
    | 'notifyRun'
    | 'dispatchOrResume'
  >;
  // Read-only: task parent/kind/status/risk lookups for wake policy and
  // epic channel membership.
  store: TaskStorePort;
  ownerRef: string;
  gates: GateHandlers;
  onHumanMessage: (actor: string, message: Message) => void;
  now?: () => Date;
}

// dispatchd's MessagingHost: everything the protocol engine needs from the
// product, wired to the orchestrator (live runs, wake/dispatch), the task
// store (policy lookups, epic channel membership) and the gate router
// (answered gate effects).
export class DaemonMessagingHost implements MessagingHost {
  constructor(private readonly deps: DaemonHostDeps) {}

  liveRunFor(taskId: string): string | null {
    return this.deps.orchestrator.liveRunIdForTask(taskId);
  }

  isLiveRun(runId: string): boolean {
    return this.deps.orchestrator.isRunLive(runId);
  }

  taskOfRun(runId: string): string | null {
    return this.deps.orchestrator.taskIdOfRun(runId);
  }

  // Delivers into the run's own conversation. deliverToRun throws when the
  // run isn't actually live; the engine catches that and holds the message
  // instead of losing it.
  async push(runId: string, rendered: string, message: Message): Promise<void> {
    this.deps.orchestrator.deliverToRun(runId, rendered, {
      label: message.from,
      messageId: message.id,
      human: message.from.startsWith('human:'),
    });
  }

  async notify(runId: string, digest: string): Promise<void> {
    this.deps.orchestrator.notifyRun(runId, digest);
  }

  notifyHuman(actor: Address, message: Message): void {
    this.deps.onHumanMessage(actor, message);
  }

  // Wakes a sleeping task by dispatching (or resuming) it as the system
  // actor. A throw from the orchestrator (e.g. the task already has a live
  // run) becomes a WakeResult failure rather than an unhandled rejection.
  async wake(target: Address, _message: Message): Promise<WakeResult> {
    if (!target.startsWith('task:'))
      return { ok: false, reason: `cannot wake ${target}` };
    const taskId = target.slice('task:'.length);
    try {
      const meta = await this.deps.orchestrator.dispatchOrResume(taskId, {
        actor: 'agent:dispatch',
      });
      return { ok: true, runId: meta.id };
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // Denies waking anything but a live, dispatchable task (no epic, not
  // landed/dropped); otherwise defers to the project's autonomy policy for
  // the 'wake' gate, capped by the task's declared risk.
  decide(request: PolicyRequest): PolicyRuling {
    const target = request.target;
    if (!target.startsWith('task:')) return 'deny';
    const task = this.deps.store.get(target.slice('task:'.length));
    if (
      task === null ||
      task.meta.kind === 'epic' ||
      task.meta.status === 'landed' ||
      task.meta.status === 'dropped'
    ) {
      return 'deny';
    }
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

  // Only `epic/<id>` channels have implicit members — every task parented to
  // that epic — so a message to the epic's channel reaches its children
  // without anyone maintaining membership by hand.
  implicitMembers(channel: string): Address[] {
    const match = /^epic\/(.+)$/.exec(channel);
    if (match === null) return [];
    return this.deps.store
      .list({ parent: match[1] })
      .map((task) => `task:${task.meta.id}`);
  }

  async onAnswered(question: Message, answer: Message): Promise<void> {
    await this.deps.gates.handle(question, answer);
  }

  now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}
