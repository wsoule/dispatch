import type {
  PolicyRuling as CorePolicyRuling,
  TaskDoc,
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
export function settle(call: () => void): Promise<void> {
  try {
    call();
    return Promise.resolve();
  } catch (err) {
    return Promise.reject(err);
  }
}

// Why `task` can never be woken ('an epic', 'landed', 'dropped'), or null when
// a wake may dispatch it. Checked when a wake gate is raised and again when it runs.
export function wakeRefusal(task: TaskDoc): string | null {
  if (task.meta.kind === 'epic') return 'an epic';
  if (task.meta.status === 'landed' || task.meta.status === 'dropped')
    return task.meta.status;
  return null;
}

// dispatchd's MessagingHost: live runs and wakes from the orchestrator, policy
// and epic membership from the task store, gate effects from GateHandlers.
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

  notify(runId: string, digest: string): Promise<void> {
    return settle(() => this.deps.orchestrator.notifyRun(runId, digest));
  }

  notifyHuman(actor: Address, message: Message): void {
    this.deps.onHumanMessage(actor, message);
  }

  // Dispatches or resumes a sleeping task as the system actor; an orchestrator
  // throw (a live run already, say) becomes a failed WakeResult.
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

  // Denies waking anything but a dispatchable task; otherwise defers to the
  // project's 'wake' policy, capped by the task's declared risk.
  decide(request: PolicyRequest): PolicyRuling {
    const target = request.target;
    if (!target.startsWith('task:')) return 'deny';
    const task = this.deps.store.get(target.slice('task:'.length));
    if (task === null || wakeRefusal(task) !== null) return 'deny';
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
