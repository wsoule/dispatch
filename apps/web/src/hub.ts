import {
  applyLinkMail,
  applyLinkState,
  DeliveryEngine,
  LoopbackLink,
  openMessagesDb,
  SqliteMessageStore,
  SYSTEM_ADDRESS,
} from '@dispatch-foo/protocol';
import type {
  AgentRecord,
  FederationHooks,
  LinkMail,
  LinkState,
  MessagingHost,
  Placement,
  PolicyRuling,
  WakeResult,
} from '@dispatch-foo/protocol';
import { OpClock } from '@dispatch-foo/protocol/federation';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Device, TeamDb } from './db.js';
import { ensureLinearAgent } from './linear.js';
import type { LiveSession } from './pages.js';

// The hosted team hub: one protocol replica per team (`@team-<id>`). Every
// signed-in machine hub is a peer over a WebSocket, running the same loopback
// link it runs with a project daemon; the team hub mirrors each machine's
// agents and places `agent:<handle>/<name>` at the machine that homes it, so
// mail for a machine that is offline waits and flows when it reconnects.
// Sessions of the hosted MCP endpoint (mcp.ts) live here directly.

const ONLINE_MS = 2 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RELAYED = 50_000;
// While machines are connected, the roster goes out this often so presence
// (who is online) stays current even when nothing else changes.
const PRESENCE_BEAT_MS = 60_000;

/** One agent as a machine hub's roster describes it. */
export interface RosterAgent {
  address: string;
  displayName: string;
  client: string;
  status: string;
  parent?: string;
  meta?: Record<string, string>;
  lastSeen?: string;
  online?: boolean;
}

/** A frame on a machine hub's socket: a request, or the reply to one. */
type Frame =
  | { id: number; kind: 'mail' | 'state' | 'agents'; body: unknown }
  | { re: number; ok: boolean; result?: unknown; error?: string };

/** What the server needs to keep a socket: send a text frame, close it. */
export interface Socket {
  send(text: string): void;
  close(code?: number, reason?: string): void;
}

// A mirror row's hash names the device that homes it; no token matches it.
const DEVICE_ROW = 'dev:';

export function deviceOfRow(agent: AgentRecord): string | null {
  if (!agent.tokenHash.startsWith(DEVICE_ROW)) return null;
  const rest = agent.tokenHash.slice(DEVICE_ROW.length);
  return rest.slice(0, rest.indexOf(':'));
}

function operatorOf(address: string): string | null {
  const m = /^agent:([^/]+)\//.exec(address);
  return m === null ? null : (m[1] ?? null);
}

class Connection {
  private next = 1;
  private readonly waiting = new Map<number, (frame: Frame) => void>();
  link: LoopbackLink | null = null;

  constructor(
    readonly device: Device,
    readonly login: string,
    readonly replica: string,
    private readonly socket: Socket
  ) {}

  request(kind: 'mail' | 'state' | 'agents', body: unknown): Promise<boolean> {
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(false);
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(id, (frame) => {
        clearTimeout(timer);
        resolve('ok' in frame && frame.ok);
      });
      try {
        this.socket.send(JSON.stringify({ id, kind, body }));
      } catch {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(false);
      }
    });
  }

  answered(frame: Frame & { re: number }): void {
    this.waiting.get(frame.re)?.(frame);
    this.waiting.delete(frame.re);
  }

  reply(re: number, ok: boolean, result: unknown, error?: string): void {
    try {
      this.socket.send(
        JSON.stringify({
          re,
          ok,
          result,
          ...(error === undefined ? {} : { error }),
        })
      );
    } catch {
      // The socket went away; the peer sends again after reconnecting.
    }
  }

  close(reason: string): void {
    this.link?.stop();
    for (const resolve of this.waiting.values()) resolve({ re: 0, ok: false });
    this.waiting.clear();
    try {
      this.socket.close(1000, reason);
    } catch {
      // Already closed.
    }
  }
}

