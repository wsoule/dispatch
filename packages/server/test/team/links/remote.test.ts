import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultAsyncGitRunner } from '../../../src/sync/worktree.js';
import {
  checkLinkRemote,
  isLocalRemote,
  linkGitRunner,
  pinFlags,
  redactRemotes,
  remoteHostUrl,
  schemeAllowed,
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
      // Would end a `-c http.<remote>.*` key early and set another setting.
      'https://example.com/r.git.cookieFile=/etc/passwd#',
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

describe('final review P2: redirects, proxies and decide-tier schemes', () => {
  it('never follows a redirect off the pinned host (a real local 302)', async () => {
    let inner = 0;
    const internal = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: () => {
        inner += 1;
        return new Response('# service=git-upload-pack\n');
      },
    });
    const bouncer = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) =>
        Response.redirect(
          `http://127.0.0.1:${internal.port}${new URL(req.url).pathname}${new URL(req.url).search}`,
          302
        ),
    });
    try {
      const url = `http://127.0.0.1:${bouncer.port}/x.git`;
      // http is not a link protocol; this test allows it after the link flags.
      const allowHttp = ['-c', 'protocol.http.allow=always'];
      const dir = mkdtempSync(join(tmpdir(), 'link-302-'));
      // Control: plain git follows the redirect.
      await defaultAsyncGitRunner(dir, [
        ...allowHttp,
        '-c',
        'http.followRedirects=true',
        'ls-remote',
        url,
      ]);
      expect(inner).toBeGreaterThan(0);
      inner = 0;
      const res = await linkGitRunner(defaultAsyncGitRunner, url)(dir, [
        ...allowHttp,
        'ls-remote',
        url,
      ]);
      expect(res.status).not.toBe(0);
      expect(inner).toBe(0);
      rmSync(dir, { recursive: true, force: true });
    } finally {
      await bouncer.stop(true);
      await internal.stop(true);
    }
  });

  it('turns proxies off for a decide-tier link and keeps them for the operator', async () => {
    const seen: { args: string[]; env?: Record<string, string> }[] = [];
    const base = (
      _cwd: string,
      args: string[],
      env?: Record<string, string>
    ) => {
      seen.push({ args, ...(env === undefined ? {} : { env }) });
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    };
    const remote = 'https://links.example/x.git';
    await linkGitRunner(
      base,
      remote,
      () => [],
      () => 'decide'
    )('/tmp', ['fetch']);
    await linkGitRunner(
      base,
      remote,
      () => [],
      () => 'operator'
    )('/tmp', ['fetch']);
    const [decide, operator] = seen;
    expect(decide.args).toContain('http.followRedirects=false');
    expect(decide.args).toContain('http.proxy=');
    for (const k of ['http_proxy', 'HTTPS_PROXY', 'all_proxy', 'NO_PROXY'])
      expect(decide.env?.[k]).toBe('');
    expect(operator.args).toContain('http.followRedirects=false');
    expect(operator.args).not.toContain('http.proxy=');
    expect(operator.env?.['http_proxy']).toBeUndefined();
  });

  it('allows only https below the operator tier', () => {
    expect(schemeAllowed('https://links.example/x.git', 'decide')).toBe(true);
    for (const r of [
      'git@links.example:x.git',
      'ssh://links.example/x.git',
      'git://links.example/x.git',
      '/srv/links.git',
    ])
      expect(schemeAllowed(r, 'decide')).toBe(false);
    expect(schemeAllowed('git@links.example:x.git', 'operator')).toBe(true);
    expect(schemeAllowed('/srv/links.git', 'operator')).toBe(true);
  });

  it('accepts a trailing-dot host and pins it as written', () => {
    const r = 'https://links.example./x.git';
    expect(checkLinkRemote(r)).toBe(true);
    expect(pinFlags(r, '93.184.216.34')).toEqual([
      '-c',
      'http.curloptResolve=links.example.:443:93.184.216.34',
    ]);
  });
});

describe('final verdict M1: a per-URL proxy in gitconfig never applies', () => {
  it('overrides exact and wildcard http.<url>.proxy entries for a decide-tier link', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'link-proxy-'));
    const global = join(dir, 'gitconfig');
    writeFileSync(
      global,
      '[http "https://links.example/"]\n\tproxy = http://exact.invalid:3128\n' +
        '[http "https://*.example"]\n\tproxy = http://wild.invalid:3128\n' +
        '[http "https://links.example/x.git"]\n\tproxy = http://path.invalid:3128\n'
    );
    const url = 'https://links.example/x.git';
    const args = ['config', '--get-urlmatch', 'http.proxy', url];
    const env = { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: '1' };
    // Control: plain git picks the user's proxy for this URL.
    const plain = await defaultAsyncGitRunner(dir, args, env);
    expect(plain.stdout).toContain('.invalid:3128');
    const decide = await linkGitRunner(
      defaultAsyncGitRunner,
      url,
      () => [],
      () => 'decide'
    )(dir, args, env);
    expect(decide.stdout.trim()).toBe('');
    const operator = await linkGitRunner(
      defaultAsyncGitRunner,
      url,
      () => [],
      () => 'operator'
    )(dir, args, env);
    expect(operator.stdout).toContain('.invalid:3128');
    rmSync(dir, { recursive: true, force: true });
  });
});
