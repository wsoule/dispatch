import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

import type {
  CredentialSource,
  IssuedTokenSummary,
  TokenLookup,
} from '../identity.js';
import { humanRef, sha256 } from '../identity.js';
import type { AuthTier } from '../tiers.js';
import { isAuthTier } from '../tiers.js';

// Teammates' credentials: the part of identity that lets more than one person
// use a daemon. Licensed under the Elastic License 2.0 (./LICENSE) — the seat
// limit enforced here is license-key functionality.
//
// A person is a handle. The operator — whoever runs the daemon, holding its
// built-in tokens — is always one of the people; every teammate holding a
// live token is another. The license says how many that may be (license.ts),
// and the limit is kept in two places so neither can be skipped:
//
// - Issuing a token to someone new is refused once every seat is taken.
// - A token is only honored while its holder is among the first people
//   invited that fit, so a hand-edited token file, or a license that lapsed,
//   leaves the earliest teammates working and refuses the rest with a reason.

/** One issued teammate credential as it is kept on disk: a hash, never the
 *  token. A copied or leaked file then grants nothing — a sha256 of 32 random
 *  bytes cannot be walked back to the bytes. */
export interface PersistedToken {
  handle: string;
  tier: AuthTier;
  /** Hex sha256 of the token. */
  hash: string;
  issuedAt: string;
  /** When it stops working, or null for never. Absent on files written
   *  before expiry existed, which reads as never. */
  expiresAt?: string | null;
  /** The last time it authenticated a request, to the nearest persist. */
  lastUsedAt?: string | null;
}

/** Where issued teammate tokens survive a restart. Injected so tests use
 *  memory; the daemon uses `fileTokenStore`. */
export interface TokenStore {
  load: () => PersistedToken[];
  save: (tokens: PersistedToken[]) => void;
  /** What went wrong with the file, for /api/health. */
  problems?: () => string[];
}

interface Entry {
  hash: Buffer;
  handle: string;
  tier: AuthTier;
  issuedAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  /** `lastUsedAt` as of the last write to the store, so a token in constant
   *  use is written back every LAST_USED_PERSIST_MS rather than per request. */
  persistedLastUsedAt: string | null;
}

/** Issuing to one more person than the license covers. */
export class SeatLimitError extends Error {
  constructor(
    message: string,
    readonly seats: number
  ) {
    super(message);
    this.name = 'SeatLimitError';
  }
}

// How stale a persisted last-used time may get. Recording use is a write to
// disk, and a busy teammate authenticates many times a second (every fetch,
// every socket); fifteen minutes is fine-grained enough to answer "has anyone
// used this token lately" without turning reads into writes.
const LAST_USED_PERSIST_MS = 15 * 60 * 1000;

/** Whether a stored expiry can be enforced. An unparseable one is dropped
 *  with its token rather than read as "never" — a hand-edited or corrupted
 *  file must fail closed, not hand out a credential with no end date. */
function validExpiry(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && !Number.isNaN(Date.parse(value)))
  );
}

/** A TokenStore over one JSON file, written 0600 because even hashes are
 *  nobody else's business. A missing file loads as empty; an unreadable one is
 *  moved aside to `.corrupt-<ts>` with a problem, so a save never overwrites
 *  credentials someone may still recover. Saves go through a temp file and a
 *  rename, so a crash leaves the old file or the new one, never half of one. */
