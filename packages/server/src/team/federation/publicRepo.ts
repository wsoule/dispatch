import { pinPublicUrl } from '@dispatch-foo/a2a';
import type { LookupAll } from '@dispatch-foo/a2a';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import type { AsyncGitRunner } from '../../sync/worktree.js';
import {
  checkLinkRemote,
  linkGitRunner,
  pinFlags,
  redactRemotes,
  remoteHostUrl,
} from '../links/remote.js';
import { sameRemote } from './onboarding.js';

// Licensed under the Elastic License 2.0 (../LICENSE).
//
// A board repo adopted from an invite without the joiner's say-so was only
// checked public once, at join; a name can resolve elsewhere later (DNS
// rebinding). This machine-local marker names that repo, and its git runner
// re-checks the host before every network command and pins git to the
// address it checked, the same rule teammate links keep (P1).

const FILE = 'public-repo.json';

// The commands that reach the remote; the rest stay in the local clone.
const NETWORK = new Set(['fetch', 'push', 'pull', 'ls-remote', 'clone']);

/** Records `repo` as one that must stay public, or clears the record. */
export function markPublicRepo(syncDir: string, repo: string | null): void {
  const path = join(syncDir, FILE);
  if (repo === null) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(syncDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify({ repo })}\n`, { mode: 0o600 });
}

/** The repo that must stay public, or null. Unreadable reads as none. */
export function publicRepoOf(syncDir: string): string | null {
  const path = join(syncDir, FILE);
  if (!existsSync(path)) return null;
  try {
    const { repo } = JSON.parse(readFileSync(path, 'utf8')) as {
      repo?: unknown;
    };
    return typeof repo === 'string' ? repo : null;
  } catch {
    return null;
  }
}

/** `base` for `remote`, pinned public before each network command when the
 *  marker names it; `base` unchanged otherwise. */
export function syncGitFor(
  base: AsyncGitRunner,
  syncDir: string,
  remote: string,
  lookup?: LookupAll
): AsyncGitRunner {
  const marked = publicRepoOf(syncDir);
  if (marked === null || sameRemote(marked, remote) !== true) return base;
  return publicPinnedGit(base, remote, lookup);
}

/** A runner that refuses a network command unless `remote` resolves only to
 *  public addresses, and connects git to the address it checked. */
export function publicPinnedGit(
  base: AsyncGitRunner,
  remote: string,
  lookup?: LookupAll
): AsyncGitRunner {
  let pin: string[] = [];
  // 'decide': no proxy at all, since a proxy resolves the host itself and
  // the pin would not hold (P2).
  const run = linkGitRunner(
    base,
    remote,
    () => pin,
    () => 'decide'
  );
  return async (cwd, args, env, maxOut) => {
    if (args.some((a) => NETWORK.has(a))) {
      const host = remoteHostUrl(remote);
      if (host === null || !/^https:\/\//i.test(remote))
        return refused(remote, 'it is not an https remote');
      if (!checkLinkRemote(remote))
        return refused(remote, 'it is not a plain git remote');
      try {
        const { address } = await pinPublicUrl(
          `https://${new URL(host).hostname}/`,
          { field: 'sync repo', ...(lookup === undefined ? {} : { lookup }) }
        );
        pin = pinFlags(remote, address);
      } catch (err) {
        return refused(
          remote,
          err instanceof Error ? redactRemotes(err.message) : 'refused'
        );
      }
    }
    return run(cwd, args, env, maxOut);
  };
}

function refused(remote: string, why: string) {
  return {
    status: 1,
    stdout: '',
    stderr: `board sync will not reach ${redactRemotes(remote)}: ${why}. The invite named it and it must stay on a public host; confirm it in Settings → Board sync to keep using it.`,
  };
}
