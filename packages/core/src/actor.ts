// Pure data shapes, no node:* imports, so this is safe for the desktop
// webview via the '@dispatch/core/browser' entry point.

export type ActorKind = 'human' | 'agent';

export interface ActorRef {
  kind: ActorKind;
  /** Stable handle within the project; null means "any actor of this kind". */
  handle: string | null;
  /** For agents, the handle of the human who owns it; null otherwise. */
  operator: string | null;
}

export class ActorRefError extends Error {}

/** The unassigned wire value, kept distinct from a malformed one. */
export const UNASSIGNED = 'none';

const HANDLE = /^[a-z0-9][a-z0-9._-]*$/;

function requireHandle(value: string, raw: string): string {
  if (!HANDLE.test(value)) {
    throw new ActorRefError(`invalid actor handle in: ${raw}`);
  }
  return value;
}

/**
 * Parses a task's `assignee` wire value. Returns null for `none`; the bare
 * `human`/`agent` legacy values parse as that kind with no handle, so existing
 * task files stay valid without migration.
 */
export function parseActorRef(raw: string): ActorRef | null {
  if (raw === UNASSIGNED) return null;
  const [kind, rest] = raw.includes(':')
    ? [raw.slice(0, raw.indexOf(':')), raw.slice(raw.indexOf(':') + 1)]
    : [raw, null];
  if (kind !== 'human' && kind !== 'agent') {
    throw new ActorRefError(`invalid actor kind: ${raw}`);
  }
  if (rest === null) return { kind, handle: null, operator: null };
  if (!rest.includes('/')) {
    return { kind, handle: requireHandle(rest, raw), operator: null };
  }
  if (kind === 'human') {
    throw new ActorRefError(`a human ref cannot carry an operator: ${raw}`);
  }
  const [operator, handle] = [
    rest.slice(0, rest.indexOf('/')),
    rest.slice(rest.indexOf('/') + 1),
  ];
  return {
    kind,
    handle: requireHandle(handle, raw),
    operator: requireHandle(operator, raw),
  };
}

export function formatActorRef(ref: ActorRef | null): string {
  if (ref === null) return UNASSIGNED;
  if (ref.handle === null) return ref.kind;
  if (ref.operator === null) return `${ref.kind}:${ref.handle}`;
  return `${ref.kind}:${ref.operator}/${ref.handle}`;
}

/** Validation gate for `assignee`, used where a throw would be the wrong shape. */
export function isValidAssignee(raw: string): boolean {
  try {
    parseActorRef(raw);
    return true;
  } catch {
    return false;
  }
}
