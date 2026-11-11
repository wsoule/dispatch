import { readHubFile, verifyHub } from '@dispatch-foo/core';
import type { HubFileInfo } from '@dispatch-foo/core';
import {
  applyLinkMail,
  applyLinkState,
  LoopbackLink,
  SYSTEM_ADDRESS,
} from '@dispatch-foo/protocol';
import type {
  AgentRecord,
  DeliveryEngine,
  FederationHooks,
  GateData,
  LinkHttpRequest,
  LinkHttpResponse,
  LinkMail,
  LinkState,
  Message,
  MessageStore,
  Placement,
} from '@dispatch-foo/protocol';
import { OpClock } from '@dispatch-foo/protocol/federation';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { registrationKey } from './gates.js';

// The project daemon's side of its link to the machine hub, the process that
// homes every MCP session on this machine. The two exchange mail as replicas
// over loopback (@dispatch-foo/protocol's LoopbackLink). The hub's agents are
// mirrored here as rows no token matches (`hub:` hashes), each placed at the
// hub; a client new to this project waits on the project's own approval gate,
// and its sessions are approved here only once it is.

const HUB_ROW = 'hub:';
// Cheap (one small file read while linked), and a hub a session just
// started is linked within seconds.
const POLL_MS = 5000;

// The request headers a forwarded web request keeps; `authorization` and
// `cookie` above all are dropped and replaced by the web credential.
const FORWARDED_HEADERS = [
  'accept',
  'content-type',
  'if-match',
  'if-none-match',
];
const FORWARD_TIMEOUT_MS = 50_000;
// The team link carries a reply in one frame of at most 4 MiB, and base64
// grows it by a third: a larger answer would drop the machine's link.
const MAX_FORWARD_REPLY_BYTES = 2.5 * 1024 * 1024;

/** Whether `agent` is a mirror of one of the hub's agents. */
export function isHubRow(agent: AgentRecord): boolean {
  return agent.tokenHash.startsWith(HUB_ROW);
}

/** Whether a replica id is a machine hub's, which team code never ships to. */
export function isHubReplica(replica: string): boolean {
  return replica.startsWith('@hub-');
}

/** One agent as the hub's roster describes it. */
interface HubAgent {
  address: string;
  displayName: string;
  client: string;
  status: string;
  parent?: string;
  meta?: Record<string, string>;
  lastSeen?: string;
}

// This project's replica id and clock with no team: kept beside its sync
// state, `@` keeping it apart from team replica ids.
class LocalIdentity {
  readonly replica: string;
  private readonly clock: OpClock;

  constructor(private readonly path: string) {
    let stored: { replica?: string; hlc?: string } = {};
    if (existsSync(path)) {
      try {
        stored = JSON.parse(readFileSync(path, 'utf8')) as typeof stored;
      } catch {
        stored = {};
      }
    }
    this.replica =
      typeof stored.replica === 'string'
        ? stored.replica
        : `@local-${randomBytes(4).toString('hex')}`;
    this.clock = new OpClock(
      this.replica,
      typeof stored.hlc === 'string' ? stored.hlc : null
    );
    this.save();
  }

  tick(): string {
    const hlc = this.clock.tick();
    this.save();
    return hlc;
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    writeFileSync(
      this.path,
      JSON.stringify({ replica: this.replica, hlc: this.clock.last }),
      { mode: 0o600 }
    );
  }
}

export interface HubLinkDeps {
  rootDir: string;
  /** Where this project keeps its no-team identity (its projects/<key>). */
  stateDir: string;
  /** The project's message store, once messaging has opened it. */
  messages: () => MessageStore;
  /** The team's hooks when this project federates with teammates. */
  team: FederationHooks | null;
  /** The project owner, who decides registration gates. */
  owner: string;
  /** Whether a hub client new to this project is approved without asking
   *  (`messaging.approveMachineAgents: auto`); read each time. */
  autoApprove?: () => boolean;
}

export class DaemonHubLink {
  /** The token the hub presents on /api/hub-link/*. */
  readonly token = randomBytes(32).toString('hex');
  // What a request forwarded from the web (through the hub, from the team
  // service) is replayed with: it speaks for the operator at the decide tier
  // only (identity.ts), so the web never reaches a shell, a file write or
  // the daemon's own controls. Never leaves this process.
  private readonly webToken = `dsw_${randomBytes(32).toString('hex')}`;
  private readonly webDigest = createHash('sha256')
    .update(this.webToken)
    .digest();
  private readonly local: LocalIdentity | null;
  private engine: DeliveryEngine | null = null;
  private port = 0;
  private hub: { id: string; replica: string; token: string } | null = null;
  private link: LoopbackLink | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  // Null until the hub's first roster arrives: mirroring an empty roster
  // would drop every session row, revocations included.
  private lastRoster: HubAgent[] | null = null;
  private linking = false;

