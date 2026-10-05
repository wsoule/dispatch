import type { A2AStore, HandoffStatuses } from '@dispatch-foo/a2a';
import { isClientAddress } from '@dispatch-foo/a2a';
import type {
  TaskDoc,
  TaskRisk,
  TaskStorePort,
  UpdatePatch,
} from '@dispatch-foo/core';
import type {
  Address,
  DeliveryEngine,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import { gateOf, MessagingError, SYSTEM_ADDRESS } from '@dispatch-foo/protocol';

import type { EventBus } from '../events.js';
import { SYSTEM_SENDER } from '../messaging/gates.js';
import type { AuthTier } from '../tiers.js';
import { tierAllows } from '../tiers.js';
import { proposalKey } from './handoff.js';
import type { A2ALineage } from './lineage.js';
import { draftOfRoot } from './reconcile.js';

// What the guards need; no BridgeDeps, because they must hold with a2a.db down.
export interface GuardDeps {
  engine: DeliveryEngine;
  messages: Pick<SqliteMessageStore, 'byIdemKey'>;
  tasks: TaskStorePort;
  ownerRef: Address;
  updateTask(id: string, patch: UpdatePatch): TaskDoc;
  statuses: () => HandoffStatuses;
  // Null when a2a.db could not be opened.
  store: A2AStore | null;
  // Tasks A2A-origin by lineage (XH-R2); absent in tests that build bare deps.
  lineage?: A2ALineage;
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

function unapproved(taskId: string): string {
  return `${taskId} is an A2A handoff the owner has not approved`;
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

// a2a.db answers when it links the task; otherwise (or while it fails) messages.db
// must tie it to a handoff, or an A2A run must have made, edited or dispatched
// it (lineage). Provenance text alone never counts.
export function isA2ATask(deps: GuardDeps, taskId: string): boolean {
  if (deps.lineage?.has(taskId) === true) return true;
  try {
    if ((deps.store?.taskForDispatchTask(taskId) ?? null) !== null) return true;
    if ((deps.store?.derivedFrom(taskId) ?? null) !== null) return true;
  } catch (err) {
    console.error(`dispatchd: could not read ${taskId}'s A2A record`, err);
  }
  const task = deps.tasks.get(taskId);
  return task !== null && handoffRoots(deps, task).length > 0;
}

const PROVENANCE = /Requested over A2A by \S+ \(message ([^)\s]+)\)\./g;

// Roots messages.db ties to `task`, from those its provenance lines name: by a system
// gate naming the task or, gateless (a failed link), a client root that drafted it.
function handoffRoots(deps: GuardDeps, task: TaskDoc): string[] {
  const named = new Set(
    Array.from(task.body.matchAll(PROVENANCE), (m) => m[1])
  );
  return [...named].filter((rootId) => {
    const gate = deps.messages.byIdemKey(SYSTEM_ADDRESS, proposalKey(rootId));
    if (gate !== null) {
      const data = gate.origin === undefined ? gateOf(gate) : null;
      return data?.type === 'task-proposal' && data.task === task.meta.id;
    }
    const root = deps.engine.getMessage(rootId);
    if (
      root === null ||
      root.origin !== undefined ||
      root.kind !== 'handoff' ||
      !root.to.includes(SYSTEM_ADDRESS) ||
      !isClientAddress(root.from)
    )
      return false;
    const linked = deps.store?.getTask(rootId)?.dispatchTask ?? null;
    return (
      (linked === null || linked === task.meta.id) && draftOfRoot(task, root)
    );
  });
}

// Whether the task came from an A2A handoff the system has not accepted.
function unapprovedHandoff(deps: GuardDeps, task: TaskDoc | null): boolean {
  if (task === null) return false;
  const accepted = (root: string) =>
    deps.engine.answerOf(root)?.choice === 'accept';
  const row = deps.store?.taskForDispatchTask(task.meta.id) ?? null;
  if (row !== null) return row.skill === 'handoff' && !accepted(row.id);
  return !handoffRoots(deps, task).every(accepted);
}

export function dispatchRefusal(deps: GuardDeps, task: TaskDoc): string | null {
  if (openProposalFor(deps, task.meta.id) !== null)
    return awaiting(task.meta.id);
  return unapprovedHandoff(deps, task) ? unapproved(task.meta.id) : null;
}

// Below decide, an unapproved handoff's task is frozen; at decide, a status
// change answers its open gate. After approval, only decide lowers the risk.
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
    const phase =
      patch.status === undefined
        ? 'draft'
        : deps.statuses().phase(patch.status);
    if (phase !== 'draft') {
      const choice = phase === 'dropped' ? 'decline' : 'approve';
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
  if (!deciding && unapprovedHandoff(deps, deps.tasks.get(taskId)))
    return { ok: false, status: 409, error: unapproved(taskId) };
  // An A2A task's spec is the client's words; only a decider rewrites it.
  const specEdit =
    patch.description !== undefined ||
    patch.body !== undefined ||
    patch.acceptanceCriteria !== undefined;
  if (!deciding && specEdit && isA2ATask(deps, taskId))
    return {
      ok: false,
      status: 403,
      error: "editing an A2A task's description or body needs the decide tier",
    };
  // Moving an A2A task under another epic changes what its runs see (XH-R5).
  if (!deciding && patch.parent !== undefined && isA2ATask(deps, taskId))
    return {
      ok: false,
      status: 403,
      error: 're-parenting an A2A task needs the decide tier',
    };
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
    const statuses = this.deps.statuses();
    if (
      task === null ||
      statuses.draft === null ||
      statuses.phase(task.meta.status) === 'draft'
    )
      return false;
    this.deps.updateTask(proposal.taskId, {
      status: statuses.draft,
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
