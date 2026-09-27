import { CANONICAL_STATUSES } from '@dispatch/core';
import { gateOf, isSystemMarker } from '@dispatch/protocol';
import type { Address, JsonValue, Message } from '@dispatch/protocol';
import { createHash } from 'node:crypto';

import { answerArtifact, workArtifacts } from './artifacts.js';
import { encodeMessage } from './codec.js';
import type { MessageView, TextMediaType } from './codec.js';
import type { GateStateV1, GateTypeName, WorkStateV1 } from './ext.js';
import type { TaskFacts } from './port.js';
import { wireState } from './states.js';
import type { TaskStateName } from './states.js';
import { GATE_URI, WORK_URI } from './uris.js';
import type { ExtensionUri } from './uris.js';
import type { ArtifactJson, MessageJson, TaskJson } from './wire.js';

// A task's status text: an in-scope message, or a fixed system sentence
// with a stable id.
export type StatusText =
  | { kind: 'message'; message: Message }
  | { kind: 'fixed'; text: string; id: string };

export interface Decision {
  row: number;
  state: TaskStateName;
  stage?: 'review' | 'landing';
  status: StatusText;
}

// How one caller reads a task: its address, active extensions, output mode,
// history cap (null for the default) and whether it asked for artifacts.
export interface ProjectionView {
  client: Address;
  extensions: ReadonlySet<ExtensionUri>;
  textMediaType: TextMediaType;
  historyLength: number | null;
  includeArtifacts: boolean;
}

export const GATE_SENTENCES: Record<GateTypeName, string> = {
  'task-proposal': 'Waiting for the project owner to approve this handoff.',
  'tool-approval': 'Waiting for the project owner to approve a tool call.',
  scope: 'Waiting for the project owner to approve a change of scope.',
  wake: 'Waiting for the project owner to approve waking the task.',
};
const DEFAULT_HISTORY = 50;
const WORKING_STATUSES = new Set(['working', 'review', 'landing']);
const CANONICAL = new Set<string>(CANONICAL_STATUSES);

type LinkedTask = Exclude<TaskFacts['task'], 'deleted' | null>;
function linked(f: TaskFacts): LinkedTask | null {
  return f.task !== null && f.task !== 'deleted' ? f.task : null;
}

// Never a gate: its body quotes tool input, and a port bug must not put it on the wire.
function latestFromOthers(f: TaskFacts): Message | null {
  for (let i = f.scope.length - 1; i >= 0; i--) {
    const m = f.scope[i];
    if (m.from !== f.client && gateOf(m) === null) return m;
  }
  return null;
}

// The first matching row of the task-state table; pure, so GetTask,
// ListTasks, SSE and the host's state cache all agree.
export function decideState(f: TaskFacts): Decision {
  const staged = (stage?: 'review' | 'landing') =>
    stage === undefined ? {} : { stage };
  const fixed = (
    row: number,
    state: TaskStateName,
    text: string,
    stage?: 'review' | 'landing'
  ): Decision => ({
    row,
    state,
    status: { kind: 'fixed', text, id: `${f.id}~${row}` },
    ...staged(stage),
  });
  const said = (
    row: number,
    state: TaskStateName,
    message: Message | null,
    fallback: string,
    stage?: 'review' | 'landing'
  ): Decision =>
    message === null
      ? fixed(row, state, fallback, stage)
      : { row, state, status: { kind: 'message', message }, ...staged(stage) };
  const handoff = f.skill === 'handoff';
  const task = linked(f);

  if (f.canceledAt !== null)
    return fixed(1, 'CANCELED', 'Canceled by the client.');
  if (
    f.declinedAt !== null ||
    (handoff && (f.answer?.choice === 'decline' || f.dropped === 'other'))
  ) {
    return said(
      2,
      'REJECTED',
      f.answer,
      'The project owner dropped this task.'
    );
  }
  if (
    !handoff &&
    ((f.answer !== null && isSystemMarker(f.answer, 'x-closed')) ||
      f.recipientTaskDropped)
  ) {
    return said(
      3,
      'FAILED',
      f.answer,
      'The task this was asked of was dropped.'
    );
  }
  if (handoff && f.task === 'deleted')
    return fixed(4, 'FAILED', 'The task was deleted.');
  if (!handoff && f.answer !== null)
    return said(5, 'COMPLETED', f.answer, 'Answered.');
  if (task?.status === 'landed') return fixed(6, 'COMPLETED', 'Landed.');
  const question = f.openQuestions.find((q) => gateOf(q) === null);
  if (question !== undefined)
    return said(7, 'INPUT_REQUIRED', question, 'Input required.');
  const gate = [...f.openGates].sort((a, b) =>
    a.openedAt.localeCompare(b.openedAt)
  )[0];
  if (gate !== undefined) {
    return {
      row: 8,
      state: 'AUTH_REQUIRED',
      status: {
        kind: 'fixed',
        text: GATE_SENTENCES[gate.type],
        id: `${f.id}~8~${gate.id}`,
      },
    };
  }
  if (task !== null) {
    if (WORKING_STATUSES.has(task.status) || !CANONICAL.has(task.status)) {
      const stage =
        task.status === 'review' || task.status === 'landing'
          ? task.status
          : undefined;
      return said(9, 'WORKING', latestFromOthers(f), 'Working.', stage);
    }
    if ((task.status === 'draft' || task.status === 'ready') && task.approved) {
      return fixed(10, 'SUBMITTED', 'Approved; waiting to be scheduled.');
    }
  }
  if (
    !handoff &&
    f.rootDeliveries.length > 0 &&
    f.rootDeliveries.every((s) => s === 'held')
  ) {
    return fixed(
      11,
      'SUBMITTED',
      `Delivered to ${f.root.to.join(', ')}'s mailbox.`
    );
  }
  return said(12, 'WORKING', latestFromOthers(f), 'Working.');
}

