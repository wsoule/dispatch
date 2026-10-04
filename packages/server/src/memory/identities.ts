import { dbVersion, openSqliteDb, queryAll, queryOne } from '@dispatch/core';
import type { SqliteDatabase } from '@dispatch/core';
import { isSqliteBusy, MemoryBusyError, MemoryError } from '@dispatch/memory';
import { createUlidFactory } from '@dispatch/protocol';
import { createHash, randomBytes as cryptoRandomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** `self` is the daemon's own human; everyone else is `pid-<ulid>`. */
export const IDENTITY_PATTERN = /^(self|pid-[0-9A-HJKMNP-TV-Z]{26})$/;

export type AliasResolution =
  | { ok: true; identity: string }
  | {
      ok: false;
      reason: 'reused-handle';
      boundEmail: string;
      currentEmail: string;
    };

// The roster's stand-in email when git has none; it names no one.
export const PLACEHOLDER_EMAIL = 'local@localhost';

const IDENTITIES_DB_VERSION = 1;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_PATTERN = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const LINK_CODE_MS = 10 * 60 * 1000;

const TABLES = `
CREATE TABLE IF NOT EXISTS identities (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS aliases (
  project_key TEXT NOT NULL, handle TEXT NOT NULL, identity_id TEXT NOT NULL,
  email_at_bind TEXT NOT NULL, bound_at TEXT NOT NULL,
  PRIMARY KEY (project_key, handle)
);
CREATE INDEX IF NOT EXISTS aliases_identity ON aliases (identity_id);
CREATE TABLE IF NOT EXISTS link_codes (
  code_sha256 TEXT PRIMARY KEY, identity_id TEXT NOT NULL, expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS owner_agents (
  project_key TEXT NOT NULL, agent TEXT NOT NULL, token_hash TEXT NOT NULL,
  approved_by TEXT NOT NULL, credential TEXT NOT NULL, approved_at TEXT NOT NULL,
  PRIMARY KEY (project_key, agent)
);
`;

interface AliasRow {
  identity_id: string;
  email_at_bind: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function normalizeEmail(email: string | null): string {
  return (email ?? '').trim().toLowerCase();
}

// An empty or placeholder email says nothing about who holds the handle.
function unknownEmail(email: string): boolean {
  return email === '' || email === PLACEHOLDER_EMAIL;
}

// Upper-cased with dashes and spaces gone; Crockford reads I and L as 1, O as 0.
function normalizeCode(code: string): string {
  return code
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
}

function codeHash(normalized: string): string {
  return createHash('sha256').update(normalized).digest('hex');
}

// The directory is 0700 and the file and its WAL files 0600, re-applied at every open.
function privatePaths(path: string): void {
  try {
    chmodSync(dirname(path), 0o700);
    for (const file of [path, `${path}-wal`, `${path}-shm`])
      if (existsSync(file)) chmodSync(file, 0o600);
  } catch {
    // A filesystem without POSIX modes is not a reason to refuse the file.
  }
}

// identities.db, shared by every daemon under one DISPATCH_HOME: an identity
// names a personal database, and each project's handle is only an alias of it.
export class MemoryIdentities {
  private readonly db: SqliteDatabase;
  private readonly now: () => Date;
  private readonly randomBytes: (n: number) => Uint8Array;
  private readonly ulid: (nowMs: number) => string;

  constructor(opts: {
    path: string;
    now?: () => Date;
    randomBytes?: (n: number) => Uint8Array;
  }) {
    this.now = opts.now ?? (() => new Date());
    this.randomBytes = opts.randomBytes ?? cryptoRandomBytes;
    this.ulid = createUlidFactory(this.randomBytes);
    this.db = openIdentitiesDb(opts.path);
  }

  // The owner is always `self`; anyone else keeps the identity their alias
  // was bound to, unless the roster email behind the handle has changed.
  resolve(input: {
    projectKey: string;
    handle: string;
    isOwner: boolean;
    rosterEmail: string | null;
  }): AliasResolution {
    const email = normalizeEmail(input.rosterEmail);
    const bound = this.alias(input.projectKey, input.handle);
    if (input.isOwner) {
      if (bound?.identity_id !== 'self' || bound.email_at_bind !== email)
        this.transaction(() => {
          this.ensureIdentity('self');
          this.bindAlias(input.projectKey, input.handle, 'self', email);
        });
      return { ok: true, identity: 'self' };
    }
    if (bound !== undefined && !this.adopts(bound, email))
      return checked(bound, email);
    return this.transaction(() => {
      const raced = this.alias(input.projectKey, input.handle);
      if (raced !== undefined) {
        if (!this.adopts(raced, email)) return checked(raced, email);
        this.bindAlias(
          input.projectKey,
          input.handle,
          raced.identity_id,
          email
        );
        return { ok: true, identity: raced.identity_id };
      }
      const identity = this.newIdentity();
      this.bindAlias(input.projectKey, input.handle, identity, email);
      return { ok: true, identity };
    });
  }

  /** A one-time `XXXX-XXXX` code for the caller's identity, valid 10 minutes. */
  startLink(input: {
    projectKey: string;
    handle: string;
    rosterEmail: string | null;
  }): { code: string; expiresAt: string } {
    return this.transaction(() => {
      const bound = this.alias(input.projectKey, input.handle);
      if (bound === undefined)
        throw new MemoryError(
          'not-found',
          `handle: ${input.handle} has no personal memory in this project yet`,
          'handle'
        );
      if (bound.identity_id === 'self')
        throw new MemoryError(
          'invalid',
          "handle: the owner's personal memory already reaches every project; there is nothing to link",
          'handle'
        );
      const email = normalizeEmail(input.rosterEmail);
      const adopted = this.adopts(bound, email);
      if (adopted)
        this.bindAlias(
          input.projectKey,
          input.handle,
          bound.identity_id,
          email
        );
      const resolved = adopted
        ? { ok: true as const, identity: bound.identity_id }
        : checked(bound, email);
      if (!resolved.ok) throw reusedHandle();
      const nowMs = this.now().getTime();
      this.db
        .prepare('DELETE FROM link_codes WHERE expires_at < ?')
        .run(new Date(nowMs).toISOString());
      const code = Array.from(
        this.randomBytes(8),
        (b) => CROCKFORD[b % 32]
      ).join('');
      const expiresAt = new Date(nowMs + LINK_CODE_MS).toISOString();
      this.db
        .prepare(
          'INSERT OR REPLACE INTO link_codes (code_sha256, identity_id, expires_at) VALUES (?, ?, ?)'
        )
        .run(codeHash(code), resolved.identity, expiresAt);
      return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
    });
  }

  // Uses up the code and binds this alias to its identity. `previous` is whose
  // entries to move over: never `self`, nor a reused handle's earlier holder.
  completeLink(input: {
    code: string;
    projectKey: string;
    handle: string;
    rosterEmail: string | null;
  }): { identity: string; previous: string | null } {
    const normalized = normalizeCode(input.code);
    if (!CODE_PATTERN.test(normalized))
      throw new MemoryError(
        'invalid',
        'code: a link code is 8 characters, like 4K7Q-2M9X',
        'code'
      );
    return this.transaction(() => {
      if (this.alias(input.projectKey, input.handle)?.identity_id === 'self')
        throw new MemoryError(
          'invalid',
          "code: the owner's personal memory already reaches every project; there is nothing to link",
          'code'
        );
      const hash = codeHash(normalized);
      const row = queryOne<{ identity_id: string; expires_at: string }>(
        this.db,
        'SELECT identity_id, expires_at FROM link_codes WHERE code_sha256 = ?',
        [hash]
      );
      if (row === undefined)
        throw new MemoryError(
          'not-found',
          'code: no such link code, or it was already used',
          'code'
        );
      this.db.prepare('DELETE FROM link_codes WHERE code_sha256 = ?').run(hash);
      if (Date.parse(row.expires_at) < this.now().getTime())
        throw new MemoryError(
          'invalid',
          'code: this link code expired; run `dispatch memory link` again',
          'code'
        );
      const email = normalizeEmail(input.rosterEmail);
      const bound = this.alias(input.projectKey, input.handle);
      const previous =
        bound === undefined ||
        bound.identity_id === row.identity_id ||
        (bound.email_at_bind !== email && !unknownEmail(bound.email_at_bind))
          ? null
          : bound.identity_id;
      this.bindAlias(input.projectKey, input.handle, row.identity_id, email);
      return { identity: row.identity_id, previous };
    });
  }

  /** Binds this alias to a brand-new identity, leaving the old one's store alone. */
  startFresh(input: {
    projectKey: string;
    handle: string;
    rosterEmail: string | null;
  }): string {
    return this.transaction(() => {
      const identity = this.newIdentity();
      this.bindAlias(
        input.projectKey,
        input.handle,
        identity,
        normalizeEmail(input.rosterEmail)
      );
      return identity;
    });
  }

  // Records that the owner approved `agent` (at this token) with the app token.
  recordOwnerApproval(input: {
    projectKey: string;
    agent: string;
    tokenHash: string;
    approvedBy: string;
  }): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO owner_agents (project_key, agent, token_hash, approved_by, credential, approved_at) VALUES (?, ?, ?, ?, 'app-token', ?)"
      )
      .run(
        input.projectKey,
        input.agent,
        input.tokenHash,
        input.approvedBy,
        this.now().toISOString()
      );
  }

  // Forgets an owner approval, as any other decision on the agent does.
  dropOwnerApproval(projectKey: string, agent: string): void {
    this.db
      .prepare('DELETE FROM owner_agents WHERE project_key = ? AND agent = ?')
      .run(projectKey, agent);
  }

  // Whether the owner approved `agent`, holding this very token, with the app token.
  ownerApproved(projectKey: string, agent: string, tokenHash: string): boolean {
    const row = queryOne<{ token_hash: string }>(
      this.db,
      'SELECT token_hash FROM owner_agents WHERE project_key = ? AND agent = ?',
      [projectKey, agent]
    );
    return row?.token_hash === tokenHash;
  }

  identities(): string[] {
    return queryAll<{ id: string }>(
      this.db,
      'SELECT id FROM identities ORDER BY created_at, id'
    ).map((r) => r.id);
  }

  aliasesOf(identity: string): { projectKey: string; handle: string }[] {
    return queryAll<{ project_key: string; handle: string }>(
      this.db,
      'SELECT project_key, handle FROM aliases WHERE identity_id = ? ORDER BY project_key, handle',
      [identity]
    ).map((r) => ({ projectKey: r.project_key, handle: r.handle }));
  }

  close(): void {
    this.db.close();
  }

  // Whether a teammate's alias bound under an unknown email takes on this real one.
  private adopts(bound: AliasRow, email: string): boolean {
    return (
      bound.identity_id !== 'self' &&
      bound.email_at_bind !== email &&
      unknownEmail(bound.email_at_bind) &&
      !unknownEmail(email)
    );
  }

  private alias(projectKey: string, handle: string): AliasRow | undefined {
    return queryOne<AliasRow>(
      this.db,
      'SELECT identity_id, email_at_bind FROM aliases WHERE project_key = ? AND handle = ?',
      [projectKey, handle]
    );
  }

  private bindAlias(
    projectKey: string,
    handle: string,
    identity: string,
    email: string
  ): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO aliases (project_key, handle, identity_id, email_at_bind, bound_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(projectKey, handle, identity, email, this.now().toISOString());
  }

  private ensureIdentity(id: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO identities (id, created_at) VALUES (?, ?)'
      )
      .run(id, this.now().toISOString());
  }

  private newIdentity(): string {
    const id = `pid-${this.ulid(this.now().getTime())}`;
    this.ensureIdentity(id);
    return id;
  }

  // BEGIN IMMEDIATE, so two daemons binding one alias never race; past the
  // short busy wait it throws MemoryBusyError, which routes retry off the loop.
  private transaction<T>(fn: () => T): T {
    try {
      this.db.exec('BEGIN IMMEDIATE');
    } catch (err) {
      throw isSqliteBusy(err) ? new MemoryBusyError() : err;
    }
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw isSqliteBusy(err) ? new MemoryBusyError() : err;
    }
  }
}

