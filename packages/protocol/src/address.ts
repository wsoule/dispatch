import { ActorRefError, parseActorRef, TASK_ID_PATTERN } from '@dispatch/core';

import { SYSTEM_ADDRESS } from './constants.js';
import { MessagingError } from './errors.js';

export { SYSTEM_ADDRESS };

export type Address = string;

export type ParsedAddress =
  | { kind: 'human'; handle: string; address: Address }
  | { kind: 'agent'; handle: string; operator: string | null; address: Address }
  | { kind: 'task'; id: string; address: Address }
  | { kind: 'run'; id: string; address: Address }
  | { kind: 'channel'; name: string; address: Address };

const RUN_ID = /^r-[0-9a-f]{6,12}$/;
const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

// Parses one address string; `field` names the input slot in the error so an
// agent can see exactly which recipient it got wrong.
export function parseAddress(raw: string, field = 'to'): ParsedAddress {
  const bad = (why: string): never => {
    throw new MessagingError(
      'invalid',
      `invalid address ${JSON.stringify(raw)}: ${why}`,
      field
    );
  };
  const colon = raw.indexOf(':');
  if (colon <= 0) return bad('expected <kind>:<id>');
  const scheme = raw.slice(0, colon);
  const rest = raw.slice(colon + 1);
  switch (scheme) {
    case 'human':
    case 'agent': {
      let ref;
      try {
        ref = parseActorRef(raw);
      } catch (err) {
        if (err instanceof ActorRefError) return bad(err.message);
        throw err;
      }
      if (ref === null || ref.handle === null)
        return bad('actor needs a handle');
      return ref.kind === 'human'
        ? { kind: 'human', handle: ref.handle, address: raw }
        : {
            kind: 'agent',
            handle: ref.handle,
            operator: ref.operator,
            address: raw,
          };
    }
    case 'task':
      return TASK_ID_PATTERN.test(rest)
        ? { kind: 'task', id: rest, address: raw }
        : bad('not a task id');
    case 'run':
      return RUN_ID.test(rest)
        ? { kind: 'run', id: rest, address: raw }
        : bad('not a run id');
    case 'channel':
      return CHANNEL_NAME.test(rest)
        ? { kind: 'channel', name: rest, address: raw }
        : bad('not a channel name');
    default:
      return bad(`unknown kind ${JSON.stringify(scheme)}`);
  }
}

/** True for senders the ping-pong breaker counts: runs and agents, not the system. */
export function isAgentAuthored(address: Address): boolean {
  if (address === SYSTEM_ADDRESS) return false;
  return address.startsWith('run:') || address.startsWith('agent:');
}
