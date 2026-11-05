import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Short-lived, single-use download tickets for `GET /api/files/raw`.
 *
 * A page that authenticates with a bearer header (the desktop webview, a page
 * the daemon serves on loopback) cannot put that header on a plain link, so
 * before tickets its Download button read the whole file into memory first.
 * A ticket lets it hand the browser a URL instead: an authenticated
 * `POST /api/files/download-ticket` checks the path exactly as the raw route
 * would and mints one, and `GET /api/files/raw?ticket=<t>` then streams that
 * one file once, with no header at all.
 *
 * What keeps that from being a weaker credential than the bearer it stands in
 * for:
 *
 * - 32 random bytes, base64url: unguessable, and URL-safe without escaping.
 * - Single use: taking a ticket deletes it, whether or not the download that
 *   follows succeeds.
 * - About a minute of life, swept on every issue and take; nothing runs on a
 *   timer, so a daemon with no downloads holds nothing.
 * - Bound to one resolved file and to the credential that asked for it: the
 *   grant carries a check the redeeming route runs again, so a teammate
 *   revoked, or a run that ended, between issue and use gets nothing.
 * - Held only in this process's memory, keyed by a digest of the ticket, and
 *   never logged. A restart forgets every ticket.
 * - Bounded: past `MAX_TICKETS` live tickets the oldest is dropped, so a
 *   caller looping on the issue route cannot grow the daemon's memory.
 */

/** How long an unused ticket stays valid. */
export const DOWNLOAD_TICKET_TTL_MS = 60_000;

/** Live tickets kept at once before the oldest is dropped. */
export const MAX_DOWNLOAD_TICKETS = 256;

const TICKET_BYTES = 32;

// What a ticket looks like on the wire: 32 bytes of base64url is 43
// characters. Anything else is refused before it is hashed or looked up.
const TICKET_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/** What a ticket lets its bearer download, and who asked for it. */
export interface DownloadGrant {
  /** The run whose worktree the path is in, or null for the project. */
  runId: string | null;
  /** The path as the caller named it, relative to the run or project. */
  path: string;
  /** Where that path resolved on disk when the ticket was issued. */
  resolvedPath: string;
  /**
   * Whether the credential that asked for the ticket would still be let
   * through to the raw route. Run again when the ticket is used.
   */
  stillAuthorized: () => boolean;
}

interface Entry {
  grant: DownloadGrant;
  digest: Buffer;
  expiresAt: number;
}

// SHA-256 of a ticket. The map is keyed by its hex form, so a lookup's timing
// depends on the digest rather than on how much of a guess matched.
function digestOf(ticket: string): Buffer {
  return createHash('sha256').update(ticket, 'utf8').digest();
}

/** One daemon's live download tickets. */
export class DownloadTickets {
  // Insertion order is expiry order (every ticket lives the same TTL), so the
  // sweep only ever looks at the front of the map.
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Mints a ticket for `grant`. */
  issue(grant: DownloadGrant): { ticket: string; expiresAt: string } {
    this.sweep();
    while (this.entries.size >= MAX_DOWNLOAD_TICKETS) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    const ticket = randomBytes(TICKET_BYTES).toString('base64url');
    const digest = digestOf(ticket);
    const expiresAt = this.now() + DOWNLOAD_TICKET_TTL_MS;
    this.entries.set(digest.toString('hex'), { grant, digest, expiresAt });
    return { ticket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /**
   * The grant behind `ticket`, removing it so it can never be used again, or
   * null when it is malformed, unknown, already used or expired.
   */
  take(ticket: string): DownloadGrant | null {
    this.sweep();
    if (!TICKET_SHAPE.test(ticket)) return null;
    const digest = digestOf(ticket);
    const key = digest.toString('hex');
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    this.entries.delete(key);
    if (!timingSafeEqual(entry.digest, digest)) return null;
    if (entry.expiresAt <= this.now()) return null;
    return entry.grant;
  }

  /** Live tickets, for tests of the bound and the sweep. */
  get size(): number {
    return this.entries.size;
  }

  // Drops every expired ticket at the front of the map.
  private sweep(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt > now) break;
      this.entries.delete(key);
    }
  }
}

// One store per daemon, keyed by that daemon's token set: every per-request
// copy of the API context shares it, and two daemons in one process (the
// test suites run many) never see each other's tickets.
const storesByDaemon = new WeakMap<object, DownloadTickets>();

/** The download tickets of the daemon that owns `daemonKey`. */
export function downloadTicketsFor(daemonKey: object): DownloadTickets {
  let store = storesByDaemon.get(daemonKey);
  if (store === undefined) {
    store = new DownloadTickets();
    storesByDaemon.set(daemonKey, store);
  }
  return store;
}
