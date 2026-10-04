import { ActorRefError, parseActorRef, TASK_ID_PATTERN } from '@dispatch/core';

import {
  MAX_ADDRESS_BYTES,
  MAX_SEGMENT_BYTES,
  SYSTEM_ADDRESS,
} from './constants.js';
import { MessagingError } from './errors.js';

export { SYSTEM_ADDRESS };

export type Address = string;

export type ParsedAddress =
  | { kind: 'human'; handle: string; address: Address }
  | { kind: 'agent'; handle: string; operator: string | null; address: Address }
  | { kind: 'task'; id: string; address: Address }
  | { kind: 'run'; id: string; address: Address }
  | { kind: 'channel'; name: string; address: Address }
  | { kind: 'a2a'; alias: string; address: Address };

/** An outbound A2A peer's alias: the handle grammar, at most 40 characters. */
export const PEER_ALIAS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,39}$/;

const RUN_ID = /^r-[0-9a-f]{6,12}$/;
const CHANNEL_NAME = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/;

const utf8Length = (s: string): number =>
  new TextEncoder().encode(s).byteLength;

// Parses one address string; `field` names the input slot in the error so an
// agent can see exactly which recipient it got wrong.
export function parseAddress(raw: string, field = 'to'): ParsedAddress {
  // A JSON body can hold anything where an address belongs.
  if (typeof raw !== 'string')
    throw new MessagingError('invalid', 'expected an address string', field);
  const bad = (why: string): never => {
    throw new MessagingError(
      'invalid',
      `invalid address ${JSON.stringify(raw.slice(0, 80))}: ${why}`,
      field
    );
  };
  // One ceiling for every host, A2A peer and federation receiver.
  if (utf8Length(raw) > MAX_ADDRESS_BYTES)
    return bad(`at most ${MAX_ADDRESS_BYTES} bytes`);
  const segment = (value: string, what: string): void => {
    if (utf8Length(value) > MAX_SEGMENT_BYTES)
      bad(`${what} is over ${MAX_SEGMENT_BYTES} bytes`);
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
      segment(ref.handle, 'handle');
      if (ref.operator !== null) segment(ref.operator, 'operator');
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
      segment(rest, 'id');
      return TASK_ID_PATTERN.test(rest)
        ? { kind: 'task', id: rest, address: raw }
        : bad('not a task id');
    case 'run':
      segment(rest, 'id');
      return RUN_ID.test(rest)
        ? { kind: 'run', id: rest, address: raw }
        : bad('not a run id');
    case 'channel':
      for (const part of rest.split('/')) segment(part, 'channel segment');
      return CHANNEL_NAME.test(rest)
        ? { kind: 'channel', name: rest, address: raw }
        : bad('not a channel name');
    case 'a2a':
      segment(rest, 'alias');
      return PEER_ALIAS_PATTERN.test(rest)
        ? { kind: 'a2a', alias: rest, address: raw }
        : bad('not an A2A peer alias (a-z, 0-9, ".", "_", "-"; at most 40)');
    default:
      return bad(`unknown kind ${JSON.stringify(scheme)}`);
  }
}

/** An outbound A2A peer (`a2a:<alias>`); every message it sends is recorded by the daemon. */
export function isPeerAddress(address: Address): boolean {
  return address.startsWith('a2a:');
}

/** True for senders the ping-pong breaker counts: runs, agents and A2A peers, not the system. */
export function isAgentAuthored(address: Address): boolean {
  if (address === SYSTEM_ADDRESS) return false;
  return (
    address.startsWith('run:') ||
    address.startsWith('agent:') ||
    isPeerAddress(address)
  );
}
