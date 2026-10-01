import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { normalizeProjectPath } from './projectPath.js';

/** How a daemon authenticates to one outbound A2A peer (the peer card's scheme). */
export interface PeerCredential {
  scheme: 'bearer' | 'api-key';
  token: string;
  /** The API key's header name; bearer tokens go in Authorization. */
  header?: string;
}

/** One project's secrets, one key per integration. */
export interface ProjectCredentials {
  linear?: { apiKey: string };
  typesafe?: { apiKey: string };
  /** Outbound A2A peers' credentials by alias, and the key that signs this
   *  project's agent card; never in config.yml or a2a.db. */
  a2a?: {
    peers?: Record<string, PeerCredential>;
    signingKey?: Record<string, string>;
  };
}

/** User-level secrets. Never written to a project's `.dispatch/`. */
export interface CredentialsFile {
  /** Machine-wide default, kept as a read-only fallback. Nothing writes it any more. */
  linear?: { apiKey: string };
  /** Machine-wide TypeSafe key. Read as the last fallback; nothing writes it. */
  typesafe?: { apiKey: string };
  /** Per-project secrets, keyed by `normalizeProjectPath` of the project root. */
  projects?: Record<string, ProjectCredentials>;
}

// The { apiKey } integrations, e.g. `'linear'`: not `'projects'`, and not
// `'a2a'`, which has its own writers below.
export type CredentialName = Exclude<keyof ProjectCredentials, 'a2a'>;

// Same `DISPATCH_HOME`-or-homedir rule as registry.ts and daemonfile.ts; an
// empty string counts as unset.
function credentialsHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

export function credentialsPath(): string {
  return resolve(credentialsHome(), '.dispatch', 'credentials.json');
}

/** The credentials file exists but cannot be read as JSON; nothing may write
 *  over it, since it holds every project's secrets. Never quotes the file. */
export class CredentialsUnreadableError extends Error {
  constructor() {
    super(
      `${credentialsPath()} cannot be parsed; fix or move it before Dispatch stores another secret`
    );
    this.name = 'CredentialsUnreadableError';
  }
}

// What the file holds: absent, a JSON object, or something unreadable.
function loadCredentials():
  | { kind: 'absent' }
  | { kind: 'ok'; file: CredentialsFile }
  | { kind: 'unreadable' } {
  const path = credentialsPath();
  if (!existsSync(path)) return { kind: 'absent' };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
      return { kind: 'unreadable' };
    return { kind: 'ok', file: parsed as CredentialsFile };
  } catch {
    return { kind: 'unreadable' };
  }
}

// A missing or corrupt file reads as "no credentials stored" rather than throwing,
// so a damaged file degrades to "not connected" instead of breaking every read.
export function readCredentials(): CredentialsFile {
  const loaded = loadCredentials();
  return loaded.kind === 'ok' ? loaded.file : {};
}

