import type { EpicProgressChild, RunMeta } from '@dispatch/client';
import type { StatusModel } from '@dispatch/core/browser';
import {
  hasStatusRole,
  isBacklogStatus,
  isCanceledStatus,
  isStartedStatus,
  statusLabel,
} from '@dispatch/core/browser';

import type { FlightNode } from './flightPlan';

// The one line under each Flight Plan node that says, in words, why it is where it is:
// what the agent is doing, whose hands it is in, where it stands in the queue, or exactly
// what it waits on ("Auto-starts when ENG-398 + ENG-405 finish").

/** The hue a sentence reads in — the node's tier, not its status. */
export type SentenceTone =
  | 'done'
  | 'working'
  | 'waiting'
  | 'review'
  | 'failed'
  | 'ready'
  | 'muted';

export interface NodeSentence {
  text: string;
  tone: SentenceTone;
}

/** `A`, `A + B`, `A, B + C`, then `A, B + 3 more` past three. */
export function joinRefs(refs: readonly string[]): string {
  if (refs.length <= 1) return refs[0] ?? '';
  if (refs.length <= 3) {
    return `${refs.slice(0, -1).join(', ')} + ${refs[refs.length - 1]}`;
  }
  return `${refs.slice(0, 2).join(', ')} + ${refs.length - 2} more`;
}

/** What a live run is doing right now, in two words at most. */
export function runStep(
  run: RunMeta | undefined,
  phase: EpicProgressChild | undefined
): string {
  if (run === undefined || run.state === 'provisioning') return 'Starting';
  if (run.state === 'awaiting-approval') return 'Waiting on approval';
  if (run.stopRequestedAt !== undefined) return 'Stopping';
  if (phase?.phase === 'fixing') return 'Fixing findings';
  if (run.kind === 'review') return 'Reviewing';
  if (run.kind === 'verify') return 'Verifying';
  return 'Working';
}

export interface SentenceInput {
  node: FlightNode;
  /** The id people know a task by: its Linear identifier when linked. */
  refFor: (id: string) => string;
  /** The node's fan-out session is filling slots right now. */
  sessionActive: boolean;
  /** For a queued node under an active session: its place in the fill order (0-based)
   * and the slots free right now. */
  queue: { position: number; free: number } | null;
  /** A live run whose claimed files this queued node would collide with. */
  parkedBehind: string | null;
  /** The node's live run, else its latest. */
  run: RunMeta | undefined;
  /** The server's reading of the node inside its fan-out, when a session exists. */
  phase: EpicProgressChild | undefined;
  /** The display name of the teammate a `teammate` node belongs to. */
  personName: string | null;
  model: StatusModel;
}

// Why an unstarted-or-stalled node is not moving, most specific reason first.
function blockedSentence(input: SentenceInput): NodeSentence {
  const { node, refFor, sessionActive, phase, run, model } = input;
  const status = node.task.meta.status;
  if (node.subPlan) return { text: 'Fans out on its own plan', tone: 'muted' };
  if (node.task.meta.derivedFrom !== undefined) {
    return { text: 'Anchors a review · agents never start it', tone: 'muted' };
  }
  if (node.waitingOn.length > 0) {
    const refs = joinRefs(node.waitingOn.map(refFor));
    const verb = node.waitingOn.length === 1 ? 'finishes' : 'finish';
    const lead = sessionActive ? 'Auto-starts when' : 'Unblocks when';
    return { text: `${lead} ${refs} ${verb}`, tone: 'muted' };
  }
  if (phase?.phase === 'capped') {
    return { text: 'Fix loop capped · needs a ruling', tone: 'waiting' };
  }
  if (phase?.phase === 'blocked') {
    return {
      text:
        phase.reason === undefined ? 'Blocked' : `Blocked · ${phase.reason}`,
      tone: 'failed',
    };
  }
  if (
    run !== undefined &&
    (run.state === 'failed' || run.state === 'interrupted-dirty')
  ) {
    return { text: 'Last run failed · press D to retry', tone: 'failed' };
  }
  if (node.task.meta.risk === 'critical') {
    return { text: 'Held · critical work starts by hand', tone: 'waiting' };
  }
  if (isBacklogStatus(status, model)) {
    return {
      text: `${statusLabel(status)} · not ready to start`,
      tone: 'muted',
    };
  }
  if (isStartedStatus(status, model)) {
    return { text: `${statusLabel(status)} · no agent on it`, tone: 'waiting' };
  }
  return { text: statusLabel(status), tone: 'muted' };
}

// `Sam’s`, from a registry name's first word; a generic owner when the name is unknown.
function possessive(name: string | null): string {
  const first = name?.trim().split(/\s+/)[0] ?? '';
  return first === '' ? 'A teammate’s' : `${first}’s`;
}

/** The node's one-line reason, and the hue to read it in. */
export function nodeSentence(input: SentenceInput): NodeSentence {
  const { node, model } = input;
  const status = node.task.meta.status;
  switch (node.state) {
    case 'done':
      return isCanceledStatus(status, model)
        ? { text: 'Dropped', tone: 'muted' }
        : { text: 'Landed', tone: 'done' };
    case 'running': {
      const step = runStep(input.run, input.phase);
      return {
        text: step,
        tone: step === 'Waiting on approval' ? 'waiting' : 'working',
      };
    }
    case 'teammate': {
      const whose = possessive(input.personName);
      return isStartedStatus(status, model)
        ? { text: `${whose} · ${statusLabel(status)}`, tone: 'ready' }
        : { text: `${whose} — won’t auto-start`, tone: 'muted' };
    }
    case 'review':
      return hasStatusRole(status, 'landing', model)
        ? { text: 'Landing', tone: 'review' }
        : { text: 'Ready for review', tone: 'review' };
    case 'queued': {
      if (!input.sessionActive || input.queue === null) {
        return { text: 'Ready to dispatch', tone: 'ready' };
      }
      const { position, free } = input.queue;
      if (position < free) {
        return input.parkedBehind === null
          ? { text: 'Next up', tone: 'working' }
          : {
              text: `Parked behind ${input.refFor(input.parkedBehind)}’s files`,
              tone: 'waiting',
            };
      }
      return { text: `#${position - free + 1} in queue`, tone: 'ready' };
    }
    case 'blocked':
      return blockedSentence(input);
  }
}
