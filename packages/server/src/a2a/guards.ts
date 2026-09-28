import type { A2AStore } from '@dispatch/a2a';
import { hasA2AProvenance } from '@dispatch/a2a';
import type {
  TaskDoc,
  TaskRisk,
  TaskStorePort,
  UpdatePatch,
} from '@dispatch/core';
import { canonicalStatus } from '@dispatch/core';
import type { Address, DeliveryEngine } from '@dispatch/protocol';
import { gateOf, MessagingError, SYSTEM_ADDRESS } from '@dispatch/protocol';

import type { EventBus } from '../events.js';
import { SYSTEM_SENDER } from '../messaging/gates.js';
import type { AuthTier } from '../tiers.js';
import { tierAllows } from '../tiers.js';

// What the guards need; no BridgeDeps, because they must hold with a2a.db down.
export interface GuardDeps {
  engine: DeliveryEngine;
  tasks: TaskStorePort;
  ownerRef: Address;
  updateTask(id: string, patch: UpdatePatch): TaskDoc;
  // Null when a2a.db could not be opened.
  store: A2AStore | null;
}

export interface OpenProposal {
  rowId: string;
  gateId: string;
  taskId: string;
}

export type PatchGuard =
  | { ok: true }
  | { ok: false; status: 403 | 409; error: string };

const RISK_RANK: Record<TaskRisk, number> = {
  routine: 0,
  elevated: 1,
  critical: 2,
};
const REVERT_LINE = 'reverted: A2A proposal awaits the owner';

function awaiting(taskId: string): string {
  return `${taskId} is an A2A proposal awaiting the owner; answer it in Needs you`;
}

// Every open task-proposal gate the system asked, from messages.db alone.
function openProposals(deps: GuardDeps): OpenProposal[] {
  const out: OpenProposal[] = [];
  for (const question of deps.engine.openBlocking()) {
    if (question.from !== SYSTEM_ADDRESS) continue;
    const gate = gateOf(question);
    if (gate?.type === 'task-proposal')
      out.push({ rowId: gate.message, gateId: question.id, taskId: gate.task });
  }
  return out;
}

// Read from messages.db alone (the open gate itself), so it holds with a2a.db down.
export function openProposalFor(
  deps: GuardDeps,
  taskId: string
): OpenProposal | null {
  return openProposals(deps).find((p) => p.taskId === taskId) ?? null;
}

// a2a.db answers when open; with it down, fail closed on the task's own provenance.
function isA2ATask(deps: GuardDeps, taskId: string): boolean {
  return deps.store !== null
    ? deps.store.taskForDispatchTask(taskId) !== null
    : hasA2AProvenance(deps.tasks.get(taskId));
}

export function dispatchRefusal(deps: GuardDeps, task: TaskDoc): string | null {
  return openProposalFor(deps, task.meta.id) === null
    ? null
    : awaiting(task.meta.id);
}

// Below decide, a gated draft is frozen; at decide, a status change is the
// owner's answer to the gate. After approval, only decide lowers the risk.
export async function guardTaskPatch(
  deps: GuardDeps,
  taskId: string,
  patch: UpdatePatch,
  caller: { tier: AuthTier; ref: string }
): Promise<PatchGuard> {
  const deciding = tierAllows(caller.tier, 'decide');
  const proposal = openProposalFor(deps, taskId);
  if (proposal !== null) {
    if (!deciding) return { ok: false, status: 409, error: awaiting(taskId) };
    const status =
      patch.status === undefined ? 'draft' : canonicalStatus(patch.status);
    if (status !== 'draft') {
      const choice = status === 'dropped' ? 'decline' : 'approve';
      try {
        await deps.engine.reply(
          proposal.gateId,
          { body: '', choice },
          { address: caller.ref, canDecide: true }
        );
      } catch (err) {
        if (!(err instanceof MessagingError && err.code === 'conflict'))
          throw err;
        return {
          ok: false,
          status: 409,
          error: `${taskId}'s A2A proposal was just answered; reload and try again`,
        };
      }
    }
    return { ok: true };
  }
  if (deciding || patch.risk === undefined) return { ok: true };
  const current = deps.tasks.get(taskId);
  if (
    current !== null &&
    RISK_RANK[patch.risk] < RISK_RANK[current.meta.risk] &&
    isA2ATask(deps, taskId)
  ) {
    return {
      ok: false,
      status: 403,
      error: "lowering an A2A task's risk needs the decide tier",
    };
  }
  return { ok: true };
}

// Puts a gated draft that anything but its gate moved back in Draft, and
// tells the owner once per gate.
export class ProposalGuard {
  private readonly told = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: GuardDeps,
    private readonly events: EventBus,
    private readonly coalesceMs = 1000
  ) {}

  // Rechecks once per burst of task.changed events.
  start(): () => void {
    const off = this.events.subscribe((e) => {
      if (e.type === 'task.changed') this.schedule();
    });
    return () => {
      off();
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  private schedule(): void {
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      try {
        this.recheck();
      } catch (err) {
        console.error('a2a: could not recheck A2A proposals', err);
      }
    }, this.coalesceMs);
  }

  // Returns how many drafts it put back; one that fails is logged and skipped.
  recheck(): number {
    let reverted = 0;
    for (const proposal of openProposals(this.deps)) {
      try {
        if (this.revert(proposal)) reverted += 1;
      } catch (err) {
        console.error(`a2a: could not put ${proposal.taskId} back`, err);
      }
    }
    return reverted;
  }

  revertIfMoved(taskId: string): boolean {
    const proposal = openProposalFor(this.deps, taskId);
    return proposal !== null && this.revert(proposal);
  }

  private revert(proposal: OpenProposal): boolean {
    const task = this.deps.tasks.get(proposal.taskId);
    if (task === null || canonicalStatus(task.meta.status) === 'draft')
      return false;
    this.deps.updateTask(proposal.taskId, {
      status: 'draft',
      appendActivity: `${new Date().toISOString()} ${REVERT_LINE}`,
    });
    if (!this.told.has(proposal.gateId)) {
      this.told.add(proposal.gateId);
      this.notify(proposal).catch((err: unknown) =>
        console.error(
          `a2a: could not tell the owner about ${task.meta.id}`,
          err
        )
      );
    }
    return true;
  }

  // Keyed by the gate, so a restart that reverts again replays this notice.
  private async notify(proposal: OpenProposal): Promise<void> {
    await this.deps.engine.send(
      {
        to: [this.deps.ownerRef],
        kind: 'notice',
        body: `${proposal.taskId} was moved while its A2A proposal is open; it is back in Draft. Answer the proposal in Needs you.`,
        refs: [{ type: 'message', id: proposal.gateId }],
        idempotencyKey: `a2a-revert:${proposal.gateId}`,
      },
      SYSTEM_SENDER
    );
  }
}
