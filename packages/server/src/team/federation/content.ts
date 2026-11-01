import type { RosterView } from '@dispatch-foo/federation';
import type { JsonValue } from '@dispatch-foo/protocol';
import {
  b64u,
  compareHlc,
  CONTENT_TYPES,
  contentKeyRequest,
  decryptContent,
  encryptContent,
  fromB64u,
  generateContentKey,
  hlcWallMs,
  isContentEnvelope,
  isContentKeyRequest,
  isStub,
  MAX_SEALED_RECIPIENTS,
  openPayload,
  parseOpHlc,
  runTag,
  sealPayload,
  TEAM_CONTENT_KEY_BYTES,
} from '@dispatch-foo/protocol/federation';
import type {
  ContentEnvelope,
  ContentKeyGrant,
  FederatedOp,
  GrantPayload,
  ParsedHlc,
} from '@dispatch-foo/protocol/federation';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  capsOf,
  CONTENT_E2E_CAP,
  forgetPresenceCaps,
  readCaps,
  recordPresenceCaps,
} from './caps.js';
import { RosterError } from './errors.js';
import type { RosterService } from './roster.js';
import type { Collector } from './service.js';
import type { ContentSealer, FedStore } from './store.js';

// End-to-end encrypted team content (stage 2): once the roster switches a team
// to `content-e2e`, every content op's body goes out under the team content
// key (TCK) of the roster's latest epoch. Keys travel only in sealed `state`
// grants; the relay and the sync branch hold ciphertext and clear hints.
//
// Licensed under the Elastic License 2.0 (../LICENSE).

/** One answer to a member's `wants` per epoch in this window. */
const WANTS_ANSWER_MS = 5 * 60 * 1000;
const EPOCH = /^[0-9a-f]{64}$/;
const MAX_WANTS = 64;

/** The note while content waits on this machine for the team's key. */
export const CONTENT_KEY_WAITING =
  "This machine has not received the team's content key yet, so its board changes, runs and team memory wait here. It asks the team for it; a teammate's machine sends it on their next sync.";

/** Content cannot go out: this machine lacks the current epoch's key. */
export class ContentKeyMissingError extends RosterError {
  override name = 'ContentKeyMissingError';
  constructor(readonly epoch: string) {
    super(
      'conflict',
      "this machine has not received the team's content key yet, so it cannot publish team content; it asks the team for it, and a teammate's machine sends it on their next sync"
    );
  }
}

// The team content keys this machine holds, by epoch: keys/content.json
// (0600) beside keys/replica.json, or memory only when no file is given.
export class ContentKeyring {
  private readonly keys = new Map<string, Buffer>();

  constructor(
    private readonly file: string | null,
    warn: (message: string) => void = console.warn
  ) {
    if (file === null || !existsSync(file)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      parsed = null;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      warn(
        `dispatchd: ${file} is not a content keyring; the team sends its keys again`
      );
      return;
    }
    for (const [epoch, key] of Object.entries(parsed)) {
      const raw = typeof key === 'string' ? keyOf(key) : null;
      if (EPOCH.test(epoch) && raw !== null) this.keys.set(epoch, raw);
    }
  }

  get(epoch: string): Buffer | null {
    return this.keys.get(epoch) ?? null;
  }

  has(epoch: string): boolean {
    return this.keys.has(epoch);
  }

  /** Keeps a key for an epoch; an epoch's first key stays. True when new. */
  put(epoch: string, key: Buffer): boolean {
    if (this.keys.has(epoch)) return false;
    this.keys.set(epoch, key);
    this.save();
    return true;
  }

  /** Puts the epoch opener's key in place of a conflicting one. */
  replace(epoch: string, key: Buffer): void {
    this.keys.set(epoch, key);
    this.save();
  }

