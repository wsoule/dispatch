// Registry constants and gate predicates. This module imports nothing, so a
// browser entry can share it without reaching node:sqlite.

/** The daemon's own identity: sender of gates, notices and breaker flags. */
export const SYSTEM_ADDRESS = 'agent:dispatch';

/** A human or the system: the only authors whose answers take effect. */
export function isDecidingAuthor(address: string): boolean {
  return address === SYSTEM_ADDRESS || address.startsWith('human:');
}

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
