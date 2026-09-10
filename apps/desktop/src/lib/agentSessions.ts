import type { AgentSessionKind, AgentSessionMeta } from '@dispatch/client';

import type { FeedState } from './feedState';
import type { RunStateBucket } from './runState';

/** How a conversation agent's kind reads in a list row — user-facing words,
 * not the wire values ('plan' would read as a noun, 'enrich' as jargon). */
export const AGENT_SESSION_KIND_LABEL: Record<AgentSessionKind, string> = {
  plan: 'planner',
  enrich: 'detail',
  draft: 'draft',
  warden: 'warden',
};

/**
 * Which of the All agents page's three filter buckets a conversation agent
 * lands in. `ready` and `failed` both land in needs-review for the same reason
 * a run's failure does: the agent came to rest and a person owes it a response
 * (confirm the proposal, answer the reply, retry or dismiss). Nothing lands in
 * closed — an in-memory conversation is never closed out, it is dismissed and
 * disappears, or dies with the daemon.
 */
export function agentSessionBucket(session: AgentSessionMeta): RunStateBucket {
  return session.state === 'running' ? 'live' : 'needs-review';
}

/** The state dot's color for a conversation agent, in the app-wide FeedState
 * vocabulary: a turn in flight is working, a settled turn waits on the human,
 * an errored turn failed. */
export function agentSessionFeedState(session: AgentSessionMeta): FeedState {
  if (session.state === 'running') return 'working';
  // A settled turn waits on the human's next message — an answer, in the
  // whose-move vocabulary.
  return session.state === 'failed' ? 'failed' : 'answer';
}