  // Through a synced temporary file, so a crash never leaves half a keyring.
  private save(): void {
    if (this.file === null) return;
    const out: Record<string, string> = {};
    for (const [epoch, key] of this.keys) out[epoch] = b64u(key);
    const tmp = `${this.file}.tmp`;
    rmSync(tmp, { force: true });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      writeSync(fd, `${JSON.stringify(out, null, 2)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
    chmodSync(this.file, 0o600);
  }
}

/** The keyring in a sync directory: keys/content.json. */
export function contentKeyring(
  syncDir: string,
  warn?: (message: string) => void
): ContentKeyring {
  const dir = join(syncDir, 'keys');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return new ContentKeyring(join(dir, 'content.json'), warn);
}

// A base64url key of TEAM_CONTENT_KEY_BYTES, or null.
function keyOf(text: string): Buffer | null {
  try {
    const raw = fromB64u(text);
    return raw.length === TEAM_CONTENT_KEY_BYTES ? Buffer.from(raw) : null;
  } catch {
    return null;
  }
}

/** A content op as staging reads it: its body opened, or why it cannot be. */
export type Opened =
  | { kind: 'plain' | 'opened'; op: FederatedOp }
  | { kind: 'request'; op: FederatedOp }
  | { kind: 'missing'; epoch: string }
  | { kind: 'malformed'; why: string };

/** What `GET /api/team/content-e2e` answers. */
export interface ContentE2eStatus {
  on: boolean;
  /** The switch's op hash, or null while off. */
  since: string | null;
  /** When the switch was signed (ISO), or null while off. */
  sinceAt: string | null;
  /** The epoch new content goes under, or null while off. */
  current: string | null;
  /** Every epoch, oldest first, and whether this machine holds its key. */
  epochs: { epoch: string; held: boolean }[];
  /** Epochs whose key this machine lacks. */
  missing: string[];
  /** Members and invitees whose build does not speak content-e2e yet. */
  lacking: { replica: string; handle: string }[];
  legacyClosed: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// Every hint a body's envelope must carry, as encryptContent derives them.
function hintsMatch(
  type: string,
  env: ContentEnvelope,
  body: JsonValue,
  key: Buffer
): boolean {
  if (type !== 'presence' || !isObj(body))
    return (
      env.kind === undefined &&
      env.run === undefined &&
      env.caps === undefined &&
      env.wants === undefined
    );
  const kind = typeof body.kind === 'string' ? body.kind : undefined;
  if (env.kind !== kind) return false;
  const run = typeof body.run === 'string' ? runTag(key, body.run) : undefined;
  if (env.run !== run) return false;
  const caps =
    body.kind === 'replica' && Array.isArray(body.caps) ? body.caps : undefined;
  if (JSON.stringify(env.caps) !== JSON.stringify(caps)) return false;
  return env.wants === undefined || body.kind === 'replica';
}

// The epochs a wants hint names, or null when it is no list of epochs.
function wantsOf(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > MAX_WANTS) return null;
  return v.every((e) => typeof e === 'string' && EPOCH.test(e))
    ? (v as string[])
    : null;
}

// Keys in, keys out, and the seal on every content op this machine publishes.
export class TeamContent implements Collector, ContentSealer {
  readonly order = 0;
  /** Opened ops, so a pass decrypts each once. */
  private cache = new WeakMap<FederatedOp, Opened>();
  /** Grant ops already taken, so a pass opens each once. */
  private readonly taken = new WeakSet<FederatedOp>();
  /** The latest wants each member's presence named. */
  private readonly asked = new Map<string, Set<string>>();
  /** When this machine last answered a (member, epoch). */
  private readonly answered = new Map<string, number>();
  /** Epochs still missing when the last pass ended: what wants names. */
  private lacking: string[] = [];
  /** The switch op's clock, read once per switch hash. */
  private switchClock: { hash: string; hlc: ParsedHlc | null } | null = null;

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      /** A key arrived: ask for a pass, so ops parked for it apply. */
      changed: () => void;
      now: () => Date;
    }
  ) {}

  private get keyring(): ContentKeyring {
    return this.deps.fed.keyring;
  }

  private get me(): string {
    return this.deps.fed.replica;
  }

  /** The roster's epochs, oldest first; empty while the team is off. */
  epochs(): readonly string[] {
    return this.deps.roster.view()?.contentE2e?.epochs ?? [];
  }

  current(): string | null {
    return this.epochs().at(-1) ?? null;
  }

  missing(): string | null {
    const epoch = this.current();
    return epoch !== null && !this.keyring.has(epoch) ? epoch : null;
  }

  wants(): string[] {
    return this.lacking.filter((e) => !this.keyring.has(e)).slice(0, MAX_WANTS);
  }

  seal(op: {
    replica: string;
    seq: number;
    type: string;
    body: JsonValue;
  }): JsonValue {
    if (!CONTENT_TYPES.has(op.type)) return op.body;
    const epoch = this.current();
    if (epoch === null) return op.body;
    const body = op.body;
    const replicaPresence =
      op.type === 'presence' && isObj(body) && body.kind === 'replica';
    const wants = replicaPresence ? this.wants() : [];
    const key = this.keyring.get(epoch);
    if (key === null) {
      if (!replicaPresence) throw new ContentKeyMissingError(epoch);
      const caps = readCaps(body.caps);
      return contentKeyRequest({
        epoch,
        ...(caps === null ? {} : { caps }),
        wants,
      }) as unknown as JsonValue;
    }
    return encryptContent({
      ...op,
      epoch,
      key,
      ...(wants.length > 0 ? { wants } : {}),
    }) as unknown as JsonValue;
  }

  /** A verified op's body as handlers read it. A plain body passes as is
   *  only when stamped before the switch; after it, it is malformed. */
  open(op: FederatedOp): Opened {
    if (!CONTENT_TYPES.has(op.type)) return { kind: 'plain', op };
    if (!isContentEnvelope(op.body))
      return this.afterSwitch(op.hlc)
        ? {
            kind: 'malformed',
            why: 'it is plain content sent after the team switched to end-to-end encryption',
          }
        : { kind: 'plain', op };
    const cached = this.cache.get(op);
    if (cached !== undefined) return cached;
    const env = op.body;
    if (isContentKeyRequest(env))
      return op.type === 'presence' &&
        readCaps(env.caps ?? []) !== null &&
        wantsOf(env.wants) !== null
        ? { kind: 'request', op }
        : { kind: 'malformed', why: 'its key request is malformed' };
    const key = this.keyring.get(env.epoch);
    if (key === null) return { kind: 'missing', epoch: env.epoch };
    let body: JsonValue;
    try {
      body = decryptContent(op, key);
    } catch {
      return { kind: 'malformed', why: 'it does not decrypt' };
    }
    if (!hintsMatch(op.type, env, body, key) || wantsOf(env.wants) === null)
      return {
        kind: 'malformed',
        why: 'its clear hints do not match its content',
      };
    const out: Opened = { kind: 'opened', op: { ...op, body } };
    this.cache.set(op, out);
    return out;
  }

  /** Whether an op waits for the key of one of the roster's epochs. */
  awaitsKey(op: FederatedOp): boolean {
    const opened = this.open(op);
    return opened.kind === 'missing' && this.epochs().includes(opened.epoch);
  }

  /** A key request stands in for replica presence: its caps hint counts. */
  applyRequest(op: FederatedOp): void {
    const { fed } = this.deps;
    fed.observe(op.hlc);
    const env = op.body as ContentEnvelope;
    const caps = env.caps === undefined ? null : readCaps(env.caps);
    if (caps !== null) recordPresenceCaps(fed, op.replica, caps, op.hlc);
    else forgetPresenceCaps(fed, op.replica, op.hlc);
  }

  /** The latest presence of a member names the epochs it lacks. */
  noteWants(op: FederatedOp, view: RosterView): void {
    if (op.replica === this.me || !view.members.has(op.replica)) return;
    const env = op.body;
    if (!isContentEnvelope(env) || env.kind !== 'replica') return;
    const wants = wantsOf(env.wants);
    if (wants === null) return;
    if (wants.length === 0) this.asked.delete(op.replica);
    else this.asked.set(op.replica, new Set(wants));
  }

  /** A sealed state op carrying keys for this machine: true when it was a
   *  grant (taken here, never a delivery report), whether or not it stood. */
  takeGrant(op: FederatedOp, standing: boolean): boolean {
    const { fed } = this.deps;
    if (this.taken.has(op)) return true;
    if (isStub(op) || !(op.to ?? []).includes(this.me)) return false;
    const payload = openPayload(op, this.me, fed.keys.sealPriv);
    if (!isObj(payload) || !Array.isArray(payload.grant)) return false;
    this.taken.add(op);
    if (!standing) return true;
    const view = this.deps.roster.view();
    const epochs = new Set(view?.contentE2e?.epochs ?? []);
    const admin = view?.members.get(op.replica)?.role === 'admin';
    let added = false;
    for (const g of payload.grant) {
      if (!isObj(g) || typeof g.epoch !== 'string' || typeof g.key !== 'string')
        continue;
      const key = keyOf(g.key);
      if (key === null || !epochs.has(g.epoch)) continue;
      const opener = this.openerOf(g.epoch) === op.replica;
      // Only an epoch's opener or an admin may hand out its key.
      if (!opener && !admin) continue;
      if (this.keyring.put(g.epoch, key)) added = true;
      else if (!key.equals(this.keyring.get(g.epoch) ?? key))
        this.conflict(g.epoch, op.replica, key, opener);
    }
    if (added) this.deps.changed();
    return true;
  }

  // Two authorized grants disagree on an epoch's key: the opener's wins, and
  // this machine's problems name it either way.
  private conflict(
    epoch: string,
    sender: string,
    key: Buffer,
    opener: boolean
  ): void {
    if (opener) {
      this.keyring.replace(epoch, key);
      this.cache = new WeakMap();
      this.deps.changed();
    }
    this.deps.fed.problem(
      `content:conflict:${epoch.slice(0, 12)}`,
      `${this.deps.roster.label(sender)} sent a different content key for epoch ${epoch.slice(0, 12)} than the one this machine held; ${opener ? 'it opened that epoch, so its key replaced the other' : 'the key already held was kept'}. A teammate's machine may be sending bad keys: check who can admit.`
    );
  }

