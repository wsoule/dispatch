import type { RemoteConfig } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import {
  resolveRemote,
  sshCommand,
  sshDestination,
  sshShell,
  UnknownRemoteError,
} from '../src/remote/ssh.js';

const host: RemoteConfig = { host: 'build-box' };
const full: RemoteConfig = {
  host: 'build-box',
  user: 'ci',
  port: 2222,
  path: '/srv/repo',
  identityFile: '/keys/id_ed25519',
};

// The script ssh is asked to run is always the last argument.
function remoteScript(argv: string[]): string {
  return argv[argv.length - 1] ?? '';
}

describe('sshDestination', () => {
  it('is the bare host with no user', () => {
    expect(sshDestination(host)).toBe('build-box');
  });

  it('prefixes the user when there is one', () => {
    expect(sshDestination(full)).toBe('ci@build-box');
  });
});

describe('sshCommand', () => {
  it('runs a command on the remote', () => {
    const argv = sshCommand(host, ['git', 'status']);
    expect(argv[0]).toBe('ssh');
    expect(argv).toContain('build-box');
    expect(remoteScript(argv)).toBe("'git' 'status'");
  });

  it('changes into the remote path first', () => {
    expect(remoteScript(sshCommand(full, ['git', 'status']))).toBe(
      "cd '/srv/repo' && 'git' 'status'"
    );
  });

  it('lets a caller override the directory', () => {
    expect(
      remoteScript(sshCommand(full, ['ls'], { cwd: '/tmp/elsewhere' }))
    ).toBe("cd '/tmp/elsewhere' && 'ls'");
  });

  it('keeps an argument containing spaces in one piece', () => {
    // ssh concatenates its trailing arguments and hands the result to a
    // shell, so an unquoted path with a space would arrive as two arguments.
    expect(remoteScript(sshCommand(host, ['cat', 'my file.txt']))).toBe(
      "'cat' 'my file.txt'"
    );
  });

  it('passes the port and identity file through', () => {
    const argv = sshCommand(full, ['true']);
    expect(argv).toContain('-p');
    expect(argv).toContain('2222');
    expect(argv).toContain('-i');
    expect(argv).toContain('/keys/id_ed25519');
  });

  it('fails fast rather than hanging on an unreachable host', () => {
    // Without this a terminal on a machine that is down sits blank for the
    // kernel's full TCP timeout with nothing to say.
    expect(sshCommand(host, ['true']).join(' ')).toContain('ConnectTimeout=10');
  });

  it('notices a dropped link', () => {
    const joined = sshCommand(host, ['true']).join(' ');
    expect(joined).toContain('ServerAliveInterval=10');
    expect(joined).toContain('ServerAliveCountMax=3');
  });
});

describe('sshShell', () => {
  it('forces a pty, which is what makes a remote terminal work', () => {
    // `-tt` is why a remote session needs no `script(1)` wrapper: ssh
    // allocates the pty on the far side.
    expect(sshShell(host)).toContain('-tt');
  });

  it('execs the shell rather than wrapping it', () => {
    // A wrapper would mean two processes to kill and an exit code that is the
    // wrapper's rather than the shell's.
    expect(remoteScript(sshShell(host))).toBe('exec $SHELL -l');
  });

  it('starts in the remote path', () => {
    expect(remoteScript(sshShell(full))).toBe(
      "cd '/srv/repo' && exec $SHELL -l"
    );
  });

  it('takes an explicit directory and shell', () => {
    expect(
      remoteScript(sshShell(host, { cwd: '/work', shell: '/bin/bash' }))
    ).toBe("cd '/work' && exec /bin/bash -l");
  });
});

describe('resolveRemote', () => {
  it('finds a configured remote', () => {
    expect(resolveRemote({ box: host }, 'box')).toEqual(host);
  });

  it('says which names exist', () => {
    try {
      resolveRemote({ box: host, other: host }, 'nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownRemoteError);
      expect((err as Error).message).toContain('box, other');
    }
  });

  it('points at the config when none are set up at all', () => {
    try {
      resolveRemote({}, 'nope');
      throw new Error('should have thrown');
    } catch (err) {
      expect((err as Error).message).toContain('remotes:');
    }
  });
});
