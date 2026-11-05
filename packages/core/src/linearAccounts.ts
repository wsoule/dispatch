// A person's "Sign in with Linear" on this machine: the OAuth token pair
// Linear issued them, kept in the 0600 credentials file beside the project
// API keys and keyed by Linear organization (workspace) id. One
// DISPATCH_HOME belongs to one OS account, so one person; every project on
// the machine whose connection is in that workspace shares the record.
// Nothing here talks to Linear: the daemon's linear/accounts.ts refreshes and
// revokes, and this module only reads and writes the slot under the locks.
import {
  acquireFileLockAsync,
  credentialsPath,
  loadCredentialsFile,
  updateCredentialsFileAsync,
} from './credentials.js';
import type { CredentialsFile } from './credentials.js';

/** A person's Linear sign-in on this machine, for one Linear organization. */
export interface LinearAccountRecord {
  version: 1;
  /** The OAuth app that issued it; refresh and revoke must use the same one. */
  clientId: string;
  accessToken: string;
  refreshToken: string;
  /** ISO time the access token expires. */
  expiresAt: string;
  scope: string[];
  user: {
    id: string;
    name: string;
    displayName: string;
    email: string;
    guest: boolean;
    admin: boolean;
  };
  organization: { id: string; name: string; urlKey: string };
  signedInAt: string;
  refreshedAt: string | null;
}

/** What may be shown about a sign-in: everything but the tokens. */
export interface PublicLinearAccount {
  userId: string;
  name: string;
  displayName: string;
  email: string;
  guest: boolean;
  admin: boolean;
  /** Whether Linear granted the `write` scope; without it the token is
   *  never used for writes. */
  canWrite: boolean;
  workspace: { id: string; name: string; urlKey: string };
  signedInAt: string;
}

/** The token-free summary the API returns for a sign-in. */
export function publicLinearAccount(
  record: LinearAccountRecord
): PublicLinearAccount {
  return {
    userId: record.user.id,
    name: record.user.name,
    displayName: record.user.displayName,
    email: record.user.email,
    guest: record.user.guest,
    admin: record.user.admin,
    canWrite: record.scope.includes('write'),
    workspace: { ...record.organization },
    signedInAt: record.signedInAt,
  };
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isText = (v: unknown): v is string => isString(v) && v !== '';

// A stored record narrowed to its shape, or null when anything is off: a
// malformed record reads as signed out rather than half a token pair.
function parseRecord(raw: unknown): LinearAccountRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return null;
  const r = raw as Record<string, unknown>;
  const user = r.user as Record<string, unknown> | null | undefined;
  const org = r.organization as Record<string, unknown> | null | undefined;
  if (
    r.version !== 1 ||
    !isText(r.clientId) ||
    !isText(r.accessToken) ||
    !isText(r.refreshToken) ||
    !isString(r.expiresAt) ||
    Number.isNaN(Date.parse(r.expiresAt)) ||
    !Array.isArray(r.scope) ||
    !r.scope.every(isString) ||
    typeof user !== 'object' ||
    user === null ||
    !isText(user.id) ||
    !isString(user.name) ||
    !isString(user.displayName) ||
    !isString(user.email) ||
    typeof user.guest !== 'boolean' ||
    typeof user.admin !== 'boolean' ||
    typeof org !== 'object' ||
    org === null ||
    !isText(org.id) ||
    !isString(org.name) ||
    !isString(org.urlKey) ||
    !isString(r.signedInAt) ||
    !(r.refreshedAt === null || isString(r.refreshedAt))
  )
    return null;
  return {
    version: 1,
    clientId: r.clientId,
    accessToken: r.accessToken,
    refreshToken: r.refreshToken,
    expiresAt: r.expiresAt,
    scope: [...r.scope],
    user: {
      id: user.id,
      name: user.name,
      displayName: user.displayName,
      email: user.email,
      guest: user.guest,
      admin: user.admin,
    },
    organization: { id: org.id, name: org.name, urlKey: org.urlKey },
    signedInAt: r.signedInAt,
    refreshedAt: r.refreshedAt,
  };
}

// The slot as an own-keys record, or empty when it is missing or malformed.
function slotOf(file: CredentialsFile): Record<string, unknown> {
  const slot: unknown = file.linearAccounts;
  return typeof slot === 'object' && slot !== null && !Array.isArray(slot)
    ? (slot as Record<string, unknown>)
    : {};
}

// The file with one organization's record replaced, or removed when `record`
// is null; an emptied slot is dropped so the file holds no empty objects.
function withRecord(
  file: CredentialsFile,
  orgId: string,
  record: LinearAccountRecord | null
): CredentialsFile {
  const slot = { ...slotOf(file) };
  if (record === null) delete slot[orgId];
  else slot[orgId] = record;
  const next: CredentialsFile = { ...file, linearAccounts: slot };
  if (Object.keys(slot).length === 0) delete next.linearAccounts;
  return next;
}