class TeamHubHost implements MessagingHost {
  federation?: FederationHooks;
  constructor(private readonly ownerRef: string) {}
  liveRunFor(): string | null {
    return null;
  }
  isLiveRun(): boolean {
    return false;
  }
  taskOfRun(): string | null {
    return null;
  }
  push(): Promise<void> {
    return Promise.resolve();
  }
  notify(): Promise<void> {
    return Promise.resolve();
  }
  notifyHuman(): void {}
  wake(): Promise<WakeResult> {
    return Promise.resolve({
      ok: false,
      reason: 'the team hub runs no agents to wake',
    });
  }
  decide(): PolicyRuling {
    return 'allow';
  }
  owner(): string {
    return this.ownerRef;
  }
  implicitMembers(): string[] {
    return [];
  }
  onAnswered(): Promise<void> {
    return Promise.resolve();
  }
  now(): Date {
    return new Date();
  }
}

/** One team's replica: its store, engine and the machines connected to it. */
export class TeamHub {
  readonly replica: string;
  readonly store: SqliteMessageStore;
  readonly engine: DeliveryEngine;
  private readonly clock: OpClock;
  private readonly connections = new Map<string, Connection>();
  private rosterTimer: ReturnType<typeof setTimeout> | null = null;
  // Message id → the device that sent it through here, so the delivery state
  // its recipient's machine reports goes back to the sender's machine.
  private readonly relayed = new Map<
    string,
    { from: string; to: Set<string> }
  >();
  private readonly closeDb: () => void;

  constructor(
    readonly teamId: string,
    dir: string,
    private readonly db: TeamDb
  ) {
    this.replica = `@team-${teamId.replace(/[^A-Za-z0-9_-]/g, '')}`;
    const sqlite = openMessagesDb(join(dir, `${teamId}.db`));
    this.closeDb = () => sqlite.close();
    this.store = new SqliteMessageStore(sqlite);
    this.clock = new OpClock(this.replica, null);
    const admin = db.members(teamId).find((m) => m.role === 'admin');
    const host = new TeamHubHost(`human:${admin?.user.login ?? 'team'}`);
    host.federation = {
      replica: this.replica,
      hlc: () => this.clock.tick(),
      placement: (target) => this.placement(target.recipient),
      remoteRunTask: () => null,
      label: (replica) => replica,
      problem: (subject, text) =>
        console.error(`team hub ${teamId}: ${subject}: ${text}`),
    };
    this.engine = new DeliveryEngine({ store: this.store, host });
    // Linear's notices come from this agent; every machine mirrors it from
    // the first roster, so it accepts the first notice too.
    ensureLinearAgent(this);
    this.pruneSignedOut();
    this.beat = setInterval(() => {
      this.pruneSignedOut();
      if (this.connections.size > 0) this.rosterChanged();
    }, PRESENCE_BEAT_MS);
    this.beat.unref();
  }

  private readonly beat: ReturnType<typeof setInterval>;

  close(): void {
    clearInterval(this.beat);
    for (const c of this.connections.values()) c.close('shutting down');
    this.connections.clear();
    if (this.rosterTimer !== null) clearTimeout(this.rosterTimer);
    this.closeDb();
  }

  // Agents of machines signed out (or whose owner left) go: a hub opened
  // after a sign-out must not show them as members of the team.
  private pruneSignedOut(): void {
    let pruned = false;
    for (const row of this.store.agents()) {
      const device = deviceOfRow(row);
      if (device !== null && !this.db.deviceLive(device)) {
        this.store.deleteAgent(row.address);
        pruned = true;
      }
    }
    if (pruned) this.rosterChanged();
  }

