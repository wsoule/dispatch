import type { RemoteConfig } from '@dispatch-foo/core';

import { shellQuote } from '../terminals.js';

/**
 * Running things on another machine over ssh.
 *
 * This builds argv; it does not open connections of its own. `ssh` already
 * handles keys, jump hosts, known-hosts and multiplexing, and it reads the
 * user's `~/.ssh/config` — which is where anyone maintaining a fleet already
 * keeps all of that. Reimplementing any of it here would be a second copy to
 * keep in step with the first.
 *
 * What is *not* here, deliberately: running an agent on a remote checkout. The
 * orchestrator works in local worktree paths throughout — it cuts them, diffs
 * them, merges them and deletes them — so remote runs are a much larger change
 * than remote shells, and half of it would be worse than none. Terminals and
 * commands work remotely; runs stay local.
 */

/** The `[user@]host` ssh takes as its destination. */
export function sshDestination(remote: RemoteConfig): string {
  return remote.user === undefined || remote.user === ''
    ? remote.host
    : `${remote.user}@${remote.host}`;
}

/** The connection flags shared by every invocation. */
function connectionArgs(remote: RemoteConfig): string[] {
  return [
    ...(remote.port === undefined ? [] : ['-p', String(remote.port)]),
    ...(remote.identityFile === undefined ? [] : ['-i', remote.identityFile]),
    // Fail rather than hang when the host is unreachable. Without this a
    // terminal opened against a machine that is down sits on a blank screen
    // for the kernel's full TCP timeout with nothing to say.
    '-o',
    'ConnectTimeout=10',
    // Notice a dropped link instead of holding a dead session open: three
    // missed probes ten seconds apart, so a laptop that slept is reported
    // within half a minute rather than never.
    '-o',
    'ServerAliveInterval=10',
    '-o',
    'ServerAliveCountMax=3',
  ];
}

/**
 * Argv for running one command on the remote.
 *
 * The command is quoted and joined into a single string because that is what
 * ssh does with its trailing arguments anyway — it concatenates them and hands
 * the result to the remote login shell. Quoting here rather than relying on
 * that concatenation is what keeps a path with a space in it from arriving as
 * two arguments.
 */
export function sshCommand(
  remote: RemoteConfig,
  command: readonly string[],
  opts: { cwd?: string } = {}
): string[] {
  const cwd = opts.cwd ?? remote.path;
  const quoted = command.map(shellQuote).join(' ');
  const script =
    cwd === undefined || cwd === ''
      ? quoted
      : `cd ${shellQuote(cwd)} && ${quoted}`;
  return ['ssh', ...connectionArgs(remote), sshDestination(remote), script];
}

/**
 * Argv for an interactive shell on the remote.
 *
 * `-tt` forces a pty even though our own stdin is a pipe. That is the whole
 * reason a remote terminal needs no `script(1)` wrapper the way a local one
 * does: ssh allocates the pty on the far side, so the remote shell is already
 * talking to a terminal.
 */
export function sshShell(
  remote: RemoteConfig,
  opts: { cwd?: string; shell?: string } = {}
): string[] {
  const cwd = opts.cwd ?? remote.path;
  const shell = opts.shell ?? '$SHELL';
  // `exec` so the login shell is replaced rather than wrapping a child: a
  // wrapper would mean two processes to kill and an exit code that is the
  // wrapper's rather than the shell's.
  const script =
    cwd === undefined || cwd === ''
      ? `exec ${shell} -l`
      : `cd ${shellQuote(cwd)} && exec ${shell} -l`;
  return [
    'ssh',
    '-tt',
    ...connectionArgs(remote),
    sshDestination(remote),
    script,
  ];
}

export class UnknownRemoteError extends Error {
  constructor(name: string, known: readonly string[]) {
    super(
      known.length === 0
        ? `no remote named "${name}" — none are configured (add a remotes: block to .dispatch/config.yml)`
        : `no remote named "${name}" (have ${known.join(', ')})`
    );
    this.name = 'UnknownRemoteError';
  }
}

/** Looks a remote up by name, or explains which names exist. */
export function resolveRemote(
  remotes: Record<string, RemoteConfig>,
  name: string
): RemoteConfig {
  const found = remotes[name];
  if (found === undefined) {
    throw new UnknownRemoteError(name, Object.keys(remotes));
  }
  return found;
}
