import { TaskStore } from '@dispatch-foo/core';
import type { ActorContext, TaskComment, TaskDoc } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { addComment } from '../src/api/comments.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { runGitSync } from './orchestrator/helpers.js';
import { licensedManager } from './team/licenseKeys.js';
import { rawFetch, useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-comments-api-'));
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
let taskId: string;
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
  const taskRes = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'store the linear reference' }),
  });
  taskId = (await json<{ meta: { id: string } }>(taskRes)).meta.id;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function send(path: string, method: string, value?: unknown, token?: string) {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
  };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const init = {
    method,
    headers,
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  };
  // An explicit token bypasses useTestAuth's default operator token.
  return token === undefined
    ? fetch(`${baseUrl}${path}`, init)
    : rawFetch(`${baseUrl}${path}`, init);
}

// A teammate's own credential, so requests are provably someone else.
function adaToken(): string {
  handle.team.license = licensedManager(50);
  return handle.team.teammates.issue('ada', 'request');
}

describe('/api/tasks/:id/comments', () => {
  it('adds, lists, edits and deletes a thread', async () => {
    const path = `/api/tasks/${taskId}/comments`;
    const first = await json<TaskComment>(
      await send(path, 'POST', { body: 'Looks right?' })
    );
    expect(first.taskId).toBe(taskId);
    expect(first.author.startsWith('human:')).toBe(true);
    expect(first.parentId).toBeNull();
    const reply = await json<TaskComment>(
      await send(path, 'POST', { body: 'Yes', parentId: first.id })
    );
    const listed = await json<TaskComment[]>(await send(path, 'GET'));
    expect(listed.map((c) => c.id)).toEqual([first.id, reply.id]);
    const edited = await json<TaskComment>(
      await send(`${path}/${first.id}`, 'PATCH', { body: 'Looks right.' })
    );
    expect(edited.body).toBe('Looks right.');
    // The author's own replies go with the comment.
    const removed = await json<{ removed: string[] }>(
      await send(`${path}/${first.id}`, 'DELETE')
    );
    expect(removed.removed.sort()).toEqual([first.id, reply.id].sort());
    expect(await json<TaskComment[]>(await send(path, 'GET'))).toEqual([]);
  });

  it('ignores a client-supplied author, created or external', async () => {
    const before = Date.now();
    const res = await send(`/api/tasks/${taskId}/comments`, 'POST', {
      body: 'as someone else',
      author: 'human:ada',
      created: '2020-01-01T00:00:00.000Z',
      external: 'linear:forged',
    });
    expect(res.status).toBe(201);
    const comment = await json<TaskComment>(res);
    expect(comment.author).not.toBe('human:ada');
    expect(Date.parse(comment.created)).toBeGreaterThanOrEqual(before - 1000);
    expect(comment.external).toBeNull();
  });

  it('lets only the author edit or delete', async () => {
    const path = `/api/tasks/${taskId}/comments`;
    const ada = adaToken();
    const hers = await json<TaskComment>(
      await send(path, 'POST', { body: 'mine' }, ada)
    );
    expect(hers.author).toBe('human:ada');
    expect(
      (await send(`${path}/${hers.id}`, 'PATCH', { body: 'hijacked' })).status
    ).toBe(403);
    expect((await send(`${path}/${hers.id}`, 'DELETE')).status).toBe(403);
    expect(
      (await send(`${path}/${hers.id}`, 'PATCH', { body: 'edited' }, ada))
        .status
    ).toBe(200);
  });

  it("refuses to delete a comment over someone else's reply", async () => {
    const path = `/api/tasks/${taskId}/comments`;
    const ada = adaToken();
    const mine = await json<TaskComment>(
      await send(path, 'POST', { body: 'question' })
    );
    const reply = await json<TaskComment>(
      await send(path, 'POST', { body: 'answer', parentId: mine.id }, ada)
    );
    expect((await send(`${path}/${mine.id}`, 'DELETE')).status).toBe(409);
    expect((await send(path, 'GET')).status).toBe(200);
    // Once the reply's author removes it, the parent can go.
    expect(
      (await send(`${path}/${reply.id}`, 'DELETE', undefined, ada)).status
    ).toBe(200);
    expect((await send(`${path}/${mine.id}`, 'DELETE')).status).toBe(200);
  });

  it('credits the on-disk agent token to an agent, never the human', async () => {
    const path = `/api/tasks/${taskId}/comments`;
    const agent = handle.tokens.agentToken;
    const posted = await json<TaskComment>(
      await send(path, 'POST', { body: 'from a run', runId: 'r-000000' }, agent)
    );
    expect(posted.author).toBe('agent');
    const human = await json<TaskComment>(
      await send(path, 'POST', { body: 'from the operator' })
    );
    // The agent token cannot touch the operator's comment.
    expect(
      (await send(`${path}/${human.id}`, 'PATCH', { body: 'x' }, agent)).status
    ).toBe(403);
    expect(
      (await send(`${path}/${posted.id}`, 'PATCH', { body: 'fixed' }, agent))
        .status
    ).toBe(200);
  });

  it('validates input and 404s unknown tasks and comments', async () => {
    const path = `/api/tasks/${taskId}/comments`;
    expect((await send(path, 'POST', { body: '  ' })).status).toBe(400);
    expect(
      (await send(path, 'POST', { body: 'x', parentId: 'c-00000000' })).status
    ).toBe(400);
    expect((await send('/api/tasks/t-ffffff/comments', 'GET')).status).toBe(
      404
    );
    expect((await send(`${path}/c-00000000`, 'DELETE')).status).toBe(404);
    expect(
      (await send(`${path}/c-00000000`, 'PATCH', { body: 'x' })).status
    ).toBe(404);
  });

  it('stamps new tasks with their creator', async () => {
    const doc = await json<TaskDoc>(await send(`/api/tasks/${taskId}`, 'GET'));
    expect(doc.meta.creator).not.toBeNull();
  });

  it('broadcasts comment.changed, not task.changed', async () => {
    const events = new EventBus();
    const seen: ServerEvent[] = [];
    events.subscribe((event) => seen.push(event));
    const res = await addComment(
      new Request('http://x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'hi' }),
      }),
      {
        rootDir: root,
        store: new TaskStore(root),
        events,
        actorContext: { humanRef: 'human:wyat' } as unknown as ActorContext,
      },
      taskId
    );
    const comment = await json<TaskComment>(res);
    expect(comment.author).toBe('human:wyat');
    expect(seen).toEqual([
      { type: 'comment.changed', taskId, commentIds: [comment.id] },
    ]);
  });

  it("credits a run's agent token comment to that run's executor", async () => {
    const res = await addComment(
      new Request('http://x', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'progress', runId: 'r-abc123' }),
      }),
      {
        rootDir: root,
        store: new TaskStore(root),
        events: new EventBus(),
        caller: {
          handle: 'wyat',
          ref: 'human:wyat',
          tier: 'request',
          agentToken: true,
        },
        actorContext: {
          humanRef: 'human:wyat',
          agentRef: (executor: string) => `agent:wyat/${executor}`,
        } as unknown as ActorContext,
        orchestrator: {
          getRun: (id: string) =>
            id === 'r-abc123' ? { meta: { executor: 'claude' } } : null,
        } as unknown as Orchestrator,
      },
      taskId
    );
    expect((await json<TaskComment>(res)).author).toBe('agent:wyat/claude');
  });
});
