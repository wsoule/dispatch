import { parse, stringify } from 'yaml';

// Pure roster shapes and transforms, no node:* imports — the server owns
// reading and writing `.dispatch/team.yml`.

export interface TeamMember {
  handle: string;
  email: string;
  displayName: string;
  /** Prior addresses, so a changed git email keeps its handle. */
  emails: string[];
}

const ILLEGAL = /[^a-z0-9._-]/g;

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
  const base = cleaned.length > 0 ? cleaned : 'member';
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function parseTeam(yaml: string): TeamMember[] {
  const raw = yaml.trim() === '' ? null : parse(yaml);
  const members = raw?.members;
  if (!Array.isArray(members)) return [];
  return members.map((m) => ({
    handle: String(m.handle),
    email: String(m.email),
    displayName: String(m.displayName ?? m.handle),
    emails: Array.isArray(m.emails) ? m.emails.map(String) : [],
  }));
}

export function serializeTeam(members: TeamMember[]): string {
  return stringify({ members });
}

/**
 * Records the local developer in the roster. Matches on current or prior email
 * so a changed git address updates in place instead of adding a second entry.
 */
export function upsertMember(
  members: TeamMember[],
  email: string,
  displayName: string
): { members: TeamMember[]; member: TeamMember; changed: boolean } {
  // Match by email first (current or prior); fall back to displayName for
  // email changes where the person's name stays the same.
  let found = members.find(
    (m) => m.email === email || m.emails.includes(email)
  );
  found ??= members.find((m) => m.displayName === displayName);
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
