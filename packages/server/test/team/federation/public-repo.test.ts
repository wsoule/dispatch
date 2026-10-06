import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AsyncGitRunner } from '../../../src/sync/worktree.js';
import {
  markPublicRepo,
  publicPinnedGit,
  publicRepoOf,
  syncGitFor,
} from '../../../src/team/federation/publicRepo.js';

// An invite's board repo, checked public once at join, must stay public on
// every pass: a name that later resolves to a private address (DNS
// rebinding) is refused, and git connects only to the address checked.

const REMOTE = 'https://git.example.com/acme/board.git';

function recorder(): {
  runner: AsyncGitRunner;
  calls: string[][];
  envs: (Record<string, string> | undefined)[];
} {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  return {
    calls,
    envs,
    runner: (_cwd, args, env) => {
      calls.push(args);
      envs.push(env);
      return Promise.resolve({ status: 0, stdout: '', stderr: '' });
    },
  };
}

describe('a public-pinned sync repo', () => {
  it('pins a fetch to the public address it checked, with no redirects', async () => {
    const { runner, calls } = recorder();
    const git = publicPinnedGit(runner, REMOTE, () =>
      Promise.resolve(['93.184.216.34'])
    );
    expect((await git('/x', ['fetch', 'origin', 'main'])).status).toBe(0);
    const args = calls[0] ?? [];
    expect(args).toContain(
      'http.curloptResolve=git.example.com:443:93.184.216.34'
    );
    expect(args).toContain('http.followRedirects=false');
    expect(args).toContain('protocol.file.allow=never');
  });

  // A proxy resolves the host itself, so the pin would not hold through one.
  it('sends git through no proxy, from the environment or git config', async () => {
    const { runner, calls, envs } = recorder();
    const git = publicPinnedGit(runner, REMOTE, () =>
      Promise.resolve(['93.184.216.34'])
    );
    await git('/x', ['fetch', 'origin', 'main']);
    expect(calls[0]).toContain('http.proxy=');
    expect(calls[0]).toContain(`http.${REMOTE}.proxy=`);
    expect(envs[0]).toMatchObject({
      https_proxy: '',
      HTTPS_PROXY: '',
      all_proxy: '',
      ALL_PROXY: '',
    });
  });

  it('refuses a fetch once the name resolves to a private address', async () => {
    const { runner, calls } = recorder();
    let address = '93.184.216.34';
    const git = publicPinnedGit(runner, REMOTE, () =>
      Promise.resolve([address])
    );
    expect((await git('/x', ['push', 'origin', 'HEAD:main'])).status).toBe(0);
    address = '127.0.0.1';
    const refused = await git('/x', ['fetch', 'origin', 'main']);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('git.example.com');
    expect(calls).toHaveLength(1);
  });

  it('leaves commands that stay in the clone alone', async () => {
    const { runner, calls } = recorder();
    let looked = 0;
    const git = publicPinnedGit(runner, REMOTE, () => {
      looked += 1;
      return Promise.resolve(['127.0.0.1']);
    });
    expect((await git('/x', ['commit', '-m', 'x'])).status).toBe(0);
    expect(looked).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('refuses a network command to a remote it cannot pin', async () => {
    const { runner, calls } = recorder();
    const git = publicPinnedGit(runner, 'git@example.com:acme/board.git');
    expect((await git('/x', ['fetch', 'origin'])).status).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe('the public-repo marker', () => {
  const dir = () =>
    realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-public-repo-')));

  it('pins only the repo it names, and clears', () => {
    const syncDir = join(dir(), 'sync');
    const { runner } = recorder();
    expect(syncGitFor(runner, syncDir, REMOTE)).toBe(runner);
    markPublicRepo(syncDir, REMOTE);
    expect(publicRepoOf(syncDir)).toBe(REMOTE);
    expect(syncGitFor(runner, syncDir, REMOTE)).not.toBe(runner);
    expect(syncGitFor(runner, syncDir, 'https://other.example.com/x.git')).toBe(
      runner
    );
    markPublicRepo(syncDir, null);
    expect(existsSync(join(syncDir, 'public-repo.json'))).toBe(false);
    expect(syncGitFor(runner, syncDir, REMOTE)).toBe(runner);
  });
});
