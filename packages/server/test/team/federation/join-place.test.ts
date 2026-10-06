import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  decodeTeamLink,
  encodeTeamLink,
} from '../../../src/team/federation/onboarding.js';
import { runGitSync } from '../../orchestrator/helpers.js';
import { cluster, quiesce } from './harness/cluster.js';
import type { Member } from './harness/cluster.js';

// A join travels where the team's board is kept: an invite naming another
// repo than the one this project syncs through moves sync there first, or is
// refused when moving would leave other machines behind. Never "joined" into
// a place the admin is not reading.
const SLOW = 240_000;
let stops: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const stop of stops.reverse()) await stop();
  stops = [];
});

// A bare repo that is not the team's, in a realpath'd temp dir.
function otherRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'fed-elsewhere-')));
  runGitSync(dir, ['init', '-q', '--bare', '-b', 'main']);
  stops.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const post = (m: Member, path: string, body: Record<string, unknown>) =>
  m.handle.api(path, { method: 'POST', body: JSON.stringify(body) });

// What the clients do: while the daemon answers `restarting`, wait for sync
// to be on and ask again.
async function act(
  m: Member,
  path: string,
  body: Record<string, unknown>
): Promise<{
  status: number;
  body: Record<string, unknown> | null;
  restarts: number;
}> {
  let answer = await post(m, path, body);
  let restarts = 0;
  while (answer.status === 202 && answer.body?.code === 'restarting') {
    restarts += 1;
    if (restarts > 200) throw new Error('never came back');
    await Bun.sleep(100);
    const sync = await m.handle
      .api('/api/board-sync')
      .catch(() => ({ status: 0, body: null }));
    if (sync.status === 200 && sync.body?.enabled === true)
      answer = await post(m, path, body).catch(() => answer);
  }
  return { ...answer, restarts };
}

const config = (m: Member) =>
  readFileSync(join(m.handle.root, '.dispatch', 'config.yml'), 'utf8');

describe('joining from a project that syncs elsewhere', () => {
  // The invite chose this repo, not the joiner: a local path waits for an
  // explicit yes, and nothing is written or pushed before it.
  it(
    'holds an invite whose repo is a local path until the joiner confirms it',
    async () => {
      const c = await cluster(['ada']);
      stops.push(c.stop);
      const [ada] = c.members as [Member];
      await post(ada, '/api/team/start', { name: 'acme', git: true });
      const link = (await post(ada, '/api/team/invite', { handle: 'bob' })).body
        ?.link as string;

      const wrong = otherRepo();
      const bob = await c.add('bob', { syncRepo: wrong });
      const before = config(bob);
      const held = await post(bob, '/api/team/join', { code: link });
      expect(held.status).toBe(409);
      expect(held.body?.code).toBe('confirm_repo');
      expect(String(held.body?.error)).toContain('a path on this machine');
      expect(config(bob)).toBe(before);
      expect((await bob.handle.api('/api/team/status')).body?.state).toBe(
        'none'
      );

      const joined = await act(bob, '/api/team/join', {
        code: link,
        confirmRepo: true,
      });
      expect([joined.status, joined.body?.error]).toEqual([200, undefined]);
      expect(config(bob)).toContain(`repo: ${c.remote}`);
    },
    SLOW
  );

  it(
    'moves sync to the repo and branch the invite names, and the admin lets it in',
    async () => {
      const c = await cluster(['ada']);
      stops.push(c.stop);
      const [ada] = c.members as [Member];
      expect(
        (await post(ada, '/api/team/start', { name: 'acme', git: true })).status
      ).toBe(200);
      const link = (await post(ada, '/api/team/invite', { handle: 'bob' })).body
        ?.link as string;

      const wrong = otherRepo();
      const bob = await c.add('bob', { syncRepo: wrong });
      const joined = await act(bob, '/api/team/join', {
        code: link,
        confirmRepo: true,
      });
      expect(joined.restarts).toBeGreaterThan(0);
      expect([joined.status, joined.body?.error]).toEqual([200, undefined]);
      expect(joined.body?.team).toMatchObject({ name: 'acme' });
      expect(config(bob)).toContain(`repo: ${c.remote}`);
      expect(config(bob)).toContain('branch: dispatch-sync');

      await quiesce(c.members, 24, 100);
      const status = (await bob.handle.api('/api/team/status')).body;
      expect(status?.state).toBe('member');
      // Nothing of the team's went to the repo bob first pointed at.
      const refs = runGitSync(wrong, ['for-each-ref', '--format=%(refname)']);
      expect(refs).not.toContain('acme');
    },
    SLOW
  );

  it(
    'refuses, changing nothing, when sync here already carries other machines',
    async () => {
      const c = await cluster(['ada']);
      stops.push(c.stop);
      const [ada] = c.members as [Member];
      await post(ada, '/api/team/start', { name: 'acme', git: true });
      const link = (await post(ada, '/api/team/invite', { handle: 'bob' })).body
        ?.link as string;

      // Bob and cy already share a board through a repo of their own.
      const theirs = otherRepo();
      const bob = await c.add('bob', { syncRepo: theirs });
      const cy = await c.add('cy', { syncRepo: theirs });
      await cy.handle.create('cy was here');
      await cy.handle.sync();
      await bob.handle.sync();
      const before = config(bob);

      const refused = await post(bob, '/api/team/join', {
        code: link,
        confirmRepo: true,
      });
      expect(refused.status).toBe(409);
      expect(String(refused.body?.error)).toContain(`sync.repo: ${c.remote}`);
      expect(String(refused.body?.error)).toContain('nothing changed');
      expect(config(bob)).toBe(before);
      expect((await bob.handle.api('/api/team/status')).body?.state).toBe(
        'none'
      );
    },
    SLOW
  );

  it(
    'a machine that already asked at the wrong place joins again with the same link',
    async () => {
      const c = await cluster(['ada']);
      stops.push(c.stop);
      const [ada] = c.members as [Member];
      await post(ada, '/api/team/start', { name: 'acme', git: true });
      const link = (await post(ada, '/api/team/invite', { handle: 'bob' })).body
        ?.link as string;

      // An older build joined where bob happened to sync: the same invite,
      // naming bob's own repo, so nothing moves and the ask lands there.
      const wrong = otherRepo();
      const bob = await c.add('bob', { syncRepo: wrong });
      const stale = encodeTeamLink({ ...decodeTeamLink(link), remote: wrong });
      expect(
        (await post(bob, '/api/team/join', { code: stale, confirmRepo: true }))
          .status
      ).toBe(200);
      await bob.handle.sync();
      await ada.handle.sync();
      expect((await bob.handle.api('/api/team/status')).body?.state).toBe(
        'joining'
      );

      // The real link moves sync, and the ask already made goes out there.
      const again = await act(bob, '/api/team/join', {
        code: link,
        confirmRepo: true,
      });
      expect(again.restarts).toBeGreaterThan(0);
      expect([again.status, again.body?.error]).toEqual([200, undefined]);
      await quiesce(c.members, 24, 100);
      expect((await bob.handle.api('/api/team/status')).body?.state).toBe(
        'member'
      );
    },
    SLOW
  );
});
