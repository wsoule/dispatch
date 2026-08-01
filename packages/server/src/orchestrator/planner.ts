import { PRIORITIES } from '@dispatch/core';
import type { Priority } from '@dispatch/core';

import { OrchestratorClientError } from './types.js';

// One task the planner proposes. `blockedByIndices` refers to *other
// entries in this same proposal's `tasks` array* (0-based) — never a real
// task id, since ids are minted only at confirm time (spec §5's
// confirm-before-write rule). `priority` mirrors core's Priority enum so a
// proposal is directly writable via TaskStore.create once confirmed.
export interface PlannedTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  blockedByIndices: number[];
  priority: Priority;
}

// The single-task shape a reviewer edits before saving — a `PlannedTask`
// minus `blockedByIndices`, directly mappable to core's `CreateInput`.
export interface TaskDraft {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: Priority;
}

// The shape a Planner produces and a client confirms. `epic` is optional —
// a plan can propose a flat set of tasks with no wrapping epic. Nothing
// here carries a `status` field on purpose: every task this proposal
// eventually creates starts `todo` and the epic starts `todo`, full stop —
// a proposal has no way to ask for anything else (Global Constraints).
export interface PlanProposal {
  epic?: { title: string; description: string };
  tasks: PlannedTask[];
}

// One assistant turn in a plan conversation: the natural-language `reply`
// the planner just produced, the `proposal` it is working toward *after* this
// turn (refined across turns — never final until a human confirms it), and an
// opaque `sessionId` the planner hands back so the next turn can resume with
// full prior context. `sessionId` is deliberately opaque to PlanManager (it's
// the Agent SDK's own session id for ClaudePlanner, a turn counter for
// FakePlanner) — the manager only stores it and threads it back into the next
// `sendMessage` call, never interprets it.
export interface PlannerTurn {
  reply: string;
  proposal: PlanProposal;
  sessionId?: string;
}

// The load-bearing planner seam (mirrors Executor in types.ts): a durable,
// read-only planning *conversation* rather than a single prompt-in/proposal-
// out call. `start` opens the conversation from the user's first prompt;
// `sendMessage` continues an existing one with a follow-up user message,
// resuming from the prior turn's `sessionId` so context carries across turns.
// Both return a PlannerTurn. FakePlanner (tests) and ClaudePlanner (the real
// Agent SDK, permissionMode 'plan', SDK session resume between turns) both
// implement this so PlanManager never branches on which one is running. A
// rejected promise means the turn failed — the registry maps that straight to
// `state: 'failed'`.
// `model` is optional on both methods — PlanManager resolves it fresh from
// `config.models` per call (see plan.ts) and passes it through; a caller that
// omits it (a test double, mostly) leaves the backend's own default in play.
export interface Planner {
  start(prompt: string, model?: string): Promise<PlannerTurn>;
  sendMessage(
    sessionId: string | undefined,
    message: string,
    model?: string
  ): Promise<PlannerTurn>;
}

// Validates and normalizes an arbitrary JSON value into a PlanProposal,
// throwing OrchestratorClientError (-> 400) with a specific, actionable
// message on the first problem found. Used by PlanManager.confirm() to
// re-validate the client-supplied (and possibly edited) proposal body from
// scratch — the confirm body is authoritative, per the plan, so this never
// trusts whatever proposal the planner itself produced.
export function validatePlanProposal(value: unknown): PlanProposal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new OrchestratorClientError('invalid proposal: expected an object');
  }
  const obj = value as Record<string, unknown>;

  let epic: { title: string; description: string } | undefined;
  if (obj.epic !== undefined) {
    if (typeof obj.epic !== 'object' || obj.epic === null) {
      throw new OrchestratorClientError(
        'invalid proposal: epic must be an object'
      );
    }
    const e = obj.epic as Record<string, unknown>;
    if (typeof e.title !== 'string' || e.title.trim() === '') {
      throw new OrchestratorClientError(
        'invalid proposal: epic.title must be a non-empty string'
      );
    }
    if (typeof e.description !== 'string') {
      throw new OrchestratorClientError(
        'invalid proposal: epic.description must be a string'
      );
    }
    epic = { title: e.title, description: e.description };
  }

  if (!Array.isArray(obj.tasks)) {
    throw new OrchestratorClientError(
      'invalid proposal: tasks must be an array'
    );
  }
  const tasks = obj.tasks.map((raw, i) =>
    validatePlannedTask(raw, i, obj.tasks as unknown[])
  );
  assertAcyclic(tasks);

  return { epic, tasks };
}