  /** A machine hub connected: start its link and tell it the roster. Null
   *  when another machine on the team already links as that replica. */
  connect(
    device: Device,
    login: string,
    replica: string,
    socket: Socket
  ): Connection | null {
    if (!this.db.setDeviceReplica(device.id, replica)) return null;
    this.connections.get(device.id)?.close('replaced by a newer connection');
    const conn = new Connection(device, login, replica, socket);
    conn.link = new LoopbackLink({
      engine: this.engine,
      store: this.store,
      me: this.replica,
      peer: replica,
      send: (kind, body) => conn.request(kind, body),
    });
    conn.link.start();
    this.connections.set(device.id, conn);
    this.db.touchDevice(device.id);
    void conn.request('agents', { agents: this.roster() });
    return conn;
  }

  disconnect(conn: Connection): void {
    if (this.connections.get(conn.device.id) === conn)
      this.connections.delete(conn.device.id);
    conn.link?.stop();
    this.rosterChanged();
  }

  /** Drops a signed-out device's connection and the agents it homed. */
  revoke(deviceId: string): void {
    const conn = this.connections.get(deviceId);
    if (conn !== undefined) {
      conn.close('signed out');
      this.connections.delete(deviceId);
    }
    for (const row of this.store.agents())
      if (deviceOfRow(row) === deviceId) this.store.deleteAgent(row.address);
    this.rosterChanged();
  }

  /** One frame from a machine hub. */
  async frame(conn: Connection, text: string): Promise<void> {
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    if ('re' in frame) {
      conn.answered(frame);
      return;
    }
    if (typeof frame.id !== 'number') return;
    this.db.touchDevice(conn.device.id);
    try {
      if (frame.kind === 'agents') {
        const agents = (frame.body as { agents?: unknown }).agents;
        this.mirror(
          conn,
          Array.isArray(agents) ? (agents as RosterAgent[]) : []
        );
        conn.reply(frame.id, true, { ok: true });
      } else if (frame.kind === 'mail') {
        const mail = frame.body as LinkMail;
        const reason = this.mailRefusal(conn, mail);
        if (reason !== null) {
          if (typeof mail.message?.id === 'string')
            conn.link?.refused(mail.message.id, reason);
          conn.reply(frame.id, true, { status: 'refused' });
          return;
        }
        // Mail between two machines passes through: each target goes on to
        // the machine that homes it. Only hosted sessions live here.
        const local: typeof mail.targets = [];
        let held = false;
        for (const target of mail.targets ?? []) {
          const device = this.homeDevice(target.recipient);
          // The system's notices are about this hub's own exchanges; one
          // machine never relays them to another.
          if (device !== null && mail.message.from === SYSTEM_ADDRESS) continue;
          if (device === null) {
            local.push(target);
            continue;
          }
          const to = this.connections.get(device);
          if (to === undefined) {
            held = true;
            continue;
          }
          this.remember(mail.message.id, conn.device.id, device);
          const ok = await to.request('mail', {
            message: mail.message,
            targets: [{ ...target, homes: [to.replica] }],
          });
          if (!ok) held = true;
        }
        if (local.length > 0) {
          const result = await applyLinkMail(
            this.engine,
            conn.link!,
            conn.replica,
            { ...mail, targets: local }
          );
          conn.reply(frame.id, true, { status: result.status });
          return;
        }
        // A machine that is offline gets it when the sender sends again: its
        // row stays forwarded until that machine reports on it.
        conn.reply(frame.id, true, { status: held ? 'held' : 'relayed' });
      } else if (frame.kind === 'state') {
        const { entries } = frame.body as LinkState;
        const mine: LinkState['entries'] = [];
        const onward = new Map<string, LinkState['entries']>();
        for (const e of entries ?? []) {
          const about = e.t === 'settle' ? e.question : e.message;
          const relay = this.relayed.get(about);
          if (relay === undefined) {
            mine.push(e);
            continue;
          }
          // A settle comes from the asker's machine and goes to the machines
          // the question went to; a delivery report comes from one of those
          // and goes back to the asker's. Anything else is dropped.
          const allowed =
            e.t === 'settle'
              ? relay.from === conn.device.id
              : relay.to.has(conn.device.id);
          if (!allowed) continue;
          const back = e.t === 'settle' ? [...relay.to] : [relay.from];
          for (const device of back)
            if (device !== conn.device.id)
              onward.set(device, [...(onward.get(device) ?? []), e]);
        }
        if (mine.length > 0)
          applyLinkState(this.engine, this.store, conn.replica, {
            entries: mine,
          });
        for (const [device, batch] of onward)
          void this.connections
            .get(device)
            ?.request('state', { entries: batch });
        conn.reply(frame.id, true, { ok: true });
      } else conn.reply(frame.id, false, null, 'unknown frame kind');
    } catch (err) {
      conn.reply(frame.id, false, null, (err as Error).message);
    }
  }

