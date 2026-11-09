import type { LinearAccountRecord } from '@dispatch-foo/core';
import { join } from 'node:path';

import { TeamDb } from './db.js';
import type { Device } from './db.js';
import { HostedDemo } from './hosting/demo.js';
import { WorkspaceHost } from './hosting/host.js';
import { HostedWorkspaces } from './hosting/workspaces.js';
import type { Connection } from './hub.js';
import { deviceOfRow, TeamHubs } from './hub.js';
import { LinearError, linearOp, Sealer, TeamLinear } from './linear.js';
import { machinesHandler } from './machines.js';
import { mcpHandler } from './mcp.js';
import { PAGE_CSP, signInPage } from './pages.js';
import { LinearGrants } from './planner/grants.js';
import { plannerHandler } from './planner/routes.js';
import {
  demoWorkspace,
  hostedWorkspace,
  linearWorkspace,
} from './planner/sources.js';
import type { WebConfig } from './web.js';
import { webHandler, webUserOf } from './web.js';

// The team service: GitHub and Linear sign-in and team pages, the device sign-in API,
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
  /** The desktop Vite bundle the hosted planner serves; null turns it off. */
  desktopDistDir?: string | null;
  /** The per-workspace daemon's entry (hosting/daemonEntry.ts); null hosts
   * none, and installs are off. */
  daemonEntry?: string | null;
}

export interface TeamService {
  port: number;
  db: TeamDb;
  hubs: TeamHubs;
  linear: TeamLinear;
  stop(): Promise<void>;
}

// A machine hub's link to its team, a planner page's live-update socket (the
// stand-in sends no events; an open socket stops the app retrying), or one
// bridged to an installed workspace's daemon as the member.
type SocketData =
  | HubSocket
  | { kind: 'planner' }
  | {
      kind: 'bridge';
      orgId: string;
      userId: string;
      upstream: WebSocket | null;
      closed: boolean;
    };

interface HubSocket {
  kind: 'hub';
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
  const sealer =
    config.teamSecret === null || config.teamSecret === ''
      ? null
      : new Sealer(config.teamSecret);
  // People's Linear grants need both the seal and the public Linear app.
  const linearClientId = config.linearClientId ?? null;
  const grants =
    sealer === null || linearClientId === null
      ? undefined
      : new LinearGrants(db.db, sealer, linearClientId, config.linearFetch);
  const secret = config.linearClientSecret ?? '';
  const entry = config.daemonEntry ?? null;
  const host =
    entry === null || grants === undefined || linearClientId === null
      ? null
      : new WorkspaceHost({
          dataDir: config.dataDir,
          entry,
          env: {
            DISPATCH_LINEAR_CLIENT_ID: linearClientId,
            ...(secret === '' ? {} : { DISPATCH_LINEAR_CLIENT_SECRET: secret }),
          },
        });
  const hosted =
    host === null ||
    sealer === null ||
    grants === undefined ||
    linearClientId === null
      ? null
      : new HostedWorkspaces(db.db, sealer, host, grants, linearClientId);
  const web = webHandler({
    db,
    ...(grants === undefined ? {} : { grants }),
    ...(hosted === null
      ? {}
      : {
          install: (userId: string, record: LinearAccountRecord) =>
            hosted.install(userId, record),
        }),
    config,
    linear,
    sessions: (teamId) => hubs.sessions(teamId),
    deviceRevoked: (deviceId, teamId) => hubs.revoke(deviceId, teamId),
  });
  const mcp = mcpHandler({
    db,
    hubs,
    origin: config.origin,
    linear,
    linearSignIn: (config.linearClientId ?? null) !== null,
  });

  const demo = demoWorkspace(
    Date.now,
    host === null ? null : new HostedDemo(host)
  );
  const planner = plannerHandler({
    origin: config.origin,
    distDir: config.desktopDistDir ?? null,
    userOf: (req) => webUserOf(db, req)?.id ?? null,
    workspace: (key) => {
      if (key === 'demo') return demo;
      const installed = hosted?.byKey(key) ?? null;
      if (installed !== null && hosted !== null && grants !== undefined)
        return hostedWorkspace(hosted, grants, installed);
      const org = grants?.workspace(key) ?? null;
      return org === null || grants === undefined
        ? null
        : linearWorkspace(grants, org, config.linearFetch);
    },
  });