  // Whether an op stamped at `hlc` comes after the team's e2e switch; an
  // unreadable clock counts as after, so a plain body is never let through.
  private afterSwitch(hlc: string): boolean {
    const since = this.deps.roster.view()?.contentE2e?.since ?? null;
    if (since === null) return false;
    if (this.switchClock?.hash !== since) {
      const row = this.deps.fed.db
        .query<{ hlc: string }, [string]>(
          'SELECT hlc FROM fed_roster WHERE hash = ?'
        )
        .get(since);
      this.switchClock = {
        hash: since,
        hlc: row === null ? null : parseOpHlc(row.hlc),
      };
    }
    const at = parseOpHlc(hlc);
    const sw = this.switchClock.hlc;
    return at === null || sw === null || compareHlc(at, sw) > 0;
  }

  /** Each pass: keys for epochs this machine opened, then grants to every
   *  member it owes them, and answers to the wants it heard. */
  collect(): void {
    const { fed, roster } = this.deps;
    const view = roster.view();
    const epochs = view?.contentE2e?.epochs ?? [];
    if (view === null || epochs.length === 0 || fed.head() === null) return;
    const mine = view.members.get(this.me);
    if (mine === undefined || mine.observer) return;
    for (const epoch of epochs) this.mint(epoch);
    // Receivers take a key only from its epoch's opener or an admin.
    const admin = mine.role === 'admin';
    const now = this.deps.now().getTime();
    const due = new Map<string, string[]>();
    const answering: string[] = [];
    for (const m of view.members.values()) {
      if (m.replica === this.me || fed.pinned(m.replica) === null) continue;
      if (!capsOf(fed, m.replica).includes(CONTENT_E2E_CAP)) continue;
      const asked = this.asked.get(m.replica);
      const give: string[] = [];
      for (const epoch of epochs) {
        const opener = this.openerOf(epoch) === this.me;
        if (!this.keyring.has(epoch) || (!opener && !admin)) continue;
        // Only the opener of an epoch and the admitter of a member owe it.
        const owed =
          (opener || m.since.replica === this.me) &&
          !this.granted(m.replica, epoch);
        const ref = `${m.replica}\n${epoch}`;
        const answer =
          asked?.has(epoch) === true &&
          now - (this.answered.get(ref) ?? -Infinity) >= WANTS_ANSWER_MS;
        if (!owed && !answer) continue;
        give.push(epoch);
        if (answer) answering.push(ref);
      }
      if (give.length > 0) due.set(m.replica, give);
    }
    if (due.size === 0) return;
    // One op per set of epochs, to at most MAX_SEALED_RECIPIENTS each.
    const groups = new Map<string, string[]>();
    for (const [replica, give] of due) {
      const k = give.join(',');
      groups.set(k, [...(groups.get(k) ?? []), replica]);
    }
    fed.atomically(() => {
      for (const [k, replicas] of groups) {
        const grant: ContentKeyGrant[] = k.split(',').map((epoch) => ({
          epoch,
          key: b64u(this.keyring.get(epoch) ?? Buffer.alloc(0)),
        }));
        for (let at = 0; at < replicas.length; at += MAX_SEALED_RECIPIENTS)
          this.publishGrant(
            grant,
            replicas.slice(at, at + MAX_SEALED_RECIPIENTS)
          );
      }
    });
    for (const ref of answering) {
      this.answered.set(ref, now);
      const [replica = '', epoch = ''] = ref.split('\n');
      this.asked.get(replica)?.delete(epoch);
    }
  }

