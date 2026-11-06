import { join } from 'node:path';

import { TeamDb } from './db.js';
import type { Device } from './db.js';
import type { Connection } from './hub.js';
import { deviceOfRow, TeamHubs } from './hub.js';
import { LinearError, linearOp, TeamLinear } from './linear.js';
import { mcpHandler } from './mcp.js';
import type { WebConfig } from './web.js';
import { webHandler } from './web.js';

// The team service: GitHub sign-in and team pages, the device sign-in API,
// the WebSocket machine hubs link over (/api/hub/connect), and the hosted MCP
// endpoint (/mcp). One Bun process; its data lives under dataDir.

export interface TeamServiceConfig extends WebConfig {
  port: number;
  hostname: string;
  dataDir: string;
  /** Seals Linear keys at rest; without it Linear cannot be connected. */
  teamSecret: string | null;
  /** Linear's API, swappable in tests. */
  linearFetch?: typeof fetch;
}

export interface TeamService {
  port: number;
  db: TeamDb;
  hubs: TeamHubs;
  linear: TeamLinear;
  stop(): Promise<void>;
}

interface SocketData {
  device: Device;
  login: string;
  replica: string;
  conn: Connection | null;
}

const MAX_FRAME_BYTES = 4 * 1024 * 1024;

export function startTeamService(config: TeamServiceConfig): TeamService {
  const db = new TeamDb(join(config.dataDir, 'team.db'));
  const hubs = new TeamHubs(join(config.dataDir, 'hubs'), db);
  const linear = new TeamLinear(
    db,
    config.teamSecret,
    config.origin,
    config.linearFetch
  );
  const web = webHandler({
    db,
    config,
    linear,
    sessions: (teamId) => hubs.sessions(teamId),
    deviceRevoked: (deviceId, teamId) => hubs.revoke(deviceId, teamId),
  });
  const mcp = mcpHandler({ db, hubs, origin: config.origin, linear });

  const server = Bun.serve<SocketData>({
    port: config.port,
    hostname: config.hostname,
    maxRequestBodySize: MAX_FRAME_BYTES,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname === '/healthz') return Response.json({ ok: true });

      // A signed-in machine hub opens its link to its team.
      if (url.pathname === '/api/hub/connect') {
        const header = req.headers.get('authorization') ?? '';
        const device = db.deviceByToken(
          header.startsWith('Bearer ') ? header.slice(7) : ''
        );
        if (device === null)
          return Response.json(
            { error: 'sign in again: dispatch-mcp login' },
            { status: 401 }
          );
        const replica = url.searchParams.get('replica') ?? '';
        if (!/^@hub-[0-9a-f]{8}$/.test(replica))
          return Response.json({ error: 'bad replica id' }, { status: 400 });
        const login = db.user(device.userId)?.login ?? '';
        if (srv.upgrade(req, { data: { device, login, replica, conn: null } }))
          return undefined;
        return Response.json(
          { error: 'upgrade to a WebSocket' },
          { status: 426 }
        );
      }

      // Linear's deliveries: signed with the team's webhook secret.
      const hook = /^\/api\/linear\/webhook\/([^/]+)$/.exec(url.pathname);
      if (hook !== null && req.method === 'POST') {
        const teamId = hook[1] ?? '';
        if (db.team(teamId) === null)
          return new Response(null, { status: 404 });
        const status = await linear.webhook(
          teamId,
          await req.text(),
          req.headers.get('linear-signature'),
          hubs.of(teamId)
        );
        return new Response(null, { status });
      }
      // A signed-in machine's agents use the team's Linear connection.
      const op = /^\/api\/team\/linear\/([a-z]+)$/.exec(url.pathname);
      if (op !== null && req.method === 'POST') {
        const header = req.headers.get('authorization') ?? '';
        const device = db.deviceByToken(
          header.startsWith('Bearer ') ? header.slice(7) : ''
        );
        if (device === null)
          return Response.json(
            { error: 'sign in again: dispatch-mcp login' },
            { status: 401 }
          );
        const args = (await req.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const hub = hubs.of(device.teamId);
        // An agent acts as itself only if this machine homes it.
        const as =
          typeof args.as === 'string' ? hub.store.getAgent(args.as) : null;
        const agent =
          as !== null && deviceOfRow(as) === device.id
            ? as.address
            : `human:${db.user(device.userId)?.login ?? 'unknown'}`;
        try {
          return Response.json(
            await linearOp(linear, device.teamId, agent, op[1] ?? '', args)
          );
        } catch (err) {
          return Response.json(
            { error: (err as Error).message },
            { status: err instanceof LinearError ? 400 : 502 }
          );
        }
      }
      const fromMcp = await mcp(req);
      if (fromMcp !== null) return fromMcp;
      const fromWeb = await web(req);
      if (fromWeb !== null) return fromWeb;
      return Response.json({ error: 'not found' }, { status: 404 });
    },
    websocket: {
      maxPayloadLength: MAX_FRAME_BYTES,
      idleTimeout: 120,
      sendPings: true,
      open(ws) {
        const hub = hubs.of(ws.data.device.teamId);
        ws.data.conn = hub.connect(
          ws.data.device,
          ws.data.login,
          ws.data.replica,
          {
            send: (text) => ws.send(text),
            close: (code, reason) => ws.close(code, reason),
          }
        );
        if (ws.data.conn === null)
          ws.close(1008, 'another machine on this team links as that replica');
      },
      async message(ws, message) {
        const conn = ws.data.conn;
        if (conn === null) return;
        // A device signed out while connected stops being heard at once.
        if (!db.deviceLive(ws.data.device.id)) {
          ws.close(1008, 'signed out');
          return;
        }
        await hubs
          .of(ws.data.device.teamId)
          .frame(
            conn,
            typeof message === 'string' ? message : message.toString()
          );
      },
      close(ws) {
        if (ws.data.conn !== null)
          hubs.of(ws.data.device.teamId).disconnect(ws.data.conn);
      },
    },
  });

  return {
    port: server.port ?? 0,
    db,
    hubs,
    linear,
    async stop() {
      hubs.close();
      await server.stop(true);
      db.close();
    },
  };
}