function validatePlannedTask(
  raw: unknown,
  index: number,
  all: unknown[]
): PlannedTask {
  if (typeof raw !== 'object' || raw === null) {
    throw new OrchestratorClientError(
      `invalid proposal: tasks[${index}] must be an object`
    );
  }
  const t = raw as Record<string, unknown>;
  if (typeof t.title !== 'string' || t.title.trim() === '') {
    throw new OrchestratorClientError(
      `invalid proposal: tasks[${index}].title must be a non-empty string`
    );
  }
  if (t.description !== undefined && typeof t.description !== 'string') {
    throw new OrchestratorClientError(
      `invalid proposal: tasks[${index}].description must be a string`
    );
  }
  if (
    !Array.isArray(t.acceptanceCriteria) ||
    !t.acceptanceCriteria.every((c) => typeof c === 'string')
  ) {
    throw new OrchestratorClientError(
      `invalid proposal: tasks[${index}].acceptanceCriteria must be a list of strings`
    );
  }
  if (
    !Array.isArray(t.blockedByIndices) ||
    !t.blockedByIndices.every(
      (n) => typeof n === 'number' && Number.isInteger(n)
    )
  ) {
    throw new OrchestratorClientError(
      `invalid proposal: tasks[${index}].blockedByIndices must be a list of integers`
    );
  }
  for (const dep of t.blockedByIndices as number[]) {
    if (dep < 0 || dep >= all.length) {
      throw new OrchestratorClientError(
        `invalid proposal: tasks[${index}].blockedByIndices has an out-of-range index ${dep}`
      );
    }
    if (dep === index) {
      throw new OrchestratorClientError(
        `invalid proposal: tasks[${index}] cannot list itself in blockedByIndices`
      );
    }
  }
  if (
    typeof t.priority !== 'string' ||
    !(PRIORITIES as readonly string[]).includes(t.priority)
  ) {
    throw new OrchestratorClientError(
      `invalid priority: ${String(t.priority)} (expected ${PRIORITIES.join('|')})`
    );
  }
  return {
    title: t.title,
    description: typeof t.description === 'string' ? t.description : '',
    acceptanceCriteria: t.acceptanceCriteria,
    // Minor fix: a duplicate index (a planner artifact, or a client
    // double-entry) must collapse to a single blockedBy id at confirm time
    // rather than writing the same real id into the array more than once —
    // dedupe here, once, rather than at every later confirm() call site.
    blockedByIndices: [...new Set(t.blockedByIndices as number[])],
    priority: t.priority as Priority,
  };
}

// DFS-based cycle check over the proposal's own index space (blockedByIndices
// point at sibling array positions, not real ids, so this runs before any id
// ever exists). A three-color visit (unvisited/visiting/done) catches a cycle
// the moment a "visiting" node is revisited, in O(tasks + edges) rather than
// repeatedly rescanning — see the performance skill's guidance against
// nested rescans.
function assertAcyclic(tasks: PlannedTask[]): void {
  const UNVISITED = 0;
  const VISITING = 1;
  const DONE = 2;
  const state = new Array<number>(tasks.length).fill(UNVISITED);

  const visit = (i: number): void => {
    if (state[i] === DONE) return;
    if (state[i] === VISITING) {
      throw new OrchestratorClientError(
        'invalid proposal: blockedByIndices contains a cycle'
      );
    }
    state[i] = VISITING;
    for (const dep of tasks[i].blockedByIndices) visit(dep);
    state[i] = DONE;
  };

  for (let i = 0; i < tasks.length; i++) visit(i);
}
