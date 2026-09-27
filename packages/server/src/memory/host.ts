import type { PolicyRuling, TaskDoc, TaskStorePort } from '@dispatch/core';
import { MemoryError } from '@dispatch/memory';
import type {
  IndexContext,
  MemoryChange,
  MemoryHost,
  Operator,
  Principal,
} from '@dispatch/memory';

import type { EventBus } from '../events.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';

export interface DaemonMemoryHostDeps {
  projectKey: string;
  store: TaskStorePort;
  orchestrator: Pick<Orchestrator, 'taskIdOfRun'>;
  events: Pick<EventBus, 'broadcast'>;
  now?: () => Date;
}

// dispatchd's MemoryHost. With no personal scope and no memory gate, no
// principal has an operator and every proposal waits for a human.
export class DaemonMemoryHost implements MemoryHost {
  constructor(private readonly deps: DaemonMemoryHostDeps) {}

  operatorOf(_principal: Principal): Operator | null {
    return null;
  }

  projectKey(): string {
    return this.deps.projectKey;
  }

  // A corrupt task file reads as "no context", never as a failed dispatch.
  taskContext(taskId: string): IndexContext | null {
    let task: TaskDoc | null;
    try {
      task = this.deps.store.get(taskId);
    } catch {
      return null;
    }
    if (task === null) return null;
    return {
      taskId,
      title: task.meta.title,
      body: task.body,
      writes: task.meta.writes,
      epic: task.meta.parent,
      risk: task.meta.risk,
      a2a: false,
    };
  }

  taskOfPrincipal(principal: Principal): string | null {
    return principal.kind === 'run'
      ? this.deps.orchestrator.taskIdOfRun(
          principal.address.slice('run:'.length)
        )
      : null;
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

  // Policy never approves a proposal on its own while there is no memory gate.
  rule(): PolicyRuling {
    return { mode: 'block' };
  }

  // The engine logs the refusal and keeps the proposal open for recovery.
  raiseGate(): Promise<string> {
    return Promise.reject(
      new MemoryError('unavailable', 'the memory gate is not available', 'gate')
    );
  }

  // Unreachable while `rule` always blocks.
  recordPolicyApproval(): void {}

  // Live runs are not told about new shared lessons.
  entryActivated(): void {}

  // Only the memory gate rejects a proposal, so there is no author to tell.
  proposalRejected(): void {}
}