  constructor(private readonly deps: HubLinkDeps) {
    this.local =
      deps.team === null
        ? new LocalIdentity(join(deps.stateDir, 'hub-link.json'))
        : null;
  }

  /** This project's replica id on the link. */
  get replica(): string {
    return this.deps.team?.replica ?? this.local!.replica;
  }

  /** The linked hub's replica id, or null while unlinked. */
  get hubReplica(): string | null {
    return this.hub?.replica ?? null;
  }

  /** Hooks for the engine: hub-homed agents placed at the hub, the rest as
   *  the team's hooks (or, with no team, here). */
  hooks(): FederationHooks {
    const team = this.deps.team;
    return {
      replica: this.replica,
      hlc: () => team?.hlc() ?? this.local!.tick(),
      placement: (target, message, replyTarget) =>
        this.placement(target, message, replyTarget) ??
        team?.placement(target, message, replyTarget) ?? { kind: 'local' },
      remoteRunTask: (runId) => team?.remoteRunTask(runId) ?? null,
      label: (replica) =>
        isHubReplica(replica)
          ? "this machine's Dispatch hub"
          : (team?.label(replica) ?? replica),
      problem: (subject, text) =>
        team === null
          ? console.error(`dispatchd: hub link: ${subject}: ${text}`)
          : team.problem(subject, text),
    };
  }

  /** Starts linking once the engine exists and the daemon listens on `port`. */
  start(engine: DeliveryEngine, port: number): void {
    this.engine = engine;
    this.port = port;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.link?.stop();
    this.link = null;
  }

