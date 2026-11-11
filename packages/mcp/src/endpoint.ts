import { readHubFile, verifyHub } from '@dispatch-foo/core';
import { spawn } from 'node:child_process';

import {
  daemonAuth,
  isDaemonHealthy,
  readDaemonFile,
  startDaemonAdvice,
} from './daemon.js';
import { selfLaunch } from './self.js';

// Where an MCP session's agent mail goes: the project's dispatchd when one
// serves this project, else the machine hub, which every session on this
// machine shares whatever repo it is in. Each endpoint keeps its own agent
// identities, so the cache scope travels with it.

/** The cache scope standing for the machine hub in place of a project root. */
export const HUB_SCOPE = '\u0000hub';

export interface Endpoint {
  kind: 'daemon' | 'hub';
  port: number;
  /** The request-tier header: registers agents, never sends as one. */
  auth: Record<string, string>;
  /** The project root, or HUB_SCOPE, that agent identities are cached under. */
  scope: string;
}

/** Whether MCP sessions may fall back to the machine hub (DISPATCH_HUB=0 off). */
function hubEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.DISPATCH_HUB !== '0';
}

/** Which way a call goes: agent mail to the machine hub whenever it is on,
 *  so every session on this machine shares one roster; project features
 *  (docs, memory) to the project's own dispatchd. */
export type Route = 'mail' | 'project';

/** The scope identities for `projRoot`'s `route` calls are cached under:
 *  the project root, or HUB_SCOPE. */
export function scopeFor(projRoot: string, route: Route): string {
  // A dispatched run speaks with the token its own daemon minted.
  const inRun = (process.env.DISPATCH_RUN_TOKEN_FILE ?? '') !== '';
  return route === 'mail' && hubEnabled() && !inRun ? HUB_SCOPE : projRoot;
}

/** The endpoint already serving `scope`, without starting one: the hub once
 *  it proves it is the hub, else the project's daemon file. */
export async function knownEndpoint(scope: string): Promise<Endpoint | null> {
  if (scope === HUB_SCOPE) return verifiedHub();
  const daemon = readDaemonFile(scope);
  return daemon === null
    ? null
    : {
        kind: 'daemon',
        port: daemon.port,
        auth: daemonAuth(daemon),
        scope,
      };
}

const HUB_START_TIMEOUT_MS = 5000;

/** A live endpoint for `scope`: the machine hub, started when none runs, or
 *  the project's dispatchd if it answers; an error says why there is none. */
export async function liveEndpoint(
  scope: string
): Promise<Endpoint | { error: string }> {
  if (scope !== HUB_SCOPE) {
    const daemon = readDaemonFile(scope);
    if (daemon === null || !(await isDaemonHealthy(daemon.port)))
      return {
        error: `dispatchd not running — ${startDaemonAdvice()}`,
      };
    return {
      kind: 'daemon',
      port: daemon.port,
      auth: daemonAuth(daemon),
      scope,
    };
  }
  const running = await verifiedHub();
  if (running !== null && !(await retiredOlderHub())) return running;
  startHubProcess();
  const deadline = Date.now() + HUB_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    const started = await verifiedHub();
    if (started !== null) return started;
  }
  return { error: 'the Dispatch machine hub did not start in time' };
}

// How long a hub's proof of identity is trusted before it is asked again.
const VERIFIED_FOR_MS = 30_000;
let verified: { port: number; id: string; at: number } | null = null;

// The hub named in hub.json, once its /api/health echoes that file's id: no
// token goes to a port some other process took after the hub died.
async function verifiedHub(): Promise<Endpoint | null> {
  const hub = readHubFile();
  if (hub === null) return null;
  const endpoint: Endpoint = {
    kind: 'hub',
    port: hub.port,
    auth: { authorization: `Bearer ${hub.token}` },
    scope: HUB_SCOPE,
  };
  if (
    verified !== null &&
    verified.port === hub.port &&
    verified.id === hub.id &&
    Date.now() - verified.at < VERIFIED_FOR_MS
  )
    return endpoint;
  if (!(await verifyHub(hub))) return null;
  verified = { port: hub.port, id: hub.id, at: Date.now() };
  return endpoint;
}

// A hub older than this server (one left running across an upgrade) is told
// to stop, so the next start runs the new code; true once it has exited.
async function retiredOlderHub(): Promise<boolean> {
  const hub = readHubFile();
  if (hub === null || hub.pid === process.pid) return false;
  const { MCP_SERVER_VERSION } = await import('./server.js');
  if (!isOlderVersion(hub.version, MCP_SERVER_VERSION)) return false;
  try {
    process.kill(hub.pid, 'SIGTERM');
  } catch {
    return false;
  }
  const deadline = Date.now() + HUB_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
    if (readHubFile()?.pid !== hub.pid) {
      verified = null;
      return true;
    }
  }
  return false;
}

/** Whether dotted version `a` sorts before `b` (numeric parts only). */
export function isOlderVersion(a: string, b: string): boolean {
  const parts = (v: string): number[] =>
    v.split('.').map((n) => {
      const x = Number.parseInt(n, 10);
      return Number.isNaN(x) ? 0 : x;
    });
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0;
  }
  return false;
}

// Starts `dispatch-mcp hub` detached; the hub takes its own start lock, so
// racing MCP servers that all get here still leave one hub running. A
// standalone executable (the desktop app's bundled copy) is started with no
// script argument; see self.ts.
function startHubProcess(): void {
  const self = selfLaunch();
  if (self === null) return;
  const child = spawn(self.command, [...self.args, 'hub'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  child.unref();
}
