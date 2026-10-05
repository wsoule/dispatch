import { foldRoster, verifyLog } from '@dispatch/federation';
import type {
  KeyInfo,
  PinnedKey,
  RosterOpRef,
  RosterView,
} from '@dispatch/federation';
import {
  fingerprint,
  isStub,
  opHash,
  stubOf,
  verifyText,
} from '@dispatch/protocol/federation';
import type {
  FederatedOp,
  KeyBody,
  LogEntry,
  RosterBody,
} from '@dispatch/protocol/federation';
import type { ServerWebSocket } from 'bun';

import { relayAuthText } from '../../../src/team/federation/relay.js';
import type { RelayFrame } from '../../../src/team/federation/relay.js';

// The in-repo fake relay (Task 22): the frame contract of
// docs/specs/2026-10-05-sealed-relay-contract.md over Bun.serve, with
// @dispatch/federation's verifyLog and foldRoster. Tests only.

const OP_MAX_BYTES = 1024 * 1024;
const OPS_PER_MINUTE = 1000;
const PENDING_PER_TEAM_MINUTE = 10;
const PENDING_PER_SOURCE_MINUTE = 3;
const RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const OPS_PER_FRAME = 1000;
const MINUTE = 60_000;

interface Conn {
  nonce: string;
  dialed: string;
  source: string;
  replica: string | null;
  status: 'member' | 'pending' | null;
}

export interface FakeRelay {
  /** The base URL clients dial: ws://127.0.0.1:<port>. */
  url: string;
  teamId: string;
  /** What the relay holds for `replica`, in seq order. */
  stored(replica: string): LogEntry[];
  /** The relay's clock, for retention and rate limits. */
  clock: { now: Date };
  stop(): Promise<void>;
}

/** A relay for the founder's team, registered from its `key` and `found`
 *  ops as `POST /v1/teams` would. */
export function startFakeRelay(
  founder: { fed: { ownLog(): LogEntry[] }; clock?: { now: Date } },
  opts: { licensePublicKey?: string | null } = {}
): Promise<FakeRelay> {
  const own = founder.fed.ownLog();
  const key = own.find((e) => e.type === 'key');
  const found = own.find(
    (e) =>
      e.type === 'roster' &&
      !isStub(e) &&
      (e.body as { action?: string } | undefined)?.action === 'found'
  );
  if (key === undefined || found === undefined)
    throw new Error('the founder has no key and found op');
  const teamId = opHash(found).slice(0, 32);
  const relay = new Relay(
    teamId,
    key,
    found,
    opts.licensePublicKey ?? null,
    founder.clock ?? { now: new Date() }
  );
  const server = Bun.serve<Conn>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, srv) {
      const path = new URL(req.url).pathname;
      if (path !== `/v1/teams/${teamId}`)
        return new Response('no such team', { status: 404 });
      const host = req.headers.get('host') ?? '';
      const ok = srv.upgrade(req, {
        data: {
          nonce: crypto.randomUUID(),
          dialed: `ws://${host}`,
          source: srv.requestIP(req)?.address ?? '?',
          replica: null,
          status: null,
        },
      });
      return ok ? undefined : new Response('upgrade failed', { status: 400 });
    },
    websocket: {
      open(ws) {
        send(ws, { t: 'challenge', nonce: ws.data.nonce });
      },
      message(ws, raw) {
        relay.onMessage(ws, typeof raw === 'string' ? raw : raw.toString());
      },
      close(ws) {
        relay.conns.delete(ws);
        relay.announce();
      },
    },
  });
  const url = `ws://127.0.0.1:${String(server.port)}`;
  return Promise.resolve({
    url,
    teamId,
    stored: (r) => relay.stored(r),
    clock: relay.clock,
    stop: async () => {
      for (const ws of relay.conns.keys()) ws.close();
      await server.stop(true);
    },
  });
}

function send(ws: ServerWebSocket<Conn>, frame: RelayFrame): void {
  ws.send(JSON.stringify(frame));
}

