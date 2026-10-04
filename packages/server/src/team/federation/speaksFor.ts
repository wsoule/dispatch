import { speaksForHandle } from '@dispatch/federation';
import type { RosterView } from '@dispatch/federation';
import { parseAddress, SYSTEM_ADDRESS } from '@dispatch/protocol';
import type { Address, Message } from '@dispatch/protocol';

import type { Evidence } from './service.js';
import type { FedStore } from './store.js';

/**
 * Whether `replica` may send as `message.from` at its op `seq` (spec "Speaks
 * for"): true, false, or null when a run or agent's claim has not arrived
 * yet (the caller parks the op until it does).
 */
export function speaksFor(input: {
  replica: string;
  message: Pick<Message, 'from' | 'kind' | 'data'>;
  seq: number;
  view: RosterView;
  fed: FedStore;
  evidence: Evidence;
}): boolean | null {
  const { replica, message, seq, view, fed, evidence } = input;
  const from: Address = message.from;
  // The engine checks a system notice is about something the two exchanged.
  if (from === SYSTEM_ADDRESS)
    return message.kind === 'notice' && message.data === undefined;
  let p;
  try {
    p = parseAddress(from, 'from');
  } catch {
    return false;
  }
  if (p.kind === 'human') return speaksForHandle(view, replica, p.handle, seq);
  if (p.kind === 'run') {
    const bound = fed.db
      .query<{ replica: string }, [string]>(
        'SELECT replica FROM fed_runs WHERE run = ?'
      )
      .get(p.id);
    if (bound !== null) return bound.replica === replica;
    const claims = evidence.runs.get(p.id);
    if (claims === undefined) return null;
    return claims.length === 1 && claims[0] === replica;
  }
  if (p.kind === 'agent') {
    if (p.operator === null) return false;
    if (!speaksForHandle(view, replica, p.operator, seq)) return false;
    const row = fed.db
      .query<{ replica: string }, [string]>(
        'SELECT replica FROM fed_agents WHERE address = ?'
      )
      .get(from);
    if (row !== null) return row.replica === replica;
    const claim = evidence.agents.get(from);
    return claim === undefined ? null : claim === replica;
  }
  return false;
}
