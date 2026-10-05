import { checkLinkPayload, sealableLinkPayload } from '@dispatch/a2a';
import type { LinkPayload } from '@dispatch/a2a';
import type { JsonValue } from '@dispatch/protocol';
import {
  aheadOfClock,
  buildOp,
  canonicalize,
  hlcWallMs,
  isStub,
  MAX_CLOCK_LEAD_MS,
  OpClock,
  openPayload,
  opHash,
  sealPayload,
  stubOf,
  TAG,
  verifyEntry,
  verifyText,
  ZERO_HASH,
} from '@dispatch/protocol/federation';
import type {
  ChainHead,
  FederatedOp,
  LogEntry,
} from '@dispatch/protocol/federation';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { defaultAsyncGitRunner } from '../../sync/worktree.js';
import type { AsyncGitRunner } from '../../sync/worktree.js';
import { SyncRepo } from '../boardSync/repo.js';
import type { SignedAcks } from '../boardSync/repo.js';
import { GitFederationTransport, signedEntry } from '../federation/git.js';
import { TransportOffline } from '../federation/transport.js';
import type { TransportHealth } from '../federation/transport.js';
import { LinkStore } from './store.js';
import type { LinkProblem } from './store.js';

/** Fresh bytes one link reads a pass: its share, so a bloated link branch
 *  cannot take the team's budget (spec "Hostile mailbox"). */
export const LINK_READ_BYTES = 6 * 1024 * 1024;

interface LinkSpec {
  id: string;
  remote: string;
  branch: string;
}

/** The peer's link keys, decided once the pairing verified its binding. */
export interface LinkPeer {
  signPub: string;
  sealPub: string;
}

export interface LinkKeys {
  signPriv: string;
  signPub: string;
  sealPriv: string;
  sealPub: string;
}

export interface LinkServiceDeps {
  /** This link's own directory: its clone and its state file. */
  dir: string;
  link: LinkSpec;
  keys: LinkKeys;
  /** Null until the pairing has verified the peer's binding (FW-R31(2)). */
  peer: () => LinkPeer | null;
  /** Whether the pairing is complete. */
  paired: () => boolean;
  /** Hands over one verified, opened, validated payload; 'parked' retries it
   *  next pass. Runs only once the link is ready (FW-R32(7)). */
  deliver: (
    payload: LinkPayload,
    from: { replica: string; seq: number }
  ) => 'applied' | 'parked';
  now: () => Date;
  git?: AsyncGitRunner;
  readBytes?: number;
}

export type PublishResult = 'published' | 'waiting' | 'refused' | 'oversize';

/** A link replica id: stable for a link sign key, and valid for federation. */
export function linkReplicaId(signPub: string): string {
  const h = createHash('sha256').update(signPub).digest('hex').slice(0, 8);
  return `a2a-${h}`;
}

// The newest timestamp a payload claims, for the one-sided hlc rule (FW-R32(1)).
function payloadTime(p: LinkPayload): number | null {
  const at = (v: unknown) => (typeof v === 'string' ? Date.parse(v) : NaN);
  let t = NaN;
  if (p.kind === 'unpair') t = at(p.at);
  else if (p.kind === 'key-change') t = at(p.statement.at);
  else if (p.kind === 'event') {
    const e = p.event as Record<string, { status?: { timestamp?: unknown } }>;
    t = at(
      e['statusUpdate']?.status?.timestamp ?? e['task']?.status?.timestamp
    );
  }
  return Number.isFinite(t) ? t : null;
}

// One teammate link over a git branch: both sides publish signed ops to their
// own files, a2a ops sealed to the other side, and read the other's through
// the federation's hardened, budgeted reader. Peer ops are accepted only on
// their chain from the cursor, and every verified hash is kept forever, so a
// line the publisher later forks or rewrites never passes (FW-R36, FW-R37).
export class LinkService {
  readonly replica: string;
  private readonly store: LinkStore;
  private readonly repo: SyncRepo;
  private readonly transport: GitFederationTransport;
  private readonly clock: OpClock;
  private ensured = false;
  private reached = false;
  private fresh: FederatedOp[] = [];