class Relay {
  readonly conns = new Map<ServerWebSocket<Conn>, Conn>();
  private readonly logs = new Map<string, LogEntry[]>();
  private readonly acks = new Map<string, Record<string, number>>();
  private readonly firstSeen = new Map<string, number>();
  private readonly invitesUsed = new Map<string, string>();
  private readonly publishTimes = new Map<string, number[]>();
  private readonly pendingTimes: { at: number; source: string }[] = [];
  /** Key ops offered by pending connections, by replica. */
  private readonly offered = new Map<string, LogEntry>();

  constructor(
    private readonly teamId: string,
    private readonly founderKey: LogEntry,
    private readonly found: LogEntry,
    private readonly licensePublicKey: string | null,
    /** The founder's clock in tests, so invites and retention share it. */
    readonly clock: { now: Date }
  ) {
    this.logs.set(founderKey.replica, [founderKey, found]);
  }

  stored(replica: string): LogEntry[] {
    this.retain();
    return [...(this.logs.get(replica) ?? [])];
  }

  onMessage(ws: ServerWebSocket<Conn>, raw: string): void {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(raw) as RelayFrame;
    } catch {
      ws.close();
      return;
    }
    const conn = ws.data;
    if (frame.t === 'auth') {
      this.auth(ws, frame);
      return;
    }
    if (conn.status === null || conn.replica === null) {
      ws.close();
      return;
    }
    if (frame.t === 'publish') {
      const through = this.store(conn, frame.ops);
      send(ws, { t: 'stored', re: frame.id, through });
      this.push(conn.replica);
    } else if (frame.t === 'pull') {
      const all = this.visible(conn, frame.since, frame.replicas);
      send(ws, {
        t: 'ops',
        re: frame.id,
        ops: all.slice(0, OPS_PER_FRAME),
        more: all.length > OPS_PER_FRAME,
      });
    } else if (frame.t === 'ack') {
      if (conn.status === 'member') this.acks.set(conn.replica, frame.through);
      this.retain();
      send(ws, { t: 'acknowledged', re: frame.id });
    }
  }

  // URL-bound auth: the signature covers the URL this socket dialed.
  private auth(
    ws: ServerWebSocket<Conn>,
    frame: Extract<RelayFrame, { t: 'auth' }>
  ): void {
    const conn = ws.data;
    const refuse = (reason: string): void => {
      send(ws, { t: 'refused', reason });
      ws.close();
    };
    const offered =
      frame.keyOp !== undefined && frame.keyOp.replica === frame.replica
        ? keyOf(frame.keyOp)
        : null;
    const held = this.logs.get(frame.replica)?.[0];
    const key = (held === undefined ? null : keyOf(held)) ?? offered;
    if (key === null) return refuse('unknown machine');
    const text = relayAuthText(conn.dialed, this.teamId, conn.nonce);
    if (!verifyText(key.signPub, text, frame.sig))
      return refuse('the signature does not cover this relay');
    const view = this.fold(
      held === undefined && frame.keyOp !== undefined
        ? new Map([[frame.replica, frame.keyOp]])
        : new Map()
    );
    if (view === null) return refuse('the team does not read');
    if (view.revoked.has(frame.replica)) return refuse('revoked');
    conn.replica = frame.replica;
    if (view.members.has(frame.replica)) {
      conn.status = 'member';
    } else {
      // A pending machine only with an unexpired, unused invite proof.
      const proof = (frame.keyOp as FederatedOp | undefined)?.body as
        | KeyBody
        | undefined;
      const invite =
        proof?.invite === undefined
          ? undefined
          : view.invites.get(proof.invite.id);
      const now = this.clock.now.getTime();
      if (
        invite === undefined ||
        !view.invitedBy.has(frame.replica) ||
        Date.parse(invite.expires) <= now
      )
        return refuse('not admitted, and no invite');
      const usedBy =
        proof?.invite === undefined
          ? undefined
          : this.invitesUsed.get(proof.invite.id);
      if (usedBy !== undefined && usedBy !== frame.replica)
        return refuse('the invite was used');
      const recent = this.pendingTimes.filter((p) => now - p.at < MINUTE);
      if (
        recent.length >= PENDING_PER_TEAM_MINUTE ||
        recent.filter((p) => p.source === conn.source).length >=
          PENDING_PER_SOURCE_MINUTE
      )
        return refuse('too many joins; try again in a minute');
      this.pendingTimes.push({ at: now, source: conn.source });
      if (proof?.invite !== undefined)
        this.invitesUsed.set(proof.invite.id, frame.replica);
      if (frame.keyOp !== undefined)
        this.offered.set(frame.replica, frame.keyOp);
      conn.status = 'pending';
    }
    this.conns.set(ws, conn);
    send(ws, { t: 'ready' });
    this.announce();
  }

  // Stores a connection's own ops after its head, verified; a pending
  // machine stores only its key op. Answers the highest seq held.
  private store(conn: Conn, ops: readonly LogEntry[]): number {
    const replica = conn.replica ?? '';
    const log = this.logs.get(replica) ?? [];
    const now = this.clock.now.getTime();
    const times = (this.publishTimes.get(replica) ?? []).filter(
      (t) => now - t < MINUTE
    );
    const switchedAt = this.transportHlc();
    const mine = ops
      .filter((e) => e.replica === replica)
      .filter((e) => conn.status === 'member' || e.type === 'key')
      .sort((a, b) => a.seq - b.seq);
    for (const e of mine) {
      if (log.some((h) => h.seq === e.seq)) continue;
      if (Buffer.byteLength(JSON.stringify(e)) > OP_MAX_BYTES) break;
      // The switch-over upload (ops before the relay switch) is not limited.
      const exempt = switchedAt !== null && e.hlc < switchedAt;
      if (!exempt && times.length >= OPS_PER_MINUTE) break;
      const head = log.at(-1);
      const pinned = log[0] === undefined ? null : pinnedOf(log[0]);
      const r = verifyLog(
        replica,
        [e],
        {
          head:
            head === undefined
              ? null
              : { seq: head.seq, hash: opHash(head), hlc: head.hlc },
          halted: null,
        },
        pinned
      );
      if (r.accepted.length === 0) break;
      log.push(e);
      if (!exempt) times.push(now);
      if (!this.firstSeen.has(`${replica}:${e.seq}`))
        this.firstSeen.set(`${replica}:${e.seq}`, now);
    }
    this.logs.set(replica, log);
    this.publishTimes.set(replica, times);
    return log.at(-1)?.seq ?? 0;
  }

  // What `conn` may read after its marks: a pending machine the founding
  // and its own; a member everything, sealed ops it is not in as stubs.
  private visible(
    conn: Conn,
    since: Record<string, number>,
    only?: readonly string[]
  ): LogEntry[] {
    this.retain();
    const me = conn.replica ?? '';
    const out: LogEntry[] = [];
    for (const [replica, log] of this.logs) {
      if (only !== undefined && !only.includes(replica)) continue;
      for (const e of log) {
        if (e.seq <= (since[replica] ?? 0)) continue;
        if (conn.status === 'pending') {
          if (e === this.founderKey || e === this.found) out.push(e);
          continue;
        }
        const sealedTo = (e as FederatedOp).to;
        out.push(
          !isStub(e) && sealedTo !== undefined && !sealedTo.includes(me)
            ? stubOf(e)
            : e
        );
      }
    }
    return out;
  }

  // Tells every member connection other than the publisher that ops arrived.
  private push(from: string): void {
    for (const [ws, c] of this.conns)
      if (c.status === 'member' && c.replica !== from)
        send(ws, { t: 'ops', ops: [] });
  }

  announce(): void {
    const online = [...this.conns.values()]
      .filter((c) => c.status === 'member' && c.replica !== null)
      .map((c) => ({
        replica: c.replica ?? '',
        since: this.clock.now.toISOString(),
      }));
    for (const ws of this.conns.keys()) send(ws, { t: 'presence', online });
  }

  // Retention: mail and state become stubs once every admitted recipient
  // acknowledged them (the rest count as acknowledged), or after 30 days;
  // presence keeps only its latest op per run and per replica.
  private retain(): void {
    const view = this.fold(new Map());
    const now = this.clock.now.getTime();
    for (const [replica, log] of this.logs)
      for (let i = 0; i < log.length; i++) {
        const e = log[i];
        if (e === undefined || isStub(e)) continue;
        if (e.type !== 'mail' && e.type !== 'state') continue;
        const to = e.to ?? [];
        const acknowledged = to.every(
          (r) =>
            view?.members.has(r) !== true ||
            (this.acks.get(r)?.[replica] ?? 0) >= e.seq
        );
        const old =
          now - (this.firstSeen.get(`${replica}:${e.seq}`) ?? now) > RETAIN_MS;
        if (acknowledged || old) log[i] = stubOf(e);
      }
    // Only the latest presence per run and per replica stays whole.
    for (const log of this.logs.values()) {
      const latest = new Map<string, number>();
      log.forEach((e, i) => {
        if (e.type !== 'presence' || isStub(e)) return;
        const body = e.body as { kind?: string; run?: string } | undefined;
        latest.set(
          body?.kind === 'run' ? `run:${body.run ?? ''}` : 'replica',
          i
        );
      });
      const keep = new Set(latest.values());
      log.forEach((e, i) => {
        if (e.type === 'presence' && !isStub(e) && !keep.has(i))
          log[i] = stubOf(e);
      });
    }
  }

  // The hlc of the folded roster's transport op naming the relay, if any.
  private transportHlc(): string | null {
    const clocks: string[] = [];
    for (const log of this.logs.values())
      for (const e of log)
        if (
          e.type === 'roster' &&
          !isStub(e) &&
          (e.body as RosterBody | undefined)?.action === 'transport' &&
          (e.body as { kind?: string }).kind === 'relay'
        )
          clocks.push(e.hlc);
    return clocks.sort()[0] ?? null;
  }

  // The roster as the relay folds it: every stored roster op with its
  // signer, every stored or offered key op as a claim; never paused.
  private fold(extra: ReadonlyMap<string, LogEntry>): RosterView | null {
    const claims = new Map<string, KeyInfo[]>();
    const ops: RosterOpRef[] = [];
    const keyed = new Map<string, LogEntry>(extra);
    for (const [replica, log] of this.logs) {
      const k = log[0];
      if (k !== undefined) keyed.set(replica, k);
      for (const e of log)
        if (e.type === 'roster' && !isStub(e))
          ops.push({
            replica,
            seq: e.seq,
            hlc: e.hlc,
            hash: opHash(e),
            body: e.body as RosterBody,
            signPub: keyOf(k ?? e)?.signPub ?? '',
          });
    }
    for (const [replica, k] of [...this.offered, ...keyed]) {
      const info = keyOf(k);
      if (info !== null && !claims.has(replica)) claims.set(replica, [info]);
    }
    const founderInfo = keyOf(this.founderKey);
    if (founderInfo === null) return null;
    try {
      return foldRoster({
        founder: { replica: this.founderKey.replica, seq: this.found.seq },
        ops,
        keys: new Map([[this.founderKey.replica, founderInfo]]),
        claims,
        now: this.clock.now,
        licensePublicKey: this.licensePublicKey,
        relay: true,
      });
    } catch {
      return null;
    }
  }
}

// A key op's claim, or null when it is no key op.
function keyOf(e: LogEntry): KeyInfo | null {
  if (e.type !== 'key' || isStub(e)) return null;
  const body = e.body as KeyBody | undefined;
  if (body === undefined) return null;
  return {
    replica: e.replica,
    handle: body.handle,
    signPub: body.signPub,
    fingerprint: fingerprint(body.signPub, body.sealPub),
    ...(body.invite === undefined ? {} : { invite: body.invite }),
  };
}

function pinnedOf(e: LogEntry): PinnedKey | null {
  if (isStub(e)) return null;
  const body = e.body as KeyBody | undefined;
  if (body === undefined) return null;
  return {
    replica: e.replica,
    handle: body.handle,
    device: body.device,
    build: body.build,
    signPub: body.signPub,
    sealPub: body.sealPub,
    fingerprint: fingerprint(body.signPub, body.sealPub),
    keySeq: e.seq,
    legacy: body.legacy,
  };
}
