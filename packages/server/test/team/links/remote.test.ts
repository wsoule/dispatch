import { describe, expect, it } from 'bun:test';

import {
  checkLinkRemote,
  isLocalRemote,
  linkGitRunner,
  pinFlags,
  redactRemotes,
  remoteHostUrl,
} from '../../../src/team/links/remote.js';

describe('link remotes (T55 review M1-M3)', () => {
  it('refuses helper forms, options, controls and over-long remotes', () => {
    for (const bad of [
      'ext::sh -c touch% /tmp/x',
      'fd::17',
      '--upload-pack=touch /tmp/x',
      'https://example.com/a\nb',
      '',
      `https://example.com/${'a'.repeat(1100)}`,
    ])
      expect(checkLinkRemote(bad)).toBe(false);
    for (const good of [
      'https://github.com/acme/links.git',
      'git@github.com:acme/links.git',
      'ssh://git@example.com/links.git',
      'git://example.com/links.git',
      '/srv/links.git',
      'file:///srv/links.git',
    ])
      expect(checkLinkRemote(good)).toBe(true);
  });

  it('tells local remotes from network ones, and names a network host', () => {
    expect(isLocalRemote('/srv/links.git')).toBe(true);
    expect(isLocalRemote('file:///srv/links.git')).toBe(true);
    expect(isLocalRemote('git@github.com:acme/links.git')).toBe(false);
    expect(remoteHostUrl('git@10.0.0.5:acme/links.git')).toBe(
      'ssh://10.0.0.5/'
    );
    expect(remoteHostUrl('https://u:p@127.0.0.1:8443/x.git')).toBe(
      'https://127.0.0.1:8443/'
    );
    expect(remoteHostUrl('/srv/links.git')).toBeNull();
  });

  it('runs every link git command with only https, ssh and git, plus file for a local remote', async () => {
    const seen: string[][] = [];
    const base = (_cwd: string, args: string[]) => {
      seen.push(args);
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };
    await linkGitRunner(base, 'https://example.com/x.git')('/tmp', [
      'fetch',
      'origin',
    ]);
    await linkGitRunner(base, '/srv/x.git')('/tmp', ['fetch', 'origin']);
    const [net, local] = seen;
    expect(net.slice(0, 2)).toEqual(['-c', 'protocol.allow=never']);
    expect(net).toContain('protocol.https.allow=always');
    expect(net).toContain('protocol.ssh.allow=always');
    expect(net).toContain('protocol.git.allow=always');
    expect(net).toContain('protocol.file.allow=never');
    expect(net.at(-2)).toBe('fetch');
    expect(local).toContain('protocol.file.allow=always');
  });

  it('redacts userinfo in remotes and error text', () => {
    expect(
      redactRemotes('fatal: https://ada:swordfish@example.com/x.git not found')
    ).toBe('fatal: https://***@example.com/x.git not found');
    expect(redactRemotes('ssh://git:pw@h/x')).toBe('ssh://***@h/x');
  });
});

describe('final review P1: git connects to the host that was checked', () => {
  it('refuses a backslash anywhere, and a URL remote the URL parser would rewrite', () => {
    for (const bad of [
      'https://public.example\\@10.0.0.5/x',
      'http://127.0.0.2\\@127.0.0.1:9/x',
      'C:\\links\\repo.git',
      'https://EXAMPLE.com/x.git',
      'https://example.com/a/../b.git',
    ])
      expect(checkLinkRemote(bad)).toBe(false);
    expect(checkLinkRemote('https://example.com/x.git')).toBe(true);
  });

  it('pins a checked address for curl and leaves ssh to a re-check', () => {
    expect(pinFlags('https://links.example/x.git', '93.184.216.34')).toEqual([
      '-c',
      'http.curloptResolve=links.example:443:93.184.216.34',
    ]);
    expect(pinFlags('http://links.example:8080/x.git', '2001:db8::1')).toEqual([
      '-c',
      'http.curloptResolve=links.example:8080:[2001:db8::1]',
    ]);
    expect(pinFlags('git@links.example:x.git', '93.184.216.34')).toEqual([]);
  });
});