  constructor(private readonly deps: LinkServiceDeps) {
    mkdirSync(deps.dir, { recursive: true });
    this.replica = linkReplicaId(deps.keys.signPub);
    this.store = new LinkStore(join(deps.dir, 'link.db'), deps.now);
    this.clock = new OpClock(this.replica, this.store.getMeta('hlc'), () =>
      deps.now().getTime()
    );
    this.repo = new SyncRepo(
      join(deps.dir, 'repo'),
      deps.link.remote,
      deps.link.branch,
      this.replica,
      deps.git ?? defaultAsyncGitRunner
    );
    this.transport = new GitFederationTransport({
      repo: this.repo,
      replica: this.replica,
      signPriv: deps.keys.signPriv,
      verifyAcks: (a) => this.verifyAcks(a),
      acknowledgedBy: (op, acks) => {
        const peer = this.peerReplica();
        return (
          peer !== null &&
          (acks.get(peer)?.through[this.replica] ?? 0) >= op.seq
        );
      },
      ownLog: () => this.store.ownLog(),
      onPruned: (seqs) => {
        const pruned = new Set(seqs);
        this.store.stubOwn(
          this.store
            .ownLog()
            .filter((e) => pruned.has(e.seq) && !isStub(e))
            .map((e) => stubOf(e as FederatedOp))
        );
      },
      readHints: () => this.readHints(),
      onRewriteSelf: () =>
        this.store.problem(
          'transport:rewrite:self',
          "someone with push access changed this side's own files on the link branch; Dispatch wrote them afresh from this side's log"
        ),
      onRewritten: (rs) => {
        for (const r of rs)
          this.store.problem(
            `transport:rewrite:${r}`,
            `${r}'s files on the link branch were rewritten rather than appended to`
          );
      },
      onOversized: (files) => {
        for (const f of files)
          this.store.problem(
            `transport:bloat:${f}`,
            `${f} on the link branch is far over a segment's size; only this link's read share is spent on it`
          );
      },
      onReset: (why) =>
        this.store.problem(
          'transport:reset',
          `the link branch could not merge; Dispatch took it as the remote holds it (${why.slice(0, 200)})`
        ),
      now: deps.now,
    });
  }

  close(): void {
    this.store.close();
  }

  problems(): LinkProblem[] {
    return this.store.problems();
  }

  /** The link transport's health: last exchange, error and bytes read. */
  health(): TransportHealth {
    return this.transport.health();
  }

  /** The peer's link replica id, once its keys are decided. */
  peerReplica(): string | null {
    const peer = this.deps.peer();
    return peer === null ? null : linkReplicaId(peer.signPub);
  }

  /** Paired, the peer's keys decided, and the branch reached once (FW-R32(7)). */
  linkReady(): boolean {
    return this.deps.paired() && this.deps.peer() !== null && this.reached;
  }

  /** Validates a payload as a receiver would, then seals it to the peer, or
   *  keeps it in the local outbox until the link is ready (FW-R31(4)). */
  publish(payload: LinkPayload): PublishResult {
    const checked = checkLinkPayload(JSON.parse(JSON.stringify(payload)));
    if (!checked.ok) return 'refused';
    if (sealableLinkPayload(checked.payload) === 'oversize') return 'oversize';
    if (!this.linkReady()) {
      return this.store.queue(JSON.stringify(checked.payload))
        ? 'waiting'
        : 'refused';
    }
    this.sealAndAppend(checked.payload);
    return 'published';
  }

  /** Payloads still waiting for the link to be ready. */
  waiting(): number {
    return this.store.outbox().length;
  }

  /** One exchange: publish, read the peer's chain, deliver, then ack. */
  async sync(): Promise<void> {
    if (!this.ensured) {
      await this.repo.ensure();
      this.ensured = true;
    }
    if (this.store.ownHead() === null)
      this.append({ type: 'key', body: { link: this.deps.link.id } });
    let entries: LogEntry[];
    try {
      await this.transport.publish(this.takeFresh());
      entries = await this.transport.pull(this.watermarks());
    } catch (err) {
      if (!(err instanceof TransportOffline)) throw err;
      this.store.problem(
        'transport:offline',
        `the link branch could not be reached: ${err.message.slice(0, 200)}`
      );
      return;
    }
    this.store.clearProblem('transport:offline');
    this.reached = true;
    if (this.linkReady()) this.drainOutbox();
    this.read(entries);
    if (this.fresh.length > 0) await this.transport.publish(this.takeFresh());
    const peer = this.peerReplica();
    const cursor = peer === null ? null : this.store.cursor(peer);
    await this.transport.ack(
      new Map(peer === null || cursor === null ? [] : [[peer, cursor.seq]])
    );
  }

