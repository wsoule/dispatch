import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Single-quotes a path for bash, so a home directory with a space or a quote
// in it still lands on PATH as one entry.
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Prefixes a verify command so it runs with the tool versions the worktree
 * pins in `.prototools`, rather than whatever a login shell finds first.
 *
 * Verify steps run under `bash -lc`, and on macOS `/etc/profile` runs
 * `path_helper`, which moves `/usr/local/bin` and `/opt/homebrew/bin` ahead of
 * anything the daemon put on PATH. A Homebrew pnpm or a stale moon symlink
 * there then wins. Homebrew's pnpm 12 reads `packageManager: pnpm@11.9.0` and
 * tries to switch to `@pnpm/exe@11.9.0`, which ships no darwin-x64 binary, so
 * every install on an Intel Mac failed. proto's shims resolve the pinned
 * version per directory (proto installs pnpm as the JS package, which runs on
 * any host node runs on), so putting them first inside the shell fixes pnpm,
 * moon and node together and keeps following `.prototools` as the pins move.
 *
 * Returns the command unchanged when the worktree pins nothing or proto is not
 * installed, so projects that don't use proto see no difference.
 */
export function withProtoShims(
  worktreePath: string,
  command: string,
  env: NodeJS.ProcessEnv = process.env
): string {
  const dirs = protoShimDirs(worktreePath, env);
  if (dirs === null) return command;
  const [shims, bin] = dirs;
  return `export PATH=${shellQuote(shims)}:${shellQuote(bin)}:"$PATH"; ${command}`;
}

/**
 * Returns an agent process's env with proto's shims (and the proto binary)
 * at the front of PATH, so the agent and every git hook it triggers run the
 * versions the worktree pins in `.prototools`.
 *
 * Agents inherit the daemon's widened PATH, which knows nvm, Homebrew and
 * `~/.bun/bin` but not proto. Without the shims, a pre-commit hook's
 * `pnpm exec lint-staged` gets whichever pnpm (or node, or bun) one of those
 * happens to provide, or none at all. An agent is not a login shell, so the
 * env PATH survives as given and needs no in-shell prefix like
 * `withProtoShims`. Hands `env` back unchanged when the worktree pins nothing
 * or proto is not installed.
 */
export function withProtoPath(
  worktreePath: string,
  env: Record<string, string>
): Record<string, string> {
  const dirs = protoShimDirs(worktreePath, env);
  if (dirs === null) return env;
  const rest = (env.PATH ?? '')
    .split(delimiter)
    .filter((p) => p !== '' && !dirs.includes(p));
  return { ...env, PATH: [...dirs, ...rest].join(delimiter) };
}

// proto's shims and bin directories, when `worktreePath` pins tools in a
// `.prototools` and proto is installed under PROTO_HOME (default ~/.proto).
function protoShimDirs(
  worktreePath: string,
  env: Record<string, string | undefined>
): [shims: string, bin: string] | null {
  if (!existsSync(join(worktreePath, '.prototools'))) return null;
  const protoHome = env.PROTO_HOME ?? join(homedir(), '.proto');
  const shims = join(protoHome, 'shims');
  if (!existsSync(shims)) return null;
  return [shims, join(protoHome, 'bin')];
}
