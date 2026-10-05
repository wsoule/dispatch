import { childEnv, loadConfig } from '@dispatch-foo/core';
import type { RemoteConfig } from '@dispatch-foo/core';
import type { Command } from 'commander';
import { spawnSync } from 'node:child_process';

import type { CliContext } from '../context.js';
import { CliError } from '../context.js';

/**
 * `dispatch remote` — the machines this project can reach over ssh.
 *
 * Local, not a daemon route: reading `.dispatch/config.yml` and running ssh
 * are both things this process can do, and routing them through the daemon
 * would only mean `dispatch remote list` failed when no daemon is running.
 *
 * Remote *terminals* do go through the daemon (`POST /api/terminals` with a
 * `remote`), because a session has to outlive the command that opened it.
 * What is not here at all: running an agent on a remote checkout. The
 * orchestrator works in local worktree paths throughout, so remote runs are a
 * much larger change than remote shells.
 *
 * The ssh argv is built here rather than imported from @dispatch/server, which
 * is Bun-only and unimportable from this CLI — the same reason apiClient.ts
 * mirrors the server's run types by hand.
 */

/** The ssh destination for a configured remote. */
export function remoteDestination(remote: {
  host: string;
  user?: string;
}): string {
  return remote.user === undefined || remote.user === ''
    ? remote.host
    : `${remote.user}@${remote.host}`;
}

/** The connection flags every invocation here shares. */
function connectionArgs(remote: RemoteConfig): string[] {
  return [
    ...(remote.port === undefined ? [] : ['-p', String(remote.port)]),
    ...(remote.identityFile === undefined ? [] : ['-i', remote.identityFile]),
  ];
}

/**
 * Reads a `local:remote` port pair, or a single port meaning both.
 *
 * One port is the common case — the same number on each side — and writing it
 * twice is the kind of thing people get wrong in one direction and then spend
 * a while debugging.
 */
export function parsePortPair(spec: string): {
  localPort: number;
  remotePort: number;
} {
  const parts = spec.split(':');
  if (parts.length > 2) {
    throw new CliError(`expected <port> or <local>:<remote>, got "${spec}"`);
  }
  const numbers = parts.map((part) => Number(part.trim()));
  for (const value of numbers) {
    if (!Number.isInteger(value) || value <= 0 || value > 65535) {
      throw new CliError(`not a port number: "${spec}"`);
    }
  }
  const [first, second] = numbers;
  if (first === undefined) {
    throw new CliError(`expected <port> or <local>:<remote>, got "${spec}"`);
  }
  return { localPort: first, remotePort: second ?? first };
}

/**
 * Argv for holding a tunnel open.
 *
 * The bind address is fixed to 127.0.0.1 so a forwarded dev server is not
 * quietly published to whatever network the laptop is on, and `-N` runs no
 * remote command — the process exists only to hold the tunnel.
 */
export function forwardArgs(
  remote: RemoteConfig,
  localPort: number,
  remotePort: number
): string[] {
  return [
    '-N',
    '-L',
    `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`,
    ...connectionArgs(remote),
    remoteDestination(remote),
  ];
}

/** Looks a remote up, or explains which names exist. */
function requireRemote(ctx: CliContext, name: string): RemoteConfig {
  const remotes = loadConfig(ctx.cwd).remotes ?? {};
  const found = remotes[name];
  if (found === undefined) {
    const known = Object.keys(remotes);
    throw new CliError(
      known.length === 0
        ? `no remote named "${name}" — none are configured`
        : `no remote named "${name}" (have ${known.join(', ')})`
    );
  }
  return found;
}

export function registerRemoteCommands(
  program: Command,
  ctx: CliContext
): void {
  const remote = program
    .command('remote')
    .description('Machines this project can reach over ssh');

  remote
    .command('list')
    .description('Every configured remote')
    .option('--json')
    .action((opts: { json?: boolean }) => {
      const remotes = loadConfig(ctx.cwd).remotes ?? {};
      const rows = Object.entries(remotes).map(([name, config]) => ({
        name,
        destination: remoteDestination(config),
        ...(config.port === undefined ? {} : { port: config.port }),
        ...(config.path === undefined ? {} : { path: config.path }),
      }));
      if (opts.json === true) {
        ctx.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        ctx.log(
          'no remotes configured (add a remotes: block to .dispatch/config.yml)'
        );
        return;
      }
      for (const row of rows) {
        ctx.log(
          `${row.name}  ${row.destination}${row.path === undefined ? '' : `  ${row.path}`}`
        );
      }
    });

  remote
    .command('exec <name> <command...>')
    .description('Run a command on a remote, in its configured path')
    .option('--cwd <dir>', 'run somewhere other than the remote’s path')
    .action((name: string, command: string[], opts: { cwd?: string }) => {
      const config = requireRemote(ctx, name);
      const cwd = opts.cwd ?? config.path;
      const args = [
        ...connectionArgs(config),
        remoteDestination(config),
        ...(cwd === undefined ? [] : ['cd', cwd, '&&']),
        ...command,
      ];
      // Inherited stdio rather than captured: this is a passthrough, so the
      // remote's own output, exit code and any prompt it puts up belong to the
      // terminal the user is sitting at.
      const result = spawnSync('ssh', args, {
        stdio: 'inherit',
        env: childEnv(),
      });
      if (result.error !== undefined) {
        throw new CliError(`could not run ssh: ${result.error.message}`);
      }
      if (result.status !== 0 && result.status !== null) {
        throw new CliError(`remote command exited with ${result.status}`);
      }
    });

  remote
    .command('forward <name> <ports>')
    .description('Hold a tunnel open to a remote port, e.g. 5173 or 8080:3000')
    .action((name: string, ports: string) => {
      const config = requireRemote(ctx, name);
      const { localPort, remotePort } = parsePortPair(ports);
      ctx.log(
        `forwarding 127.0.0.1:${localPort} -> ${name}:${remotePort} (Ctrl-C to stop)`
      );
      // Foreground, because the tunnel lasts exactly as long as this command
      // does. Backgrounding it would need somewhere to record the process and
      // something to reap it, which is the daemon's job rather than this
      // command's.
      const result = spawnSync(
        'ssh',
        forwardArgs(config, localPort, remotePort),
        { stdio: 'inherit', env: childEnv() }
      );
      if (result.error !== undefined) {
        throw new CliError(`could not run ssh: ${result.error.message}`);
      }
    });
}
