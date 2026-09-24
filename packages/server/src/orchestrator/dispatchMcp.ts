import type { CartoMode } from '@dispatch/core';
import { loadConfig } from '@dispatch/core';
import type { CartoBinary } from '@dispatch/core/carto';
import { discoverCarto, supportsMcpServe } from '@dispatch/core/carto';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The MCP servers a dispatched run gets — Dispatch's own tools and carto —
// described once, provider-neutrally. Each executor adapts a spec to its
// backend's config shape (the Agent SDK's McpServerConfig, Codex's
// mcp_servers table) rather than keeping its own copy of this wiring.
export interface StdioServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  /** Per-tool-call ceiling the backend should enforce, when it can. */
  timeoutMs?: number;
}

// The only inherited environment variables the dispatch MCP server child is
// given. An ALLOWLIST, deliberately: backends serialize this env onto the
// spawned CLI's argv, readable by any local process through `ps`, so copying
// `process.env` would publish every credential dispatchd inherited. The
// child's needs are tiny and known: the DISPATCH_* variables it reads plus
// what the runtime itself needs to start.
const MCP_ENV_PASSTHROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
  // Bun's own install/cache root, when the install isn't in the default place.
  'BUN_INSTALL',
  // Redirects all dispatch state away from the real home directory; the
  // child's daemon discovery reads it (packages/mcp/src/daemon.ts).
  'DISPATCH_HOME',
];

// Per-call ceiling on dispatch's own MCP tools. Must stay above `ask_user`'s
// 30-minute wait budget or it cuts that tool call off.
export const DISPATCH_MCP_TOOL_TIMEOUT_MS = 31 * 60_000;

// Locates the dispatch MCP server's stdio entry point via module resolution
// rather than a relative path (same pattern as the CLI's resolveDaemonBin).
// `@dispatch/mcp`'s exports map exposes `./package.json` for exactly this;
// the bin sits alongside it at `src/bin.ts`, which Bun runs directly.
function resolveMcpBin(): string {
  const pkgJsonPath = createRequire(import.meta.url).resolve(
    '@dispatch/mcp/package.json'
  );
  return join(dirname(pkgJsonPath), 'src', 'bin.ts');
}

// The dispatch MCP server for one run. Rooted at the run's own WORKTREE (`cwd`)
// via `--root` so task_* tools read the checkout the agent edits;
// `DISPATCH_PROJECT_ROOT` names the project so daemon discovery and
// task_comment target the real daemon file and `.dispatch/tasks`;
// `DISPATCH_RUN_ID` lets agent_message/message_user identify the sender.
// `DISPATCH_MCP_BIN` (set by the packaged desktop app) points at the compiled
// MCP binary so a release needs neither `bun` nor the monorepo checkout.
export function dispatchMcpSpec(
  cwd: string,
  projectRoot: string,
  runId: string,
  runTokenFile?: string
): StdioServerSpec {
  const env: Record<string, string> = {};
  for (const key of MCP_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.DISPATCH_PROJECT_ROOT = projectRoot;
  env.DISPATCH_RUN_ID = runId;
  // Contract with the MCP: the path of a file whose whole content is the token.
  if (runTokenFile !== undefined) env.DISPATCH_RUN_TOKEN_FILE = runTokenFile;
  const mcpBin = process.env.DISPATCH_MCP_BIN;
  if (mcpBin !== undefined && mcpBin !== '') {
    return {
      command: mcpBin,
      args: ['--root', cwd],
      env,
      timeoutMs: DISPATCH_MCP_TOOL_TIMEOUT_MS,
    };
  }
  return {
    command: 'bun',
    args: [resolveMcpBin(), '--root', cwd],
    env,
    timeoutMs: DISPATCH_MCP_TOOL_TIMEOUT_MS,
  };
}

// Same allowlist rationale as MCP_ENV_PASSTHROUGH; CARTO_MCP_TIER stays
// absent so the agent's tool menu stays at carto's ~10-tool core.
const CARTO_MCP_ENV_PASSTHROUGH: readonly string[] = [
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LC_ALL',
];

// `carto serve` roots itself at cwd, and not every backend can set a child's
// cwd, so it runs through a shell wrapper. projectRoot/binary.path are passed
// as positional params ($1/$2), never spliced into the script text, so a
// `$(...)` or backtick in either value can never run as a shell command.
export function cartoSpecFor(
  projectRoot: string,
  binary: CartoBinary
): StdioServerSpec {
  const env: Record<string, string> = {};
  for (const key of CARTO_MCP_ENV_PASSTHROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    command: '/bin/sh',
    args: ['-c', 'cd "$1" && exec "$2" serve', 'sh', projectRoot, binary.path],
    env,
  };
}

// A carto server only when `carto.enabled` allows it, the binary is present,
// and it is new enough to answer over MCP (carto#9: earlier `carto serve`
// never connected its transport) — a spawn failure or a server that never
// connects would cost every run a startup error for no benefit. Called once
// per dispatched run, so the config read is not on a hot path; a malformed
// config degrades to the default `on`.
export function cartoMcpSpec(projectRoot: string): StdioServerSpec | null {
  let mode: CartoMode = 'on';
  try {
    mode = loadConfig(projectRoot).carto.enabled;
  } catch {
    // A config Dispatch can't read must not decide carto policy by itself.
  }
  if (mode === 'off') return null;
  const discovery = discoverCarto();
  if (!discovery.ok) return null;
  if (!supportsMcpServe(discovery.binary.version)) return null;
  return cartoSpecFor(projectRoot, discovery.binary);
}
