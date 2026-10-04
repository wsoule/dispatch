import {
  foldRoster,
  FREE_SEATS,
  isCovered,
  keyFieldsProblem,
  KNOWN_ROSTER_PAIRS,
  printable,
  readLicenseKey,
  speaksForHandle,
} from '@dispatch/federation';
import type { KeyInfo, PinnedKey, RosterView } from '@dispatch/federation';
import type { JsonValue } from '@dispatch/protocol';
import {
  b64u,
  crockford32,
  ed25519FromSeed,
  fingerprint,
  fromB64u,
  hlcWallMs,
  MAX_CLOCK_LEAD_MS,
  opHash,
  sha256Hex,
  signText,
  TAG,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type {
  FederatedOp,
  KeyBody,
  LegacyAttestation,
  RosterBody,
} from '@dispatch/protocol/federation';
import { randomBytes } from 'node:crypto';

import { seatLimitMessage } from '../license.js';
import type { AuditKind } from './audit.js';
import { signedEntry } from './git.js';
import type { FedStore } from './store.js';
import { MAX_KEY_CLAIMS } from './store.js';

/** Why a roster action was refused; the routes map each code to a status. */
export class RosterError extends Error {
  override name = 'RosterError';
  constructor(
    readonly code: 'forbidden' | 'conflict' | 'seat_limit' | 'invalid',
    message: string
  ) {
    super(message);
  }
}

export interface RosterDeps {
  fed: FedStore;
  handle: string;
  device: string;
  build: string;
  now: () => Date;
  installedLicense: () => string | null;
  licensePublicKey: string | null;
  /** Attestations of the v1 logs on the branch (Task 9b); [] until then. */
  legacy: () => LegacyAttestation[];
  ownV1Attestation: () => { throughSeq: number; digest: string } | null;
  relayUrl?: () => string | null;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// A retried invite for the same handle within this window gets the same code.
const INVITE_RETRY_MS = 2 * 60 * 1000;
const SEED_BYTES = 32;
const RECOVERY_GROUPS = 13;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const OBSERVER = 'an observer publishes only keys, presence and acks';
const NO_ADMIN = 'would leave the team with no admin';

interface RosterRow {
  replica: string;
  sign_pub: string;
  seq: number;
  hlc: string;
  hash: string;
  body_json: string;
}

interface Founding {
  replica: string;
  seq: number;
  hash: string;
  hlc: string;
  /** The key that signed it, one of its replica id's claims. */
  signPub: string;
}

interface PendingInvite {
  id: string;
  sig: string;
  teamId: string;
  /** When this machine joined with it; it binds for INVITE_TTL_MS after. */
  at?: string;
}

// The daemon's side of the signed roster: it publishes this machine's roster
// ops, applies verified ones, and reads rights from the shared fold.
// The tail of a held op's problem, which only the hold clears.
const CLOCK_HOLD =
  "ahead of this machine's clock; it waits until the clock catches up";

export class RosterService {
  private cached: RosterView | null | undefined;
  /** Problem subjects the last fold recorded, cleared when they go away. */
  private recorded = new Set<string>();
  /** Invites issued here lately, by handle, for a retried request. */
  private recentInvites = new Map<
    string,
    { code: string; expires: string; at: number }
  >();

  constructor(private readonly deps: RosterDeps) {}

  private get fed(): FedStore {
    return this.deps.fed;
  }

  private get me(): string {
    return this.fed.replica;
  }

  /** The fold of every verified roster op, or null until a founder is pinned. */
  view(): RosterView | null {
    if (this.cached === undefined) this.cached = this.fold();
    return this.cached;
  }

  /** Re-folds, since the fold reads the clock: a license expires, a deadline
   *  passes, an invite stops binding. */
  reload(): void {
    // An invite that stopped binding may leave one founding to follow.
    if (!this.founded()) this.onFoundSeen();
    this.refresh();
  }

  founded(): boolean {
    return this.fed.meta('founder') !== null;
  }

  teamId(): string | null {
    return this.fed.meta('team_id');
  }

  /** The `found` ops seen from pinned publishers, while none is pinned or chosen. */
  foundingsSeen(): { replica: string; fingerprint: string }[] {
    return this.foundings().map((f) => ({
      replica: f.replica,
      fingerprint: this.claimOf(f.replica, f.signPub)?.fingerprint ?? '',
    }));
  }

  /** The op hash of a roster op this replica holds, for naming it in a dismiss. */
  opHashOf(replica: string, seq: number): string | null {
    const row = this.fed.db
      .query<{ hash: string }, [string, number, string]>(
        'SELECT hash FROM fed_roster WHERE replica = ? AND seq = ? AND sign_pub = ?'
      )
      .get(replica, seq, this.fed.pinned(replica)?.signPub ?? '');
    return row?.hash ?? null;
  }

  // ---- actions ----

  found(
    name: string,
    legacy: LegacyAttestation[] = this.deps.legacy()
  ): { recoveryCode: string } {
    if (this.founded() || this.foundings().length > 0)
      throw new RosterError(
        'conflict',
        'a team is already founded on this branch'
      );
    const seed = randomBytes(SEED_BYTES);
    const recovery = ed25519FromSeed(seed);
    this.atomically(() => {
      this.publishKey();
      const found = this.publish({
        rv: 1,
        action: 'found',
        name,
        legacy,
        recoveryPub: recovery.signPub,
      });
      this.pinFounder(founding(found, this.fed.keys.signPub), 'firm');
      const key = this.deps.installedLicense();
      if (key !== null && this.licenseVerifies(key))
        this.publish({ rv: 1, action: 'license', key });
    });
    return { recoveryCode: encodeRecoveryCode(seed) };
  }

  trust(fp: string): void {
    const chosen = this.foundings().find(
      (f) => this.claimOf(f.replica, f.signPub)?.fingerprint === fp
    );
    if (chosen === undefined)
      throw new RosterError('invalid', `no founding with fingerprint ${fp}`);
    const invite = this.bindingInvite();
    if (invite !== null && chosen.hash.slice(0, 32) !== invite.teamId)
      throw new RosterError(
        'conflict',
        `this machine joined with an invite to team ${invite.teamId}; trust that team's founding, or run \`dispatch team abandon-invite\` and then trust this one`
      );
    const founder = this.fed.meta('founder');
    if (founder === chosen.replica) return;
    if (founder === this.me) {
      const others = [...(this.view()?.members.keys() ?? [])].filter(
        (r) => r !== this.me
      );
      if (others.length > 0)
        throw new RosterError('conflict', 'your team already has members');
    } else if (founder !== null && this.fed.meta('founder_pin') === 'firm')
      throw new RosterError('conflict', 'a founder is already pinned');
    this.pinFounder(chosen, 'firm');
    this.fed.audit('trust', `replica:${chosen.replica}`, {
      replica: chosen.replica,
      seq: chosen.seq,
      hash: chosen.hash,
      fingerprint: fp,
    });
  }

  invite(handle: string): { code: string; expires: string } {
    const view = this.member();
    const mine = view.members.get(this.me);
    if (mine?.role !== 'admin' && mine?.handle !== handle)
      throw new RosterError(
        'forbidden',
        'a member may invite only for their own handle'
      );
    const at = this.deps.now().getTime();
    const recent = this.recentInvites.get(handle);
    if (recent !== undefined && at - recent.at < INVITE_RETRY_MS)
      return { code: recent.code, expires: recent.expires };
    const seed = randomBytes(SEED_BYTES);
    const pub = ed25519FromSeed(seed).signPub;
    const expires = new Date(at + INVITE_TTL_MS).toISOString();
    this.publish({
      rv: 1,
      action: 'invite',
      id: sha256Hex(pub).slice(0, 16),
      pub,
      handle,
      expires,
    });
    const code = encodeInviteCode({
      teamId: view.teamId,
      seed,
      relay: this.deps.relayUrl?.() ?? null,
    });
    this.recentInvites.set(handle, { code, expires, at });
    return { code, expires };
  }

  join(code: string): void {
    const { teamId, seed } = decodeInviteCode(code);
    const pinnedTeam = this.teamId();
    if (pinnedTeam !== null && pinnedTeam !== teamId)
      throw new RosterError(
        'invalid',
        'this invite is for another team than the one this machine follows'
      );
    if (this.fed.head() !== null)
      throw new RosterError(
        'conflict',
        'this machine already asked to join; an admin can admit it by fingerprint'
      );
    const inviteKey = ed25519FromSeed(seed);
    const sig = signText(
      inviteKey.signPriv,
      `${TAG.invite}\n${teamId}\n${this.me}\n${this.fed.keys.signPub}`
    );
    const pending: PendingInvite = {
      id: sha256Hex(inviteKey.signPub).slice(0, 16),
      sig,
      teamId,
      at: this.deps.now().toISOString(),
    };
    this.atomically(() => {
      this.fed.setMeta('pending_invite', JSON.stringify(pending));
      this.publishKey();
    });
  }

  /** Lets go of the invite this machine joined with, so trust or another
   *  founding may decide; its key op already published stays as it is. */
  abandonInvite(): void {
    if (this.pendingInvite() === null)
      throw new RosterError('conflict', 'this machine holds no invite');
    this.atomically(() => {
      this.fed.setMeta('pending_invite', null);
      this.onFoundSeen();
    });
  }

  recover(code: string): void {
    const seed = decodeRecoveryCode(code);
    const view = this.view();
    const teamId = this.teamId();
    if (view === null || teamId === null)
      throw new RosterError(
        'invalid',
        "this machine has not seen the team's founding yet; pull first"
      );
    const recovery = ed25519FromSeed(seed);
    if (recovery.signPub !== view.recoveryPub)
      throw new RosterError(
        'invalid',
        "this is not the team's current recovery code"
      );
    if (view.members.has(this.me))
      throw new RosterError('conflict', 'this machine is already admitted');
    if (this.ownRosterOps() > 0)
      throw new RosterError(
        'conflict',
        'a recover must be this machine’s first roster op; join as a new machine'
      );
    const proof = signText(
      recovery.signPriv,
      `${TAG.recovery}\n${teamId}\n${this.me}\n${this.fed.keys.signPub}`
    );
    this.atomically(() => {
      this.publishKey();
      this.publish({ rv: 1, action: 'recover', proof }, (v, op) =>
        v.members.get(this.me)?.recovered === true
          ? null
          : new RosterError(
              'invalid',
              noteFor(v, op) ?? 'the recovery code did not admit this machine'
            )
      );
    });
  }

  replaceRecoveryKey(): { recoveryCode: string } {
    this.admin('rotate the recovery code');
    const seed = randomBytes(SEED_BYTES);
    this.publish({
      rv: 1,
      action: 'recovery-key',
      pub: ed25519FromSeed(seed).signPub,
    });
    return { recoveryCode: encodeRecoveryCode(seed) };
  }

  shareLicense(): void {
    this.admin('share the team license');
    const key = this.deps.installedLicense();
    if (key === null || !this.licenseVerifies(key))
      throw new RosterError(
        'invalid',
        'no valid license key is installed on this machine'
      );
    this.publish({ rv: 1, action: 'license', key });
  }

  admit(
    replica: string,
    opts: {
      fingerprint: string;
      handle?: string;
      role?: 'member' | 'admin';
      hosts?: string[];
      observer?: boolean;
    }
  ): void {
    const view = this.member();
    // Any claim on the id may be the one admitted: the fingerprint picks it.
    const claims = this.fed.claims(replica);
    if (claims.length === 0)
      throw new RosterError(
        'conflict',
        `${replica} has published no key op this machine has read`
      );
    const pinned = claims.find((c) => c.fingerprint === opts.fingerprint);
    if (pinned === undefined)
      throw new RosterError(
        'conflict',
        `${replica}'s key has fingerprint ${claims.map((c) => c.fingerprint).join(' or ')}, not ${opts.fingerprint}`
      );
    if (view.revoked.has(replica))
      throw new RosterError(
        'conflict',
        `${replica} was revoked and is never admitted again`
      );
    if (view.members.has(replica))
      throw new RosterError('conflict', `${replica} is already admitted`);
    const handle = opts.handle ?? pinned.handle;
    const role = opts.role ?? 'member';
    const hosts = opts.hosts ?? [];
    const observer = opts.observer === true;
    const mine = view.members.get(this.me);
    const ownDevice =
      mine?.handle === handle &&
      pinned.handle === handle &&
      role === 'member' &&
      hosts.length === 0 &&
      !observer;
    if (mine?.role !== 'admin' && !ownDevice)
      throw new RosterError(
        'forbidden',
        'a member may admit only a device of their own, as a member'
      );
    if (!observer) this.checkSeats(view, [handle, ...hosts]);
    this.publish({
      rv: 1,
      action: 'admit',
      replica,
      handle,
      role,
      fingerprint: opts.fingerprint,
      ...(hosts.length > 0 ? { hosts } : {}),
      ...(observer ? { observer: true as const } : {}),
    });
  }

  revoke(replica: string, reason: string): void {
    const view = this.member();
    if (replica === this.me)
      throw new RosterError(
        'conflict',
        "this machine cannot revoke its own key; another admin's machine can"
      );
    const mine = view.members.get(this.me);
    const theirs =
      view.members.get(replica)?.handle ?? this.fed.pinned(replica)?.handle;
    if (mine?.role !== 'admin' && mine?.handle !== theirs)
      throw new RosterError(
        'forbidden',
        'a member may revoke only devices with their own handle'
      );
    this.publish({
      rv: 1,
      action: 'revoke',
      replica,
      ...this.cut(replica),
      reason,
    });
  }

  setRole(replica: string, role: 'member' | 'admin'): void {
    const view = this.admin('change roles');
    const current = view.members.get(replica);
    if (current === undefined)
      throw new RosterError('conflict', `${replica} is not admitted`);
    if (current.role === role)
      throw new RosterError(
        'conflict',
        `${replica} is already ${role === 'admin' ? 'an admin' : 'a member'}`
      );
    if (role === 'admin')
      this.publish({ rv: 1, action: 'role', replica, role });
    else
      this.publish({
        rv: 1,
        action: 'role',
        replica,
        role,
        ...this.cut(replica),
      });
  }

  setHosts(replica: string, hosts: string[]): void {
    const view = this.admin('set hosts');
    const current = view.members.get(replica);
    if (current === undefined)
      throw new RosterError('conflict', `${replica} is not admitted`);
    if (!current.observer) this.checkSeats(view, hosts);
    const drops = current.hosts.some((h) => !hosts.includes(h));
    this.publish({
      rv: 1,
      action: 'hosts',
      replica,
      hosts,
      ...(drops ? this.cut(replica) : {}),
    });
  }

  closeLegacy(entries: LegacyAttestation[] = this.deps.legacy()): void {
    const view = this.member();
    if (view.legacy.closed !== null)
      throw new RosterError('conflict', 'the legacy window is already closed');
    this.publish({ rv: 1, action: 'close-legacy', entries });
  }

  /** FW-R8: takes an op no build reads out of every fold, when this admin may. */
  dismiss(replica: string, seq: number, hash: string): void {
    const row = this.fed.db
      .query<RosterRow, [string, number, string]>(
        'SELECT * FROM fed_roster WHERE replica = ? AND seq = ? AND hash = ?'
      )
      .get(replica, seq, hash);
    if (row === null || row.hash !== hash)
      throw new RosterError(
        'invalid',
        `this machine holds no roster op ${replica}:${seq} with hash ${hash}`
      );
    const body = JSON.parse(row.body_json) as {
      action?: unknown;
      rv?: unknown;
    };
    if (KNOWN_ROSTER_PAIRS.has(`${String(body.action)}@${String(body.rv)}`))
      throw new RosterError(
        'invalid',
        'every build reads this op, so no dismiss can take it out'
      );
    this.admin('dismiss a roster op');
    this.publish({ rv: 1, action: 'dismiss', replica, seq, hash }, (v, op) =>
      v.dismissed.some(
        (d) => d.replica === replica && d.seq === seq && d.by === this.me
      )
        ? null
        : new RosterError(
            'forbidden',
            noteFor(v, op) ?? 'the dismiss is not valid'
          )
    );
  }

  // ---- queries ----

  isAdmitted(replica: string): boolean {
    return this.view()?.members.has(replica) === true;
  }

  isCovered(replica: string): boolean {
    const view = this.view();
    return view !== null && isCovered(view, replica);
  }

  isObserver(replica: string): boolean {
    return this.view()?.members.get(replica)?.observer === true;
  }

  handleOf(replica: string): string | null {
    return this.view()?.members.get(replica)?.handle ?? null;
  }

  label(replica: string): string {
    return this.handleOf(replica) ?? replica;
  }

  replicasOfHandle(handle: string): string[] {
    const members = [...(this.view()?.members.values() ?? [])];
    return members
      .filter((m) => m.handle === handle || m.hosts.includes(handle))
      .map((m) => m.replica);
  }

  speaksForHuman(replica: string, handle: string, seq: number): boolean {
    const view = this.view();
    return view !== null && speaksForHandle(view, replica, handle, seq);
  }

  seats(): number {
    return this.view()?.seats ?? FREE_SEATS;
  }

  // ---- applying verified ops ----

  /** Records a verified key or roster op, then re-folds, records and audits it.
   *  One stamped too far ahead is held (FW-R21): the caller stops there. */
  applyVerified(entry: FederatedOp, hash: string): 'applied' | 'held' {
    const subject = `op:${entry.replica}:${entry.seq}`;
    // This machine's own ops are never held (FW-R22(5)): after its wall clock
    // steps back, its chain's clock is still ahead of it.
    if (entry.replica !== this.me && this.fed.ahead(entry.hlc)) {
      this.fed.problem(
        subject,
        `${entry.replica}'s op at seq ${entry.seq} is stamped ${entry.hlc}, more than ${MAX_CLOCK_LEAD_MS / 60_000} minutes ${CLOCK_HOLD}`
      );
      return 'held';
    }
    // Only the clock hold's own problem: a fold problem (an unreadable op's
    // pause) shares the subject and stays while the fold reports it.
    if (
      this.fed
        .problems()
        .some((p) => p.subject === subject && p.message.includes(CLOCK_HOLD))
    )
      this.fed.clearProblem(subject);
    this.fed.observe(entry.hlc);
    if (entry.type === 'key') {
      this.pinKey(entry);
      return 'applied';
    }
    if (entry.type !== 'roster') return 'applied';
    const signer = this.signerOf(entry);
    if (signer === null) return 'applied';
    const inserted = this.fed.db
      .query(
        'INSERT OR IGNORE INTO fed_roster (replica, sign_pub, seq, hlc, hash, body_json) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(
        entry.replica,
        signer,
        entry.seq,
        entry.hlc,
        hash,
        JSON.stringify(entry.body)
      );
    if (inserted.changes === 0) return 'applied';
    if (isFound(entry.body)) this.onFoundSeen();
    this.refresh();
    this.auditOp(entry, hash);
    return 'applied';
  }

  // ---- internals ----

  // FW-R24: each replica's key is decided from the op set, never from which
  // key op this machine happened to see first. The founder's is the key that
  // signed the trusted found; any other id with one claim speaks with it, and
  // an id with rival claims with the one an accepted admit or recover names.
  // The fold reads only roster ops signed by each replica's decided key.
  /** The keys the last fold decided, by replica (FW-R24). */
  private decided = new Map<string, PinnedKey>();

  private fold(): RosterView | null {
    const claims = new Map<string, PinnedKey[]>();
    for (const c of this.fed.claims()) {
      const list = claims.get(c.replica);
      if (list === undefined) claims.set(c.replica, [c]);
      else list.push(c);
    }
    const decided = new Map<string, PinnedKey>();
    const disputed: string[] = [];
    for (const [replica, list] of claims) {
      const [only] = list;
      if (list.length === 1 && only !== undefined) decided.set(replica, only);
      else disputed.push(replica);
    }
    this.decided = decided;
    const founder = this.fed.meta('founder');
    const founderSeq = Number(this.fed.meta('founder_seq'));
    const teamId = this.fed.meta('team_id');
    if (founder === null || teamId === null) return null;
    const rows = this.rows();
    const found = rows.find(
      (r) =>
        r.replica === founder &&
        r.seq === founderSeq &&
        r.hash.startsWith(teamId)
    );
    const founderKey = claims
      .get(founder)
      ?.find((c) => c.signPub === found?.sign_pub);
    if (found === undefined || founderKey === undefined) return null;
    decided.set(founder, founderKey);
    const run = (keys: ReadonlyMap<string, PinnedKey>): RosterView =>
      foldRoster({
        founder: { replica: founder, seq: founderSeq },
        ops: rows
          .filter((r) => keys.get(r.replica)?.signPub === r.sign_pub)
          .map((r) => ({
            replica: r.replica,
            seq: r.seq,
            hlc: r.hlc,
            hash: r.hash,
            body: JSON.parse(r.body_json) as RosterBody,
          })),
        keys: keyInfos(keys),
        now: this.deps.now(),
        licensePublicKey: this.deps.licensePublicKey,
      });
    let view = run(decided);
    for (const replica of disputed.filter((r) => r !== founder).sort()) {
      const list = [...(claims.get(replica) ?? [])].sort((a, b) =>
        a.fingerprint.localeCompare(b.fingerprint)
      );
      for (const c of list) {
        const trial = new Map(decided).set(replica, c);
        const v = run(trial);
        // Admitted under this key, even if revoked since.
        const held =
          v.members.has(replica) ||
          (v.revoked.get(replica)?.handle ?? null) !== null;
        if (held) {
          decided.set(replica, c);
          view = v;
          break;
        }
      }
    }
    return view;
  }

  // Re-folds, records the fold's problems under their own subjects, and drops
  // those it no longer reports.
  private refresh(): void {
    this.cached = this.fold();
    const view = this.cached;
    const now = new Set<string>();
    for (const p of view?.problems ?? []) {
      this.fed.problem(p.subject, p.message);
      now.add(p.subject);
    }
    for (const replica of this.fed.setDecided([...this.decided.values()])) {
      // Read again from the start on the key now decided.
      this.fed.db
        .query('DELETE FROM fed_cursors WHERE replica = ?')
        .run(replica);
      this.fed.db
        .query('DELETE FROM fed_seen_ops WHERE replica = ?')
        .run(replica);
    }
    for (const p of this.claimProblems()) {
      this.fed.problem(p.subject, p.message);
      now.add(p.subject);
    }
    if (view !== null) this.auditResolutions(view);
    for (const subject of this.recorded)
      if (!now.has(subject)) this.fed.clearProblem(subject);
    this.recorded = now;
    // An automatic pin firms up once this machine is admitted under it, never
    // against an invite this machine holds for another team.
    const invite = this.bindingInvite();
    if (
      view !== null &&
      this.fed.meta('founder_pin') === 'auto' &&
      view.members.has(this.me) &&
      (invite === null || invite.teamId === view.teamId)
    )
      this.fed.setMeta('founder_pin', 'firm');
    if (view !== null)
      this.fed.setMeta(
        'legacy_until',
        new Date(view.legacy.deadlineMs).toISOString()
      );
  }

  private rows(): RosterRow[] {
    return this.fed.db
      .query<RosterRow, []>('SELECT * FROM fed_roster ORDER BY replica, seq')
      .all();
  }

  /** Whether any founding is on the branch, pinned or not. */
  foundingSeen(): boolean {
    return this.rows().some((r) => isFound(JSON.parse(r.body_json) as unknown));
  }

  private foundings(): Founding[] {
    return this.rows()
      .filter((r) => isFound(JSON.parse(r.body_json) as unknown))
      .map(({ replica, seq, hash, hlc, sign_pub }) => ({
        replica,
        seq,
        hash,
        hlc,
        signPub: sign_pub,
      }));
  }

  private ownRosterOps(): number {
    return this.rows().filter((r) => r.replica === this.me).length;
  }

  // A second founding seen before this machine was admitted under an automatic
  // pin unpins it: two foundings seen at once pin neither, until trust picks.
  // While an invite is held, only the founding of its team is a candidate
  // (FW-R22(4)): a hostile founding seen first never captures the joiner.
  private onFoundSeen(): void {
    const pin = this.fed.meta('founder_pin');
    if (this.founded() && pin === 'firm') return;
    const invite = this.bindingInvite();
    const seen = this.foundings().filter(
      (f) => invite === null || f.hash.slice(0, 32) === invite.teamId
    );
    const only = seen.length === 1 ? seen[0] : undefined;
    if (only !== undefined && !this.founded()) this.pinFounder(only, 'auto');
    else if (seen.length > 1 && pin === 'auto') this.unpinFounder();
  }

  private pinFounder(f: Founding, how: 'auto' | 'firm'): void {
    const teamId = f.hash.slice(0, 32);
    this.fed.setMeta('founder', f.replica);
    this.fed.setMeta('founder_seq', String(f.seq));
    this.fed.setMeta('founder_pin', how);
    this.fed.setMeta('team_id', teamId);
    this.fed.setMeta(
      'founded_at',
      new Date(hlcWallMs(f.hlc) ?? this.deps.now().getTime()).toISOString()
    );
    this.refresh();
    if (f.replica !== this.me) this.onFounderPinned();
  }

  private unpinFounder(): void {
    for (const key of [
      'founder',
      'founder_seq',
      'founder_pin',
      'team_id',
      'founded_at',
      'legacy_until',
    ] as const)
      this.fed.setMeta(key, null);
    this.refresh();
  }

  // Once a founder is pinned, this machine announces its key, unless an
  // invite or a recovery already did. The pass writes the v1 outbox in its
  // own publish step (B3), never a write running beside it.
  private onFounderPinned(): void {
    this.publishKey();
  }

  private publishKey(): void {
    if (this.fed.head() !== null) return;
    const pending = this.pendingInvite();
    const body: KeyBody = {
      handle: this.deps.handle,
      // Every other machine refuses a key op it could not print (M1).
      device: labelOf(this.deps.device),
      build: labelOf(this.deps.build),
      signPub: this.fed.keys.signPub,
      sealPub: this.fed.keys.sealPub,
      legacy: this.deps.ownV1Attestation(),
      ...(pending === null
        ? {}
        : { invite: { id: pending.id, sig: pending.sig } }),
    };
    const op = this.fed.append({
      type: 'key',
      body: body as unknown as JsonValue,
    });
    this.applyVerified(op, opHash(op));
  }

  private pinKey(entry: FederatedOp): void {
    const body = entry.body as unknown as KeyBody;
    // M1: a label nobody could print safely makes no claim.
    if (
      typeof body.handle !== 'string' ||
      typeof body.device !== 'string' ||
      typeof body.build !== 'string' ||
      keyFieldsProblem(body.handle, body.device, body.build) !== null
    )
      return;
    const claimed = this.fed.claim({
      replica: entry.replica,
      handle: body.handle,
      device: body.device,
      build: body.build,
      signPub: body.signPub,
      sealPub: body.sealPub,
      fingerprint: fingerprint(body.signPub, body.sealPub),
      keySeq: entry.seq,
      legacy: body.legacy,
      ...(body.invite === undefined ? {} : { invite: body.invite }),
    });
    if (claimed === 'full')
      this.fed.problem(
        `key:${entry.replica}`,
        `more than ${MAX_KEY_CLAIMS} keys claim replica ${entry.replica}; later claims are ignored`
      );
    if (claimed === 'new') this.refresh();
  }

  /** The claim on `replica` with this signing key. */
  private claimOf(replica: string, signPub: string): PinnedKey | undefined {
    return this.fed.claims(replica).find((c) => c.signPub === signPub);
  }

  // The claim whose key signed a roster op; this machine's own ops are its own.
  private signerOf(entry: FederatedOp): string | null {
    if (entry.replica === this.me) return this.fed.keys.signPub;
    return (
      this.fed.claims(entry.replica).find((c) => signedEntry(entry, c.signPub))
        ?.signPub ?? null
    );
  }

  // A problem per replica id with rival claims, naming what decides it.
  private claimProblems(): { subject: string; message: string }[] {
    const out: { subject: string; message: string }[] = [];
    const byId = new Map<string, PinnedKey[]>();
    for (const c of this.fed.claims())
      byId.set(c.replica, [...(byId.get(c.replica) ?? []), c]);
    for (const [replica, list] of byId) {
      if (list.length < 2) continue;
      const chosen = this.decided.get(replica);
      const fps = list.map((c) => c.fingerprint).join(', ');
      out.push({
        subject: `key:${replica}`,
        message:
          chosen === undefined
            ? `${list.length} keys claim replica ${replica} (${fps}) and none is admitted; an admin admits the one whose fingerprint its owner confirms, and the others are ignored`
            : `${list.length} keys claim replica ${replica} (${fps}); this team follows ${chosen.fingerprint}, which it admitted, and ignores the others. Someone with push access published the others: check who.`,
      });
    }
    return out;
  }

  private pendingInvite(): PendingInvite | null {
    const raw = this.fed.meta('pending_invite');
    return raw === null ? null : (JSON.parse(raw) as PendingInvite);
  }

  // The held invite while it still binds which founding this machine follows:
  // for INVITE_TTL_MS after joining, the longest an invite lives.
  private bindingInvite(): PendingInvite | null {
    const invite = this.pendingInvite();
    if (invite?.at === undefined) return invite;
    const until = Date.parse(invite.at) + INVITE_TTL_MS;
    return this.deps.now().getTime() < until ? invite : null;
  }

  // One state.db transaction; a rollback also drops the view folded inside it.
  private atomically<T>(fn: () => T): T {
    try {
      return this.fed.db.transaction(fn)();
    } catch (err) {
      this.refresh();
      throw err;
    }
  }

  // Appends a roster op and applies it to this machine's fold at once. The op
  // is judged by the fold itself, and a refused one rolls back with its writes.
  private publish(
    body: RosterBody,
    judge: (
      view: RosterView,
      op: FederatedOp,
      hash: string
    ) => RosterError | null = byDefault
  ): FederatedOp {
    return this.atomically(() => {
      const op = this.fed.append({
        type: 'roster',
        body: body as unknown as JsonValue,
      });
      const hash = opHash(op);
      this.applyVerified(op, hash);
      const view = this.view();
      const refusal = view === null ? null : judge(view, op, hash);
      if (refusal !== null) throw refusal;
      return op;
    });
  }

  // The view, refusing an observer and a machine not admitted under it.
  private member(): RosterView {
    const view = this.view();
    if (view === null)
      throw new RosterError(
        'conflict',
        'no team is founded on this branch yet'
      );
    const mine = view.members.get(this.me);
    if (mine === undefined)
      throw new RosterError(
        'forbidden',
        'this machine is not admitted to the team'
      );
    if (mine.observer) throw new RosterError('forbidden', OBSERVER);
    return view;
  }

  private admin(what: string): RosterView {
    const view = this.member();
    if (view.members.get(this.me)?.role !== 'admin')
      throw new RosterError('forbidden', `only an admin can ${what}`);
    return view;
  }

  // Refuses an admission that brings the team past its seats.
  private checkSeats(view: RosterView, handles: readonly string[]): void {
    const fresh = new Set(handles.filter((h) => !view.people.includes(h)));
    if (fresh.size === 0) return;
    if (view.people.length + fresh.size > view.seats)
      throw new RosterError(
        'seat_limit',
        seatLimitMessage(view.seats, view.license)
      );
  }

  // A removal's cut: the target's last op this machine has verified.
  private cut(replica: string): { afterSeq: number; afterHash: string } {
    const head =
      replica === this.me ? this.fed.head() : this.fed.cursor(replica).head;
    return { afterSeq: head?.seq ?? 0, afterHash: head?.hash ?? ZERO_HASH };
  }

  private licenseVerifies(key: string): boolean {
    return (
      readLicenseKey(key, this.deps.licensePublicKey, this.deps.now()).kind ===
      'licensed'
    );
  }

  // A removal audited as it applied gets a second row once a fight decides
  // it otherwise: the log says how each revocation ended (E).
  private auditResolutions(view: RosterView): void {
    if (view.resolution.size === 0) return;
    for (const r of this.rows()) {
      const resolution = view.resolution.get(r.hash);
      if (resolution === undefined) continue;
      const action = String(
        (JSON.parse(r.body_json) as { action?: unknown }).action
      );
      const kind = AUDITED.get(action);
      if (kind === undefined) continue;
      const subject = `op:${r.replica}:${r.seq}`;
      const last = this.fed.db
        .query<{ detail_json: string }, [string, string]>(
          'SELECT detail_json FROM fed_audit WHERE subject = ? AND kind = ? ORDER BY id DESC LIMIT 1'
        )
        .get(subject, kind);
      if (last === null) continue;
      const before = (JSON.parse(last.detail_json) as { resolution?: unknown })
        .resolution;
      if (before === resolution) continue;
      this.fed.audit(kind, subject, {
        replica: r.replica,
        seq: r.seq,
        hash: r.hash,
        action,
        resolution,
        resolved: true,
      });
    }
  }

  private auditOp(entry: FederatedOp, hash: string): void {
    const body = entry.body as { action?: unknown; observer?: unknown };
    const kind = AUDITED.get(String(body.action));
    if (kind === undefined) return;
    const detail: Record<string, JsonValue> = {
      replica: entry.replica,
      seq: entry.seq,
      hash,
      action: String(body.action),
    };
    const resolution = this.view()?.resolution.get(hash);
    if (resolution !== undefined) detail.resolution = resolution;
    const audited =
      kind === 'admission' && body.observer === true ? 'observer' : kind;
    this.fed.audit(audited, `op:${entry.replica}:${entry.seq}`, detail);
  }
}

// Each roster action's audit kind (F-D38).
const AUDITED = new Map<string, AuditKind>([
  ['found', 'founding'],
  ['admit', 'admission'],
  ['role', 'role'],
  ['hosts', 'hosts'],
  ['license', 'license'],
  ['invite', 'invite'],
  ['revoke', 'revocation'],
  ['recover', 'recovery'],
  ['recovery-key', 'recovery'],
  ['close-legacy', 'legacy-close'],
  ['transport', 'transport'],
  ['dismiss', 'dismiss'],
]);

// A grant the fold ignored, or a removal it voided, is refused with its reason.
function byDefault(
  view: RosterView,
  op: FederatedOp,
  hash: string
): RosterError | null {
  const note = noteFor(view, op);
  const resolution = view.resolution.get(hash);
  if (resolution === 'void')
    return note?.includes(NO_ADMIN) === true
      ? new RosterError('conflict', note)
      : new RosterError('forbidden', note ?? 'the fold voids this removal');
  if (resolution === undefined && note !== null)
    return new RosterError('forbidden', note);
  return null;
}

function noteFor(view: RosterView, op: FederatedOp): string | null {
  const subject = `op:${op.replica}:${op.seq}`;
  return view.problems.find((p) => p.subject === subject)?.message ?? null;
}

function isFound(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const b = body as { action?: unknown; rv?: unknown };
  return b.action === 'found' && b.rv === 1;
}

function founding(op: FederatedOp, signPub: string): Founding {
  return {
    replica: op.replica,
    seq: op.seq,
    hash: opHash(op),
    hlc: op.hlc,
    signPub,
  };
}

// ---- codes ----

/** 52 Crockford characters in 13 groups of four, joined by "-". */
export function encodeRecoveryCode(seed: Uint8Array): string {
  return (crockford32(seed).match(/.{4}/g) ?? []).join('-');
}

export function decodeRecoveryCode(code: string): Buffer {
  const text = code.replace(/-/g, '').toUpperCase();
  const seed = fromCrockford32(text, SEED_BYTES);
  if (seed === null || text.length !== RECOVERY_GROUPS * 4)
    throw new RosterError('invalid', 'not a recovery code');
  return seed;
}

/** `di1.<teamId>.<crockford32(seed)>.<b64u(relay) or empty>`. */
export function encodeInviteCode(input: {
  teamId: string;
  seed: Uint8Array;
  relay: string | null;
}): string {
  const relay =
    input.relay === null ? '' : b64u(Buffer.from(input.relay, 'utf8'));
  return `di1.${input.teamId}.${crockford32(input.seed)}.${relay}`;
}

export function decodeInviteCode(code: string): {
  teamId: string;
  seed: Buffer;
  relay: string | null;
} {
  const refused = new RosterError('invalid', 'not an invite code');
  const parts = code.trim().split('.');
  if (parts.length !== 4 || parts[0] !== 'di1') throw refused;
  const [, teamId = '', seedText = '', relayText = ''] = parts;
  if (!/^[0-9a-f]{32}$/.test(teamId)) throw refused;
  const seed = fromCrockford32(seedText, SEED_BYTES);
  if (seed === null) throw refused;
  let relay: string | null = null;
  if (relayText !== '') {
    try {
      relay = fromB64u(relayText).toString('utf8');
    } catch {
      throw refused;
    }
  }
  return { teamId, seed, relay };
}

// Decodes exactly what crockford32 writes for `bytes` bytes, or null.
function fromCrockford32(text: string, bytes: number): Buffer | null {
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of text) {
    const v = CROCKFORD.indexOf(ch);
    if (v < 0) return null;
    buffer = ((buffer << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const seed = Buffer.from(out);
  if (seed.length !== bytes || crockford32(seed) !== text) return null;
  return seed;
}

// The fold's view of each decided key.
function keyInfos(keys: ReadonlyMap<string, PinnedKey>): Map<string, KeyInfo> {
  const out = new Map<string, KeyInfo>();
  for (const [replica, pin] of keys)
    out.set(replica, {
      replica,
      handle: pin.handle,
      signPub: pin.signPub,
      fingerprint: pin.fingerprint,
      ...(pin.invite === undefined ? {} : { invite: pin.invite }),
    });
  return out;
}

// This machine's device or build as its key op carries it: printable, never empty.
function labelOf(value: string): string {
  const clean = printable(value);
  return clean === '' ? 'unknown' : clean;
}
