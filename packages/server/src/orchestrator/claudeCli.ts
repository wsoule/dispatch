import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The actionable message shown to the user when no Claude Code CLI can be
// found anywhere. The native installer drops `claude` into a location
// (`~/.local/bin`) the desktop app's spawned daemon PATH already searches, so
// once the user runs this and re-dispatches (or re-plans), the PATH fallback
// in openClaudeQuery() below picks it up with no further configuration.
export const CLAUDE_INSTALL_HINT =
  'Claude Code CLI not found. Install it and re-dispatch — macOS/Linux: `curl -fsSL https://claude.ai/install.sh | bash` · Windows: `irm https://claude.ai/install.ps1 | iex` (docs: https://docs.claude.com/en/docs/claude-code/setup).';

// True for the SDK's own "can't find the native CLI" failure: "Native CLI
// binary for <platform>-<arch> not found. Reinstall
// @anthropic-ai/claude-agent-sdk without --omit=optional, or set
// options.pathToClaudeCodeExecutable." Used to decide when to fall back to a
// PATH `claude` and, ultimately, when to surface the install hint.
export function isMissingCliError(message: string): boolean {
  return /Native CLI binary for/.test(message);
}

// Rewrites the SDK's opaque missing-CLI message — meaningless to a
// desktop-app user who never touched npm or the SDK — into a concrete
// install command. Any other error passes through unchanged, so unrelated
// startup failures (a bad prompt, a network error, a planner validation
// failure, ...) are never hidden behind a misleading "install Claude Code"
// hint.
export function rewriteMissingCliError(message: string): string {
  return isMissingCliError(message) ? CLAUDE_INSTALL_HINT : message;
}

// Auto memory loads from every settings scope and ignores settingSources, so a
// session that is not a run or the overseer switches it off explicitly.
export function withAutoMemoryOff(options: Options): Options {
  if (typeof options.settings === 'string')
    throw new Error(
      'openClaudeQuery: a settings file path cannot carry the auto-memory switch'
    );
  const base = options.settings ?? {};
  return {
    ...options,
    settings: {
      ...base,
      autoMemoryEnabled: false,
      env: { ...(base.env ?? {}), CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
    },
  };
}

// Opens an Agent SDK `query()`, resolving the Claude Code CLI the SDK spawns
// robustly. `query()` resolves that CLI *synchronously* and throws right here
// when it can't find one — both the executor's run path and the planner's
// one-shot call hit this exact failure in a packaged app (no node_modules
// bundled CLI). Resolution order:
//
//   1. `DISPATCH_CLAUDE_BIN` — an explicit operator override, tried first.
//   2. The SDK's own bundled per-platform CLI (auto-resolved from
//      node_modules) — the dev / `bun install` path, left exactly as before.
//   3. Only if (2) fails with the SDK's missing-CLI error, a `claude` found
//      on PATH — this is what makes a packaged dispatchd (no node_modules)
//      work whenever Claude Code is installed on the machine.
//
// If none of these yields a CLI, the SDK's raw reinstall-the-npm-package
// message is rewritten into an actionable install command. Callers are
// expected to let this throw propagate through whatever failure path they
// already have (the executor's startAndRegister catch, the planner's
// runPlanner catch) — both already carry the thrown message straight to the
// user, so the rewrite happening here is what makes that surfaced text
// actionable instead of opaque.
//
// Auto memory is off unless the caller passes `memory: 'managed'`, which only
// runs do.
export function openClaudeQuery(
  queryFn: typeof query,
  prompt: Parameters<typeof query>[0]['prompt'],
  options: Options,
  opts: { memory?: 'off' | 'managed' } = {}
): Query {
  const resolved =
    opts.memory === 'managed' ? options : withAutoMemoryOff(options);
  const withExecutable = (exe: string): Options => ({
    ...resolved,
    pathToClaudeCodeExecutable: exe,
  });

  const override = process.env.DISPATCH_CLAUDE_BIN;
  if (override !== undefined && override !== '') {
    try {
      return queryFn({ prompt, options: withExecutable(override) });
    } catch (err) {
      throw new Error(rewriteMissingCliError((err as Error).message));
    }
  }

  try {
    return queryFn({ prompt, options: resolved });
  } catch (err) {
    const message = (err as Error).message;
    if (!isMissingCliError(message)) throw err;
    const onPath = Bun.which('claude');
    if (onPath === null) throw new Error(CLAUDE_INSTALL_HINT);
    try {
      return queryFn({ prompt, options: withExecutable(onPath) });
    } catch (retryErr) {
      throw new Error(rewriteMissingCliError((retryErr as Error).message));
    }
  }
}

const cliVersions = new Map<string, { mtimeMs: number; version: string }>();

// Runs `<exe> --version` and keeps the first dotted version, or null.
async function spawnVersion(exe: string): Promise<string | null> {
  try {
    const proc = Bun.spawn([exe, '--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      timeout: 10_000,
    });
    const [stdout, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (exitCode !== 0) return null;
    return /\d+\.\d+\.\d+/.exec(stdout)?.[0] ?? null;
  } catch {
    return null;
  }
}

// A CLI's version, spawned only when its path or mtime is new to this process.
async function cachedVersion(exe: string): Promise<string | null> {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(exe).mtimeMs;
  } catch {
    return null;
  }
  const hit = cliVersions.get(exe);
  if (hit !== undefined && hit.mtimeMs === mtimeMs) return hit.version;
  const version = await spawnVersion(exe);
  if (version !== null) cliVersions.set(exe, { mtimeMs, version });
  return version;
}

// The SDK's bundled per-platform CLI, found as the SDK finds it, with the
// version the SDK's package.json records for it; null when it is absent.
function bundledCli(): { path: string; version: string | null } | null {
  try {
    const sdkEntry = fileURLToPath(
      import.meta.resolve('@anthropic-ai/claude-agent-sdk')
    );
    const { platform, arch } = process;
    const targets =
      platform === 'linux'
        ? [`linux-${arch}`, `linux-${arch}-musl`]
        : [`${platform}-${arch}`];
    const suffix = platform === 'win32' ? '.exe' : '';
    const sdkRequire = createRequire(sdkEntry);
    for (const target of targets) {
      let path: string;
      try {
        path = sdkRequire.resolve(
          `@anthropic-ai/claude-agent-sdk-${target}/claude${suffix}`
        );
      } catch {
        continue;
      }
      if (!existsSync(path)) continue;
      const pkg = JSON.parse(
        readFileSync(join(dirname(sdkEntry), 'package.json'), 'utf8')
      ) as { claudeCodeVersion?: unknown };
      const version =
        typeof pkg.claudeCodeVersion === 'string'
          ? pkg.claudeCodeVersion
          : null;
      return { path, version };
    }
    return null;
  } catch {
    return null;
  }
}

// The CLI openClaudeQuery would run, in its order (override, bundled, PATH),
// and that CLI's version; either is null when it cannot be found.
export async function resolveClaudeCli(): Promise<{
  path: string | null;
  version: string | null;
}> {
  const override = process.env.DISPATCH_CLAUDE_BIN;
  if (override !== undefined && override !== '')
    return { path: override, version: await cachedVersion(override) };
  const bundled = bundledCli();
  if (bundled !== null) return bundled;
  const onPath = Bun.which('claude');
  if (onPath === null) return { path: null, version: null };
  return { path: onPath, version: await cachedVersion(onPath) };
}
