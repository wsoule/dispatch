import { ActorContext, TaskStore } from '@dispatch-foo/core';
import type { Person } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPeople } from '../src/api/people.js';
import { TaskCache } from '../src/cache.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-people-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  // startServer hydrates the merge queue, which writes run state under
  // DISPATCH_HOME — left unset it lands in the real home, one dir per test.
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/people', () => {
  it('lists the roster plus configured people, and who is asking', async () => {
    const patch = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        people: [
          {
            ref: 'human:ada',
            name: 'Ada',
            avatarUrl: 'https://example.com/ada.png',
          },
        ],
      }),
    });
    expect(patch.status).toBe(200);
    const res = await fetch(`${baseUrl}/api/people`);
    expect(res.status).toBe(200);
    const snapshot = await json<{
      me: string;
      people: { ref: string; name: string; avatarUrl: string | null }[];
    }>(res);
    expect(snapshot.me.startsWith('human:')).toBe(true);
    // The daemon registered its own operator in team.yml at boot.
    expect(snapshot.people.map((p) => p.ref)).toContain(snapshot.me);
    expect(snapshot.people.find((p) => p.ref === 'human:ada')?.avatarUrl).toBe(
      'https://example.com/ada.png'
    );
  });

  it('rejects an invalid people patch', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ people: [{ ref: 'agent:x', name: 'X' }] }),
    });
    expect(res.status).toBe(400);
  });
});

describe('the Linear placeholder assignee', () => {
  // The listing as a window sees it with these tasks cached.
  async function peopleWith(assignees: string[]) {
    const store = TaskStore.init(root);
    for (const assignee of assignees) {
      store.create({ title: assignee, assignee });
    }
    const cache = new TaskCache();
    cache.rebuild(store);
    const res = listPeople({
      rootDir: root,
      actorContext: ActorContext.resolve(root, () => 'test@example.com'),
      cache,
    });
    return (await json<{ people: Person[] }>(res)).people;
  }

  it('is listed by what it is, as a placeholder, while a task holds it', async () => {
    const people = await peopleWith(['human:linear-user']);
    expect(people.find((p) => p.ref === 'human:linear-user')).toEqual({
      ref: 'human:linear-user',
      name: 'Unknown Linear user',
      email: null,
      avatarUrl: null,
      external: null,
      placeholder: true,
    });
  });

  it('is not listed when no task holds it', async () => {
    const people = await peopleWith(['human:ana']);
    expect(people.some((p) => p.ref === 'human:linear-user')).toBe(false);
  });
});