  // Open bridges, re-checked every few minutes: a socket outliving its
  // member's membership is closed.
  const bridges = new Set<Bun.ServerWebSocket<SocketData>>();
  const recheck = setInterval(() => {
    for (const ws of bridges)
      if (
        ws.data.kind === 'bridge' &&
        hosted !== null &&
        !hosted.admits(ws.data.userId, ws.data.orgId)
      )
        ws.close(1008, 'open the workspace again');
  }, 5 * 60_000);

  // Your own machines from the web, over their hub links (machines.ts).
  const machines = machinesHandler({
    db,
    hubs,
    origin: config.origin,
    distDir: config.desktopDistDir ?? null,
    userOf: (req) => webUserOf(db, req),
    signIn: (next) =>
      new Response(
        signInPage(
          next,
          config.devLogin,
          (config.linearClientId ?? null) !== null
        ),
        {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': PAGE_CSP,
          },
        }
      ),
  });

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
        if (
          srv.upgrade(req, {
            data: { kind: 'hub', device, login, replica, conn: null },
          })
        )
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
      // A planner page's live-update socket, for its view token.
      const watch = /^\/w\/([a-z0-9-]{1,64})\/ws$/.exec(url.pathname);
      const watcher =
        watch === null
          ? null
          : planner.watches(
              watch[1] ?? '',
              url.searchParams.get('token') ?? '',
              req
            );
      if (watch !== null && watcher !== null) {
        const installed = hosted?.byKey(watch[1] ?? '') ?? null;
        const data: SocketData =
          installed === null || watcher.userId === null
            ? { kind: 'planner' }
            : {
                kind: 'bridge',
                orgId: installed.orgId,
                userId: watcher.userId,
                upstream: null,
                closed: false,
              };
        return srv.upgrade(req, { data })
          ? undefined
          : Response.json({ error: 'upgrade to a WebSocket' }, { status: 426 });
      }
      // A machine page's live-update socket: open, with no events yet (the
      // hub link forwards requests, not the event stream).
      const machineWatch = /^\/m\/([^/]+)\/([0-9a-f]{16})\/ws$/.exec(
        url.pathname
      );
      if (
        machineWatch !== null &&
        machines.watches(
          machineWatch[1] ?? '',
          machineWatch[2] ?? '',
          url.searchParams.get('token') ?? '',
          req
        )
      )
        return srv.upgrade(req, { data: { kind: 'planner' } })
          ? undefined
          : Response.json({ error: 'upgrade to a WebSocket' }, { status: 426 });
      const fromMachines = await machines.fetch(req);
      if (fromMachines !== null) return fromMachines;
      const fromPlanner = await planner.fetch(req);
      if (fromPlanner !== null) return fromPlanner;
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
        const bridge = ws.data;
        if (bridge.kind === 'bridge' && hosted !== null) {
          bridges.add(ws);
          void hosted
            .socket(bridge.userId, bridge.orgId)
            .then(({ url, token }) => {
              if (bridge.closed) return;
              const upstream = new WebSocket(url, {
                headers: { authorization: `Bearer ${token}` },
              });
              bridge.upstream = upstream;
              upstream.onmessage = (event) => {
                ws.send(
                  typeof event.data === 'string'
                    ? event.data
                    : new Uint8Array(event.data as ArrayBuffer)
                );
              };
              upstream.onclose = () => ws.close(1011, 'workspace restarted');
            })
            .catch(() => ws.close(1011, 'workspace unavailable'));
          return;
        }
        if (ws.data.kind !== 'hub') return;
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
        if (ws.data.kind === 'bridge') {
          if (ws.data.upstream?.readyState === WebSocket.OPEN)
            ws.data.upstream.send(message);
          return;
        }
        if (ws.data.kind !== 'hub') return;
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
        if (ws.data.kind === 'bridge') {
          bridges.delete(ws);
          ws.data.closed = true;
          ws.data.upstream?.close();
          return;
        }
        if (ws.data.kind === 'hub' && ws.data.conn !== null)
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
      clearInterval(recheck);
      hubs.close();
      await host?.close();
      await server.stop(true);
      db.close();
    },
  };
}