// A teammate never resolves to `self`, and a changed roster email means the
// handle now belongs to someone else.
function checked(bound: AliasRow, email: string): AliasResolution {
  if (bound.identity_id === 'self' || bound.email_at_bind !== email)
    return {
      ok: false,
      reason: 'reused-handle',
      boundEmail: bound.email_at_bind,
      currentEmail: email,
    };
  return { ok: true, identity: bound.identity_id };
}

function reusedHandle(): MemoryError {
  return new MemoryError(
    'conflict',
    'this handle was bound to someone else; link or start fresh',
    'identity'
  );
}

// Refuses only a file whose min_reader_version is newer than this build.
function openIdentitiesDb(path: string): SqliteDatabase {
  let db: SqliteDatabase;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    db = openSqliteDb(path);
  } catch (err) {
    throw new MemoryError(
      'unavailable',
      `personal memory identities unavailable: ${message(err)}`,
      'store'
    );
  }
  try {
    db.exec(TABLES);
    const minReader = queryOne<{ value: string }>(
      db,
      "SELECT value FROM meta WHERE key = 'min_reader_version'"
    );
    if (
      minReader !== undefined &&
      Number(minReader.value) > IDENTITIES_DB_VERSION
    )
      throw new Error(
        `written by a newer Dispatch (needs reader ${minReader.value}, this build is ${IDENTITIES_DB_VERSION})`
      );
    db.prepare(
      "INSERT OR IGNORE INTO meta (key, value) VALUES ('min_reader_version', ?)"
    ).run(String(IDENTITIES_DB_VERSION));
    if (dbVersion(db) < IDENTITIES_DB_VERSION)
      db.exec(`PRAGMA user_version = ${IDENTITIES_DB_VERSION}`);
    privatePaths(path);
    return db;
  } catch (err) {
    db.close();
    throw new MemoryError(
      'unavailable',
      `personal memory identities unavailable: ${message(err)}`,
      'store'
    );
  }
}
