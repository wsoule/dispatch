import { parse, stringify } from 'yaml';

// Pure roster shapes and transforms, no node:* imports — the server owns
// reading and writing `.dispatch/team.yml`.

export class TeamParseError extends Error {}

export interface TeamMember {
  handle: string;
  email: string;
  displayName: string;
  /** Prior addresses, so a changed git email keeps its handle. */
  emails: string[];
}

const ILLEGAL = /[^a-z0-9._-]/g;

// Same format actor.ts's handles must satisfy — duplicated rather than
// imported, same as inbox.ts's copy, so this file's dependency surface
// stays exactly what it is today.
const HANDLE = /^[a-z0-9][a-z0-9._-]*$/;

/** The longest handle an address may carry. Handles are ASCII, so length is bytes. */
export const MAX_HANDLE_BYTES = 64;

/** A roster entry parseTeamReport skipped, and what the owner must fix. */
export interface DroppedEntry {
  /** The entry's email, or null when it has none. */
  email: string | null;
  /** `too-long` when the handle's length is all that is wrong; `malformed` otherwise. */
  problem: 'too-long' | 'malformed';
}

// Line breaks and C1 controls JSON.stringify leaves raw.
const RAW_AFTER_JSON = /[\u007f-\u009f\u2028\u2029]/g;

/**
 * Names an entry parseTeamReport dropped, for a log line or an error. The
 * email is quoted and escaped so a hand-edited one cannot forge extra lines.
 */
export function describeDroppedEntry(entry: DroppedEntry): string {
  if (entry.email === null) return 'an entry with no email';
  const quoted = JSON.stringify(entry.email).replace(
    RAW_AFTER_JSON,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return `the entry for ${quoted}`;
}

/** Derives a stable handle from an email's local part, suffixing on collision. */
export function handleFromEmail(email: string, taken: Set<string>): string {
  const local = email.slice(
    0,
    email.indexOf('@') === -1 ? undefined : email.indexOf('@')
  );
  const cleaned = local
    .toLowerCase()
    .replace(ILLEGAL, '')
    .replace(/^[._-]+/, '');
  const base = (cleaned.length > 0 ? cleaned : 'member').slice(
    0,
    MAX_HANDLE_BYTES
  );
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = String(n);
    const candidate = `${base.slice(0, MAX_HANDLE_BYTES - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function parseTeam(yaml: string): TeamMember[] {
  return parseTeamReport(yaml).members;
}

/**
 * Parses a roster and reports each entry it drops, so the caller can refuse to
 * rewrite the file and tell the owner what to fix.
 */
export function parseTeamReport(yaml: string): {
  members: TeamMember[];
  dropped: DroppedEntry[];
} {
  let raw: unknown;
  try {
    raw = yaml.trim() === '' ? null : parse(yaml);
  } catch (err) {
    // A conflicted team.yml must be reported, never silently replaced.
    throw new TeamParseError(`invalid team.yml: ${(err as Error).message}`);
  }
  const members = (raw as { members?: unknown } | null)?.members;
  if (!Array.isArray(members)) return { members: [], dropped: [] };
  // An entry without a usable handle and email is dropped, not coerced —
  // a fabricated "undefined" handle produces an unparseable actor ref. A
  // handle that doesn't match the format the rest of the system requires
  // (e.g. a hand-edited `handle: Wyat`, or one over MAX_HANDLE_BYTES) is
  // dropped the same way: it would otherwise reach InboxStore, which throws
  // an uncaught error out of startServer instead of failing closed.
  const kept: TeamMember[] = [];
  const dropped: DroppedEntry[] = [];
  for (const m of members as unknown[]) {
    const entry = m as Partial<TeamMember> | null;
    const handle = entry?.handle;
    const email = entry?.email;
    const wellFormed =
      typeof handle === 'string' &&
      typeof email === 'string' &&
      HANDLE.test(handle);
    if (!wellFormed || handle.length > MAX_HANDLE_BYTES) {
      dropped.push({
        email: typeof email === 'string' && email !== '' ? email : null,
        problem: wellFormed ? 'too-long' : 'malformed',
      });
      continue;
    }
    kept.push({
      handle,
      email,
      displayName:
        typeof entry?.displayName === 'string' ? entry.displayName : handle,
      emails: Array.isArray(entry?.emails)
        ? entry.emails.filter((e): e is string => typeof e === 'string')
        : [],
    });
  }
  return { members: kept, dropped };
}

export function serializeTeam(members: TeamMember[]): string {
  return stringify({ members });
}

/**
 * Records the local developer in the roster. `knownHandle` is the caller's own
 * record of who it is, which is the only reliable way to survive an email
 * change — never guess identity from a display name, since two people share one.
 */
export function upsertMember(
  members: TeamMember[],
  email: string,
  displayName: string,
  knownHandle?: string
): { members: TeamMember[]; member: TeamMember; changed: boolean } {
  const byHandle =
    knownHandle === undefined
      ? undefined
      : members.find((m) => m.handle === knownHandle);
  const byEmail = members.find(
    (m) => m.email === email || m.emails.includes(email)
  );
  // A knownHandle match only wins outright when its own email matches, or
  // when no other entry independently claims `email` — that is what makes
  // it survive a legitimate email change. If a *different* entry already
  // owns `email`, the knownHandle match belongs to someone else (a corrupted
  // or stale known-handle record), and the email lookup — the true match —
  // must win instead, or two people's rosters merge into one.
  const found =
    byHandle !== undefined &&
    (byHandle.email === email ||
      byEmail === undefined ||
      byEmail.handle === byHandle.handle)
      ? byHandle
      : byEmail;
  if (
    found !== undefined &&
    found.email === email &&
    found.displayName === displayName
  ) {
    return { members, member: found, changed: false };
  }
  if (found !== undefined) {
    const prior =
      found.email === email || found.emails.includes(found.email)
        ? found.emails
        : [...found.emails, found.email];
    const member: TeamMember = {
      ...found,
      email,
      displayName,
      emails: prior.filter((e) => e !== email),
    };
    return {
      members: members.map((m) => (m.handle === found.handle ? member : m)),
      member,
      changed: true,
    };
  }
  const member: TeamMember = {
    handle: handleFromEmail(email, new Set(members.map((m) => m.handle))),
    email,
    displayName,
    emails: [],
  };
  return { members: [...members, member], member, changed: true };
}