  /** After each pass: what is still missing is what the next presence asks for. */
  passEnded(): void {
    const { fed } = this.deps;
    this.lacking = this.epochs().filter((e) => !this.keyring.has(e));
    if (this.missing() === null) fed.clearProblem('content:key');
  }

  /** Names why content waits on this machine, once a publish could not go. */
  waiting(): void {
    if (this.missing() === null) return;
    this.deps.fed.problem('content:key', CONTENT_KEY_WAITING);
  }

  /** An admin switches the team to e2e content: every member and invitee
   *  must speak it, and the legacy window must be closed. */
  switchOn(): void {
    const { fed, roster } = this.deps;
    roster.requireAdmin('turn on end-to-end encrypted team content');
    const view = roster.view();
    if (view === null)
      throw new RosterError('conflict', 'this machine is in no team');
    if (view.legacy.closed === null)
      throw new RosterError(
        'conflict',
        'close the legacy window first: older builds copy the board in the clear'
      );
    const lacking = this.lackingCap(view);
    if (lacking.length > 0)
      throw new RosterError(
        'conflict',
        `every machine needs a Dispatch build that speaks end-to-end encrypted content; not yet: ${lacking.map((l) => l.handle).join(', ')}`
      );
    roster.switchContentE2e();
    // The switch's key and its grants go out with the switch.
    if (fed.head() !== null) this.collect();
  }

