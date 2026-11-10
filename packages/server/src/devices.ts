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

import type { TokenLookup } from './identity.js';
import { humanRef, sha256 } from './identity.js';
import type { AuthTier } from './tiers.js';
import { isAuthTier } from './tiers.js';

// The operator's own other devices: a laptop, a phone, the desktop app on
// another machine — anything that reaches this daemon from somewhere other
// than the process that started it, and so never sees the app token it
// printed.
//
// A device is paired, not invited. Whoever holds the app token asks for a
// short one-time code (`dispatch pair`), types it into the device, and the
// device trades it for a token of its own. That token speaks for the
// operator's handle, so a paired device is the owner acting from elsewhere:
// it takes no team seat and is not a teammate token (team/teammates.ts is the
// licensed, one-token-per-person side). Each device keeps its own token so one
// lost phone is revoked without signing out the rest.

/** A paired device as clients may see it: never its token or hash. */
export interface PairedDevice {
  id: string;
  name: string;
  tier: AuthTier;
  pairedAt: string;
  lastUsedAt: string | null;
}

interface PersistedDevice extends PairedDevice {
  /** Hex sha256 of the device's token. */
  hash: string;
  /** The device whose code paired this one, or null when the app token did.
   *  Unpairing a device unpairs everything it paired, so a stolen phone
   *  cannot leave behind a second device that outlives its revocation. */
  pairedBy?: string | null;
}

/** Where paired devices survive a restart. Injected so tests use memory. */
export interface DeviceStore {
  load: () => PersistedDevice[];
  save: (devices: PersistedDevice[]) => void;
}

/** A DeviceStore over one 0600 JSON file, written through a temp file and a
 *  rename so a crash leaves the old list or the new one. A file that will not
 *  parse loads as no devices — every device then pairs again, which fails
 *  closed rather than guessing at credentials. */
export function fileDeviceStore(path: string): DeviceStore {
  return {
    load: () => {
      if (!existsSync(path)) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
      } catch {
        console.error(`dispatchd: paired devices file ${path} is unreadable`);
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (d): d is PersistedDevice =>
          typeof d === 'object' &&
          d !== null &&
          typeof (d as PersistedDevice).id === 'string' &&
          typeof (d as PersistedDevice).name === 'string' &&
          isAuthTier((d as PersistedDevice).tier) &&
          typeof (d as PersistedDevice).pairedAt === 'string' &&
          /^[0-9a-f]{64}$/.test(String((d as PersistedDevice).hash))
      );
    },
    save: (devices) => {
      mkdirSync(dirname(path), { recursive: true });
      const temp = `${path}.tmp-${process.pid}`;
      writeFileSync(temp, JSON.stringify(devices, null, 2), { mode: 0o600 });
      try {
        chmodSync(temp, 0o600);
      } catch {
        // A filesystem without POSIX modes is not a reason to fail the write.
      }
      renameSync(temp, path);
    },
  };
}

const MEMORY_ONLY: DeviceStore = { load: () => [], save: () => {} };

// Same reasoning as team tokens: recording use is a disk write, and a device
// authenticates on every fetch, so the stored time may lag by this much.
const LAST_USED_PERSIST_MS = 15 * 60 * 1000;

interface Entry extends PairedDevice {
  hash: Buffer;
  pairedBy: string | null;
  persistedLastUsedAt: string | null;
}

/**
 * Every device paired with this daemon, asked by the TokenRegistry about any
 * token that is not one of the daemon's own two.
 */
export class PairedDevices {
  private readonly entries: Entry[];
  private readonly store: DeviceStore;
  private readonly clock: () => Date;

  constructor(
    private readonly operatorHandle: string,
    opts: { store?: DeviceStore; clock?: () => Date } = {}
  ) {
    this.store = opts.store ?? MEMORY_ONLY;
    this.clock = opts.clock ?? (() => new Date());
    this.entries = this.store.load().map((d) => ({
      id: d.id,
      name: d.name,
      tier: d.tier,
      pairedAt: d.pairedAt,
      lastUsedAt: d.lastUsedAt ?? null,
      hash: Buffer.from(d.hash, 'hex'),
      pairedBy: d.pairedBy ?? null,
      persistedLastUsedAt: d.lastUsedAt ?? null,
    }));
  }

  /** What a presented token is, given its sha256: a device, or nothing. */
  lookup(digest: Buffer): TokenLookup {
    const entry = this.entries.find((e) => timingSafeEqual(digest, e.hash));
    if (entry === undefined) return { kind: 'unknown' };
    this.recordUse(entry);
    return {
      kind: 'valid',
      identity: {
        handle: this.operatorHandle,
        ref: humanRef(this.operatorHandle),
        tier: entry.tier,
        device: entry.id,
      },
    };
  }

