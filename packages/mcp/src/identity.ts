import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import type { DaemonFileInfo } from './daemon.js';
import {
  daemonAuth,
  isDaemonHealthy,
  readDaemonFile,
  requestDeadline,
} from './daemon.js';

// Messaging identity: who an MCP tool call speaks as — a live run speaks as
// itself; everything else self-registers a per-project cached agent identity.

export interface MessagingCredential {
  token: string;
  address: string | null;
  kind: 'run' | 'agent';
}

function dispatchHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// Keys a project's cached tokens by its realpath, so the same project
// reached via a symlink or a relative path shares one cache directory.
function projectKey(rootDir: string): string {
  let real: string;
  try {
    real = realpathSync(rootDir);
  } catch {
    real = rootDir;
  }
  return createHash('sha256').update(real).digest('hex').slice(0, 12);
}

function agentsDir(rootDir: string): string {
  return join(dispatchHome(), '.dispatch', 'agents', projectKey(rootDir));
}

/** Where `rootDir` caches `name`'s registration — exported so a tool error
 *  can point a human at the exact file to delete. */
export function agentTokenFilePath(rootDir: string, name: string): string {
  return join(agentsDir(rootDir), `${name}.json`);
}

interface StoredAgentToken {
  token: string;
  address: string;
}

// A corrupt or missing cache file both read as "no cache" — the same
// resilience readDaemonFile gives a truncated daemon file.
function readStoredToken(path: string): StoredAgentToken | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
      token?: unknown;
      address?: unknown;
    };
    if (
      typeof parsed.token === 'string' &&
      typeof parsed.address === 'string'
    ) {
      return { token: parsed.token, address: parsed.address };
    }
  } catch {
    // Fall through to null below.
  }
  return null;
}

function writeStoredToken(path: string, value: StoredAgentToken): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
}

// Self-heal step: drops a cached token so the next messagingCredential call
// registers a fresh one (used when the daemon reports it unknown, not revoked).
export function forgetAgentToken(rootDir: string, name: string): void {
  try {
    rmSync(agentTokenFilePath(rootDir, name), { force: true });
  } catch {
    // Already gone — nothing to clean up.
  }
}

// Mirrors packages/server/src/messaging/routes.ts's normalizeAgentName
// exactly (not imported — MIT must not depend on the FSL server).
function normalizeAgentName(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return lowered.replace(/^[^a-z0-9]+/, '').slice(0, 40);
}

// The first label of a hostname: "Wyats-MacBook-Pro" out of
// "Wyats-MacBook-Pro.local".
function shortHost(host: string): string {
  const dot = host.indexOf('.');
  return dot === -1 ? host : host.slice(0, dot);
}

/** DISPATCH_AGENT_NAME wins; otherwise "<mcp client>.<short hostname>",
 *  normalized like the server's own registration handler. */
export function agentName(
  env: NodeJS.ProcessEnv,
  clientName: string | undefined,
  host: string
): string {
  const override = env.DISPATCH_AGENT_NAME;
  if (override !== undefined && override.trim() !== '') {
    return normalizeAgentName(override);
  }
  const client =
    clientName !== undefined && clientName.trim() !== '' ? clientName : 'agent';
  return normalizeAgentName(`${client}.${shortHost(host)}`);
}

// Dedupes concurrent registrations for the same (project, name) pair so two
// tool calls racing past an empty cache register exactly once between them.
const inFlightRegistrations = new Map<
  string,
  Promise<MessagingCredential | { error: string }>
>();

async function registerAgent(
  rootDir: string,
  daemon: DaemonFileInfo,
  name: string,
  clientName: string | undefined
): Promise<MessagingCredential | { error: string }> {
  const key = `${rootDir}\u0000${name}`;
  const existing = inFlightRegistrations.get(key);
  if (existing !== undefined) return existing;
  const promise = doRegisterAgent(rootDir, daemon, name, clientName);
  inFlightRegistrations.set(key, promise);
  try {
    return await promise;
  } finally {
    inFlightRegistrations.delete(key);
  }
}

// The one real POST /api/agents/register (registerAgent wraps it with the
// in-flight dedup). A 409 re-checks the cache first — a parallel writer.
async function doRegisterAgent(
  rootDir: string,
  daemon: DaemonFileInfo,
  name: string,
  clientName: string | undefined
): Promise<MessagingCredential | { error: string }> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${daemon.port}/api/agents/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...daemonAuth(daemon) },
      body: JSON.stringify({
        name,
        client:
          clientName !== undefined && clientName.trim() !== ''
            ? clientName
            : 'unknown',
      }),
      signal: requestDeadline(),
    });
  } catch (err) {
    return { error: `agent registration failed: ${(err as Error).message}` };
  }
  const path = agentTokenFilePath(rootDir, name);
  if (res.status === 409) {
    const cached = readStoredToken(path);
    if (cached !== null) {
      return { token: cached.token, address: cached.address, kind: 'agent' };
    }
    return {
      error:
        `${name} is already registered; revoke it in Dispatch → Settings → ` +
        `Agents, then delete ${path}`,
    };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      error: `agent registration failed: ${body.error ?? `HTTP ${res.status}`}`,
    };
  }
  const created = (await res.json()) as { address: string; token: string };
  writeStoredToken(path, { token: created.token, address: created.address });
  return { token: created.token, address: created.address, kind: 'agent' };
}

/** The credential a messaging tool call presents: a live run's own token, or
 *  a self-registered per-project agent identity. `rootDir` must already be
 *  the daemon-discovery project root (see toolKit.ts's `projectRoot`). */
export async function messagingCredential(
  rootDir: string,
  clientName: string | undefined
): Promise<MessagingCredential | { error: string }> {
  const runToken = process.env.DISPATCH_RUN_TOKEN;
  if (runToken !== undefined && runToken !== '') {
    const runId = process.env.DISPATCH_RUN_ID;
    return {
      token: runToken,
      kind: 'run',
      address: runId !== undefined && runId !== '' ? `run:${runId}` : null,
    };
  }

  const name = agentName(process.env, clientName, hostname());
  const cached = readStoredToken(agentTokenFilePath(rootDir, name));
  if (cached !== null) {
    return { token: cached.token, address: cached.address, kind: 'agent' };
  }

  const daemon = readDaemonFile(rootDir);
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return {
      error:
        'dispatchd not running — cannot register this agent identity. Start it with: dispatch serve',
    };
  }
  return registerAgent(rootDir, daemon, name, clientName);
}