  /** Live agent sessions on this team, for its page and the hosted MCP. */
  sessions(): LiveSession[] {
    const now = Date.now();
    return this.store
      .agents()
      .filter((a) => a.status === 'approved' && a.parent !== undefined)
      .map((a) => ({
        address: a.address,
        client: a.client,
        ...(a.meta?.label === undefined ? {} : { label: a.meta.label }),
        ...(a.meta?.repo === undefined ? {} : { repo: a.meta.repo }),
        online: this.isOnline(a, now),
      }))
      .sort((a, b) =>
        a.online === b.online
          ? a.address.localeCompare(b.address)
          : a.online
            ? -1
            : 1
      );
  }

  /** Every agent on the team, as each machine hub mirrors it. */
  roster(): RosterAgent[] {
    const now = Date.now();
    return this.store
      .agents()
      .filter((a) => a.status === 'approved')
      .map((a) => ({
        address: a.address,
        displayName: a.displayName,
        client: a.client,
        status: a.status,
        ...(a.parent === undefined ? {} : { parent: a.parent }),
        ...(a.meta === undefined ? {} : { meta: a.meta }),
        ...(a.lastSeen === undefined ? {} : { lastSeen: a.lastSeen }),
        online: this.isOnline(a, now),
      }));
  }

  /** The roster changed: every connected machine hears it, once per beat. */
  rosterChanged(): void {
    if (this.rosterTimer !== null) return;
    this.rosterTimer = setTimeout(() => {
      this.rosterTimer = null;
      const agents = this.roster();
      for (const c of this.connections.values())
        void c.request('agents', { agents });
    }, 250);
  }

  // An agent of a connected machine, or a hosted session, seen recently.
  private isOnline(agent: AgentRecord, now: number): boolean {
    const device = deviceOfRow(agent);
    if (device !== null && !this.connections.has(device)) return false;
    return (
      agent.lastSeen !== undefined &&
      now - Date.parse(agent.lastSeen) <= ONLINE_MS
    );
  }

  // Why a machine's mail is refused, or null. Relay state is keyed by message
  // id, so an id another machine already relayed stays that machine's: reusing
  // it would route the new recipients' reports to the original sender.
  private mailRefusal(conn: Connection, mail: LinkMail): string | null {
    if (!this.speaksFor(conn, mail.message?.from))
      return `${conn.login}'s machine does not speak for ${String(mail.message?.from)}`;
    const relay = this.relayed.get(mail.message.id);
    if (relay !== undefined && relay.from !== conn.device.id)
      return `message id ${mail.message.id} is already in use`;
    return null;
  }

  // A machine may speak only for agents it homes; the system's notices pass.
  private speaksFor(conn: Connection, from: unknown): boolean {
    if (from === SYSTEM_ADDRESS) return true;
    if (typeof from !== 'string') return false;
    const row = this.store.getAgent(from);
    return row !== null && deviceOfRow(row) === conn.device.id;
  }

