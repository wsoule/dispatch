import type { OverseerSession } from '../hooks/useOverseerSession';
import { ASK_GROUP_ORDER, type AskGroup } from './needsYou';

export interface OrbInput {
  /** The Overseer was revoked and takes no turns. */
  revoked: boolean;
  /** The daemon is unreachable or the last turn failed. */
  broken: boolean;
  asks: number;
  review: number;
  turnLive: boolean;
  liveRuns: number;
}

export type OrbTone = 'off' | 'broken' | 'amber' | 'green' | 'motion' | 'idle';

export interface OrbState {
  tone: OrbTone;
  count: number | null;
  /** Spins during an Overseer turn, in whatever colour the tone has. */
  spinning: boolean;
}

/** The orb's one state: off, broken, asks, reviews, motion, idle — first match wins. */
export function orbState(input: OrbInput): OrbState {
  if (input.revoked) return { tone: 'off', count: null, spinning: false };
  if (input.broken) return { tone: 'broken', count: null, spinning: false };
  const spinning = input.turnLive;
  if (input.asks > 0) return { tone: 'amber', count: input.asks, spinning };
  if (input.review > 0) return { tone: 'green', count: input.review, spinning };
  if (input.turnLive || input.liveRuns > 0) {
    return { tone: 'motion', count: null, spinning };
  }
  return { tone: 'idle', count: null, spinning: false };
}

/** Whether the Overseer is mid-turn. `recordError` only decides the no-record case, so a
 * background refetch error on a running record never flickers it off. */
export function overseerTurnLive(overseer: OverseerSession): boolean {
  return (
    overseer.conversationId !== null &&
    (overseer.record === undefined
      ? overseer.recordError === null
      : overseer.record.state === 'running')
  );
}

/** The orb's tooltip and accessible name. */
export function orbLabel(input: {
  state: OrbState;
  groups: Partial<Record<AskGroup, number>>;
  review: number;
}): string {
  const { state } = input;
  if (state.tone === 'off') {
    return 'Overseer · off · approve it again in Settings › Connected agents';
  }
  if (state.tone === 'broken') return 'Overseer · not reachable';
  const parts = ['Overseer'];
  const asks = ASK_GROUP_ORDER.reduce((n, g) => n + (input.groups[g] ?? 0), 0);
  if (asks > 0) {
    const named = ASK_GROUP_ORDER.filter((g) => (input.groups[g] ?? 0) > 0)
      .map((g) => `${g} ${input.groups[g]}`)
      .join(' · ');
    parts.push(`${asks} waiting on you (${named})`);
  } else {
    parts.push('nothing waiting on you');
  }
  if (input.review > 0) parts.push(`${input.review} ready for review`);
  return parts.join(' · ');
}
