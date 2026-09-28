import type { Address } from './address.js';
import { hasGateData, MARKERS } from './constants.js';
import type { Message } from './envelope.js';

/** Markers that never leave the machine: the registry's plus the policy engine's. */
export const LOCAL_ONLY_MARKERS: readonly string[] = [
  ...new Set<string>([...MARKERS, 'x-policy', 'x-expired']),
];

const OVERSEER = /^agent:[^/]+\/overseer$/;
const A2A_AGENT = /^agent:[^/]+\/a2a\./;

/** Overseer and A2A identities: never federated, never in channel or agent ops. */
export function isFederationLocalAddress(address: Address): boolean {
  return (
    address.startsWith('a2a:') ||
    OVERSEER.test(address) ||
    A2A_AGENT.test(address)
  );
}

export type LocalOnlyReason = 'gate' | 'marker' | 'participant' | 'root';

function dataType(message: Message): string | null {
  const data = message.data;
  if (
    data === null ||
    data === undefined ||
    typeof data !== 'object' ||
    Array.isArray(data)
  )
    return null;
  const type = (data as { type?: unknown }).type;
  return typeof type === 'string' ? type : null;
}

// Why a message must stay on this machine, or null: gate data on it or its
// reply target, a system marker, an overseer or A2A participant, or a local-only root.
export function localOnlyReason(
  message: Message,
  replyTarget: Message | null,
  root: Message | null
): LocalOnlyReason | null {
  if (
    hasGateData(message) ||
    (replyTarget !== null && hasGateData(replyTarget))
  )
    return 'gate';
  const type = dataType(message);
  if (type !== null && LOCAL_ONLY_MARKERS.includes(type)) return 'marker';
  if ([message.from, ...message.to].some(isFederationLocalAddress))
    return 'participant';
  if (
    root !== null &&
    root.id !== message.id &&
    localOnlyReason(root, null, null) !== null
  )
    return 'root';
  return null;
}