  // Mirrors a machine's agents: only addresses under its owner's handle, so
  // no machine can claim a teammate's; its rows it no longer lists go.
  private mirror(conn: Connection, agents: RosterAgent[]): void {
    const listed = new Set<string>();
    const now = new Date().toISOString();
    for (const a of agents) {
      if (a.status !== 'approved' || operatorOf(a.address) !== conn.login)
        continue;
      const existing = this.store.getAgent(a.address);
      // Someone else's machine (or a hosted session) holds this address.
      if (existing !== null && deviceOfRow(existing) !== conn.device.id)
        continue;
      listed.add(a.address);
      this.store.putAgent({
        address: a.address,
        displayName: String(a.displayName).slice(0, 100),
        client: String(a.client).slice(0, 100),
        tokenHash:
          existing?.tokenHash ??
          `${DEVICE_ROW}${conn.device.id}:${randomBytes(12).toString('hex')}`,
        status: 'approved',
        muted: existing?.muted ?? false,
        approvedBy: `human:${conn.login}`,
        createdAt: existing?.createdAt ?? now,
        ...(a.parent === undefined ? {} : { parent: a.parent }),
        ...(a.meta === undefined ? {} : { meta: a.meta }),
        lastSeen: a.lastSeen ?? now,
      });
    }
    for (const row of this.store.agents())
      if (deviceOfRow(row) === conn.device.id && !listed.has(row.address))
        this.store.deleteAgent(row.address);
    this.rosterChanged();
  }

  // Recent relays only: state for an older message has long been reported.
  private remember(messageId: string, from: string, to: string): void {
    const entry = this.relayed.get(messageId) ?? {
      from,
      to: new Set<string>(),
    };
    entry.to.add(to);
    this.relayed.delete(messageId);
    this.relayed.set(messageId, entry);
    if (this.relayed.size > MAX_RELAYED) {
      const oldest = this.relayed.keys().next().value;
      if (oldest !== undefined) this.relayed.delete(oldest);
    }
  }

  // The device homing `recipient`, or null for an agent that lives here.
  private homeDevice(recipient: string): string | null {
    if (!recipient.startsWith('agent:')) return null;
    const row = this.store.getAgent(recipient);
    return row === null ? null : deviceOfRow(row);
  }

  private placement(recipient: string): Placement {
    if (!recipient.startsWith('agent:')) return { kind: 'local' };
    const row = this.store.getAgent(recipient);
    const device = row === null ? null : deviceOfRow(row);
    if (device === null) return { kind: 'local' };
    const replica = this.db.deviceReplica(device);
    return replica === null
      ? {
          kind: 'refuse',
          reason: `${recipient}'s machine has not connected yet`,
        }
      : { kind: 'remote', homes: [replica], alsoLocal: false };
  }

  /** For tests and the page: the connection a device holds, if any. */
  connected(deviceId: string): boolean {
    return this.connections.has(deviceId);
  }
}

export type { Connection };

/** Every team's hub, opened on first use. */
export class TeamHubs {
  private readonly hubs = new Map<string, TeamHub>();

  constructor(
    private readonly dir: string,
    private readonly db: TeamDb
  ) {
    mkdirSync(dir, { recursive: true });
  }

  of(teamId: string): TeamHub {
    let hub = this.hubs.get(teamId);
    if (hub === undefined) {
      hub = new TeamHub(teamId, this.dir, this.db);
      this.hubs.set(teamId, hub);
    }
    return hub;
  }

  /** Sessions on a team, without opening a hub nobody has used. */
  sessions(teamId: string): LiveSession[] {
    return this.hubs.get(teamId)?.sessions() ?? [];
  }

  /** A signed-out device leaves its team's hub, opened if need be. */
  revoke(deviceId: string, teamId?: string): void {
    if (teamId !== undefined) this.of(teamId).revoke(deviceId);
    for (const hub of this.hubs.values()) hub.revoke(deviceId);
  }

  close(): void {
    for (const hub of this.hubs.values()) hub.close();
    this.hubs.clear();
  }
}
