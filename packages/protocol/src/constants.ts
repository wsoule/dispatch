// Registry constants and gate predicates. This module imports nothing, so a
// browser entry can share it without reaching node:sqlite.

/** The daemon's own identity: sender of gates, notices and breaker flags. */
export const SYSTEM_ADDRESS = 'agent:dispatch';

/** A human or the system: the only authors whose answers take effect. */
export function isDecidingAuthor(address: string): boolean {
  return address === SYSTEM_ADDRESS || address.startsWith('human:');
}

export const ADDRESS_SCHEMES = [
  'human',
  'agent',
  'task',
  'run',
  'channel',
  'a2a',
] as const;

export const BUILT_IN_KINDS = [
  'message',
  'question',
  'answer',
  'handoff',
  'notice',
] as const;

export const REF_TYPES = [
  'task',
  'run',
  'file',
  'commit',
  'message',
  'doc',
] as const;

// Every gate type this package defines a payload for; a host implements a subset.
export const GATE_TYPES = [
  'tool-approval',
  'scope',
  'wake',
  'agent-registration',
  'overseer-action',
  'memory',
  'task-proposal',
  'doc',
] as const;

export const DELIVERY_STATES = [
  'held',
  'sending',
  'pushed',
  'notified',
  'read',
  'answered',
] as const;

/** The system markers: `data.type` values that mean something only from the system. */
export const MARKERS = ['x-closed', 'x-breaker'] as const;

/** The engine's error codes and the HTTP status a host answers each with. */
export const ERROR_CODES = {
  invalid: 400,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  limited: 429,
} as const;

// Ceilings on one address and on each handle, operator, id and channel segment.
export const MAX_ADDRESS_BYTES = 256;
export const MAX_SEGMENT_BYTES = 64;

export type GateRaiser = 'system' | 'system-or-decider' | 'session';

// Who may raise each gate type. A type missing here is system-only.
export const GATE_RAISERS: Readonly<Record<string, GateRaiser>> = {
  wake: 'system',
  'tool-approval': 'system',
  scope: 'session',
  'agent-registration': 'system',
  'overseer-action': 'system',
  memory: 'system-or-decider',
  'task-proposal': 'system',
  doc: 'system',
};

export function raiserOf(type: string): GateRaiser {
  return GATE_RAISERS[type] ?? 'system';
}

// Gate data: an object `data` whose `type` is a string without the x- prefix,
// on any kind. Egress and locality use this, known type or not.
export function hasGateData(m: { data?: unknown }): boolean {
  const data = m.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return false;
  const type = (data as { type?: unknown }).type;
  return typeof type === 'string' && !type.startsWith('x-');
}

// The gate type a question or handoff carries, or null for a plain one: a
// known type always counts; an unknown one only from the system or a human.
export function gateTypeOf(
  m: { kind: string; from?: string; data?: unknown },
  known: ReadonlySet<string>
): string | null {
  if ((m.kind !== 'question' && m.kind !== 'handoff') || !hasGateData(m))
    return null;
  const type = (m.data as { type: string }).type;
  if (known.has(type)) return type;
  return isDecidingAuthor(m.from ?? '') ? type : null;
}
