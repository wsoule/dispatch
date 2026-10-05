// Signed statements between paired agents. Each carries its own tag, so one
// kind can never pass as another.

export const UNPAIR_TAG = 'dispatch-a2a-unpair-v1';

/** The body of POST <base>/dispatch/unpair; the request itself is RFC 9421-signed. */
export interface UnpairNotice {
  tag: typeof UNPAIR_TAG;
  id: string;
  at: string;
}

export function unpairNotice(id: string, at: Date): UnpairNotice {
  return { tag: UNPAIR_TAG, id, at: at.toISOString() };
}

const ID = /^[A-Za-z0-9_-]{16,64}$/;

/** The notice's pairing id and time, or null for anything else. */
export function parseUnpairNotice(
  raw: unknown
): { id: string; at: string } | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  if (r.tag !== UNPAIR_TAG || typeof r.id !== 'string' || !ID.test(r.id))
    return null;
  if (typeof r.at !== 'string' || Number.isNaN(Date.parse(r.at))) return null;
  return { id: r.id, at: r.at };
}
