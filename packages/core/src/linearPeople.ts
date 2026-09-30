// Linear users as the project's people registry: each member becomes (or is
// matched to) a `human:<handle>` person carrying `external: linear:<id>`, and
// the API key's own user is the local human. Pure: no node:* imports.
import type { LinearUser } from './linearMap.js';
import type { Person } from './people.js';
import { slugify } from './slug.js';

const USER_PREFIX = 'linear:';

/** The `Person.external` value for a Linear user. */
export function linearUserExternal(userId: string): string {
  return `${USER_PREFIX}${userId}`;
}

/** Linear user id <-> person ref, both ways. */
export interface PeopleIndex {
  refByUser: ReadonlyMap<string, string>;
  userByRef: ReadonlyMap<string, string>;
  /** The local human's ref, which the legacy bare `human` means. */
  localRef: string;
}

/** Indexes every person carrying a Linear user id. */
export function peopleIndex(
  people: readonly Person[],
  localRef: string
): PeopleIndex {
  const refByUser = new Map<string, string>();
  const userByRef = new Map<string, string>();
  for (const p of people) {
    const ext = p.external ?? null;
    if (ext === null || !ext.startsWith(USER_PREFIX)) continue;
    const userId = ext.slice(USER_PREFIX.length);
    refByUser.set(userId, p.ref);
    userByRef.set(p.ref, userId);
  }
  return { refByUser, userByRef, localRef };
}

// A handle the actor-ref grammar accepts (`^[a-z0-9][a-z0-9._-]*$`), from
// Linear's short display name, then the email's local part, then the name.
function handleFor(user: LinearUser): string {
  for (const raw of [
    user.displayName,
    user.email?.split('@')[0] ?? '',
    user.name,
  ]) {
    const slug = slugify(raw);
    if (slug !== '') return slug;
  }
  const id = slugify(user.id).slice(0, 8);
  return `user-${id === '' ? 'x' : id}`;
}

function samePerson(a: Person, b: Person): boolean {
  return (
    a.ref === b.ref &&
    a.name === b.name &&
    (a.email ?? null) === (b.email ?? null) &&
    (a.avatarUrl ?? null) === (b.avatarUrl ?? null) &&
    (a.external ?? null) === (b.external ?? null)
  );
}

export interface PeopleSyncInput {
  /** `people:` as configured (what gets rewritten). */
  configured: readonly Person[];
  /** Everyone already known: configured plus the team roster. */
  known: readonly Person[];
  users: readonly LinearUser[];
  /** The API key's own Linear user: always the local human. */
  viewerId: string;
  localRef: string;
}

export interface PeopleSyncResult {
  /** The new `people:` list: existing entries in place, new ones appended. */
  configured: Person[];
  changed: boolean;
}

/**
 * Folds Linear's users into the people registry. A user already linked keeps
 * its ref; the viewer is the local human; anyone else is matched by email,
 * and failing that gets a fresh `human:<handle>`. Names, emails and avatars
 * follow Linear.
 */
export function syncLinearPeople(input: PeopleSyncInput): PeopleSyncResult {
  const configured = input.configured.map((p) => ({ ...p }));
  const byRef = new Map(configured.map((p) => [p.ref, p]));
  const knownByUser = peopleIndex(
    [...input.known, ...configured],
    input.localRef
  ).refByUser;
  const byEmail = new Map<string, string>();
  for (const p of [...input.known, ...configured]) {
    if (p.email != null && p.email !== '') {
      byEmail.set(p.email.toLowerCase(), p.ref);
    }
  }
  const usedRefs = new Set([
    ...input.known.map((p) => p.ref),
    ...configured.map((p) => p.ref),
  ]);
  const claimed = new Set<string>();

  for (const user of input.users) {
    const external = linearUserExternal(user.id);
    let ref =
      knownByUser.get(user.id) ??
      (user.id === input.viewerId ? input.localRef : undefined) ??
      (user.email === null ? undefined : byEmail.get(user.email.toLowerCase()));
    if (ref === undefined || claimed.has(ref)) {
      const handle = handleFor(user);
      ref = `human:${handle}`;
      for (let n = 2; usedRefs.has(ref) || claimed.has(ref); n++) {
        ref = `human:${handle}-${n}`;
      }
    }
    claimed.add(ref);
    usedRefs.add(ref);
    const next: Person = {
      ref,
      name: user.name.trim() === '' ? user.displayName : user.name.trim(),
      email: user.email,
      avatarUrl: user.avatarUrl,
      external,
    };
    const existing = byRef.get(ref);
    if (existing === undefined) {
      configured.push(next);
      byRef.set(ref, next);
    } else {
      Object.assign(existing, next);
    }
  }

  const changed =
    configured.length !== input.configured.length ||
    configured.some((p, i) => !samePerson(p, input.configured[i]));
  return { configured, changed };
}
