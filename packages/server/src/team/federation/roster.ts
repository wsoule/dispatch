import {
  foldRoster,
  FREE_SEATS,
  isCovered,
  KNOWN_ROSTER_PAIRS,
  readLicenseKey,
  speaksForHandle,
} from '@dispatch/federation';
import type { KeyInfo, RosterOpRef, RosterView } from '@dispatch/federation';
import type { JsonValue } from '@dispatch/protocol';
import {
  b64u,
  crockford32,
  ed25519FromSeed,
  fingerprint,
  fromB64u,
  hlcWallMs,
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
import type { FedStore } from './store.js';

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
  /** Writes the v1 outbox to the branch once a founder is pinned. */
  flushV1?: () => Promise<void>;
  relayUrl?: () => string | null;
}

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SEED_BYTES = 32;
const RECOVERY_GROUPS = 13;
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const OBSERVER = 'an observer publishes only keys, presence and acks';
const NO_ADMIN = 'would leave the team with no admin';

interface RosterRow {
  replica: string;
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
}

interface PendingInvite {
  id: string;
  sig: string;
  teamId: string;
}

// The daemon's side of the signed roster: it publishes this machine's roster
// ops, applies verified ones, and reads rights from the shared fold.
export class RosterService {
  private cached: RosterView | null | undefined;
  /** Problem subjects the last fold recorded, cleared when they go away. */
  private recorded = new Set<string>();

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
      fingerprint: this.fed.pinned(f.replica)?.fingerprint ?? '',
    }));
  }

  /** The op hash of a roster op this replica holds, for naming it in a dismiss. */
  opHashOf(replica: string, seq: number): string | null {
    const row = this.fed.db
      .query<{ hash: string }, [string, number]>(
        'SELECT hash FROM fed_roster WHERE replica = ? AND seq = ?'
      )
      .get(replica, seq);
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
    this.fed.db.transaction(() => {
      this.publishKey();
      const found = this.publish({
        rv: 1,
        action: 'found',
        name,
        legacy,
        recoveryPub: recovery.signPub,
      });
      this.pinFounder(founding(found), 'firm');
      const key = this.deps.installedLicense();
      if (key !== null && this.licenseVerifies(key))
        this.publish({ rv: 1, action: 'license', key });
    })();
    return { recoveryCode: encodeRecoveryCode(seed) };
  }

  trust(fp: string): void {
    const chosen = this.foundings().find(
      (f) => this.fed.pinned(f.replica)?.fingerprint === fp
    );
    if (chosen === undefined)
      throw new RosterError('invalid', `no founding with fingerprint ${fp}`);
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
    const seed = randomBytes(SEED_BYTES);
    const pub = ed25519FromSeed(seed).signPub;
    const expires = new Date(
      this.deps.now().getTime() + INVITE_TTL_MS
    ).toISOString();
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
    };
    this.fed.db.transaction(() => {
      this.fed.setMeta('pending_invite', JSON.stringify(pending));
      this.publishKey();
    })();
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
    this.fed.db.transaction(() => {
      this.publishKey();
      this.publish({ rv: 1, action: 'recover', proof }, (v, op) =>
        v.members.get(this.me)?.recovered === true
          ? null
          : new RosterError(
              'invalid',
              noteFor(v, op) ?? 'the recovery code did not admit this machine'
            )
      );
    })();
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
    const pinned = this.fed.pinned(replica);
    if (pinned === null)
      throw new RosterError(
        'conflict',
        `${replica} has published no key op this machine has read`
      );
    if (pinned.fingerprint !== opts.fingerprint)
      throw new RosterError(
        'conflict',
        `${replica}'s key has fingerprint ${pinned.fingerprint}, not ${opts.fingerprint}`
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
      .query<RosterRow, [string, number]>(
        'SELECT * FROM fed_roster WHERE replica = ? AND seq = ?'
      )
      .get(replica, seq);
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

  /** Records a verified key or roster op, then re-folds, records and audits it. */
  applyVerified(entry: FederatedOp, hash: string): void {
    this.fed.observe(entry.hlc);
    if (entry.type === 'key') {
      this.pinKey(entry);
      return;
    }
    if (entry.type !== 'roster') return;
    const inserted = this.fed.db
      .query(
        'INSERT OR IGNORE INTO fed_roster (replica, seq, hlc, hash, body_json) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        entry.replica,
        entry.seq,
        entry.hlc,
        hash,
        JSON.stringify(entry.body)
      );
    if (inserted.changes === 0) return;
    if (isFound(entry.body)) this.onFoundSeen(entry, hash);
    this.refresh();
    this.auditOp(entry, hash);
  }

  // ---- internals ----

  private fold(): RosterView | null {
    const founder = this.fed.meta('founder');
    const founderSeq = this.fed.meta('founder_seq');
    if (founder === null || founderSeq === null) return null;
    const ops: RosterOpRef[] = this.rows().map((r) => ({
      replica: r.replica,
      seq: r.seq,
      hlc: r.hlc,
      hash: r.hash,
      body: JSON.parse(r.body_json) as RosterBody,
    }));
    const keys = new Map<string, KeyInfo>();
    for (const pin of this.fed.pins())
      keys.set(pin.replica, {
        replica: pin.replica,
        handle: pin.handle,
        signPub: pin.signPub,
        fingerprint: pin.fingerprint,
        ...(pin.invite === undefined ? {} : { invite: pin.invite }),
      });
    return foldRoster({
      founder: { replica: founder, seq: Number(founderSeq) },
      ops,
      keys,
      now: this.deps.now(),
      licensePublicKey: this.deps.licensePublicKey,
    });
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
    for (const subject of this.recorded)
      if (!now.has(subject)) this.fed.clearProblem(subject);
    this.recorded = now;
    // An automatic pin firms up once this machine is admitted under it.
    if (
      view !== null &&
      this.fed.meta('founder_pin') === 'auto' &&
      view.members.has(this.me)
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

  private foundings(): Founding[] {
    return this.rows()
      .filter((r) => isFound(JSON.parse(r.body_json) as unknown))
      .filter((r) => this.fed.pinned(r.replica) !== null)
      .map(({ replica, seq, hash, hlc }) => ({ replica, seq, hash, hlc }));
  }

  private ownRosterOps(): number {
    return this.rows().filter((r) => r.replica === this.me).length;
  }

  // A second founding seen before this machine was admitted under an automatic
  // pin unpins it: two foundings seen at once pin neither, until trust picks.
  private onFoundSeen(entry: FederatedOp, hash: string): void {
    const pin = this.fed.meta('founder_pin');
    if (this.founded() && pin === 'firm') return;
    const seen = this.foundings();
    if (seen.length === 1 && !this.founded())
      this.pinFounder(founding({ ...entry, hash }), 'auto');
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
    const pending = this.pendingInvite();
    if (pending !== null && pending.teamId !== teamId) {
      this.fed.setMeta('pending_invite', null);
      this.fed.problem(
        'team',
        'the invite this machine joined with is for another team than the founding it follows; ask for a new invite'
      );
    }
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

  // Once a founder is pinned, the v1 outbox goes out and this machine announces
  // its key, unless an invite or a recovery already did.
  private onFounderPinned(): void {
    if (this.fed.head() !== null) return;
    const flush = this.deps.flushV1 ?? (async () => {});
    flush().catch((err: unknown) => {
      console.warn(
        `dispatchd: could not write the v1 outbox: ${(err as Error).message}`
      );
    });
    this.publishKey();
  }

  private publishKey(): void {
    if (this.fed.head() !== null) return;
    const pending = this.pendingInvite();
    const body: KeyBody = {
      handle: this.deps.handle,
      device: this.deps.device,
      build: this.deps.build,
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
    this.fed.pin({
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
    if (this.founded()) this.refresh();
  }

  private pendingInvite(): PendingInvite | null {
    const raw = this.fed.meta('pending_invite');
    return raw === null ? null : (JSON.parse(raw) as PendingInvite);
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
    try {
      return this.fed.db.transaction(() => {
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
      })();
    } catch (err) {
      this.refresh();
      throw err;
    }
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

function founding(op: FederatedOp & { hash?: string }): Founding {
  return {
    replica: op.replica,
    seq: op.seq,
    hash: op.hash ?? opHash(op),
    hlc: op.hlc,
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
