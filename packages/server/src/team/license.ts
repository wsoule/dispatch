import {
  FREE_SEATS,
  LICENSE_PUBLIC_KEY,
  readLicenseKey,
} from '@dispatch/federation';
import type { LicenseState } from '@dispatch/federation';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

// How many people may use Dispatch together, and the license key that says
// so. Everything in this folder is licensed under the Elastic License 2.0
// (./LICENSE), whose terms forbid circumventing this functionality.
//
// Dispatch is free for up to FREE_SEATS people with every feature. More than
// that needs a license key: a small signed document naming the organization,
// how many seats it paid for, and until when. The key is checked on this
// machine, against the public key in @dispatch/federation — nothing phones
// home, which is the same promise the rest of Dispatch makes about leaving the
// machine.
//
// A key that is missing, malformed, signed by anyone else, or expired never
// locks anyone out: it reads as the free tier, with the reason attached so
// Settings → License can say what is wrong.

// The key check and the public key live in @dispatch/federation, shared with
// the relay; these re-exports keep scripts and tests importing from here.
export { FREE_SEATS, readLicenseKey, signLicense } from '@dispatch/federation';
export type { License, LicenseState } from '@dispatch/federation';

interface LicenseOptions {
  /** Where an installed key is kept (orchestrator/paths.ts licenseKeyPath). */
  path: string;
  /** A key from the environment (`DISPATCH_LICENSE`), which wins over the
   *  file — how a shared host managed by config tooling sets one. */
  envKey?: string;
  publicKey?: string | null;
  clock?: () => Date;
}

/**
 * The license this daemon runs under, read fresh on every question so a key
 * installed from Settings — or an expiry passing — takes effect without a
 * restart.
 */
export class LicenseManager {
  private readonly publicKey: string | null;
  private readonly clock: () => Date;

  constructor(private readonly opts: LicenseOptions) {
    this.publicKey =
      opts.publicKey === undefined ? LICENSE_PUBLIC_KEY : opts.publicKey;
    this.clock = opts.clock ?? (() => new Date());
  }

  /** The installed key, which the roster shares with the team at founding. */
  installedKey(): string | null {
    const env = this.opts.envKey?.trim();
    if (env !== undefined && env !== '') return env;
    if (!existsSync(this.opts.path)) return null;
    try {
      const text = readFileSync(this.opts.path, 'utf8').trim();
      return text === '' ? null : text;
    } catch {
      return null;
    }
  }

  state(): LicenseState {
    const key = this.installedKey();
    if (key === null) return { kind: 'free', seats: FREE_SEATS };
    return readLicenseKey(key, this.publicKey, this.clock());
  }

  /** How many people may use this project together right now. */
  seats(): number {
    return this.state().seats;
  }

  /**
   * Verifies a key and, if it is good, installs it. A key that does not
   * verify is refused rather than written, so pasting the wrong thing never
   * replaces a working license.
   */
  install(key: string): LicenseState {
    const next = readLicenseKey(key, this.publicKey, this.clock());
    if (next.kind !== 'licensed') return next;
    mkdirSync(dirname(this.opts.path), { recursive: true });
    writeFileSync(this.opts.path, `${key.trim()}\n`, { mode: 0o600 });
    try {
      chmodSync(this.opts.path, 0o600);
    } catch {
      // A filesystem without POSIX modes is not a reason to fail the write.
    }
    return next;
  }
}

/** The sentence a person sees when a seat is not there to give. */
export function seatLimitMessage(seats: number, state: LicenseState): string {
  const why =
    state.kind === 'expired'
      ? `the license for ${state.license.org} expired on ${state.license.expiresAt?.slice(0, 10)}, so the free plan applies`
      : state.kind === 'licensed'
        ? `the license for ${state.license.org} covers ${seats} people`
        : `the free plan covers ${seats} people`;
  return `Dispatch is licensed for ${seats} people here and they all have access: ${why}. Add seats with a license key (Settings → License, or dispatch license set), or revoke someone first.`;
}

/** Why a machine is not syncing the board: its owner is past the seats. */
export function syncPausedMessage(seats: number, state: LicenseState): string {
  const plan =
    state.kind === 'licensed'
      ? `the license for ${state.license.org} covers ${seats}`
      : `the free plan covers ${seats}`;
  return `Board sync is paused on this machine: more people share this board than the license covers (${plan}), and the first ${seats} to sync keep the seats. Work carries on here. Add seats with a license key (Settings → License) to join them.`;
}
