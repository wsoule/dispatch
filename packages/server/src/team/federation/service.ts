import {
  comparePositions,
  isCovered,
  printable,
  verifyLog,
} from '@dispatch/federation';
import type { LogCursor, RosterView } from '@dispatch/federation';
import {
  fingerprint as fingerprintOf,
  hlcWallMs,
  isStub,
  MAX_CLOCK_LEAD_MS,
  opHash,
  verifyEntry,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type {
  ChainHead,
  FederatedOp,
  LogEntry,
} from '@dispatch/protocol/federation';

import type { BoardOp } from '../boardSync/engine.js';
import type { SyncLedger, SyncProblem } from '../boardSync/ledger.js';
import type { RepoSyncResult } from '../boardSync/repo.js';
import { personOf } from '../boardSync/repo.js';
import type { SyncedTaskStore } from '../boardSync/syncedStore.js';
import type { AuditKind } from './audit.js';
import type { LegacyWindow, V1Log } from './legacy.js';
import type { RosterService } from './roster.js';
import type { FedStore } from './store.js';
import { TransportOffline } from './transport.js';
import type {
  FederationTransport,
  TransportHealth,
  Watermarks,
} from './transport.js';
import { dropNote } from './validate.js';

// When board sync runs, and what it reports. Before a team is founded a pass
// is today's v1 pass step for step; once founded it exchanges signed ops
// through one transport seam (spec "A pass"). Passes run soon after a local
// change (debounced) and on an interval otherwise, never two at once.
//
// Licensed under the Elastic License 2.0 (../LICENSE). A board is shared by
// as many people as the license covers, earliest first; someone past the seats
// pauses: nothing of theirs goes out, nobody applies theirs, nothing is deleted.

/** The one clock rule: an op stamped further ahead than this waits (FW-R21). */
export const CLOCK_GUARD_MS = MAX_CLOCK_LEAD_MS;
/** An op this far ahead also names its machine's clock as wrong. */
const CLOCK_PROBLEM_MS = 60 * 60 * 1000;
/** Waiting ops one publisher may hold here (FW-R33(5)). */
const MAX_PARKED_PER_PUBLISHER = 10_000;
/** Waiting ops restaged per publisher, and in all, each pass. */
const RESTAGE_PER_PUBLISHER = 200;
const RESTAGE_PER_PASS = 2_000;

/** Team messaging op types, applied only once mailReady (FW-R32(7)). */
const F2_TYPES = new Set(['presence', 'agent', 'channel', 'mail', 'state']);
/** Op types a handler may ask to reread; their hashes are kept (FW-R37(2)). */
const REREAD_TYPES = new Set(['doc']);

/** How soon the next pass runs while an asker waits (fastUntil). */
const FAST_PASS_MS = 10_000;
/** fed_applied rows kept for the revocation race (F-D34). */
const APPLIED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Seqs behind a head whose hashes stay for fork and cut checks; older ones
 *  go, except a live revocation's afterSeq. */
const SEEN_OPS_KEPT = 10_000;
// The most of a disputed id's claimed chain read before one is decided.
const CLAIM_PREFIX_OPS = 8;
// A full scan for a missing key or founding: this many passes in a row, then
// waits doubling up to this long, unless the files it reads change.
const SCAN_EAGER = 3;
const SCAN_MAX_WAIT_MS = 30 * 60 * 1000;
const SCAN_MIN_INTERVAL_MS = 60 * 1000;
// One bad-signature or halt audit row per replica in this window.
const AUDIT_WINDOW_MS = 10 * 60 * 1000;

/** What `GET /api/board-sync` reports. */
interface SyncStatus {
  enabled: true;
  replica: string;
  remote: string;
  branch: string;
  lastSyncAt: string | null;
  /** Why the last pass could not reach the remote, if it could not. Local
   *  work carries on either way; this is only ever about the exchange. */
  lastError: string | null;
  /** Changes made here and not yet pushed. */
  pending: number;
  /** Changes from others applied since the daemon started. */
  applied: number;
  problems: SyncProblem[];
  /** People sharing the branch, and how many the license covers. */
  people: number;
  seats: number;
  /** Why this machine is not syncing although the remote is fine: it is
   *  past the license's seats. Null while it syncs. */
  paused: string | null;
}

export interface FederationStatus extends SyncStatus {
  teamId: string | null;
  founded: boolean;
  legacyUntil: string | null;
  /** The transport's kind, for the request tier (F-D29). */
  transport: 'git' | 'relay';
  /** The transport's health, for the decide tier. */
  transportHealth: TransportHealth;
  federationProblems: { subject: string; message: string; at: string }[];
}

/** Run and agent claims among this pull's verified ops: run id -> every
 *  replica claiming it, agent address -> its publisher. */
export interface Evidence {
  runs: Map<string, string[]>;
  agents: Map<string, string>;
}

export interface StageContext {
  view: RosterView;
  now: Date;
  evidence: Evidence;
}

export interface OpHandler {
  readonly type: string;
  /** Inside the state.db transaction; 'parked' keeps the op for a later pass. */
  stage(op: FederatedOp, ctx: StageContext): 'applied' | 'parked' | 'dropped';
  /** After each pass that ran to the end: project what the pass applied. */
  passComplete?(): void;
  /** Its applied ops count in `applied`, as task ops do (board state). */
  readonly countsApplied?: boolean;
  /** Retention dropped a parked op of this type (XD1c). */
  dropped?(op: FederatedOp, reason: 'overflow' | 'revoked'): void;
}

/** Queues ops into fed_outbox before publishing (spec "Collect"). */
export interface Collector {
  readonly order: number;
  collect(now: Date): void;
}

export interface InboxDrainer {
  drain(now: Date): Promise<void>;
  waiting(replica: string): number;
}

/** The v1 side of the sync branch, which SyncRepo satisfies. */
export interface V1Branch extends V1Log {
  ensure(): Promise<void>;
  exchange(): Promise<RepoSyncResult>;
  write(ops: BoardOp[]): Promise<void>;
  readOthers(cursor: (replica: string) => number): BoardOp[];
  people(): Map<string, string>;
}

export interface FederationServiceOptions {
  /** Waiting ops per publisher before the oldest go (tests lower it). */
  maxParkedPerPublisher?: number;
  /** Waiting ops restaged per publisher each pass (tests lower it). */
  restagePerPublisher?: number;
  store: SyncedTaskStore;
  ledger: SyncLedger;
  v1: V1Branch;
  fed: FedStore;
  roster: RosterService;
  legacy: LegacyWindow;
  transport: FederationTransport;
  remote: string;
  branch: string;
  intervalMs: number;
  /** Called when a pass changed the board, so the daemon can rebuild its
   *  cache and tell every client — the same as a local edit does. */
  onBoardChanged: () => void;
  /** How many people the license covers, asked on every pass. */
  seats: () => number;
  /** The sentence to pause with when this machine is past the seats. */
  seatMessage: (seats: number) => string;
  debounceMs?: number;
  now?: () => Date;
  /** Seqs behind each head whose hashes fed_seen_ops keeps (SEEN_OPS_KEPT). */
  seenOpsKept?: number;
}

// One replica's verified entries, and how its log ended this read.
interface Verified {
  entries: { entry: LogEntry; hash: string }[];
  halted: string | null;
  /** A halt or stall was recorded for this log on this pass. */
  flagged: boolean;
}

export class FederationService {
  private lastSyncAt: string | null = null;
  /** Backoff per full scan (FW-R28), by what it looks for. */
  private readonly scans = new Map<
    string,
    { attempts: number; nextAt: number; stamp: string; lastAt: number | null }
  >();
  /** Per undecided id, the lines and roster it was last read with. */
  private readonly undecidedSeen = new Map<string, string>();
  private lastError: string | null = null;
  private paused: string | null = null;
  private people = 0;
  private applied = 0;
  private running: Promise<void> | null = null;
  private again = false;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private ready: Promise<void> | null = null;
  private stopped = false;
  private readonly handlers = new Map<string, OpHandler>();
  private readonly collectors: Collector[] = [];
  private inbox: InboxDrainer | null = null;
  private fast: Date | null = null;
  private restageStart = 0;
  private restagePass = 0;
  // When each waiting op was last restaged, by pass (FW-R35(3)). Known limit:
  // kept in memory, so a restart tries each publisher's oldest ops first once.
  private readonly restageTried = new Map<string, number>();
  // Ops a handler asked to see again (XD1e), by replica. Known limit: kept in
  // memory, so a restart forgets them and the handler asks again.
  private readonly rereads = new Map<string, Set<number>>();

  constructor(private readonly opts: FederationServiceOptions) {}

  /** The next pass pulls `replica` from below `seqs` and hands each of those
   *  ops, verified again, to its handler once more. */
  reread(replica: string, seqs: readonly number[]): void {
    const wanted = this.rereads.get(replica) ?? new Set<number>();
    for (const seq of seqs)
      if (Number.isInteger(seq) && seq > 0) wanted.add(seq);
    if (wanted.size > 0) this.rereads.set(replica, wanted);
  }

  /** Starts the interval and runs a first pass. */
  start(): void {
    this.interval = setInterval(() => {
      void this.syncNow();
    }, this.opts.intervalMs);
    void this.syncNow();
  }

  /** Stops scheduling passes and waits for the one in flight (B2), so the
   *  ledger can close after it. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.interval !== null) clearInterval(this.interval);
    if (this.debounce !== null) clearTimeout(this.debounce);
    await this.running;
  }

  /** A local change happened: sync shortly, once the burst is over. */
  notifyLocalChange(): void {
    this.schedule(this.opts.debounceMs ?? 2000);
  }

  // One pending pass, `ms` from now, replacing any earlier one.
  private schedule(ms: number): void {
    if (this.stopped) return;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = null;
      void this.syncNow();
    }, ms);
  }

  /** Runs a pass now, or right after the one in flight. Resolves when the
   *  pass this call asked for has finished. */
  async syncNow(): Promise<void> {
    if (this.stopped) return;
    if (this.running !== null) {
      this.again = true;
      await this.running;
      if (this.running !== null) await this.running;
      return;
    }
    this.running = this.pass().finally(() => {
      this.running = null;
    });
    await this.running;
    if (this.again) {
      this.again = false;
      await this.syncNow();
    }
  }

  register(handler: OpHandler): void {
    this.handlers.set(handler.type, handler);
  }

  addCollector(collector: Collector): void {
    this.collectors.push(collector);
    this.collectors.sort((a, b) => a.order - b.order);
  }

  setInbox(inbox: InboxDrainer): void {
    this.inbox = inbox;
  }

  /** Task 16: shorter passes while an asker waits, until `when`. */
  fastUntil(when: Date): void {
    this.fast = when;
  }

  status(): FederationStatus {
    const { ledger, fed, roster, transport } = this.opts;
    const view = roster.view();
    return {
      enabled: true,
      replica: ledger.replica,
      remote: this.opts.remote,
      branch: this.opts.branch,
      lastSyncAt: this.lastSyncAt,
      lastError: this.lastError,
      // Written to the clone but not yet pushed counts too (FW-R25).
      pending:
        ledger.outbox().length +
        fed.outbox().length +
        transport.health().unpublished,
      applied: this.applied,
      problems: ledger.problems(),
      people: view?.people.length ?? this.people,
      seats: this.opts.seats(),
      paused: this.paused ?? this.rosterPause(view),
      teamId: roster.teamId(),
      founded: roster.founded(),
      legacyUntil: fed.meta('legacy_until'),
      transport: transport.kind,
      transportHealth: transport.health(),
      federationProblems: fed.problems(),
    };
  }

  // A roster op this build cannot read stops every replica's ops applying:
  // the pause problem's own words, which name the commands that lift it.
  private rosterPause(view: RosterView | null): string | null {
    const paused = view?.unknown;
    if (paused == null) return null;
    const note = this.opts.fed
      .problems()
      .find((p) => p.subject === `op:${paused.replica}:${paused.seq}`);
    return `Board sync is paused on this machine: ${note?.message ?? `it cannot read ${paused.replica}'s roster op at seq ${paused.seq}`}`;
  }

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private async pass(): Promise<void> {
    const { v1, roster, fed, transport, legacy } = this.opts;
    try {
      this.ready ??= v1.ensure();
      await this.ready;
      // The fold reads the clock (license expiry, the legacy deadline).
      roster.reload();
      if (!roster.founded()) {
        const covered = await this.v1Pass();
        await this.discoverFounding();
        // Lines from a branch that carries a founding wait for it: past the
        // window they are refused, so no machine applies them first.
        if (covered !== null && !roster.foundingSeen()) this.v1Apply(covered);
        // A founding pinned just now: this replica's key op goes out this pass.
        if (!roster.founded()) return;
      }
      const now = this.now();
      if (!this.coveredHere()) {
        this.paused = this.opts.seatMessage(roster.seats());
        this.lastSyncAt = now.toISOString();
        return;
      }
      this.paused = null;
      // An older build's ops first, before any op this pass mints passes them.
      legacy.reissue();
      try {
        legacy.maybeClose();
      } catch (err) {
        console.warn(
          `dispatchd: could not close the legacy window: ${(err as Error).message}`
        );
      }
      for (const c of this.collectors) c.collect(now);
      // Offline keeps both outboxes; the pull below says why.
      try {
        await this.publish();
      } catch (err) {
        if (!(err instanceof TransportOffline)) throw err;
      }
      // From one below each cursor, so a rival of the head op is seen (FW-R23).
      // A reread pulls its replica again from below the asked-for seqs.
      const marks = new Map(this.watermarks(1));
      for (const [replica, seqs] of this.rereads)
        marks.set(
          replica,
          Math.min(marks.get(replica) ?? 0, Math.max(0, Math.min(...seqs) - 2))
        );
      const entries = await transport.pull(marks);
      this.lastError = null;
      const v1Ops = v1.readOthers((r) => this.opts.ledger.cursor(r));
      const before = roster.view();
      const verified = this.verify(entries);
      this.afterFold(before);
      const changed = this.stage(verified, v1Ops, now);
      this.stageRereads(entries, now);
      await this.findNamedKeys();
      if (this.inbox !== null) await this.inbox.drain(now);
      await transport.ack(this.watermarks());
      for (const h of this.handlers.values()) h.passComplete?.();
      if (fed.outbox().length > 0) this.notifyLocalChange();
      this.lastSyncAt = now.toISOString();
      // A route's late sync failure is over once a sync goes through.
      fed.clearProblem('team:route');
      if (changed) this.opts.onBoardChanged();
      if (this.fast !== null && now < this.fast) this.schedule(FAST_PASS_MS);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
    }
  }

  // Today's pass, step for step, until a team is founded.
  // Sends this replica's v1 outbox and exchanges; the people the license
  // covers, or null when this replica is past the seats.
  private async v1Pass(): Promise<Set<string> | null> {
    const { ledger, v1 } = this.opts;
    const outbox = ledger.outbox();
    const seats = this.opts.seats();
    if (!this.coveredV1(seats, outbox[0]?.hlc).has(this.person())) {
      this.paused = this.opts.seatMessage(seats);
      this.lastSyncAt = this.now().toISOString();
      return null;
    }
    this.paused = null;
    if (outbox.length > 0) {
      await v1.write(outbox);
      const sent = outbox.at(-1)?.seq ?? 0;
      ledger.sent(sent);
      // B4: before a key op, nothing sent is ever re-issued; keep no record of it.
      if (this.opts.fed.head() === null)
        this.opts.fed.db
          .query('DELETE FROM fed_v1_minted WHERE seq <= ?')
          .run(sent);
    }
    const exchanged = await v1.exchange();
    this.lastError = exchanged.offline ?? null;
    this.lastSyncAt = this.now().toISOString();
    return this.coveredV1(seats);
  }

  // Applies other replicas' v1 lines from people the license covers.
  private v1Apply(covered: Set<string>): void {
    const { ledger, v1 } = this.opts;
    const incoming = v1
      .readOthers((replica) => ledger.cursor(replica))
      .filter((op) => covered.has(personOf(op.replica)))
      .sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0));
    let changed = false;
    ledger.atomically(() => {
      changed = this.applyV1(incoming);
    });
    if (changed) this.opts.onBoardChanged();
  }

  // Before a founder is pinned, every verified key and roster op goes to the
  // roster, so a pass pins a founding and announces this replica's key.
  private async discoverFounding(): Promise<void> {
    // An id first seen is read only to its key op (FW-R25), so a read that
    // claims new ids reads once more, in full, for their foundings.
    for (let round = 0; round < 2 && !this.opts.roster.founded(); round++) {
      let entries: LogEntry[];
      try {
        entries = await this.opts.transport.pull(new Map());
        this.opts.fed.clearProblem('team:founding');
      } catch (err) {
        // B7: say why no founding can be seen, instead of waiting silently.
        this.opts.fed.problem(
          'team:founding',
          `this machine could not read the sync branch for a founding: ${(err as Error).message}`
        );
        return;
      }
      const claims = this.opts.fed.claims().length;
      this.readFoundings(entries);
      if (this.opts.fed.claims().length === claims) break;
    }
    // FW-R28: a held invite names a team whose founding no read has shown;
    // every file is scanned until it shows, with a problem while it is missing.
    const awaited = this.opts.roster.awaitedTeam();
    if (
      !this.opts.roster.founded() &&
      awaited !== null &&
      this.scanDue(`founding\n${awaited}`, null)
    ) {
      this.readFoundings(await this.opts.transport.scan(null));
      if (this.opts.roster.awaitedTeam() === null) {
        this.opts.fed.clearProblem('team:founding');
        this.opts.transport.forgetScans(null);
      } else
        this.opts.fed.problem(
          'team:founding',
          `the invite this machine joined with is for team ${awaited}, whose founding is on no file of the sync branch this machine can read yet; it keeps looking. Check the invite came from this repository's team.`
        );
    }
    // Founded: the scans for a founding are over (FW-R30(5)).
    if (this.opts.roster.founded()) this.opts.transport.forgetScans(null);
    if (this.opts.fed.outbox().length > 0) this.notifyLocalChange();
  }

  // Each key op's chain on its own, its key and roster ops applied: a rival
  // claim never hides a founding.
  private readFoundings(entries: LogEntry[]): void {
    for (const [replica, list] of byReplica(entries)) {
      if (replica === this.opts.fed.replica) continue;
      for (const k of keyOps(list)) {
        const r = verifyLog(
          replica,
          chainFrom(list, null, keyOpSignPub(k)).chain,
          { head: null, halted: null },
          null
        );
        for (const { entry, hash } of r.accepted) {
          if (
            isStub(entry) ||
            (entry.type !== 'key' && entry.type !== 'roster')
          )
            continue;
          const named = entry.type === 'key' && namesItself(list, k);
          if (this.opts.roster.applyVerified(entry, hash, { named }) === 'held')
            break;
        }
      }
    }
  }

  // Whether a full scan for `key` is due: the first SCAN_EAGER passes in a
  // row, then waits doubling from a minute up to SCAN_MAX_WAIT_MS, and at
  // once whenever the stamp of the files it reads changes.
  private scanDue(key: string, replicas: readonly string[] | null): boolean {
    const stamp = this.opts.transport.stamp(replicas);
    const now = this.now().getTime();
    let st = this.scans.get(key);
    if (st === undefined) {
      st = { attempts: 0, nextAt: 0, stamp, lastAt: null };
      this.scans.set(key, st);
    } else if (st.stamp !== stamp) {
      // A change to its files scans again, but never sooner than a minute
      // after the last scan (FW-R29(3)).
      st.stamp = stamp;
      st.attempts = SCAN_EAGER;
      st.nextAt = (st.lastAt ?? 0) + SCAN_MIN_INTERVAL_MS;
    }
    if (now < st.nextAt) return false;
    st.attempts += 1;
    st.lastAt = now;
    if (st.attempts >= SCAN_EAGER)
      st.nextAt =
        now +
        Math.min(
          SCAN_MAX_WAIT_MS,
          SCAN_MIN_INTERVAL_MS * 2 ** (st.attempts - SCAN_EAGER)
        );
    return true;
  }

  /** FW-R28: the key op an admit names that no probe found, from a scan of
   *  that id's files outside the caps; true once a claim with it is held. */
  async findKey(replica: string, fingerprint: string): Promise<boolean> {
    const entries = await this.opts.transport.scan([replica]);
    for (const k of keyOps(entries.filter((e) => e.replica === replica))) {
      const body = k.body as { signPub?: unknown; sealPub?: unknown };
      if (
        typeof body.signPub !== 'string' ||
        typeof body.sealPub !== 'string' ||
        fingerprintOf(body.signPub, body.sealPub) !== fingerprint
      )
        continue;
      this.opts.roster.applyVerified(k, opHash(k), { named: true });
    }
    const found = this.opts.fed
      .claims(replica)
      .some((c) => c.fingerprint === fingerprint);
    if (found) this.opts.transport.forgetScans([replica]);
    return found;
  }

  // FW-R28: every key an admitted member's admit names but no read has
  // stored is looked for in its id's files, with a problem while missing.
  private async findNamedKeys(): Promise<void> {
    const { fed, roster } = this.opts;
    const missing = roster.missingNamedKeys();
    for (const { replica, fingerprint } of missing) {
      const key = `key\n${replica}\n${fingerprint}`;
      if (!this.scanDue(key, [replica])) continue;
      const found = await this.findKey(replica, fingerprint);
      if (found) this.scans.delete(key);
      const subject = `key:missing:${replica}`;
      if (found) fed.clearProblem(subject);
      else
        fed.problem(
          subject,
          `an admit names key ${fingerprint} for ${replica}, but no file of the sync branch this machine can read holds it yet; it keeps looking. If it never shows, revoke ${replica} and admit its machine again.`
        );
    }
    for (const p of fed.problems())
      if (
        p.subject.startsWith('key:missing:') &&
        !missing.some((m) => `key:missing:${m.replica}` === p.subject)
      )
        fed.clearProblem(p.subject);
  }

  // The people the license covers on the v1 branch, as BoardSyncService did.
  private coveredV1(seats: number, pendingHlc?: string): Set<string> {
    const people = this.opts.v1.people();
    const me = this.person();
    if (!people.has(me)) people.set(me, pendingHlc ?? '￿');
    this.people = people.size;
    return new Set(
      [...people.entries()]
        .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
        .slice(0, seats)
        .map(([person]) => person)
    );
  }

  private person(): string {
    return personOf(this.opts.ledger.replica);
  }

  // A pending replica must publish its key op to be admitted; only an
  // admitted replica past the seats pauses.
  private coveredHere(): boolean {
    const view = this.opts.roster.view();
    if (view === null || !view.members.has(this.opts.fed.replica)) return true;
    return isCovered(view, this.opts.fed.replica);
  }

  // Signed ops through the transport, then the v1 outbox (copies while the
  // window is open, and an older build's own lines).
  private async publish(): Promise<void> {
    const { fed, ledger, v1, transport } = this.opts;
    const ops = fed.outbox();
    const last = ops.at(-1);
    if (last !== undefined) {
      await transport.publish(ops);
      fed.published(last.seq);
    }
    const outbox = ledger.outbox();
    const lastV1 = outbox.at(-1);
    if (lastV1 !== undefined) {
      await v1.write(outbox);
      ledger.sent(lastV1.seq);
    }
  }

  private watermarks(back = 0): Watermarks {
    const out = new Map<string, number>();
    for (const row of this.opts.fed.db
      .query<{ replica: string; seq: number | null }, []>(
        'SELECT replica, seq FROM fed_cursors'
      )
      .all())
      if (row.seq !== null) out.set(row.replica, Math.max(0, row.seq - back));
    return out;
  }

  // The hash of the op this machine applied at (replica, seq), if any.
  private seenHash(replica: string, seq: number): string | null {
    return (
      this.opts.fed.db
        .query<{ hash: string }, [string, number]>(
          'SELECT hash FROM fed_seen_ops WHERE replica = ? AND seq = ?'
        )
        .get(replica, seq)?.hash ?? null
    );
  }

  // A validly signed op at a seq this machine already verified, other than
  // the one it verified: a fork (FW-R23), halting that log.
  private rivalOf(
    replica: string,
    list: readonly LogEntry[],
    cursor: LogCursor,
    signPub: string | null
  ): number | null {
    const head = cursor.head;
    if (head === null || signPub === null) return null;
    for (const e of list) {
      if (e.seq > head.seq) continue;
      const known =
        e.seq === head.seq ? head.hash : this.seenHash(replica, e.seq);
      let hash: string;
      try {
        hash = opHash(e);
      } catch {
        continue;
      }
      if (known === null || hash === known) continue;
      const before =
        e.type === 'key'
          ? null
          : {
              seq: e.seq - 1,
              hash: e.prev,
              hlc: `0000000000000.0000.${replica}`,
            };
      if (verifyEntry(before, e, signPub).ok) return e.seq;
    }
    return null;
  }

  // Verifies each replica's log from its cursor and hands key and roster ops
  // to the roster at once; cursors move only in staging.
  private verify(entries: LogEntry[]): Map<string, Verified> {
    const { fed, roster } = this.opts;
    const out = new Map<string, Verified>();
    // An undecided id whose lines and roster are as last pass costs nothing.
    const rosterRows =
      fed.db
        .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM fed_roster')
        .get()?.n ?? 0;
    for (const [replica, list] of byReplica(entries)) {
      if (replica === fed.replica) continue;
      const undecided = fed.pinned(replica) === null;
      const seen = undecided ? claimListKey(list, rosterRows) : null;
      if (seen !== null && this.undecidedSeen.get(replica) === seen) {
        out.set(replica, { entries: [], halted: null, flagged: false });
        continue;
      }
      // FW-R24: every self-signed key op claims the id; the roster decides
      // which key it speaks with, and only that key's chain is read.
      for (const k of keyOps(list))
        if (
          roster.applyVerified(k, opHash(k), {
            named: namesItself(list, k),
          }) === 'held'
        )
          break;
      const cursor = fed.cursor(replica);
      if (cursor.halted !== null) continue;
      const pinned = fed.pinned(replica);
      if (pinned === null) {
        this.readClaims(replica, list);
        if (seen !== null) this.undecidedSeen.set(replica, seen);
        out.set(replica, { entries: [], halted: null, flagged: false });
        continue;
      }
      this.undecidedSeen.delete(replica);
      const rival = this.rivalOf(
        replica,
        list,
        cursor,
        pinned?.signPub ?? null
      );
      if (rival !== null) {
        const reason = `${replica}'s log fails verification at seq ${rival}: two ops share this seq; revoke it, or have it push again`;
        this.recordHalt(replica, reason);
        out.set(replica, { entries: [], halted: reason, flagged: true });
        continue;
      }
      const { chain, stalled } = chainFrom(
        list,
        cursor.head,
        pinned?.signPub ?? null
      );
      if (stalled !== null)
        this.recordHalt(
          replica,
          `${replica}'s log fails verification at seq ${stalled.seq}: ${stalled.reason}; it waits for an op that verifies, or revoke it`
        );
      const r = verifyLog(replica, chain, cursor, pinned);
      const kept: Verified['entries'] = [];
      for (const item of r.accepted) {
        const { entry, hash } = item;
        if (!isStub(entry) && (entry.type === 'key' || entry.type === 'roster'))
          if (roster.applyVerified(entry, hash) === 'held') break;
        kept.push(item);
      }
      const halted = kept.length === r.accepted.length ? r.cursor.halted : null;
      if (halted !== null) this.recordHalt(replica, halted);
      out.set(replica, {
        entries: kept,
        halted,
        flagged: halted !== null || stalled !== null,
      });
    }
    this.checkCuts(out);
    return out;
  }

  // An id with rival claims and none decided: each claimed chain is read only
  // through its first roster op after the key op, which may be its recover.
  private readClaims(replica: string, list: readonly LogEntry[]): void {
    for (const claim of this.opts.fed.claims(replica)) {
      const chain = chainFrom(list, null, claim.signPub).chain;
      const firstRoster = chain.findIndex((e) => e.type === 'roster');
      const prefix = chain.slice(
        0,
        firstRoster < 0 ? 1 : Math.min(firstRoster + 1, CLAIM_PREFIX_OPS)
      );
      const r = verifyLog(replica, prefix, { head: null, halted: null }, claim);
      for (const { entry, hash } of r.accepted)
        if (!isStub(entry) && entry.type === 'roster')
          if (this.opts.roster.applyVerified(entry, hash) === 'held') break;
    }
  }

  // A revoked replica's op at afterSeq must hash to afterHash: the cut names
  // one history, and a log that shows another halts there. Checked once every
  // log is verified, since the revocation may come in another replica's log.
  private checkCuts(verified: Map<string, Verified>): void {
    const view = this.opts.roster.view();
    if (view === null) return;
    for (const [replica, v] of verified) {
      const cut = view.revoked.get(replica);
      if (cut === undefined) continue;
      const at = v.entries.find(({ entry }) => entry.seq === cut.afterSeq);
      const read = this.opts.fed.cursor(replica).head;
      const hash =
        at?.hash ??
        (read?.seq === cut.afterSeq
          ? read.hash
          : (this.seenHash(replica, cut.afterSeq) ?? undefined));
      // Past the cut with its hash pruned: the history there cannot be checked.
      if (hash === undefined && read !== null && read.seq > cut.afterSeq)
        this.opts.fed.problem(
          `team:cut:${replica}`,
          `the revocation of ${replica} names seq ${cut.afterSeq}, older than the hashes this machine keeps; its history there cannot be checked`
        );
      if (hash === undefined || hash === cut.afterHash) continue;
      const reason = `${replica}'s log fails verification at seq ${cut.afterSeq}: it shows another history than the one its revocation names; revoke it, or have it push again`;
      v.entries = v.entries.filter(({ entry }) => entry.seq < cut.afterSeq);
      v.halted = reason;
      v.flagged = true;
      this.recordHalt(replica, reason);
    }
  }

  // A halt's problem and audit row, by its reason (F-D38).
  private recordHalt(replica: string, reason: string): void {
    const kind: AuditKind =
      reason.includes('two ops share this seq') ||
      reason.includes('prev does not match')
        ? 'fork'
        : reason.includes('bad signature') || reason.includes('bodyHash')
          ? 'bad-signature'
          : 'halt';
    const subject = `halt:${replica}`;
    const { fed } = this.opts;
    // Re-read while blocked ops wait before it: one audit row per halt.
    if (
      fed.problems().some((p) => p.subject === subject && p.message === reason)
    )
      return;
    fed.problem(subject, reason);
    // A fork is always written; a replica that keeps failing writes one row a window.
    const last = fed.db
      .query<{ at: string }, [string, string]>(
        'SELECT at FROM fed_audit WHERE subject = ? AND kind = ? ORDER BY at DESC LIMIT 1'
      )
      .get(subject, kind);
    if (
      kind === 'fork' ||
      last === null ||
      this.now().getTime() - Date.parse(last.at) >= AUDIT_WINDOW_MS
    )
      fed.audit(kind, subject, { replica, reason });
  }

  // The log reads again: its halt or stall problem (its own subject) goes.
  private clearHaltProblem(replica: string): void {
    this.opts.fed.clearProblem(`halt:${replica}`);
  }

  // The races a new fold reveals: a revocation cutting below ops applied here
  // (F-D34), and a close-legacy that folded here (Task 9b).
  private afterFold(before: RosterView | null): void {
    const { fed, roster, legacy } = this.opts;
    const view = roster.view();
    if (view === null) return;
    for (const [replica, cut] of view.revoked) {
      if (before?.revoked.has(replica) === true) continue;
      const read = fed.cursor(replica).head?.seq ?? 0;
      if (read <= cut.afterSeq) continue;
      const tasks = fed.db
        .query<{ task: string }, [string, number]>(
          'SELECT DISTINCT task FROM fed_applied WHERE replica = ? AND seq > ? ORDER BY task'
        )
        .all(replica, cut.afterSeq)
        .map((row) => row.task);
      if (tasks.length === 0) continue;
      fed.problem(
        `team:race:${replica}`,
        `${roster.label(replica)} was revoked after this machine applied its changes to ${tasks.join(', ')}; they stay until someone edits them`
      );
    }
    if (before?.legacy.closed === null && view.legacy.closed !== null)
      legacy.onClosed();
  }

  // Applies verified ops in (hlc, replica, seq) order in one state.db
  // transaction, each replica's cursor moving past what it consumed.
  private stage(
    verified: Map<string, Verified>,
    v1Ops: BoardOp[],
    now: Date
  ): boolean {
    const { ledger, fed, roster } = this.opts;
    let changed = false;
    ledger.atomically(() => {
      const view = roster.view();
      if (view === null) return;
      const ctx: StageContext = {
        view,
        now,
        evidence: evidenceOf(verified, view),
      };
      this.restage(ctx);
      const blocked = new Set<string>();
      // An op this build cannot read, from someone who stands, pauses applying.
      if (view.unknown !== null)
        for (const replica of verified.keys()) blocked.add(replica);
      const heads = new Map<string, LogCursor['head']>();
      const walk = [...verified]
        .flatMap(([, v]) => v.entries)
        .sort((a, b) => comparePositions(a.entry, b.entry));
      for (const { entry, hash } of walk) {
        const r = entry.replica;
        if (blocked.has(r)) continue;
        const outcome = this.stageOne(entry, view, ctx, now);
        if (outcome === 'block') {
          blocked.add(r);
          continue;
        }
        if (outcome === 'changed') changed = true;
        heads.set(r, { seq: entry.seq, hash, hlc: entry.hlc });
        fed.db
          .query(
            'INSERT OR IGNORE INTO fed_seen_ops (replica, seq, hash) VALUES (?, ?, ?)'
          )
          .run(r, entry.seq, hash);
      }
      for (const [replica, v] of verified) {
        const head = heads.get(replica) ?? fed.cursor(replica).head;
        const halted = blocked.has(replica) ? null : v.halted;
        if (heads.has(replica) || halted !== null)
          fed.setCursor(replica, { head, halted });
        // The log reads again: its verification problem is over.
        if (heads.has(replica) && !v.flagged) this.clearHaltProblem(replica);
        // Its ops apply again: its clock no longer runs ahead of this one.
        if (heads.has(replica) && !blocked.has(replica))
          fed.clearProblem(`clock:${replica}`);
        if (head !== null && heads.has(replica))
          fed.db
            .query(
              'DELETE FROM fed_seen_ops WHERE replica = ? AND seq < ? AND seq != ?'
            )
            .run(
              replica,
              head.seq - (this.opts.seenOpsKept ?? SEEN_OPS_KEPT),
              view.revoked.get(replica)?.afterSeq ?? -1
            );
      }
      if (this.applyV1Filtered(v1Ops)) changed = true;
      // An observer note goes once its replica is no observer any more.
      for (const p of fed.problems()) {
        if (!p.subject.startsWith('observer:')) continue;
        const r = p.subject.slice('observer:'.length);
        if (view.members.get(r)?.observer !== true) fed.clearProblem(p.subject);
      }
      fed.db
        .query('DELETE FROM fed_applied WHERE at < ?')
        .run(new Date(now.getTime() - APPLIED_RETENTION_MS).toISOString());
    });
    return changed;
  }

  // One op: 'block' keeps it and the rest of its replica's ops for a later
  // pass; anything else moves the cursor past it.
  private stageOne(
    entry: LogEntry,
    view: RosterView,
    ctx: StageContext,
    now: Date
  ): 'block' | 'changed' | 'moved' {
    const { fed, roster, store } = this.opts;
    const r = entry.replica;
    // A revoked replica's ops above its cut are dropped; those below stand.
    const cut = view.revoked.get(r);
    if (cut !== undefined && entry.seq > cut.afterSeq) return 'moved';
    const member = view.members.get(r);
    // A pending replica, or one past the seats, waits with its cursor unmoved.
    if (cut === undefined && (member === undefined || !isCovered(view, r)))
      return 'block';
    // Key and roster ops were applied when they verified.
    if (entry.type === 'key' || entry.type === 'roster') return 'moved';
    const observer = member?.observer ?? cut?.observer ?? false;
    if (observer && entry.type !== 'presence') {
      fed.problem(
        `observer:${r}`,
        `${roster.label(r)} is an observer, so its ${entry.type} change at seq ${entry.seq} was dropped: an observer publishes only keys, presence and acks. If it should edit, revoke it (\`dispatch team keys revoke ${r}\`), and have its owner join again from a fresh machine id; else acknowledge this.`
      );
      fed.audit('speaks-for', `op:${r}:${entry.seq}`, {
        replica: r,
        seq: entry.seq,
        type: entry.type,
      });
      return 'moved';
    }
    // FW-R37(2): the hash of an op a handler may reread is kept before it waits.
    if (REREAD_TYPES.has(entry.type))
      fed.rememberReread(r, entry.seq, opHash(entry));
    // FW-R32(2), FW-R33(1): every verified mail op, a pruned one too, is
    // remembered before it can wait, so a forward of it can be checked.
    if (entry.type === 'mail') fed.rememberMail(r, entry.seq, opHash(entry));
    const ahead = (hlcWallMs(entry.hlc) ?? 0) - now.getTime();
    if (ahead > CLOCK_GUARD_MS) {
      if (ahead > CLOCK_PROBLEM_MS) this.clockProblem(r, ahead);
      return 'block';
    }
    if (isStub(entry)) {
      if (entry.to?.includes(fed.replica) === true)
        fed.problem(
          `op:${r}:${entry.seq}`,
          `${entry.type} from ${r} seq ${entry.seq} was pruned before this machine read it`
        );
      return 'moved';
    }
    if (entry.type === 'task') {
      const body = entry.body as unknown as Omit<
        BoardOp,
        'v' | 'replica' | 'seq' | 'hlc'
      >;
      const result = store.applyRemote({
        v: 1,
        replica: r,
        seq: entry.seq,
        hlc: entry.hlc,
        ...body,
      });
      if (result.held === true) return 'block';
      if (result.problem !== undefined)
        this.opts.ledger.recordProblem(
          body.task,
          result.problem,
          now.toISOString()
        );
      fed.db
        .query(
          'INSERT OR IGNORE INTO fed_applied (replica, seq, task, at) VALUES (?, ?, ?, ?)'
        )
        .run(r, entry.seq, body.task, now.toISOString());
      if (!result.changed) return 'moved';
      this.applied += 1;
      return 'changed';
    }
    const handler = this.handlers.get(entry.type);
    // FW-R32(7): team messaging ops wait until this machine is firmly in.
    const waiting = F2_TYPES.has(entry.type) && !this.opts.roster.mailReady();
    if (handler !== undefined && !waiting) {
      if (this.stageSafely(handler, entry, ctx) === 'parked')
        this.park(entry, 'parked');
      return 'moved';
    }
    fed.db
      .query(
        'INSERT OR IGNORE INTO fed_unknown (replica, seq, op_json) VALUES (?, ?, ?)'
      )
      .run(r, entry.seq, JSON.stringify(entry));
    this.makeRoom('fed_unknown', entry);
    return 'moved';
  }

  // FW-R32(3): a handler that throws drops that one op with a rolling note;
  // no op can stop a pass.
  private stageSafely(
    handler: OpHandler,
    op: FederatedOp,
    ctx: StageContext
  ): 'applied' | 'parked' | 'dropped' {
    try {
      const out = handler.stage(op, ctx);
      if (out === 'applied' && handler.countsApplied === true)
        this.applied += 1;
      return out;
    } catch (err) {
      dropNote(
        this.opts.fed,
        'malformed',
        op.replica,
        `${this.opts.roster.label(op.replica)}'s ${op.type} op at seq ${op.seq} could not be applied and was dropped: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`
      );
      return 'dropped';
    }
  }

  // "<handle>'s <device> runs N minutes ahead", once per message, with an
  // audit row when it is new.
  private clockProblem(replica: string, ahead: number): void {
    const { fed, roster } = this.opts;
    const subject = `clock:${replica}`;
    const device = printable(fed.pinned(replica)?.device ?? replica);
    // One message while it waits, not a new one each minute it stays ahead.
    const message = `${roster.label(replica)}'s ${device} runs more than an hour ahead, so its changes wait until this machine's clock reaches them; fix that machine's clock`;
    if (
      fed.problems().some((p) => p.subject === subject && p.message === message)
    )
      return;
    fed.problem(subject, message);
    fed.audit('clock-hold', subject, { replica, aheadMs: ahead });
  }

  private park(op: FederatedOp, reason: string): void {
    this.makeRoom('fed_parked', op);
    this.opts.fed.db
      .query(
        'INSERT OR REPLACE INTO fed_parked (replica, seq, op_json, reason, first_at) VALUES (?, ?, ?, ?, ?)'
      )
      .run(
        op.replica,
        op.seq,
        JSON.stringify(op),
        reason,
        this.now().toISOString()
      );
  }

  // Tells a parked op's handler that retention dropped it.
  private droppedParked(json: string, reason: 'overflow' | 'revoked'): void {
    const op = JSON.parse(json) as FederatedOp;
    try {
      this.handlers.get(op.type)?.dropped?.(op, reason);
    } catch (err) {
      console.error(`dispatchd: a dropped ${op.type} op's handler failed`, err);
    }
  }

  // XD1e: the ops a handler asked for again, from this pass's pull (lowered
  // to below them). Each stages again only when its hash matches the one
  // kept when it was first verified (FW-R37(2)), and its signature and
  // content check against its predecessor's clock; else it is refused.
  private stageRereads(entries: readonly LogEntry[], now: Date): void {
    if (this.rereads.size === 0) return;
    const { ledger, fed, roster } = this.opts;
    const asked = new Map(this.rereads);
    this.rereads.clear();
    const byHash = new Map<string, LogEntry>();
    for (const e of entries) {
      const h = orNull(() => opHash(e));
      if (h !== null) byHash.set(h, e);
    }
    ledger.atomically(() => {
      const view = roster.view();
      if (view === null) return;
      const ctx: StageContext = {
        view,
        now,
        evidence: evidenceOf(new Map(), view),
      };
      for (const e of entries) {
        if (asked.get(e.replica)?.has(e.seq) !== true || isStub(e)) continue;
        const kept = fed.rereadSeen(e.replica, e.seq);
        if (kept === null || kept !== orNull(() => opHash(e))) continue;
        asked.get(e.replica)?.delete(e.seq);
        const handler = this.handlers.get(e.type);
        const pinned = fed.pinned(e.replica);
        if (handler === undefined || pinned === null) continue;
        const prev = byHash.get(e.prev);
        const prevHlc =
          prev?.replica === e.replica
            ? prev.hlc
            : `${'0'.repeat(13)}.0000.${e.replica}`;
        const ok = verifyEntry(
          { seq: e.seq - 1, hash: e.prev, hlc: prevHlc },
          e,
          pinned.signPub
        );
        if (!ok.ok) continue;
        if (this.stageSafely(handler, e, ctx) === 'parked')
          this.park(e, 'parked');
      }
    });
  }

  // FW-R33(5): one publisher's waiting ops are capped; past the cap its
  // oldest goes, with a rolling note.
  private makeRoom(table: 'fed_parked' | 'fed_unknown', op: FederatedOp): void {
    const { db } = this.opts.fed;
    const cap = this.opts.maxParkedPerPublisher ?? MAX_PARKED_PER_PUBLISHER;
    const held =
      db
        .query<{ n: number }, [string, number]>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE replica = ? AND seq != ?`
        )
        .get(op.replica, op.seq)?.n ?? 0;
    if (held < cap) return;
    const gone = db
      .query<{ seq: number; op_json: string }, [string, number, number]>(
        `SELECT seq, op_json FROM ${table} WHERE replica = ? AND seq != ? ORDER BY seq LIMIT ?`
      )
      .all(op.replica, op.seq, held - cap + 1);
    db.query(
      `DELETE FROM ${table} WHERE replica = ? AND seq IN (SELECT seq FROM ${table} WHERE replica = ? AND seq != ? ORDER BY seq LIMIT ?)`
    ).run(op.replica, op.replica, op.seq, held - cap + 1);
    if (table === 'fed_parked')
      for (const row of gone) this.droppedParked(row.op_json, 'overflow');
    dropNote(
      this.opts.fed,
      'mail-drop',
      op.replica,
      `${this.opts.roster.label(op.replica)} has more than ${cap} ops waiting here; the oldest were dropped`
    );
  }

  // Parked ops and ops of a type now registered get their handler again.
  private restage(ctx: StageContext): void {
    const { fed } = this.opts;
    const { db } = fed;
    // FW-R33(5), FW-R35(3): a budget per publisher and per pass; within a
    // publisher the least recently tried go first, so stuck ops cannot
    // starve the ones behind them, and publishers rotate.
    const perPublisher = this.opts.restagePerPublisher ?? RESTAGE_PER_PUBLISHER;
    const keys = (['fed_parked', 'fed_unknown'] as const).flatMap((table) =>
      db
        .query<{ replica: string; seq: number }, []>(
          `SELECT replica, seq FROM ${table}`
        )
        .all()
        .map((row) => ({ ...row, table }))
    );
    const tried = (k: { table: string; replica: string; seq: number }) =>
      this.restageTried.get(`${k.table}:${k.replica}:${k.seq}`) ?? -1;
    const byPublisher = new Map<string, typeof keys>();
    for (const k of keys) {
      const list = byPublisher.get(k.replica) ?? [];
      list.push(k);
      byPublisher.set(k.replica, list);
    }
    const all = [...byPublisher.values()].flatMap((list) =>
      list
        .sort((a, b) =>
          tried(a) !== tried(b) ? tried(a) - tried(b) : a.seq - b.seq
        )
        .slice(0, perPublisher)
        .sort((a, b) => a.seq - b.seq)
        .map((k) => ({
          ...k,
          op_json:
            db
              .query<{ op_json: string }, [string, number]>(
                `SELECT op_json FROM ${k.table} WHERE replica = ? AND seq = ?`
              )
              .get(k.replica, k.seq)?.op_json ?? 'null',
        }))
    );
    const publishers = [...new Set(all.map((r) => r.replica))].sort();
    const start =
      publishers.length === 0 ? 0 : this.restageStart % publishers.length;
    this.restageStart += 1;
    const order = [...publishers.slice(start), ...publishers.slice(0, start)];
    const rows = order
      .flatMap((r) => all.filter((row) => row.replica === r))
      .slice(0, RESTAGE_PER_PASS);
    const ready = this.opts.roster.mailReady();
    const pass = ++this.restagePass;
    // Rows no longer waiting are forgotten.
    const waitingNow = new Set(
      keys.map((k) => `${k.table}:${k.replica}:${k.seq}`)
    );
    for (const key of this.restageTried.keys())
      if (!waitingNow.has(key)) this.restageTried.delete(key);
    for (const row of rows) {
      this.restageTried.set(`${row.table}:${row.replica}:${row.seq}`, pass);
      const op = JSON.parse(row.op_json) as FederatedOp;
      // A parked op above its publisher's settled revocation cut goes (XD1c).
      const cut = ctx.view.revoked.get(op.replica);
      if (
        row.table === 'fed_parked' &&
        cut !== undefined &&
        op.seq > cut.afterSeq &&
        !revocationContested(fed, op.replica, ctx.view)
      ) {
        db.query('DELETE FROM fed_parked WHERE replica = ? AND seq = ?').run(
          row.replica,
          row.seq
        );
        this.droppedParked(row.op_json, 'revoked');
        continue;
      }
      const handler = this.handlers.get(op.type);
      if (handler === undefined) continue;
      if (F2_TYPES.has(op.type) && !ready) continue;
      const parked = this.stageSafely(handler, op, ctx) === 'parked';
      if (parked && row.table === 'fed_parked') continue;
      db.query(`DELETE FROM ${row.table} WHERE replica = ? AND seq = ?`).run(
        row.replica,
        row.seq
      );
      if (parked) this.park(op, 'parked');
    }
  }

  // v1 lines once founded: the legacy window decides which apply, which are
  // refused, and whose wait (cursor unmoved).
  private applyV1Filtered(ops: BoardOp[]): boolean {
    const { apply, refused } = this.opts.legacy.filterV1(ops);
    const changed = this.applyV1(
      [...apply].sort((a, b) => (a.hlc < b.hlc ? -1 : a.hlc > b.hlc ? 1 : 0))
    );
    for (const op of refused)
      if (op.seq > this.opts.ledger.cursor(op.replica))
        this.opts.ledger.setCursor(op.replica, op.seq);
    return changed;
  }

  // Applies v1 changes and advances each replica's cursor; a held change
  // stops its replica there (FW-R21).
  private applyV1(ops: BoardOp[]): boolean {
    const { ledger, store } = this.opts;
    let changed = false;
    const reached = new Map<string, number>();
    const held = new Set<string>();
    for (const op of ops) {
      if (held.has(op.replica)) continue;
      const result = store.applyRemote(op);
      // A held change is named under its replica, never over the task's own
      // problem, and the note goes once that replica's change applies (M7).
      const subject = `replica:${op.replica}`;
      if (result.held === true) {
        held.add(op.replica);
        ledger.recordProblem(
          subject,
          result.problem ?? 'held',
          new Date().toISOString()
        );
        continue;
      }
      ledger.clearProblem(subject);
      if (result.problem !== undefined)
        ledger.recordProblem(op.task, result.problem, new Date().toISOString());
      if (result.changed) {
        changed = true;
        this.applied += 1;
      }
      reached.set(op.replica, Math.max(reached.get(op.replica) ?? 0, op.seq));
    }
    for (const [replica, seq] of reached)
      if (seq > ledger.cursor(replica)) ledger.setCursor(replica, seq);
    return changed;
  }
}

function byReplica(entries: LogEntry[]): Map<string, LogEntry[]> {
  const out = new Map<string, LogEntry[]>();
  for (const e of entries) {
    const list = out.get(e.replica);
    if (list === undefined) out.set(e.replica, [e]);
    else list.push(e);
  }
  return out;
}

// FW-R23: one replica's log, rebuilt from its head by following prev links
// across whatever files held its lines. Copies of one op collapse to the line
// that verifies, full over stub, and a line that does not chain is dropped,
// unless it is a validly signed rival of the next op: a fork, which verifyLog
// halts on.
function chainFrom(
  entries: readonly LogEntry[],
  head: ChainHead | null,
  signPub: string | null
): { chain: LogEntry[]; stalled: { seq: number; reason: string } | null } {
  // prev -> op hash -> every line with that hash; a stub shares its op's hash.
  const byPrev = new Map<string, Map<string, LogEntry[]>>();
  for (const e of entries) {
    let hash: string;
    try {
      hash = opHash(e);
    } catch {
      continue;
    }
    const next = byPrev.get(e.prev) ?? new Map<string, LogEntry[]>();
    next.set(hash, [...(next.get(hash) ?? []), e]);
    byPrev.set(e.prev, next);
  }
  const out: LogEntry[] = [];
  let at = head;
  let key = signPub;
  for (;;) {
    const groups = [...(byPrev.get(at?.hash ?? ZERO_HASH)?.values() ?? [])];
    const valid: LogEntry[] = [];
    for (const lines of groups) {
      const ok = lines
        .filter((c) => {
          const k = key ?? keyOpSignPub(c);
          return k !== null && verifyEntry(at, c, k).ok;
        })
        .sort((a, b) => Number(isStub(a)) - Number(isStub(b)));
      if (ok[0] !== undefined) valid.push(ok[0]);
    }
    const [first] = valid;
    if (first === undefined) {
      // Something claims to follow the head and none of it verifies: the log
      // waits there, named, for the op that does.
      const bad = groups[0]?.[0];
      if (bad === undefined) return { chain: out, stalled: null };
      const k = key ?? keyOpSignPub(bad);
      const checked = k === null ? null : verifyEntry(at, bad, k);
      const reason =
        checked === null
          ? 'no key'
          : checked.ok
            ? 'out of order'
            : checked.reason;
      return { chain: out, stalled: { seq: bad.seq, reason } };
    }
    out.push(...valid);
    if (valid.length > 1) return { chain: out, stalled: null };
    key ??= keyOpSignPub(first);
    at = { seq: first.seq, hash: opHash(first), hlc: first.hlc };
  }
}

// What an undecided id's read depends on: its lines and how many roster ops
// this machine holds (an admit may since name one of its claims).
function claimListKey(list: readonly LogEntry[], rosterRows: number): string {
  const hashes = list.map((e) => {
    try {
      return opHash(e);
    } catch {
      return '';
    }
  });
  return `${rosterRows}:${hashes.sort().join(',')}`;
}

// Whether k's own chain founds a team or recovers: roster ops that name the
// key that signs them, so its claim is never dropped by the cap (FW-R26(2)).
function namesItself(list: readonly LogEntry[], k: FederatedOp): boolean {
  const key = keyOpSignPub(k);
  if (key === null) return false;
  return chainFrom(list, null, key).chain.some((e) => {
    if (e.type !== 'roster' || isStub(e)) return false;
    const action = (e.body as { action?: unknown } | undefined)?.action;
    return action === 'found' || action === 'recover';
  });
}

// The log's key ops that verify with the key each carries: its claims.
function keyOps(list: readonly LogEntry[]): FederatedOp[] {
  return list.filter((e): e is FederatedOp => {
    if (e.type !== 'key' || isStub(e)) return false;
    const k = keyOpSignPub(e);
    return k !== null && verifyEntry(null, e, k).ok;
  });
}

// The signing key a log's key op carries, which verifies the op itself.
function keyOpSignPub(e: LogEntry): string | null {
  if (e.type !== 'key' || isStub(e)) return null;
  const body = e.body as { signPub?: unknown } | undefined;
  return typeof body?.signPub === 'string' ? body.signPub : null;
}

// The run and agent claims a pull's verified ops make, read before any is
// staged, so a run claimed twice in one pull binds to neither.
/** Whether a revocation of `replica` is still being fought: its parked ops
 *  wait until the fight is decided (FW-R31(5)). */
export function revocationContested(
  fed: FedStore,
  replica: string,
  view: RosterView
): boolean {
  return fed.db
    .query<{ hash: string }, [string]>(
      'SELECT hash FROM fed_roster WHERE replica = ?'
    )
    .all(replica)
    .some((r) => view.resolution.has(r.hash));
}

// The value, or null when computing it throws (hostile input).
function orNull<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}

function evidenceOf(
  verified: Map<string, Verified>,
  view: RosterView
): Evidence {
  const evidence: Evidence = { runs: new Map(), agents: new Map() };
  for (const [replica, v] of verified)
    for (const { entry } of v.entries) {
      // FW-R32(5): only a replica standing at its op makes a claim.
      if (isStub(entry) || !standsAt(view, replica, entry.seq)) continue;
      const body = entry.body as Record<string, unknown> | undefined;
      if (body === undefined) continue;
      if (
        entry.type === 'presence' &&
        body['kind'] === 'run' &&
        typeof body['run'] === 'string'
      ) {
        const claims = evidence.runs.get(body['run']) ?? [];
        if (!claims.includes(replica)) claims.push(replica);
        evidence.runs.set(body['run'], claims);
      } else if (entry.type === 'agent' && typeof body['address'] === 'string')
        evidence.agents.set(body['address'], replica);
    }
  return evidence;
}

/** Whether `replica` stood in the team at its op `seq`: a member that is no
 *  observer, or a revoked one at or below its cut. */
export function standsAt(
  view: RosterView,
  replica: string,
  seq: number
): boolean {
  const cut = view.revoked.get(replica);
  if (cut !== undefined) return seq <= cut.afterSeq && !cut.observer;
  const m = view.members.get(replica);
  return m !== undefined && !m.observer;
}
