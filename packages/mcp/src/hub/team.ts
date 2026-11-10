import { hubDir } from '@dispatch-foo/core';
import {
  applyLinkMail,
  applyLinkState,
  LoopbackLink,
  SYSTEM_ADDRESS,
} from '@dispatch-foo/protocol';
import type {
  AgentRecord,
  DeliveryEngine,
  LinkHttpRequest,
  LinkMail,
  LinkState,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { HubWeb } from './web.js';

// The machine hub's link to its team: once this machine is signed in
// (`dispatch-mcp login`, saved in ~/.dispatch/hub/team.json) the hub keeps a
// WebSocket to the hosted team hub and runs the loopback link over it.
// Teammates' agents (and this person's hosted sessions) are mirrored here as
// rows no token matches and placed at the team; this machine's own agents
// stay here and are pushed to the team so teammates can reach them.

/** What signing in saved: where the team hub is and who this machine is. */
export interface TeamFile {
  server: string;
  token: string;
  handle: string;
  team: { id: string; name: string };
  device: string;
}

/** The default team service; DISPATCH_TEAM_URL points elsewhere. */
const DEFAULT_TEAM_SERVER = 'https://app.dispatch.foo';

export function teamServer(env: NodeJS.ProcessEnv = process.env): string {
  return (env.DISPATCH_TEAM_URL ?? DEFAULT_TEAM_SERVER).replace(/\/+$/, '');
}

function teamFilePath(): string {
  return join(hubDir(), 'team.json');
}

export function readTeamFile(): TeamFile | null {
  if (!existsSync(teamFilePath())) return null;
  try {
    const parsed = JSON.parse(readFileSync(teamFilePath(), 'utf8')) as TeamFile;
    return typeof parsed.token === 'string' && typeof parsed.server === 'string'
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export function writeTeamFile(file: TeamFile): void {
  mkdirSync(hubDir(), { recursive: true, mode: 0o700 });
  const temp = `${teamFilePath()}.tmp-${process.pid}`;
  writeFileSync(temp, JSON.stringify(file), { mode: 0o600 });
  renameSync(temp, teamFilePath());
}

export function removeTeamFile(): void {
  rmSync(teamFilePath(), { force: true });
}

/** The team hub's replica id, as the team service names it. */
export function teamReplica(teamId: string): string {
  return `@team-${teamId.replace(/[^A-Za-z0-9_-]/g, '')}`;
}

// A mirror of an agent homed on the team (a teammate's, or a hosted session).
const TEAM_ROW = 'team:';

export function isTeamRow(agent: AgentRecord): boolean {
  return agent.tokenHash.startsWith(TEAM_ROW);
}

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

type Frame =
  | {
      id: number;
      kind: 'mail' | 'state' | 'agents' | 'projects' | 'http';
      body: unknown;
    }
  | { re: number; ok: boolean; result?: unknown; error?: string };

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const PRESENCE_BEAT_MS = 60_000;

export class TeamLink {
  readonly replica: string;
  private socket: WebSocket | null = null;
  private link: LoopbackLink | null = null;
  private next = 1;
  private readonly waiting = new Map<number, (ok: boolean) => void>();
  private retryMs = RECONNECT_MIN_MS;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private beat: ReturnType<typeof setInterval> | null = null;
  /** Whether the socket is open: teammates are reachable right now. */
  connected = false;

  constructor(
    private readonly file: TeamFile,
    private readonly deps: {
      engine: DeliveryEngine;
      store: SqliteMessageStore;
      /** This hub's own replica id. */
      me: string;
      /** This hub's own agents (no mirrors), to push to the team. */
      ownRoster: () => RosterAgent[];
      /** What the web may reach on this machine (hub/web.ts). */
      web?: HubWeb;
    }
  ) {
    this.replica = teamReplica(file.team.id);
  }

  start(): void {
    this.stopped = false;
    this.open();
    // Last-seen times change on every call but are not roster changes, so
    // the roster also goes out on a beat: the team sees who is live.
    this.beat = setInterval(() => this.pushRoster(), PRESENCE_BEAT_MS);
    this.beat.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    if (this.beat !== null) clearInterval(this.beat);
    this.beat = null;
    this.link?.stop();
    this.link = null;
    try {
      this.socket?.close();
    } catch {
      // Already closed.
    }
    this.socket = null;
    this.connected = false;
  }

  /** The hub's own agents changed: the team hears. */
  pushRoster(): void {
    if (this.connected)
      void this.request('agents', { agents: this.deps.ownRoster() });
  }

  /** Whether `address` is homed on the team rather than this machine. */
  homes(address: string): boolean {
    const row = this.deps.store.getAgent(address);
    return row !== null && isTeamRow(row);
  }

  private open(): void {
    const url = `${this.file.server.replace(/^http/, 'ws')}/api/hub/connect?replica=${encodeURIComponent(this.deps.me)}`;
    let socket: WebSocket;
    try {
      socket = new WebSocket(url, {
        headers: { authorization: `Bearer ${this.file.token}` },
      } as unknown as string[]);
    } catch {
      this.retry();
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.connected = true;
      this.retryMs = RECONNECT_MIN_MS;
      this.link = new LoopbackLink({
        engine: this.deps.engine,
        store: this.deps.store,
        me: this.deps.me,
        peer: this.replica,
        send: (kind, body) => this.request(kind, body),
      });
      this.link.start();
      this.pushRoster();
    };
    socket.onmessage = (event) => {
      void this.frame(
        typeof event.data === 'string' ? event.data : String(event.data)
      );
    };
    socket.onclose = () => {
      this.connected = false;
      this.link?.stop();
      this.link = null;
      for (const resolve of this.waiting.values()) resolve(false);
      this.waiting.clear();
      if (this.socket === socket) this.socket = null;
      this.retry();
    };
    socket.onerror = () => {
      // onclose follows and retries.
    };
  }

  private retry(): void {
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => this.open(), this.retryMs);
    this.retryTimer.unref?.();
    this.retryMs = Math.min(this.retryMs * 2, RECONNECT_MAX_MS);
  }

  private request(
    kind: 'mail' | 'state' | 'agents',
    body: unknown
  ): Promise<boolean> {
    const socket = this.socket;
    if (socket === null || !this.connected) return Promise.resolve(false);
    const id = this.next++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve(false);
      }, REQUEST_TIMEOUT_MS);
      this.waiting.set(id, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
      try {
        socket.send(JSON.stringify({ id, kind, body }));
      } catch {
        clearTimeout(timer);
        this.waiting.delete(id);
        resolve(false);
      }
    });
  }

  private reply(
    re: number,
    ok: boolean,
    result: unknown,
    error?: string
  ): void {
    try {
      this.socket?.send(
        JSON.stringify({
          re,
          ok,
          result,
          ...(error === undefined ? {} : { error }),
        })
      );
    } catch {
      // Gone; the team sends again after the reconnect.
    }
  }

  private async frame(text: string): Promise<void> {
    let frame: Frame;
    try {
      frame = JSON.parse(text) as Frame;
    } catch {
      return;
    }
    if ('re' in frame) {
      this.waiting.get(frame.re)?.(frame.ok);
      this.waiting.delete(frame.re);
      return;
    }
    // The web's requests (hub/web.ts) need no loopback link of their own.
    if (frame.kind === 'projects' || frame.kind === 'http') {
      await this.webFrame(frame.id, frame.kind, frame.body);
      return;
    }
    const link = this.link;
    if (link === null) return;
    try {
      if (frame.kind === 'agents') {
        const agents = (frame.body as { agents?: unknown }).agents;
        this.mirror(Array.isArray(agents) ? (agents as RosterAgent[]) : []);
        this.reply(frame.id, true, { ok: true });
      } else if (frame.kind === 'mail') {
        const mail = frame.body as LinkMail;
        // The team speaks only for agents it homes, and the system's notices.
        const from = mail.message?.from;
        if (
          from !== SYSTEM_ADDRESS &&
          !(typeof from === 'string' && this.homes(from))
        ) {
          if (typeof mail.message?.id === 'string')
            link.refused(
              mail.message.id,
              `the team does not speak for ${String(from)}`
            );
          this.reply(frame.id, true, { status: 'refused' });
          return;
        }
        const result = await applyLinkMail(
          this.deps.engine,
          link,
          this.replica,
          mail
        );
        this.reply(frame.id, true, { status: result.status });
      } else if (frame.kind === 'state') {
        applyLinkState(
          this.deps.engine,
          this.deps.store,
          this.replica,
          frame.body as LinkState
        );
        this.reply(frame.id, true, { ok: true });
      } else {
        // A kind this hub does not know: say so rather than leave the team
        // waiting out its timeout.
        this.reply(frame.id, false, null, 'unknown frame kind');
      }
    } catch (err) {
      this.reply(frame.id, false, null, (err as Error).message);
    }
  }

  // The web listing this machine's projects, or one request to one of them.
  private async webFrame(
    id: number,
    kind: 'projects' | 'http',
    body: unknown
  ): Promise<void> {
    const web = this.deps.web;
    if (web === undefined || !web.enabled()) {
      this.reply(id, false, null, 'web access is off on this machine');
      return;
    }
    try {
      if (kind === 'projects') {
        this.reply(id, true, { projects: web.projects() });
        return;
      }
      const answer = await web.forward(body as LinkHttpRequest);
      if (answer === null) this.reply(id, false, null, 'no such project');
      else this.reply(id, true, answer);
    } catch (err) {
      this.reply(id, false, null, (err as Error).message);
    }
  }

  // Mirrors the team's agents that are not this machine's own; the mirrors
  // the team no longer lists go.
  private mirror(agents: RosterAgent[]): void {
    const { store } = this.deps;
    const listed = new Set<string>();
    const now = new Date().toISOString();
    for (const a of agents) {
      if (a.status !== 'approved' || !a.address.startsWith('agent:')) continue;
      const existing = store.getAgent(a.address);
      if (existing !== null && !isTeamRow(existing)) continue;
      listed.add(a.address);
      store.putAgent({
        address: a.address,
        displayName: String(a.displayName).slice(0, 100),
        client: String(a.client).slice(0, 100),
        tokenHash:
          existing?.tokenHash ??
          `${TEAM_ROW}${randomBytes(12).toString('hex')}`,
        status: 'approved',
        muted: existing?.muted ?? false,
        approvedBy: 'team',
        createdAt: existing?.createdAt ?? now,
        ...(a.parent === undefined ? {} : { parent: a.parent }),
        ...(a.meta === undefined ? {} : { meta: a.meta }),
        // Teammates' presence as the team sees it.
        ...(a.online === true
          ? { lastSeen: now }
          : a.lastSeen === undefined
            ? {}
            : { lastSeen: a.lastSeen }),
      });
    }
    for (const row of store.agents())
      if (isTeamRow(row) && !listed.has(row.address))
        store.deleteAgent(row.address);
  }
}
