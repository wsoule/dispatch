import type {
  Caller,
  OpenInput,
  OpenResult,
  TaskLink,
  TaskRow,
} from '@dispatch/a2a';
import {
  handoffSupported,
  parseWorkExt,
  shapeDraft,
  unwrapExternalData,
  wrapExternalData,
} from '@dispatch/a2a';
import { canonicalStatus } from '@dispatch/core';
import type { Address, Message } from '@dispatch/protocol';
import { gateOf, MessagingError, SYSTEM_ADDRESS } from '@dispatch/protocol';

import { SYSTEM_SENDER } from '../messaging/gates.js';
import type { BridgeDeps } from './port.js';
import { rowFor } from './reconcile.js';
import type { BridgeWatch } from './watch.js';

const DAY_MS = 24 * 60 * 60 * 1000;

// The proposal gate's idempotency key: a resend after a crash is a replay.
export function proposalKey(rootId: string): string {
  return `task-proposal:${rootId}`;
}

// A client's handoff: its root to the system, a checked draft, then the
// owner's proposal gate. The port has already applied its limits and refs rule.
export async function openHandoff(
  deps: BridgeDeps,
  hub: BridgeWatch,
  caller: Caller,
  input: OpenInput
): Promise<OpenResult> {
  // Parsed again so every BridgePort caller gets the same field limits.
  const work = parseWorkExt(input.work);
  if (work?.skill !== 'handoff')
    throw new MessagingError(
      'invalid',
      'hand off work with the work extension (skill: handoff)',
      'work.skill'
    );
  if (!handoffSupported(deps.statuses()))
    throw new MessagingError(
      'invalid',
      'this project does not take handoffs',
      'work.skill'
    );
  const policy = deps.policy();
  const now = deps.now?.() ?? new Date();
  const dayAgo = new Date(now.getTime() - DAY_MS).toISOString();
  if (
    deps.store.countSince(caller.address, 'handoff', dayAgo) >=
    policy.handoffsPerDay
  ) {
    throw new MessagingError(
      'limited',
      `at most ${policy.handoffsPerDay} handoffs per day`,
      'from'
    );
  }
  // Checked before anything is stored, so a bad field leaves no orphan root.
  const invalid = deps.validateTask(
    shapeDraft(work, input.body, caller.address, 'm-probe')
  );
  if (invalid !== null) throw new MessagingError('invalid', invalid, 'work');
  const data = wrapExternalData([
    {
      work: { ...work },
      ...(input.data === undefined
        ? {}
        : { data: unwrapExternalData(input.data) }),
    },
  ]);
  const sent = await deps.engine.send(
    {
      to: [SYSTEM_ADDRESS],
      kind: 'handoff',
      body: input.body,
      refs: input.refs,
      idempotencyKey: input.clientMessageId,
      ...(data === undefined ? {} : { data }),
    },
    { address: caller.address, canDecide: false }
  );
  const root = sent.message;
  deps.store.insertTask(rowFor(caller.address, root));
  // A concurrent duplicate: the first send is building the draft and gate.
  if (sent.replayed === true) return { kind: 'task', taskId: root.id };
  const doc = deps.createTask(
    shapeDraft(work, input.body, caller.address, root.id)
  );
  const row = { ...rowFor(caller.address, root), dispatchTask: doc.meta.id };
  deps.store.updateTask(root.id, { dispatchTask: doc.meta.id });
  await sendProposalGate(deps, row, doc.meta.title);
  hub.recompute(root.id);
  return { kind: 'task', taskId: root.id };
}

// Backslash-escapes markdown syntax so a client's title quotes as text.
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_~[\]()!<>|#]/g, '\\$&');
}

// Asks the owner to approve the row's draft, as the system, and records the gate.
export async function sendProposalGate(
  deps: BridgeDeps,
  row: TaskRow,
  title: string
): Promise<string> {
  const task = row.dispatchTask;
  if (task === null) throw new Error(`a2a task ${row.id} has no draft`);
  const { message } = await deps.engine.send(
    {
      to: [deps.ownerRef],
      kind: 'question',
      blocking: true,
      choices: ['approve', 'decline'],
      replyTo: row.id,
      idempotencyKey: proposalKey(row.id),
      body: `${row.client} proposes a task over A2A: "${escapeMarkdown(title)}" (${task}). Approve to move it to Ready; nothing runs until you do.`,
      data: {
        type: 'task-proposal',
        task,
        proposedBy: row.client,
        message: row.id,
      },
    },
    SYSTEM_SENDER
  );
  deps.store.updateTask(row.id, { gate: message.id });
  return message.id;
}

// The system's answer to the client's root; an answer already there is a replay.
export async function answerRoot(
  deps: BridgeDeps,
  row: TaskRow,
  choice: 'accept' | 'decline',
  declined = 'Declined by the project owner.'
): Promise<void> {
  const root = deps.engine.getMessage(row.id);
  if (root === null) return;
  const task = row.dispatchTask;
  try {
    await deps.engine.send(
      {
        to: [root.from],
        kind: 'answer',
        replyTo: row.id,
        choice,
        body: choice === 'accept' ? `Accepted as ${task}.` : declined,
        refs:
          choice === 'accept' && task !== null
            ? [{ type: 'task', id: task }]
            : [],
      },
      SYSTEM_SENDER
    );
  } catch (err) {
    if (err instanceof MessagingError && err.code === 'conflict') return;
    throw err;
  }
}

// The proposal's effect, for the gate a2a.db links to this root and draft;
// idempotent, because a replay or boot reconciliation can run it again.
export async function handleProposal(
  deps: BridgeDeps,
  hub: BridgeWatch,
  question: Message,
  answer: Message
): Promise<void> {
  const gate = gateOf(question);
  if (question.from !== SYSTEM_ADDRESS || gate?.type !== 'task-proposal')
    return;
  const row = deps.store.getTask(gate.message);
  if (
    row === null ||
    row.gate !== question.id ||
    row.dispatchTask !== gate.task
  )
    return;
  const task = deps.tasks.get(gate.task);
  if (answer.choice === 'approve') {
    if (task !== null && canonicalStatus(task.meta.status) === 'draft')
      deps.updateTask(gate.task, { status: 'ready' });
    await answerRoot(deps, row, 'accept');
  } else {
    if (task !== null && task.meta.status !== 'dropped')
      deps.updateTask(gate.task, { status: 'dropped' });
    await answerRoot(deps, row, 'decline');
  }
  hub.recompute(row.id);
}

// Whether the owner approved the row's handoff: the system accepted its root.
function approved(deps: BridgeDeps, row: TaskRow): boolean {
  return (
    row.skill === 'handoff' &&
    row.dispatchTask !== null &&
    deps.engine.answerOf(row.id)?.choice === 'accept'
  );
}

// A handoff's Dispatch task, whether it was approved, and its runs.
export function linkOf(deps: BridgeDeps, row: TaskRow): TaskLink | null {
  if (row.skill !== 'handoff' || row.dispatchTask === null) return null;
  const taskId = row.dispatchTask;
  const runIds = new Set(
    deps.runs
      .list()
      .filter((r) => r.taskId === taskId)
      .map((r) => r.id)
  );
  return { taskId, approved: approved(deps, row), runIds };
}

// The Dispatch tasks of `client`'s approved handoffs.
export function approvedTasksOf(
  deps: BridgeDeps,
  client: Address
): Set<string> {
  const out = new Set<string>();
  for (const row of deps.store.tasksOf(client)) {
    if (row.dispatchTask !== null && approved(deps, row))
      out.add(row.dispatchTask);
  }
  return out;
}
