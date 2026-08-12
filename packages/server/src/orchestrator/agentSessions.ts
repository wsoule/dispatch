import type { DraftRecord, PlanRecord } from './plan.js';
import type { WardenRecord } from './warden.js';

// Which kind of conversation agent a session row is. Task runs are deliberately
// not part of this union — they are durable, worktree-backed and already listed
// by GET /api/runs; this covers the in-memory conversation agents that had no
// listing at all: planner chats ('plan'), "add detail" drafting agents
// ('enrich'), single-task drafts ('draft') and warden chats ('warden').
type AgentSessionKind = 'plan' | 'enrich' | 'draft' | 'warden';

// The one lifecycle every conversation agent shares: a turn is in flight, the
// last turn settled with something to look at, or the last turn errored.
type AgentSessionState = 'running' | 'ready' | 'failed';

// One conversation agent, normalized for a list row. The full records stay
// behind their own per-id endpoints; this carries only what a row renders.
export interface AgentSessionMeta {
  id: string;
  kind: AgentSessionKind;
  // What the agent is working on: an enrich plan's task/note/capture title,
  // or the opening prompt's first line for free-form conversations.
  title: string;
  state: AgentSessionState;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

// How much of an opening prompt a list row shows. Long enough to read the
// ask, short enough that one row stays one line.
const MAX_TITLE_LENGTH = 120;

// A prompt's first non-empty line, truncated — the row title for sessions
// whose prompt is the human's own words.
function promptTitle(prompt: string): string {
  const line =
    prompt
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  return line.length <= MAX_TITLE_LENGTH
    ? line
    : `${line.slice(0, MAX_TITLE_LENGTH)}…`;
}

/**
 * Normalizes every in-memory conversation agent into one list, newest activity
 * first. Pure so the shape is testable without a server; api.ts's
 * GET /api/agents is just this over the three managers' listings.
 */
export function buildAgentSessions(
  plans: PlanRecord[],
  drafts: DraftRecord[],
  wardens: WardenRecord[]
): AgentSessionMeta[] {
  const sessions: AgentSessionMeta[] = [
    ...plans.map(
      (plan): AgentSessionMeta => ({
        id: plan.id,
        kind: plan.role === 'enrich' ? 'enrich' : 'plan',
        // An enrich plan's prompt is boilerplate; its subject (the task/note
        // title it was started from) is what a person would recognize. Still
        // squeezed through promptTitle — an inbox capture's subject is raw
        // dumped text, which can be long and multi-line.
        title: promptTitle(plan.subject ?? plan.prompt),
        state: plan.state,
        error: plan.error,
        createdAt: plan.createdAt,
        updatedAt: plan.updatedAt,
      })
    ),
    ...drafts.map(
      (draft): AgentSessionMeta => ({
        id: draft.id,
        kind: 'draft',
        title: promptTitle(draft.prompt),
        state: draft.state,
        error: draft.error ?? undefined,
        createdAt: draft.createdAt,
        updatedAt: draft.updatedAt,
      })
    ),
    ...wardens.map(
      (warden): AgentSessionMeta => ({
        id: warden.id,
        kind: 'warden',
        title: promptTitle(warden.prompt),
        state: warden.state,
        error: warden.error,
        createdAt: warden.createdAt,
        updatedAt: warden.updatedAt,
      })
    ),
  ];
  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