  /** Whether `presented` is the token this daemon gave the hub. */
  authorizes(presented: string): boolean {
    const a = Buffer.from(presented);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** Whether a presented token's digest is the web credential. */
  webMatches(digest: Buffer): boolean {
    return (
      digest.length === this.webDigest.length &&
      timingSafeEqual(digest, this.webDigest)
    );
  }

  /**
   * Replays one request the hub forwarded from the web on this daemon's own
   * API, with the web credential. Only `/api/` paths, and never the hub
   * link's own routes, so a forwarded request cannot pose as the hub.
   */
  async forward(body: unknown): Promise<LinkHttpResponse> {
    const req = body as Partial<LinkHttpRequest>;
    const path = typeof req.path === 'string' ? req.path : '';
    const method = typeof req.method === 'string' ? req.method : 'GET';
    if (
      !path.startsWith('/api/') ||
      path.startsWith('/api/hub-link') ||
      this.port === 0
    )
      return webAnswer(404, { error: 'not found' });
    const headers = new Headers();
    const given = req.headers ?? {};
    for (const name of FORWARDED_HEADERS) {
      const value = given[name];
      if (typeof value === 'string') headers.set(name, value);
    }
    headers.set('authorization', `Bearer ${this.webToken}`);
    const bytes =
      typeof req.body === 'string' && req.body !== ''
        ? Buffer.from(req.body, 'base64')
        : null;
    const res = await fetch(`http://127.0.0.1:${String(this.port)}${path}`, {
      method,
      headers,
      ...(bytes === null || method === 'GET' || method === 'HEAD'
        ? {}
        : { body: bytes }),
      redirect: 'manual',
      signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
    });
    const reply = await readCapped(res, MAX_FORWARD_REPLY_BYTES);
    if (reply === null)
      return webAnswer(413, {
        error: 'That answer is too large to send to the web.',
      });
    const out: Record<string, string> = {};
    res.headers.forEach((value, name) => {
      if (name !== 'set-cookie') out[name] = value;
    });
    return {
      status: res.status,
      headers: out,
      body: Buffer.from(reply).toString('base64'),
    };
  }

  /**
   * Whether this machine's hub lets the web reach its projects, or null when
   * no hub runs; `enabled` sets it first. A machine-wide switch, kept by the
   * hub (desktop's Settings, This machine).
   */
  async webAccess(enabled?: boolean): Promise<boolean | null> {
    const file = readHubFile();
    if (file === null) return null;
    try {
      const res = await fetch(
        `http://127.0.0.1:${String(file.port)}/api/web-access`,
        {
          method: enabled === undefined ? 'GET' : 'PUT',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${file.token}`,
          },
          ...(enabled === undefined
            ? {}
            : { body: JSON.stringify({ enabled }) }),
          signal: AbortSignal.timeout(5000),
        }
      );
      if (!res.ok) return null;
      return ((await res.json()) as { enabled?: unknown }).enabled === true;
    } catch {
      return null;
    }
  }

  /** Handles one /api/hub-link/<kind> call from the hub. */
  async receive(kind: string, body: unknown): Promise<unknown> {
    const engine = this.engine;
    const link = this.link;
    const hub = this.hub;
    if (kind === 'agents') {
      const agents = (body as { agents?: unknown }).agents;
      if (Array.isArray(agents)) await this.mirror(agents as HubAgent[]);
      return { ok: true };
    }
    if (engine === null || link === null || hub === null)
      throw new Error('not linked to the hub');
    if (kind === 'mail') {
      // The hub speaks only for the agents it homes: mail from anyone else
      // (a person, a run, an agent of this project) is refused.
      const from = (body as { message?: { from?: unknown } }).message?.from;
      if (!hubMaySpeakFor(this.deps.messages(), from)) {
        const id = (body as { message?: { id?: unknown } }).message?.id;
        if (typeof id === 'string')
          link.refused(id, `the hub does not speak for ${String(from)}`);
        return { status: 'refused' };
      }
      const result = await applyLinkMail(
        engine,
        link,
        hub.replica,
        body as LinkMail
      );
      return { status: result.status };
    }
    if (kind === 'state') {
      applyLinkState(
        engine,
        this.deps.messages(),
        hub.replica,
        body as LinkState
      );
      return { ok: true };
    }
    throw new Error(`no hub link route ${kind}`);
  }

  // Hub-homed agents go to the hub, linked or not: their mail waits as
  // forwarded until the link is up. Anything else is not this hook's call.
  private placement(
    target: { recipient: string },
    _message: Message,
    _replyTarget: Message | null
  ): Placement | null {
    if (!target.recipient.startsWith('agent:')) return null;
    const row = this.deps.messages().getAgent(target.recipient);
    if (row === null || !isHubRow(row)) return null;
    const hub = this.hubReplica ?? this.lastHubReplica();
    return hub === null
      ? null
      : { kind: 'remote', homes: [hub], alsoLocal: false };
  }

  // The hub replica remote rows already name, so mail placed before this boot
  // linked still has somewhere to go.
  private lastHubReplica(): string | null {
    for (const r of this.deps.messages().remoteDeliveries({}))
      for (const h of r.homes) if (isHubReplica(h)) return h;
    return null;
  }

  // Links when the hub is up and not yet linked (or restarted under a new
  // id), and re-applies the last roster so sessions waiting on a client's
  // approval here are approved once it is.
  private async tick(): Promise<void> {
    if (this.linking) return;
    this.linking = true;
    try {
      const file = readHubFile();
      if (file === null) return;
      if (this.hub?.id !== file.id || this.link === null)
        await this.linkTo(file);
      if (this.lastRoster !== null) await this.mirror(this.lastRoster);
    } finally {
      this.linking = false;
    }
  }

  private async linkTo(file: HubFileInfo): Promise<void> {
    if (this.engine === null || !(await verifyHub(file))) return;
    let answer: { replica: string; token: string };
    try {
      const res = await fetch(
        `http://127.0.0.1:${file.port}/api/link/register`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${file.token}`,
          },
          body: JSON.stringify({
            root: this.deps.rootDir,
            replica: this.replica,
            port: this.port,
            token: this.token,
          }),
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!res.ok) return;
      answer = (await res.json()) as { replica: string; token: string };
    } catch {
      return;
    }
    this.link?.stop();
    this.hub = { id: file.id, replica: answer.replica, token: answer.token };
    const hub = this.hub;
    const link: LoopbackLink = new LoopbackLink({
      engine: this.engine,
      store: this.deps.messages(),
      me: this.replica,
      peer: answer.replica,
      send: async (kind, body) => {
        try {
          const res = await fetch(
            `http://127.0.0.1:${file.port}/api/link/${kind}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                authorization: `Bearer ${hub.token}`,
              },
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(10_000),
            }
          );
          // The hub restarted and forgot this link: retire it and link again
          // next tick, leaving any newer link alone.
          if (res.status === 401) {
            link.stop();
            if (this.link === link) this.link = null;
          }
          return res.ok;
        } catch {
          return false;
        }
      },
    });
    this.link = link;
    link.start();
  }

  // Mirrors the hub's roster: a client new to this project raises the
  // project's registration gate; a session is approved here only while its
  // client is; sessions the hub dropped go.
  private async mirror(agents: HubAgent[]): Promise<void> {
    this.lastRoster = agents;
    const store = this.deps.messages();
    const now = new Date().toISOString();
    const listed = new Set<string>();
    for (const a of agents) {
      if (a.status !== 'approved' || !a.address.startsWith('agent:')) continue;
      listed.add(a.address);
      let existing = store.getAgent(a.address);
      // A session this project knew directly (before the hub, or with the
      // hub off) now lives on the hub: its row becomes a mirror, status kept.
      if (existing !== null && !isHubRow(existing) && a.parent !== undefined) {
        existing = { ...existing, tokenHash: hubTokenHash() };
        store.putAgent(existing);
      }
      if (existing !== null && !isHubRow(existing)) continue;
      if (a.parent === undefined) {
        if (existing !== null) {
          store.putAgent({
            ...existing,
            displayName: a.displayName,
            client: a.client,
          });
          continue;
        }
        await this.raiseGate(a, now);
        continue;
      }
      const parent = store.getAgent(a.parent);
      const status =
        existing?.status === 'revoked'
          ? 'revoked'
          : parent?.status === 'approved'
            ? 'approved'
            : 'pending';
      store.putAgent({
        address: a.address,
        displayName: a.displayName,
        client: a.client,
        tokenHash: existing?.tokenHash ?? hubTokenHash(),
        status,
        muted: (parent?.muted ?? false) || (existing?.muted ?? false),
        approvedBy: status === 'approved' ? a.parent : null,
        createdAt: existing?.createdAt ?? now,
        parent: a.parent,
        ...(a.meta === undefined ? {} : { meta: a.meta }),
        ...(a.lastSeen === undefined ? {} : { lastSeen: a.lastSeen }),
      });
    }
    // A revoked row stays as a tombstone, so a later roster cannot bring it
    // back approved.
    for (const row of store.agents())
      if (
        isHubRow(row) &&
        row.parent !== undefined &&
        row.status !== 'revoked' &&
        !listed.has(row.address)
      )
        store.deleteAgent(row.address);
  }

  // A hub client this project has never seen: a pending row and the same
  // agent-registration gate a direct registration raises.
  private async raiseGate(a: HubAgent, now: string): Promise<void> {
    const engine = this.engine;
    if (engine === null) return;
    const tokenHash = hubTokenHash();
    // The project opted in: the hub serves only this OS user's processes,
    // the same trust as the owner's own terminal, so no question is asked.
    if (this.deps.autoApprove?.() === true) {
      this.deps.messages().putAgent({
        address: a.address,
        displayName: a.displayName,
        client: a.client,
        tokenHash,
        status: 'approved',
        muted: false,
        approvedBy: this.deps.owner,
        createdAt: now,
      });
      console.log(
        `dispatchd: hub link: approved ${a.address} (${a.client}) under messaging.approveMachineAgents: auto`
      );
      return;
    }
    this.deps.messages().putAgent({
      address: a.address,
      displayName: a.displayName,
      client: a.client,
      tokenHash,
      status: 'pending',
      muted: false,
      approvedBy: null,
      createdAt: now,
    });
    try {
      await engine.send(
        {
          to: [this.deps.owner],
          kind: 'question',
          blocking: true,
          choices: ['approve', 'deny'],
          body: `Agent ${a.address} (${a.client}) on this machine's Dispatch hub wants to message this project.`,
          data: {
            type: 'agent-registration',
            agent: a.address,
            client: a.client,
            requestedBy: this.deps.owner,
            key: registrationKey(tokenHash),
          } satisfies GateData,
        },
        { address: SYSTEM_ADDRESS, canDecide: true }
      );
    } catch (err) {
      this.deps.messages().putAgent({
        ...this.deps.messages().getAgent(a.address)!,
        status: 'revoked',
      });
      console.error(
        `dispatchd: hub link: could not ask about ${a.address}: ${(err as Error).message}`
      );
    }
  }
}

/** Whether hub mail may come from `from`: an agent the hub homes (a mirror
 *  row) or a system notice; never a person, a run or this project's agents. */
export function hubMaySpeakFor(store: MessageStore, from: unknown): boolean {
  if (from === SYSTEM_ADDRESS) return true;
  if (typeof from !== 'string') return false;
  const agent = store.getAgent(from);
  return agent !== null && isHubRow(agent);
}

// A mirror row's hash: unique, so its gate key is too, and matching no token.
function hubTokenHash(): string {
  return `${HUB_ROW}${randomBytes(16).toString('hex')}`;
}

function webAnswer(status: number, body: unknown): LinkHttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: Buffer.from(JSON.stringify(body)).toString('base64'),
  };
}

// A response body, or null once it passes `max` bytes (the read stops there,
// so a streaming route is cancelled rather than buffered whole).
async function readCapped(
  res: Response,
  max: number
): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}
