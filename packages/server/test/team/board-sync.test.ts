import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import type { ServerHandle } from '../../src/index.js';
import { startServer } from '../../src/index.js';
import { runGitSync } from '../orchestrator/helpers.js';
import { rawFetch } from '../testAuth.js';
import { licensedManager } from './licenseKeys.js';

// Board sync end to end: real daemons, each with its own project checkout
// and its own database, exchanging changes through a real git remote — a bare
// repository on disk, which is all a team's origin is to git.

let fakeHome: string;
let remote: string;
const handles: ServerHandle[] = [];
const dirs: string[] = [];
const originalHome = process.env.DISPATCH_HOME;

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  fakeHome = tempDir('dispatch-home-');
  process.env.DISPATCH_HOME = fakeHome;
  remote = tempDir('dispatch-sync-remote-');
  runGitSync(remote, ['init', '-q', '--bare', '-b', 'main']);
});

afterEach(async () => {
  for (const h of handles.splice(0)) await h.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A teammate: their own checkout and database. `where` is the sync config's
 * line saying where the board travels — by default a repository of its own
 * (the bare `remote`); `setup` runs on the checkout before the daemon starts.
 */
async function teammate(
  name: string,
  where = `repo: ${remote}`,
  intervalSec = 3600,
  setup?: (root: string) => void
) {
  const root = tempDir(`dispatch-sync-${name}-`);
  runGitSync(root, ['init', '-q', '-b', 'main']);
  setup?.(root);
  runGitSync(root, ['config', 'user.email', `${name}@example.com`]);
  runGitSync(root, ['config', 'user.name', name]);
  writeFileSync(join(root, 'README.md'), `# ${name}\n`);
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  // A long interval: every pass in these tests is asked for explicitly, so
  // what each assertion sees does not depend on a timer.
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    `sync:\n  enabled: true\n${where === '' ? '' : `  ${where}\n`}  intervalSec: ${intervalSec}\n`
  );
  runGitSync(root, ['add', '-A']);
  runGitSync(root, ['commit', '-q', '-m', 'init']);
  const handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    storeBackend: 'sqlite',
  });
  handles.push(handle);
  const base = `http://127.0.0.1:${handle.port}`;
  const auth = { authorization: `Bearer ${handle.tokens.appToken}` };
  const api = async (
    path: string,
    init: { method?: string; body?: string } = {}
  ) => {
    const res = await rawFetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...auth },
    });
    const text = await res.text();
    return {
      status: res.status,
      body: text === '' ? null : (JSON.parse(text) as Record<string, unknown>),
    };
  };
  return {
    root,
    handle,
    api,
    sync: () => api('/api/board-sync/now', { method: 'POST' }),
    create: async (title: string) =>
      (
        (
          await api('/api/tasks', {
            method: 'POST',
            body: JSON.stringify({ title }),
          })
        ).body as {
          meta: { id: string };
        }
      ).meta.id,
    patch: (id: string, patch: object) =>
      api(`/api/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    get: async (id: string) => {
      const res = await api(`/api/tasks/${id}`);
      return res.status === 200
        ? (res.body as { meta: Record<string, unknown>; body: string })
        : null;
    },
  };
}

describe('board sync', () => {
  it('a task created on one machine appears on another', async () => {
    const ada = await teammate('ada');
    const grace = await teammate('grace');

    const id = await ada.create('Fix the login redirect');
    // A synced board mints the longer ids that make two machines picking the
    // same one vanishingly unlikely.
    expect(id).toMatch(/^t-[0-9a-f]{8}$/);
    expect((await ada.sync()).body?.lastError).toBeNull();
    await grace.sync();

    expect((await grace.get(id))?.meta.title).toBe('Fix the login redirect');
  });

  it('edits to different fields on both machines both survive', async () => {
    const ada = await teammate('ada');
    const grace = await teammate('grace');
    const id = await ada.create('Fix the login redirect');
    await ada.sync();
    await grace.sync();

    await ada.patch(id, { labels: ['auth'] });
    await grace.patch(id, { priority: 'high' });
    await ada.sync();
    await grace.sync();
    await ada.sync();

    for (const who of [ada, grace]) {
      const task = await who.get(id);
      expect(task?.meta.labels).toEqual(['auth']);
      expect(task?.meta.priority).toBe('high');
    }
  });

  it('the same field edited on both: the later edit wins on both', async () => {
    const ada = await teammate('ada');
    const grace = await teammate('grace');
    const id = await ada.create('Draft');
    await ada.sync();
    await grace.sync();

    await ada.patch(id, { title: 'Ada’s title' });
    await Bun.sleep(5);
    await grace.patch(id, { title: 'Grace’s title' });
    await ada.sync();
    await grace.sync();
    await ada.sync();

    expect((await ada.get(id))?.meta.title).toBe('Grace’s title');
    expect((await grace.get(id))?.meta.title).toBe('Grace’s title');
  });

  it('a deletion reaches the other machine', async () => {
    const ada = await teammate('ada');
    const grace = await teammate('grace');
    const id = await ada.create('Obsolete');
    await ada.sync();
    await grace.sync();
    expect(await grace.get(id)).not.toBeNull();

    // Removal has no public route (tasks are archived), so this goes through
    // the orchestrator's store, which is the wrapped one every caller holds.
    grace.handle.orchestrator['ctx'].store.remove(id);
    await grace.sync();
    await ada.sync();
    expect(await ada.get(id)).toBeNull();
  });

  it('by default the board rides a branch of the project’s own origin, and nothing else there moves', async () => {
    // The zero-config setup: `sync: { enabled: true }` and the origin every
    // checkout of the project already has — here added as a relative path,
    // which git would read against the wrong directory if left as it is.
    const withOrigin = (root: string) =>
      runGitSync(root, [
        'remote',
        'add',
        'origin',
        join('..', basename(remote)),
      ]);
    const ada = await teammate('ada', '', 3600, withOrigin);
    const grace = await teammate('grace', '', 3600, withOrigin);

    const id = await ada.create('Next to the code');
    expect((await ada.sync()).body?.lastError).toBeNull();
    await grace.sync();
    expect((await grace.get(id))?.meta.title).toBe('Next to the code');

    // Only the sync branch was pushed; the project's own branches are theirs.
    const heads = runGitSync(remote, ['for-each-ref', '--format=%(refname)']);
    expect(heads.trim().split('\n')).toEqual(['refs/heads/dispatch-sync']);
  });

  it('or a repository of its own, named by a path relative to the project', async () => {
    const where = `repo: ${join('..', basename(remote))}`;
    const ada = await teammate('ada', where);
    const grace = await teammate('grace', where);

    const id = await ada.create('In a repo of its own');
    expect((await ada.sync()).body?.lastError).toBeNull();
    await grace.sync();
    expect((await grace.get(id))?.meta.title).toBe('In a repo of its own');
  });

  it('moving the board to a new place brings it across on the next sync', async () => {
    const ada = await teammate('ada');
    const id = await ada.create('Made before the move');
    await ada.sync();

    // Ada's project moves its board to a repository of its own: same
    // checkout, same database, a new place in config.yml, a restart.
    const moved = tempDir('dispatch-sync-moved-');
    runGitSync(moved, ['init', '-q', '--bare', '-b', 'main']);
    await ada.handle.stop();
    handles.splice(handles.indexOf(ada.handle), 1);
    writeFileSync(
      join(ada.root, '.dispatch', 'config.yml'),
      `sync:\n  enabled: true\n  repo: ${moved}\n  intervalSec: 3600\n`
    );
    const again = await startServer({
      rootDir: ada.root,
      port: 0,
      webDistDir: null,
      storeBackend: 'sqlite',
    });
    handles.push(again);
    const res = await rawFetch(
      `http://127.0.0.1:${again.port}/api/board-sync/now`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${again.tokens.appToken}` },
      }
    );
    expect(((await res.json()) as { lastError: unknown }).lastError).toBeNull();

    // Someone who only ever knew the new place gets what was made before.
    const grace = await teammate('grace', `repo: ${moved}`);
    await grace.sync();
    expect((await grace.get(id))?.meta.title).toBe('Made before the move');
  });

  it('past the free plan, the fourth person pauses and the first three sync on', async () => {
    const first = [
      await teammate('ada'),
      await teammate('grace'),
      await teammate('linus'),
    ];
    const ids: string[] = [];
    for (const who of first) {
      ids.push(await who.create(`From ${ids.length}`));
      await who.sync();
    }
    for (const who of first) await who.sync();

    // Barbara is the fourth person on the branch: paused, told why, and her
    // work stays on her machine rather than reaching anyone.
    const barbara = await teammate('barbara');
    const hers = await barbara.create('Made while paused');
    const status = (await barbara.sync()).body as {
      paused: string | null;
      people: number;
      seats: number;
    };
    expect(status.paused).toContain('free plan covers 3');
    expect(status.seats).toBe(3);
    expect(await barbara.get(ids[0])).toBeNull();
    for (const who of first) await who.sync();
    expect(await first[0].get(hers)).toBeNull();

    // The three still share everything with each other.
    const later = await first[2].create('Still syncing');
    await first[2].sync();
    await first[0].sync();
    expect((await first[0].get(later))?.meta.title).toBe('Still syncing');
    expect(((await first[0].sync()).body as { paused: unknown }).paused).toBe(
      null
    );

    // A machine that pushes anyway — its own license check says yes, the
    // others' say no — still does not get onto their boards.
    barbara.handle.team.license = licensedManager(5);
    expect(((await barbara.sync()).body as { paused: unknown }).paused).toBe(
      null
    );
    for (const who of first) await who.sync();
    expect(await first[0].get(hers)).toBeNull();

    // Seats for four: Barbara joins with her work intact, nothing redone.
    for (const who of [...first, barbara]) {
      who.handle.team.license = licensedManager(5);
    }
    expect(((await barbara.sync()).body as { paused: unknown }).paused).toBe(
      null
    );
    await first[0].sync();
    expect((await first[0].get(hers))?.meta.title).toBe('Made while paused');
    expect((await barbara.get(ids[0]))?.meta.title).toBe('From 0');
  }, 60_000);

  it('a new machine with an empty database gets the whole board', async () => {
    const ada = await teammate('ada');
    const ids = [await ada.create('One'), await ada.create('Two')];
    await ada.patch(ids[0], { status: 'done' });
    await ada.sync();

    // Someone new clones the repo and turns sync on: nothing local at all.
    const linus = await teammate('linus');
    await linus.sync();
    expect((await linus.get(ids[0]))?.meta.title).toBe('One');
    expect((await linus.get(ids[1]))?.meta.title).toBe('Two');
    expect((await linus.get(ids[0]))?.meta.status).toBe(
      (await ada.get(ids[0]))?.meta.status
    );
  });

  it('while the remote is unreachable, work goes on and waits to be sent', async () => {
    const ada = await teammate(
      'ada',
      `repo: ${join(tmpdir(), 'dispatch-no-such-remote-x', 'r.git')}`
    );
    const id = await ada.create('Written offline');
    const status = (await ada.sync()).body as {
      lastError: string | null;
      pending: number;
    };
    expect(status.lastError).not.toBeNull();
    // The change is committed to this replica's own log, ready to go.
    expect(status.pending).toBe(0);
    expect((await ada.get(id))?.meta.title).toBe('Written offline');
  });

  it('reports itself off when it is off', async () => {
    const root = tempDir('dispatch-sync-off-');
    runGitSync(root, ['init', '-q', '-b', 'main']);
    const handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      storeBackend: 'sqlite',
    });
    handles.push(handle);
    const res = await rawFetch(
      `http://127.0.0.1:${handle.port}/api/board-sync`,
      {
        headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
      }
    );
    expect(await res.json()).toEqual({ enabled: false, reason: 'off' });
    const now = await rawFetch(
      `http://127.0.0.1:${handle.port}/api/board-sync/now`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
      }
    );
    expect(now.status).toBe(409);
    expect(await now.text()).toContain('sync.enabled: true');
  });

  // Turned on but never started: here its remote doesn't exist.
  it('says so when it is on but did not start', async () => {
    const ada = await teammate('ada', 'remote: nowhere');
    expect((await ada.api('/api/board-sync')).body).toEqual({
      enabled: false,
      reason: 'not-started',
    });
    const now = await ada.sync();
    expect(now.status).toBe(409);
    expect((now.body as { error: string }).error).toContain("isn't running");
  });

  // A board kept as files is never shared this way, whatever config.yml says.
  it('points a board kept as files at committing its task files', async () => {
    const root = tempDir('dispatch-sync-files-');
    runGitSync(root, ['init', '-q', '-b', 'main']);
    TaskStore.init(root);
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'sync:\n  enabled: true\n'
    );
    const handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      storeBackend: 'files',
    });
    handles.push(handle);
    const base = `http://127.0.0.1:${handle.port}`;
    const auth = { authorization: `Bearer ${handle.tokens.appToken}` };
    const res = await rawFetch(`${base}/api/board-sync`, { headers: auth });
    expect(await res.json()).toEqual({ enabled: false, reason: 'files' });
    const now = await rawFetch(`${base}/api/board-sync/now`, {
      method: 'POST',
      headers: auth,
    });
    expect(now.status).toBe(409);
    const text = await now.text();
    expect(text).toContain('Commit task files to the main branch');
    expect(text).not.toContain('sync.enabled');
  });

  it('leaves the file backend syncer’s own status route alone', async () => {
    // /api/sync predates this and the app's status strip reads it; board
    // sync answering there instead would blank that strip.
    const ada = await teammate('ada');
    const res = await ada.api('/api/sync');
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('replica');
  });

  it('with nobody pressing anything, a teammate’s board updates on its own', async () => {
    // The path people actually use: an edit is pushed shortly after it is
    // made, the other daemon pulls on its interval, and its clients hear
    // task.changed and refetch — no sync command anywhere.
    const ada = await teammate('ada', `repo: ${remote}`, 5);
    const grace = await teammate('grace', `repo: ${remote}`, 5);
    const events: string[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${grace.handle.port}/ws?token=${grace.handle.tokens.agentToken}`
    );
    ws.onmessage = (m) =>
      events.push((JSON.parse(String(m.data)) as { type: string }).type);
    await new Promise((resolve) => (ws.onopen = resolve));

    const id = await ada.create('Arrives by itself');
    let seen = null;
    for (let i = 0; i < 60 && seen === null; i++) {
      await Bun.sleep(500);
      seen = await grace.get(id);
    }
    ws.close();
    expect(seen?.meta.title).toBe('Arrives by itself');
    expect(events).toContain('task.changed');
  }, 40_000);
});