  status(): ContentE2eStatus {
    const view = this.deps.roster.view();
    const epochs = this.epochs();
    return {
      on: epochs.length > 0,
      since: view?.contentE2e?.since ?? null,
      sinceAt: this.signedAt(view?.contentE2e?.since ?? null),
      current: this.current(),
      epochs: epochs.map((epoch) => ({
        epoch,
        held: this.keyring.has(epoch),
      })),
      missing: epochs.filter((e) => !this.keyring.has(e)),
      lacking: view === null ? [] : this.lackingCap(view),
      legacyClosed: view?.legacy.closed != null,
    };
  }

  // A roster op's signing time, from its HLC.
  private signedAt(hash: string | null): string | null {
    if (hash === null) return null;
    const row = this.deps.fed.db
      .query<{ hlc: string }, [string]>(
        'SELECT hlc FROM fed_roster WHERE hash = ?'
      )
      .get(hash);
    const ms = row === null ? null : hlcWallMs(row.hlc);
    return ms === null ? null : new Date(ms).toISOString();
  }

  // Members and invitees, other than this machine, whose build lacks the cap.
  private lackingCap(view: RosterView): { replica: string; handle: string }[] {
    const { fed, roster } = this.deps;
    return [...view.members.keys(), ...view.invitedBy.keys()]
      .filter((r) => r !== this.me && !capsOf(fed, r).includes(CONTENT_E2E_CAP))
      .map((replica) => ({
        replica,
        handle:
          view.members.get(replica)?.handle ??
          view.invitedBy.get(replica) ??
          roster.label(replica),
      }));
  }

  // Only the machine whose roster op opened an epoch makes its key, once:
  // a keyring lost later is refilled by grants, never by a rival key.
  private mint(epoch: string): void {
    const { fed } = this.deps;
    if (this.keyring.has(epoch) || this.openerOf(epoch) !== this.me) return;
    const minted = this.minted();
    if (minted.includes(epoch)) return;
    this.keyring.put(epoch, generateContentKey());
    fed.setMeta('content_minted', JSON.stringify([...minted, epoch]));
  }

  private minted(): string[] {
    const raw = this.deps.fed.meta('content_minted');
    return raw === null ? [] : (JSON.parse(raw) as string[]);
  }

  // The replica whose roster op hashes to `epoch`.
  private openerOf(epoch: string): string | null {
    return (
      this.deps.fed.db
        .query<{ replica: string }, [string]>(
          'SELECT replica FROM fed_roster WHERE hash = ?'
        )
        .get(epoch)?.replica ?? null
    );
  }

  private granted(replica: string, epoch: string): boolean {
    return (
      this.deps.fed.db
        .query<{ one: number }, [string, string]>(
          'SELECT 1 AS one FROM fed_content_grants WHERE replica = ? AND epoch = ?'
        )
        .get(replica, epoch) !== null
    );
  }

  private publishGrant(grant: ContentKeyGrant[], replicas: string[]): void {
    const { fed } = this.deps;
    const recipients = new Map<string, string>();
    for (const r of replicas) {
      const pin = fed.pinned(r);
      if (pin !== null) recipients.set(r, pin.sealPub);
    }
    if (recipients.size === 0) return;
    const payload: GrantPayload = { grant };
    fed.append({
      type: 'state',
      seal: (stamp) => {
        const { to, sealed } = sealPayload({
          replica: fed.replica,
          seq: stamp.seq,
          type: 'state',
          payload: payload as unknown as JsonValue,
          recipients,
        });
        return { to, sealed };
      },
      onStamp: () => {
        for (const r of recipients.keys())
          for (const g of grant)
            fed.db
              .query(
                'INSERT OR IGNORE INTO fed_content_grants (replica, epoch) VALUES (?, ?)'
              )
              .run(r, g.epoch);
      },
    });
  }
}