  private takeFresh(): FederatedOp[] {
    return this.fresh.splice(0);
  }

  private watermarks(): Map<string, number> {
    const peer = this.peerReplica();
    if (peer === null) return new Map();
    // From the head itself, so a rewrite of it is seen (FW-R36).
    const c = this.store.cursor(peer);
    return new Map([[peer, Math.max(0, (c?.seq ?? 0) - 1)]]);
  }

  private readHints() {
    const peer = this.deps.peer();
    const peerId = this.peerReplica();
    const c = peerId === null ? null : this.store.cursor(peerId);
    const budget = this.deps.readBytes ?? LINK_READ_BYTES;
    const heads = new Map<string, string>();
    if (peerId !== null && c !== null && c.hash !== '')
      heads.set(peerId, c.hash);
    return {
      budget,
      totalBudget: budget,
      heads,
      tier: (r: string) => (r === this.replica || r === peerId ? 0 : 2),
      maxUnknown: 1,
      signedBy: (e: LogEntry) => peer !== null && signedEntry(e, peer.signPub),
    };
  }

  private verifyAcks(a: SignedAcks): boolean {
    const peer = this.deps.peer();
    if (peer === null || a.replica !== this.peerReplica()) return false;
    const { sig, ...body } = a;
    return verifyText(peer.signPub, `${TAG.ack}\n${canonicalize(body)}`, sig);
  }

  private append(fields: {
    type: 'key' | 'a2a';
    body?: JsonValue;
    seal?: (seq: number) => Pick<FederatedOp, 'to' | 'sealed'>;
  }): FederatedOp {
    const head = this.store.ownHead();
    const seq = (head?.seq ?? 0) + 1;
    const hlc = this.clock.tick();
    this.store.setMeta('hlc', hlc);
    const sealed = fields.seal?.(seq);
    const op = buildOp(
      {
        replica: this.replica,
        seq,
        prev: head === null ? ZERO_HASH : opHash(head),
        hlc,
        type: fields.type,
        ...(fields.body === undefined ? {} : { body: fields.body }),
        ...(sealed === undefined
          ? {}
          : { to: sealed.to, sealed: sealed.sealed }),
      },
      this.deps.keys.signPriv
    );
    this.store.appendOwn(op);
    this.fresh.push(op);
    return op;
  }

  private sealAndAppend(payload: LinkPayload): void {
    const peer = this.deps.peer();
    const peerId = this.peerReplica();
    if (peer === null || peerId === null) return;
    this.append({
      type: 'a2a',
      seal: (seq) =>
        sealPayload({
          replica: this.replica,
          seq,
          type: 'a2a',
          payload: payload as unknown as JsonValue,
          recipients: new Map([[peerId, peer.sealPub]]),
        }),
    });
  }

  private drainOutbox(): void {
    for (const row of this.store.outbox()) {
      this.sealAndAppend(JSON.parse(row.payloadJson) as LinkPayload);
      this.store.dequeue(row.id);
    }
  }