export function fileTokenStore(path: string): TokenStore {
  const problems: string[] = [];
  // Reads the file; null when it is missing, 'unreadable' when it will not parse.
  const read = (): unknown[] | null | 'unreadable' => {
    if (!existsSync(path)) return null;
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      return Array.isArray(parsed) ? parsed : 'unreadable';
    } catch {
      return 'unreadable';
    }
  };
  const moveAside = (): void => {
    const aside = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(path, aside);
    const problem = `team token file ${path} was unreadable; moved to ${aside}. Issue teammates fresh tokens, or repair it and restart.`;
    problems.push(problem);
    console.error(`dispatchd: ${problem}`);
  };
  return {
    load: () => {
      const parsed = read();
      if (parsed === null) return [];
      if (parsed === 'unreadable') {
        moveAside();
        return [];
      }
      return parsed.filter(
        (t): t is PersistedToken =>
          typeof t === 'object' &&
          t !== null &&
          typeof (t as PersistedToken).handle === 'string' &&
          isAuthTier((t as PersistedToken).tier) &&
          typeof (t as PersistedToken).hash === 'string' &&
          /^[0-9a-f]{64}$/.test((t as PersistedToken).hash) &&
          validExpiry((t as PersistedToken).expiresAt)
      );
    },
    save: (tokens) => {
      mkdirSync(dirname(path), { recursive: true });
      if (read() === 'unreadable') moveAside();
      const temp = `${path}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(tokens, null, 2), { mode: 0o600 });
      try {
        chmodSync(temp, 0o600);
      } catch {
        // A filesystem without POSIX modes is not a reason to fail the write.
      }
      renameSync(temp, path);
    },
    problems: () => [...problems],
  };
}

/** A store that keeps nothing — the default, so a set built without one
 *  (tests, a harness) never touches disk. */
const MEMORY_ONLY: TokenStore = { load: () => [], save: () => {} };

interface TeammateOptions {
  store?: TokenStore;
  /** How many people the license covers, the operator included. Asked on
   *  every check, so a key installed while the daemon runs applies at once. */
  seats?: () => number;
  /** The sentence to refuse with when the seats are taken. */
  seatMessage?: (seats: number) => string;
  clock?: () => Date;
  /** Whoever runs the daemon; a token for their handle (issued before that
   *  was refused) authenticates no one and takes no seat. */
  operatorHandle?: string;
}

/**
 * Every credential issued to a teammate, and whether the license covers them.
 * The daemon's TokenRegistry asks this for any token that is not its own.
 */
export class TeammateTokens implements CredentialSource {
  private readonly entries: Entry[] = [];
  private readonly store: TokenStore;
  private readonly seats: () => number;
  private readonly seatMessage: (seats: number) => string;
  private readonly clock: () => Date;
  private readonly operatorHandle: string | null;

  constructor(opts: TeammateOptions = {}) {
    this.operatorHandle = opts.operatorHandle ?? null;
    this.store = opts.store ?? MEMORY_ONLY;
    this.seats = opts.seats ?? (() => Number.POSITIVE_INFINITY);
    this.seatMessage =
      opts.seatMessage ??
      ((seats) => `this project is licensed for ${seats} people`);
    this.clock = opts.clock ?? (() => new Date());
    for (const t of this.store.load()) {
      this.entries.push({
        hash: Buffer.from(t.hash, 'hex'),
        handle: t.handle,
        tier: t.tier,
        // Older files could carry no issue time; the earliest possible one
        // keeps them first in line, where they would have been.
        issuedAt:
          typeof t.issuedAt === 'string' &&
          !Number.isNaN(Date.parse(t.issuedAt))
            ? t.issuedAt
            : new Date(0).toISOString(),
        expiresAt: t.expiresAt ?? null,
        lastUsedAt: t.lastUsedAt ?? null,
        persistedLastUsedAt: t.lastUsedAt ?? null,
      });
    }
  }

  private live(e: Entry, now: number): boolean {
    return e.expiresAt === null || now < Date.parse(e.expiresAt);
  }

  // A live token that can authenticate: never one for the operator's handle.
  private usable(e: Entry, now: number): boolean {
    return e.handle !== this.operatorHandle && this.live(e, now);
  }

  /**
   * The teammates the license covers right now: the earliest-invited handles
   * holding a live token, as many as fit beside the operator. Earliest first
   * so a lapse or a downgrade never locks out the people who were there
   * before whoever tipped it over.
   */
  private covered(now: number): Set<string> {
    const room = Math.max(this.seats() - 1, 0);
    const byFirstIssue = new Map<string, number>();
    for (const e of this.entries) {
      if (!this.usable(e, now)) continue;
      const at = Date.parse(e.issuedAt);
      const seen = byFirstIssue.get(e.handle);
      if (seen === undefined || at < seen) byFirstIssue.set(e.handle, at);
    }
    return new Set(
      [...byFirstIssue.entries()]
        .sort((a, b) =>
          a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] - b[1]
        )
        .slice(0, room)
        .map(([handle]) => handle)
    );
  }

  lookup(digest: Buffer): TokenLookup {
    const entry = this.entries.find((e) => timingSafeEqual(digest, e.hash));
    if (entry === undefined || entry.handle === this.operatorHandle)
      return { kind: 'unknown' };
    const now = this.clock();
    if (!this.live(entry, now.getTime())) {
      return {
        kind: 'expired',
        handle: entry.handle,
        expiredAt: entry.expiresAt ?? '',
      };
    }
    if (!this.covered(now.getTime()).has(entry.handle)) {
      return {
        kind: 'refused',
        handle: entry.handle,
        reason: this.seatMessage(this.seats()),
      };
    }
    this.recordUse(entry, now);
    return {
      kind: 'valid',
      identity: {
        handle: entry.handle,
        ref: humanRef(entry.handle),
        tier: entry.tier,
      },
    };
  }

  /** Notes a use in memory, and writes it through when the stored value has
   *  fallen more than LAST_USED_PERSIST_MS behind. */
  private recordUse(entry: Entry, now: Date): void {
    entry.lastUsedAt = now.toISOString();
    const persisted =
      entry.persistedLastUsedAt === null
        ? null
        : Date.parse(entry.persistedLastUsedAt);
    if (
      persisted === null ||
      now.getTime() - persisted >= LAST_USED_PERSIST_MS
    ) {
      this.persist();
    }
  }

  /** How many people have access now, the operator included. */
  /** What went wrong with the token file, for /api/health. */
  problems(): string[] {
    return this.store.problems?.() ?? [];
  }

  peopleWithAccess(): number {
    const now = this.clock().getTime();
    return (
      1 +
      new Set(
        this.entries.filter((e) => this.usable(e, now)).map((e) => e.handle)
      ).size
    );
  }

  /**
   * Mints a credential for one teammate and returns it — the only time the
   * token value exists outside its owner's hands.
   *
   * One token per person: issuing replaces whatever that handle held, at any
   * tier. Raising or lowering someone's tier is then just inviting them again,
   * and a teammate whose laptop was lost is re-credentialed rather than left
   * with a forgotten second token still live at their old tier. Neither takes
   * a new seat; only someone new does, and SeatLimitError says when none is
   * left.
   */
  issue(
    handle: string,
    tier: AuthTier,
    options: { expiresAt?: Date | null } = {}
  ): string {
    const now = this.clock().getTime();
    const others = new Set(
      this.entries
        .filter((e) => e.handle !== handle && this.usable(e, now))
        .map((e) => e.handle)
    );
    const seats = this.seats();
    if (1 + others.size + 1 > seats) {
      throw new SeatLimitError(this.seatMessage(seats), seats);
    }
    this.drop(handle);
    const token = randomBytes(32).toString('hex');
    this.entries.push({
      hash: sha256(token),
      handle,
      tier,
      issuedAt: this.clock().toISOString(),
      expiresAt: options.expiresAt?.toISOString() ?? null,
      lastUsedAt: null,
      persistedLastUsedAt: null,
    });
    this.persist();
    return token;
  }

  /** Drops an issued credential. Returns whether one was there. */
  revoke(handle: string): boolean {
    const dropped = this.drop(handle);
    if (dropped) this.persist();
    return dropped;
  }

  list(): IssuedTokenSummary[] {
    const now = this.clock().getTime();
    return this.entries.map((e) => ({
      handle: e.handle,
      tier: e.tier,
      builtIn: false,
      issuedAt: e.issuedAt,
      expiresAt: e.expiresAt,
      lastUsedAt: e.lastUsedAt,
      expired: !this.live(e, now),
      unusable: e.handle === this.operatorHandle,
    }));
  }

  /** The tier a teammate's issued token carries, or null when they hold
   *  none. */
  issuedTier(handle: string): AuthTier | null {
    return this.entries.find((e) => e.handle === handle)?.tier ?? null;
  }

  /** Drops every issued token a handle holds. A file written before tokens
   *  were one per person can carry several; all of them go. */
  private drop(handle: string): boolean {
    const before = this.entries.length;
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].handle === handle) this.entries.splice(i, 1);
    }
    return this.entries.length !== before;
  }

  /** Writes every issued entry back as hashes. */
  private persist(): void {
    this.store.save(
      this.entries.map((e) => ({
        handle: e.handle,
        tier: e.tier,
        hash: e.hash.toString('hex'),
        issuedAt: e.issuedAt,
        expiresAt: e.expiresAt,
        lastUsedAt: e.lastUsedAt,
      }))
    );
    for (const e of this.entries) e.persistedLastUsedAt = e.lastUsedAt;
  }
}