/** The sign-in for one Linear organization, or null when there is none, it
 *  is malformed, or the credentials file cannot be read. Takes no lock. */
export function readLinearAccount(orgId: string): LinearAccountRecord | null {
  const loaded = loadCredentialsFile();
  if (loaded.kind !== 'ok') return null;
  const slot = slotOf(loaded.file);
  return Object.hasOwn(slot, orgId) ? parseRecord(slot[orgId]) : null;
}

/** Every well-formed sign-in stored on this machine, in no set order; empty
 *  when the credentials file cannot be read. Takes no lock. */
export function listLinearAccounts(): LinearAccountRecord[] {
  const loaded = loadCredentialsFile();
  if (loaded.kind !== 'ok') return [];
  return Object.values(slotOf(loaded.file)).flatMap((raw) => {
    const record = parseRecord(raw);
    return record === null ? [] : [record];
  });
}

/** Whether any sign-in is stored at all: a cheap check, so a machine where
 *  nobody signed in never pays for a Linear identity lookup. */
export function hasLinearAccounts(): boolean {
  const loaded = loadCredentialsFile();
  return loaded.kind === 'ok' && Object.keys(slotOf(loaded.file)).length > 0;
}

/**
 * Stores a sign-in, replacing any record for the same organization, and
 * answers the record it replaced (so the caller can revoke that grant).
 * Throws CredentialsUnreadableError, writing nothing, on an unreadable file.
 */
export async function writeLinearAccount(
  record: LinearAccountRecord
): Promise<LinearAccountRecord | null> {
  let previous: LinearAccountRecord | null = null;
  await updateCredentialsFileAsync((file) => {
    const slot = slotOf(file);
    const orgId = record.organization.id;
    previous = Object.hasOwn(slot, orgId) ? parseRecord(slot[orgId]) : null;
    return withRecord(file, orgId, { ...record });
  });
  return previous;
}

/**
 * Replaces a sign-in's tokens after a refresh, only while the stored record
 * still holds `expectedRefreshToken` (compare-and-set): false, writing
 * nothing, when the record is gone or another process replaced it first.
 */
export async function replaceLinearAccountTokens(
  orgId: string,
  expectedRefreshToken: string,
  next: Pick<
    LinearAccountRecord,
    'accessToken' | 'refreshToken' | 'expiresAt' | 'scope' | 'refreshedAt'
  >
): Promise<boolean> {
  let replaced = false;
  await updateCredentialsFileAsync((file) => {
    const slot = slotOf(file);
    const current = Object.hasOwn(slot, orgId)
      ? parseRecord(slot[orgId])
      : null;
    if (current === null || current.refreshToken !== expectedRefreshToken)
      return null;
    replaced = true;
    return withRecord(file, orgId, {
      ...current,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken,
      expiresAt: next.expiresAt,
      scope: [...next.scope],
      refreshedAt: next.refreshedAt,
    });
  });
  return replaced;
}

/**
 * Deletes a sign-in and answers what was deleted. With
 * `expectedRefreshToken`, only while the record still holds it, so a stale
 * refresh failure cannot delete a newer sign-in. A malformed record is
 * deleted too (answered as null).
 */
export async function removeLinearAccount(
  orgId: string,
  expectedRefreshToken?: string
): Promise<LinearAccountRecord | null> {
  let removed: LinearAccountRecord | null = null;
  await updateCredentialsFileAsync((file) => {
    const slot = slotOf(file);
    if (!Object.hasOwn(slot, orgId)) return null;
    const current = parseRecord(slot[orgId]);
    if (
      expectedRefreshToken !== undefined &&
      current?.refreshToken !== expectedRefreshToken
    )
      return null;
    removed = current;
    return withRecord(file, orgId, null);
  });
  return removed;
}

// Longer than the token endpoint's 15 s timeout, so a waiter outlives one
// refresh in another process.
const REFRESH_LOCK_WAIT_MS = 30_000;

/** The refresh lock's path: beside credentials.json, apart from its own lock. */
export function linearRefreshLockPath(): string {
  return `${credentialsPath()}.linear-refresh.lock`;
}

/**
 * Runs `work` holding the cross-process Linear refresh lock, so two daemons
 * never spend the same rotating refresh token, and a sign-out never races a
 * refresh. Lock order is always this lock, then the credentials lock (taken
 * inside by the writers above). Throws when the lock cannot be had in 30 s.
 */
export async function withLinearRefreshLock<T>(
  work: () => Promise<T>
): Promise<T> {
  const release = await acquireFileLockAsync(
    linearRefreshLockPath(),
    REFRESH_LOCK_WAIT_MS
  );
  try {
    return await work();
  } finally {
    release();
  }
}