// Writes to a sibling temp file and renames it onto the live path, so a crash or
// ENOSPC mid-write cannot truncate a file that now holds every project's keys —
// the rename is atomic within a filesystem. Mode 0600 is set on both the create
// and the overwrite path — writeFileSync's `mode` is ignored when the file
// already exists, so the chmod is explicit. Callers hold the lock.
function writeCredentials(file: CredentialsFile): void {
  const path = credentialsPath();
  const tmpPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(file, null, 2)}\n`, {
    mode: 0o600,
  });
  try {
    chmodSync(tmpPath, 0o600);
  } catch {
    // A filesystem without POSIX modes is not a reason to fail the write.
  }
  renameSync(tmpPath, path);
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5_000;

// An advisory lock file beside credentials.json, so two processes writing at
// once cannot drop each other's update; a lock older than 10s is abandoned.
function lockCredentials(): () => void {
  const lock = `${credentialsPath()}.lock`;
  mkdirSync(resolve(lock, '..'), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600));
      return () => {
        try {
          unlinkSync(lock);
        } catch {
          // Taken over as stale; nothing left to release.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    try {
      if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) {
        unlinkSync(lock);
        continue;
      }
    } catch {
      continue;
    }
    if (Date.now() > deadline)
      throw new Error(
        `${lock} is held by another process; remove it if no Dispatch process is running`
      );
    Atomics.wait(pause, 0, 0, 10);
  }
}

// Every writer's read-modify-write, under the lock and on a fresh read. A file
// that cannot be parsed is never replaced, or one write would lose every
// project's secrets. `change` returns null to write nothing.
function updateCredentials(
  change: (file: CredentialsFile) => CredentialsFile | null
): void {
  const release = lockCredentials();
  try {
    const loaded = loadCredentials();
    if (loaded.kind === 'unreadable') throw new CredentialsUnreadableError();
    const next = change(loaded.kind === 'ok' ? loaded.file : {});
    if (next !== null) writeCredentials(next);
  } finally {
    release();
  }
}

export function writeCredential(
  name: CredentialName,
  value: { apiKey: string }
): void {
  updateCredentials((file) => ({ ...file, [name]: value }));
}

export function clearCredential(name: CredentialName): void {
  updateCredentials((file) => {
    const next = { ...file };
    delete next[name];
    return next;
  });
}

// Stores a secret against one project root. The global `linear` slot is left
// alone, so an existing machine-wide key keeps working for every other project.
export function writeProjectCredential(
  rootDir: string,
  name: CredentialName,
  value: { apiKey: string }
): void {
  const key = normalizeProjectPath(rootDir);
  updateCredentials((file) => {
    const existing = file.projects?.[key] ?? {};
    return withProjectEntry(file, key, { ...existing, [name]: value });
  });
}

// Removes one secret from one project, dropping the project's entry once its
// last secret is gone so the file does not accumulate empty objects.
export function clearProjectCredential(
  rootDir: string,
  name: CredentialName
): void {
  const key = normalizeProjectPath(rootDir);
  updateCredentials((file) => {
    const entry = file.projects?.[key];
    if (entry === undefined) return null;
    const remaining: ProjectCredentials = { ...entry };
    delete remaining[name];
    return withProjectEntry(file, key, remaining);
  });
}

// The file with one project's entry replaced, dropping it (and an emptied
// `projects`) when it holds nothing, so the file never accumulates empty objects.
function withProjectEntry(
  file: CredentialsFile,
  key: string,
  entry: ProjectCredentials
): CredentialsFile {
  const projects = { ...file.projects };
  if (Object.keys(entry).length === 0) delete projects[key];
  else projects[key] = entry;
  const next: CredentialsFile = { ...file, projects };
  if (Object.keys(projects).length === 0) delete next.projects;
  return next;
}

// The stored peers map as an own-keys record, or empty when the slot is malformed.
function peersOf(
  entry: ProjectCredentials | undefined
): Record<string, unknown> {
  const peers: unknown = entry?.a2a?.peers;
  return typeof peers === 'object' && peers !== null && !Array.isArray(peers)
    ? (peers as Record<string, unknown>)
    : {};
}

function isPeerCredential(value: unknown): value is PeerCredential {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.scheme === 'bearer' || v.scheme === 'api-key') &&
    typeof v.token === 'string' &&
    v.token !== '' &&
    (v.header === undefined || typeof v.header === 'string')
  );
}

/** One peer's stored credential, or null when it is absent or malformed. */
export function readPeerCredential(
  rootDir: string,
  alias: string
): PeerCredential | null {
  const peers = peersOf(
    readCredentials().projects?.[normalizeProjectPath(rootDir)]
  );
  if (!Object.hasOwn(peers, alias)) return null;
  const raw = peers[alias];
  if (!isPeerCredential(raw)) return null;
  return {
    scheme: raw.scheme,
    token: raw.token,
    ...(raw.header === undefined ? {} : { header: raw.header }),
  };
}

export function writePeerCredential(
  rootDir: string,
  alias: string,
  credential: PeerCredential
): void {
  const key = normalizeProjectPath(rootDir);
  updateCredentials((file) => {
    const entry = file.projects?.[key] ?? {};
    const peers = { ...peersOf(entry), [alias]: credential } as Record<
      string,
      PeerCredential
    >;
    return withProjectEntry(file, key, {
      ...entry,
      a2a: { ...entry.a2a, peers },
    });
  });
}

export function clearPeerCredential(rootDir: string, alias: string): void {
  const key = normalizeProjectPath(rootDir);
  updateCredentials((file) => {
    const entry = file.projects?.[key];
    const peers = { ...peersOf(entry) } as Record<string, PeerCredential>;
    if (entry === undefined || !Object.hasOwn(peers, alias)) return null;
    delete peers[alias];
    const a2a: NonNullable<ProjectCredentials['a2a']> = {
      ...entry.a2a,
      peers,
    };
    if (Object.keys(peers).length === 0) delete a2a.peers;
    const next: ProjectCredentials = { ...entry, a2a };
    if (Object.keys(a2a).length === 0) delete next.a2a;
    return withProjectEntry(file, key, next);
  });
}

export type SigningKeyRead =
  | { status: 'absent' }
  | { status: 'ok'; jwk: Record<string, string> }
  // The slot holds something that is not a JWK of strings.
  | { status: 'malformed' }
  // The credentials file itself cannot be parsed.
  | { status: 'unreadable' };

/** The project's card-signing key. Only 'absent' means a new key may be made. */
export function readA2ASigningKey(rootDir: string): SigningKeyRead {
  const loaded = loadCredentials();
  if (loaded.kind === 'unreadable') return { status: 'unreadable' };
  if (loaded.kind === 'absent') return { status: 'absent' };
  const raw: unknown =
    loaded.file.projects?.[normalizeProjectPath(rootDir)]?.a2a?.signingKey;
  if (raw === undefined) return { status: 'absent' };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { status: 'malformed' };
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0 || entries.some(([, v]) => typeof v !== 'string'))
    return { status: 'malformed' };
  return {
    status: 'ok',
    jwk: Object.fromEntries(entries) as Record<string, string>,
  };
}

/** Stores the project's card-signing key in the 0600 credentials file. */
export function writeA2ASigningKey(
  rootDir: string,
  jwk: Record<string, string>
): void {
  const key = normalizeProjectPath(rootDir);
  updateCredentials((file) => {
    const entry = file.projects?.[key] ?? {};
    return withProjectEntry(file, key, {
      ...entry,
      a2a: { ...entry.a2a, signingKey: { ...jwk } },
    });
  });
}

/** Where a resolved key came from — in precedence order — or `null` when there is none. */
export type CredentialSource = 'project' | 'env' | 'global' | null;

// A stored or exported value only counts when it has content after trimming, so
// a blank env var falls through to the next tier instead of masking it.
function nonEmpty(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// The project's own key wins, so a stale `LINEAR_API_KEY` in the shell cannot
// hijack a project that was deliberately connected. The env var is next, and the
// legacy machine-wide key is the last resort.
export function resolveLinearApiKey(rootDir: string): {
  apiKey: string | null;
  source: CredentialSource;
} {
  const file = readCredentials();

  const fromProject = nonEmpty(
    file.projects?.[normalizeProjectPath(rootDir)]?.linear?.apiKey
  );
  if (fromProject !== null) return { apiKey: fromProject, source: 'project' };

  const fromEnv = nonEmpty(process.env.LINEAR_API_KEY);
  if (fromEnv !== null) return { apiKey: fromEnv, source: 'env' };

  const fromGlobal = nonEmpty(file.linear?.apiKey);
  if (fromGlobal !== null) return { apiKey: fromGlobal, source: 'global' };

  return { apiKey: null, source: null };
}

// The env var wins here, the reverse of Linear's order: a TypeSafe key is not
// project-specific, so a shell export is a deliberate choice rather than a
// stale leftover that could hijack a connected project.
export function resolveTypesafeApiKey(rootDir: string): {
  apiKey: string | null;
  source: CredentialSource;
} {
  const fromEnv = nonEmpty(process.env.TYPESAFE_API_KEY);
  if (fromEnv !== null) return { apiKey: fromEnv, source: 'env' };

  const file = readCredentials();
  const fromProject = nonEmpty(
    file.projects?.[normalizeProjectPath(rootDir)]?.typesafe?.apiKey
  );
  if (fromProject !== null) return { apiKey: fromProject, source: 'project' };

  const fromGlobal = nonEmpty(file.typesafe?.apiKey);
  if (fromGlobal !== null) return { apiKey: fromGlobal, source: 'global' };

  return { apiKey: null, source: null };
}