  // Walks the peer's chain from the cursor. Entries are hints: only the one
  // that verifies on the head is followed. A signed line that differs from a
  // kept hash, or a second signed child of one op, is a fork and halts.
  private read(entries: readonly LogEntry[]): void {
    const peer = this.deps.peer();
    const peerId = this.peerReplica();
    if (peer === null || peerId === null) return;
    this.listRivals(entries, peerId, peer.signPub);
    const signed = entries.filter(
      (e) => e.replica === peerId && signedEntry(e, peer.signPub)
    );
    const cursor = this.store.cursor(peerId);
    if (cursor !== null && cursor.halted !== null) return;
    for (const e of signed) {
      const kept = this.store.kept(peerId, e.seq);
      if (kept !== null && kept !== opHash(e))
        return this.fork(
          peerId,
          `seq ${e.seq} differs from the op read before`
        );
    }
    if (!this.deps.paired()) return;
    let head: ChainHead | null =
      cursor === null
        ? null
        : { seq: cursor.seq, hash: cursor.hash, hlc: cursor.hlc };
    // Parked ops go first, each still matching its kept hash (FW-R37).
    for (const op of this.store.parked(peerId)) {
      const done = this.deliverOp(peer, op);
      if (done === 'parked' || done === 'held') return;
      this.store.release(peerId, op.seq);
    }
    for (;;) {
      const next = signed.filter((e) =>
        head === null
          ? e.type === 'key' && e.prev === ZERO_HASH
          : e.prev === head.hash
      );
      const distinct = new Set(next.map((e) => opHash(e)));
      if (distinct.size > 1)
        return this.fork(peerId, `two ops follow seq ${head?.seq ?? 0}`);
      const e = next[0];
      if (e === undefined) return;
      const checked = verifyEntry(head, e, peer.signPub);
      if (!checked.ok)
        return this.fork(
          peerId,
          `seq ${e.seq} breaks the chain: ${checked.reason}`
        );
      this.store.keep(peerId, e.seq, opHash(e));
      // FW-R21: an op far ahead of this clock waits, and the ops behind it.
      if (aheadOfClock(e.hlc, this.deps.now().getTime())) {
        this.store.problem(
          `link-clock:${peerId}`,
          `the other side's op at seq ${e.seq} is stamped more than 5 minutes ahead of this machine's clock; it waits until the clock catches up`
        );
        return;
      }
      this.store.clearProblem(`link-clock:${peerId}`);
      this.clock.observe(e.hlc);
      if (e.type === 'a2a' && !isStub(e)) {
        const done = this.deliverOp(peer, e);
        if (done === 'held') return;
        if (done === 'parked' && !this.store.park(e)) {
          this.store.problem(
            `link-park:${peerId}`,
            `too many of the other side's ops are waiting; seq ${e.seq} waits on the branch`
          );
          return;
        }
      } else if (isStub(e) && e.to?.includes(this.replica) === true) {
        this.store.problem(
          `link-pruned:${peerId}`,
          `the other side's op at seq ${e.seq} was pruned before this side read it`
        );
      }
      this.store.advance(peerId, { seq: e.seq, hash: opHash(e), hlc: e.hlc });
      head = { seq: e.seq, hash: opHash(e), hlc: e.hlc };
    }
  }

  // Opens, validates and hands over one a2a op. 'held' leaves the cursor on
  // it: a payload claiming a time past its op's hlc or now (FW-R32(1)).
  private deliverOp(
    peer: LinkPeer,
    op: FederatedOp
  ): 'applied' | 'parked' | 'dropped' | 'held' {
    const peerId = linkReplicaId(peer.signPub);
    let opened: JsonValue | null = null;
    try {
      opened = openPayload(op, this.replica, this.deps.keys.sealPriv);
    } catch {
      opened = null;
    }
    const checked = opened === null ? null : checkLinkPayload(opened);
    if (checked === null || !checked.ok) {
      const why =
        checked === null
          ? 'could not be opened'
          : `is not valid: ${checked.problem}`;
      this.store.problem(
        `link-drop:${this.deps.link.id}`,
        `the other side's op at seq ${op.seq} ${why}; it was dropped`
      );
      return 'dropped';
    }
    const claimed = payloadTime(checked.payload);
    const opMs = hlcWallMs(op.hlc) ?? 0;
    const nowMs = this.deps.now().getTime();
    if (
      claimed !== null &&
      (claimed > opMs + MAX_CLOCK_LEAD_MS ||
        claimed > nowMs + MAX_CLOCK_LEAD_MS)
    ) {
      this.store.problem(
        `link-clock:${peerId}`,
        `the other side's op at seq ${op.seq} carries a time ahead of its own stamp or this clock; it waits`
      );
      return 'held';
    }
    if (!this.linkReady()) return 'parked';
    return this.deps.deliver(checked.payload, { replica: peerId, seq: op.seq });
  }

  // FW-R24: a key op on the branch that the pinned link key did not sign is a
  // rival claim. It is listed, never followed, and the honest chain goes on.
  private listRivals(
    entries: readonly LogEntry[],
    peerId: string,
    signPub: string
  ): void {
    const rivals = entries.filter(
      (e) =>
        e.type === 'key' &&
        e.replica !== this.replica &&
        !(e.replica === peerId && signedEntry(e, signPub))
    );
    if (rivals.length === 0) return;
    this.store.problem(
      `link-rival:${this.deps.link.id}`,
      `a key op on the link branch (${rivals
        .map((e) => e.replica)
        .slice(0, 3)
        .join(', ')}) is not signed by the paired link key; it is ignored`
    );
  }

  private fork(peerId: string, why: string): void {
    this.store.halt(peerId, why);
    this.store.problem(
      `link-fork:${this.deps.link.id}`,
      `the other side's log on the link branch forked (${why}); this link stopped reading it. Unpair and pair again once the other side is checked.`,
      false
    );
  }
}
