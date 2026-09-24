import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { dirname, join } from 'node:path';

import type { DaemonFileInfo } from './daemon.js';
import {
  daemonAuth,
  isDaemonHealthy,
  readDaemonFile,
  requestDeadline,
} from './daemon.js';

// ---------------------------------------------------------------------------
// Messaging identity — who an MCP tool call speaks as when it sends a
// message, replies, reads its mailbox, or joins a channel.
//
// The messaging routes (packages/server/src/messaging/principal.ts)
// deliberately reject the shared on-disk agentToken every other tool in this
// package presents: a message needs a real, individually-identifiable and
// revocable sender, not "the operator". So this module resolves a second,
// narrower credential:
//  - Inside a live dispatch run, that run's own DISPATCH_RUN_TOKEN — the run
//    speaks as itself (`run:<id>`).
//  - Outside a run (a human's own `dispatch mcp`, or an external agent
//    client like a second Claude Code session talking to this project), a
//    per-client agent identity, self-registered with dispatchd on first use
//    and cached to a token file so registration happens at most once per
//    client per machine.
// ---------------------------------------------------------------------------

export interface MessagingCredential {
  token: string;
  address: string | null;
  kind: 'run' | 'agent';
}

// Same `$DISPATCH_HOME`/homedir() fallback as daemon.ts's own (private)
// daemonHome() — duplicated rather than shared because daemon.ts doesn't
// export it, and this is the only other place that needs it.
function dispatchHome(): string {
  const home = process.env.DISPATCH_HOME;
  return home !== undefined && home !== '' ? home : homedir();
}

// Where this machine caches a self-registered agent's token, one file per
// normalized name.
function agentTokenPath(name: string): string {
  return join(dispatchHome(), '.dispatch', 'agents', `${name}.token`);
}

// Duplicates packages/server/src/messaging/routes.ts's normalizeAgentName
// exactly, rather than importing it: @dispatch/mcp is MIT and must not
// depend on the FSL server package. Keeping the two in sync means the name
// this process picks for itself is already the name the server will
// normalize it to, so the registered address is predictable instead of
// silently different from what was asked for.
function normalizeAgentName(raw: string): string {
  const lowered = raw.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return lowered.replace(/^[^a-z0-9]+/, '').slice(0, 40);
}

// The first label of a hostname ("Wyats-MacBook-Pro" out of
// "Wyats-MacBook-Pro.local") — short enough to read comfortably in an
// address, and stable across networks that append different domain suffixes
// to the same machine.
function shortHost(host: string): string {
  const dot = host.indexOf('.');
  return dot === -1 ? host : host.slice(0, dot);
}

// The name this MCP client registers itself under: an explicit
// DISPATCH_AGENT_NAME override always wins; otherwise "<mcp client
// name>.<short hostname>" (e.g. a Claude Code session on
// "Wyats-MacBook-Pro.local" becomes "claude-code.wyats-macbook-pro") —
// distinct enough to tell two clients on the same machine apart, and stable
// across that client's own restarts so it keeps re-using one registration.
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

// Registers a brand-new agent identity with dispatchd's shared request-tier
// token, writes the minted token to disk (mode 0600 — it is a bearer
// credential from here on), and returns it. A 409 means this exact name is
// already registered (approved or still pending) under a token this process
// has lost — only a human revoking it can clear that, so the guidance text
// is written to be relayed to the calling agent verbatim.
async function registerAgent(
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
  if (res.status === 409) {
    return {
      error: `an agent named ${name} is already registered; revoke it in Dispatch → Settings → Agents to re-register`,
    };
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      error: `agent registration failed: ${body.error ?? `HTTP ${res.status}`}`,
    };
  }
  const created = (await res.json()) as { address: string; token: string };
  const path = agentTokenPath(name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, created.token, { mode: 0o600 });
  return { token: created.token, kind: 'agent', address: null };
}

// The credential a messaging tool call presents to dispatchd: this run's own
// token when called from inside a live dispatch run, otherwise a
// self-registered agent identity — cached to disk after the first
// registration so a given client only ever registers once per machine.
// `rootDir` is expected to already be the daemon-discovery root (the
// project root, not a run's worktree — see tools.ts's `projectRoot`).
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
  const tokenPath = agentTokenPath(name);
  if (existsSync(tokenPath)) {
    return {
      token: readFileSync(tokenPath, 'utf8').trim(),
      kind: 'agent',
      address: null,
    };
  }

  const daemon = readDaemonFile(rootDir);
  if (daemon === null || !(await isDaemonHealthy(daemon.port))) {
    return {
      error:
        'dispatchd not running — cannot register this agent identity. Start it with: dispatch serve',
    };
  }
  return registerAgent(daemon, name, clientName);
}
