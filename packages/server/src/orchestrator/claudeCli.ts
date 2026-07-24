import type { query } from '@anthropic-ai/claude-agent-sdk';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';

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
export function openClaudeQuery(
  queryFn: typeof query,
  prompt: Parameters<typeof query>[0]['prompt'],
  options: Options
): Query {
  const withExecutable = (exe: string): Options => ({
    ...options,
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
    return queryFn({ prompt, options });
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