  /** Pairs a new device and returns its token — the only time the token
   *  exists outside the device that holds it. */
  add(
    name: string,
    tier: AuthTier,
    pairedBy: string | null = null
  ): { token: string; device: PairedDevice } {
    const token = randomBytes(32).toString('hex');
    const entry: Entry = {
      id: `d-${randomBytes(4).toString('hex')}`,
      name,
      tier,
      pairedAt: this.clock().toISOString(),
      lastUsedAt: null,
      hash: sha256(token),
      pairedBy,
      persistedLastUsedAt: null,
    };
    this.entries.push(entry);
    this.persist();
    return { token, device: summary(entry) };
  }

  list(): PairedDevice[] {
    return this.entries.map(summary);
  }

  /** Unpairs a device and every device it paired, transitively. Returns
   *  the ids unpaired; empty when `id` was not paired. */
  revoke(id: string): string[] {
    if (!this.entries.some((e) => e.id === id)) return [];
    const gone = new Set([id]);
    // Grows until no remaining device was paired by one already going.
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of this.entries) {
        if (!gone.has(e.id) && e.pairedBy !== null && gone.has(e.pairedBy)) {
          gone.add(e.id);
          grew = true;
        }
      }
    }
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (gone.has(this.entries[i].id)) this.entries.splice(i, 1);
    }
    this.persist();
    return [...gone];
  }

  private recordUse(entry: Entry): void {
    const now = this.clock();
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

  private persist(): void {
    this.store.save(
      this.entries.map((e) => ({
        ...summary(e),
        hash: e.hash.toString('hex'),
        pairedBy: e.pairedBy,
      }))
    );
    for (const e of this.entries) e.persistedLastUsedAt = e.lastUsedAt;
  }
}

function summary(e: Entry): PairedDevice {
  return {
    id: e.id,
    name: e.name,
    tier: e.tier,
    pairedAt: e.pairedAt,
    lastUsedAt: e.lastUsedAt,
  };
}

// Crockford base32: no I, L, O or U, so a code read aloud or off a phone
// screen has no look-alike letters. 256 is a multiple of 32, so a random
// byte modulo 32 is unbiased.
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 8;
const DEFAULT_TTL_MS = 10 * 60 * 1000;
// Wrong guesses across all open codes before every one of them is burned. An
// 8-character code is 40 bits; capping guesses per batch of codes keeps a
// network attacker to a handful of tries per offer instead of ten minutes of
// them.
const DEFAULT_MAX_FAILURES = 10;

/** A code as the user may type it: any case, with or without the dash or
 *  spaces, and the look-alike letters Crockford folds (O → 0, I/L → 1). */
export function normalizePairingCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export interface PairingOffer {
  /** `XXXX-XXXX`, shown to the user once. */
  code: string;
  tier: AuthTier;
  expiresAt: string;
}

export type RedeemResult =
  | { ok: true; tier: AuthTier; pairedBy: string | null }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * One-time pairing codes, held in memory only: a daemon restart forgets every
 * open code, which is the safe direction. A code is good once, for one
 * device, until it expires.
 */
export class PairingCodes {
  private readonly open = new Map<
    string,
    { tier: AuthTier; expires: number; pairedBy: string | null }
  >();
  private failures = 0;
  private readonly clock: () => Date;
  private readonly ttlMs: number;
  private readonly maxFailures: number;

  constructor(
    opts: { clock?: () => Date; ttlMs?: number; maxFailures?: number } = {}
  ) {
    this.clock = opts.clock ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.maxFailures = opts.maxFailures ?? DEFAULT_MAX_FAILURES;
  }

  /** A new code for a device at `tier`. `pairedBy` is the device asking,
   *  or null for the app token. */
  offer(tier: AuthTier, pairedBy: string | null = null): PairingOffer {
    const bytes = randomBytes(CODE_LENGTH);
    let code = '';
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
    const expires = this.clock().getTime() + this.ttlMs;
    this.open.set(code, { tier, expires, pairedBy });
    return {
      code: formatCode(code),
      tier,
      expiresAt: new Date(expires).toISOString(),
    };
  }

  /** Spends a code. A wrong one counts toward burning every open code. */
  redeem(raw: string): RedeemResult {
    const code = normalizePairingCode(raw);
    const found = this.open.get(code);
    if (found === undefined) {
      this.failures += 1;
      if (this.failures >= this.maxFailures) {
        this.open.clear();
        this.failures = 0;
      }
      return { ok: false, reason: 'invalid' };
    }
    this.open.delete(code);
    if (this.clock().getTime() >= found.expires) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, tier: found.tier, pairedBy: found.pairedBy };
  }
}