// When the decided status took effect: its message's time, else the cancel,
// decline or gate time, else the latest in-scope message.
export function statusAt(f: TaskFacts, d: Decision): string {
  if (d.status.kind === 'message') return d.status.message.createdAt;
  const statusId = d.status.id;
  const gate =
    d.row === 8
      ? f.openGates.find((g) => statusId === `${f.id}~8~${g.id}`)
      : undefined;
  return (
    f.canceledAt ??
    f.declinedAt ??
    gate?.openedAt ??
    f.scope.at(-1)?.createdAt ??
    f.createdAt
  );
}

function withExtension(
  message: MessageJson,
  uri: ExtensionUri,
  value: GateStateV1 | WorkStateV1
): void {
  message.metadata = {
    ...message.metadata,
    [uri]: value as unknown as JsonValue,
  };
  message.extensions = [...(message.extensions ?? []), uri];
}

// One task as ProtoJSON for one caller: the decided state and status, the
// gate and work extensions it activated, capped history and any artifacts.
export function project(f: TaskFacts, view: ProjectionView): TaskJson {
  const decision = decideState(f);
  const messageView: MessageView = {
    client: view.client,
    textMediaType: view.textMediaType,
    extensions: view.extensions,
    clientIds: f.clientIds,
    taskId: f.id,
  };
  const status: MessageJson =
    decision.status.kind === 'message'
      ? encodeMessage(decision.status.message, messageView)
      : {
          messageId: decision.status.id,
          contextId: f.contextId,
          taskId: f.id,
          role: 'ROLE_AGENT',
          parts: [
            { text: decision.status.text, mediaType: view.textMediaType },
          ],
        };
  if (decision.state === 'AUTH_REQUIRED' && view.extensions.has(GATE_URI)) {
    // Only each gate's id, type and time leave; never its payload.
    withExtension(status, GATE_URI, {
      gates: f.openGates.map((g) => ({
        id: g.id,
        type: g.type,
        openedAt: g.openedAt,
        waitingOn: 'owner',
      })),
    });
  }
  const json: TaskJson = {
    id: f.id,
    contextId: f.contextId,
    status: { state: wireState(decision.state), message: status },
  };
  if (view.includeArtifacts) {
    const artifacts: ArtifactJson[] = [
      ...(decision.row === 5 && f.answer !== null
        ? [answerArtifact(f.answer, view)]
        : []),
      ...workArtifacts(f.work, view),
      ...(f.hostArtifacts ?? []),
    ];
    if (artifacts.length > 0) json.artifacts = artifacts;
  }
  const limit = view.historyLength ?? DEFAULT_HISTORY;
  json.history =
    limit <= 0
      ? []
      : f.scope
          .filter((m) => gateOf(m) === null)
          .slice(-limit)
          .map((m) => encodeMessage(m, messageView));
  const task = linked(f);
  if (f.skill === 'handoff' && task !== null && view.extensions.has(WORK_URI)) {
    const work: WorkStateV1 = {
      task: task.id,
      title: task.title,
      status: task.status,
      ...(decision.stage === undefined ? {} : { stage: decision.stage }),
    };
    json.metadata = { [WORK_URI]: work as unknown as JsonValue };
    withExtension(status, WORK_URI, work);
  }
  return json;
}

// An answer that matched none of the offered choices: the task's status says so.
export function withReask(
  task: TaskJson,
  reask: string | null,
  view: ProjectionView
): TaskJson {
  if (reask === null) return task;
  return {
    ...task,
    status: {
      ...task.status,
      message: {
        messageId: `${task.id}~reask`,
        contextId: task.contextId,
        taskId: task.id,
        role: 'ROLE_AGENT',
        parts: [{ text: reask, mediaType: view.textMediaType }],
      },
    },
  };
}

// A sha256 of what a watcher must see change: the decision, the scope's ids,
// the work and host artifacts and the linked task.
export function projectionKey(f: TaskFacts): string {
  const d = decideState(f);
  const statusId =
    d.status.kind === 'message' ? d.status.message.id : d.status.id;
  return createHash('sha256')
    .update(
      JSON.stringify([
        d.row,
        d.state,
        d.stage ?? null,
        statusId,
        f.scope.map((m) => m.id),
        f.work,
        f.task,
        f.hostArtifacts ?? [],
      ])
    )
    .digest('hex');
}
