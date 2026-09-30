import { FileCommentStore, TaskStore } from '@dispatch/core';
import type { LinearComment, LinearIssue } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerEvent } from '../src/events.js';
import { LinearSync } from '../src/linear/sync.js';
import { FakeLinearClient, TEAMMATE, VIEWER } from './linearFake.js';

let root: string;
let store: TaskStore;
let comments: FileCommentStore;
let events: EventBus;
let broadcasts: ServerEvent[];
let fake: FakeLinearClient;
let sync: LinearSync;
const originalHome = process.env.DISPATCH_HOME;

function remoteComment(
  issue: LinearIssue,
  overrides: Partial<LinearComment> = {}
): LinearComment {
  const at = '2026-07-06T00:00:00.000Z';
  return {
    id: `cm-${Math.random().toString(16).slice(2, 10)}`,
    issueId: issue.id,
    body: 'From Linear',
    userId: TEAMMATE.id,
    parentId: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    ...overrides,
  };
}

// An imported issue and its task, with the given remote comments pulled.
async function importWith(
  build: (issue: LinearIssue) => LinearComment[]
): Promise<{ issue: LinearIssue; taskId: string }> {
  const issue = fake.issue();
  fake.issues.push(issue);
  fake.commentList = build(issue);
  await sync.importIssues();
  const task = store
    .list()
    .find((d) => d.meta.external === `linear:${issue.id}`);
  if (task === undefined) throw new Error('import did not link the issue');
  fake.calls = [];
  return { issue, taskId: task.meta.id };
}

function localChanged(taskId: string, ids: string[]): void {
  sync.notifyCommentChanged(taskId, ids);
}

beforeEach(() => {
  process.env.DISPATCH_HOME = mkdtempSync(join(tmpdir(), 'dispatch-lcs-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-lcs-'));
  store = TaskStore.init(root);
  comments = new FileCommentStore(root);
  events = new EventBus();
  broadcasts = [];
  events.subscribe((event) => broadcasts.push(event));
  fake = new FakeLinearClient();
  fake.members = [VIEWER, TEAMMATE];
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    'autoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n'
  );
  sync = new LinearSync({
    rootDir: root,
    store,
    cache: new TaskCache(),
    events,
    comments,
    client: fake,
    localHumanRef: 'human:wyat',
    pushDebounceMs: 60_000,
  });
  // Enables the change notifications; the debounced push never fires here.
  sync.start();
});

afterEach(async () => {
  await sync.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
});

describe('pulling comments', () => {
  it('imports a thread with its authors, times and nesting', async () => {
    const { taskId } = await importWith((issue) => {
      const top = remoteComment(issue, { id: 'cm-top', body: 'Top' });
      return [
        top,
        remoteComment(issue, {
          id: 'cm-reply',
          body: 'Reply',
          userId: VIEWER.id,
          parentId: 'cm-top',
          createdAt: '2026-07-07T00:00:00.000Z',
          updatedAt: '2026-07-07T00:00:00.000Z',
        }),
      ];
    });

    const [top, reply] = comments.list(taskId);
    expect(top).toMatchObject({
      body: 'Top',
      author: 'human:ana',
      external: 'linear:cm-top',
      parentId: null,
      created: '2026-07-06T00:00:00.000Z',
    });
    expect(reply).toMatchObject({
      body: 'Reply',
      author: 'human:wyat',
      parentId: top.id,
    });
    expect(
      broadcasts.some(
        (e) => e.type === 'comment.changed' && e.taskId === taskId
      )
    ).toBe(true);
  });

  it('applies an edit made in Linear and removes an archived comment', async () => {
    const { taskId } = await importWith((issue) => [
      remoteComment(issue, { id: 'cm-a', body: 'Old' }),
      remoteComment(issue, { id: 'cm-b', body: 'Doomed' }),
    ]);
    const [a, b] = fake.commentList;
    a.body = 'New';
    a.updatedAt = fake.stamp();
    b.archivedAt = fake.stamp();
    b.updatedAt = b.archivedAt;

    await sync.syncOnce();

    expect(comments.list(taskId).map((c) => c.body)).toEqual(['New']);
    expect(fake.calls).not.toContain('updateComment');
  });

  it('never pushes back a comment it just pulled', async () => {
    await importWith((issue) => [remoteComment(issue)]);
    await sync.syncOnce();
    expect(fake.calls).not.toContain('createComment');
    expect(fake.calls).not.toContain('updateComment');
  });

  it('drops a twin whose Linear comment is gone when an import reads them all', async () => {
    const { taskId } = await importWith((issue) => [
      remoteComment(issue, { id: 'cm-gone' }),
    ]);
    fake.commentList = [];

    await sync.importIssues();

    expect(comments.list(taskId)).toEqual([]);
  });
});

describe('pushing comments', () => {
  it('creates a local comment in Linear and links it', async () => {
    const { issue, taskId } = await importWith(() => []);
    const mine = comments.add({ taskId, author: 'human:wyat', body: 'Mine' });
    localChanged(taskId, [mine.id]);

    await sync.syncOnce();

    const remote = fake.commentList.find((c) => c.body === 'Mine');
    expect(remote?.issueId).toBe(issue.id);
    expect(comments.get(taskId, mine.id)?.external).toBe(
      `linear:${remote?.id}`
    );

    fake.calls = [];
    await sync.syncOnce();
    expect(fake.calls).not.toContain('createComment');
  });

  it('threads a reply to a reply under the thread’s top comment', async () => {
    const { taskId } = await importWith((issue) => [
      remoteComment(issue, { id: 'cm-root', body: 'Root' }),
    ]);
    const root = comments.list(taskId)[0];
    const reply = comments.add({
      taskId,
      author: 'human:wyat',
      body: 'Reply',
      parentId: root.id,
    });
    const deeper = comments.add({
      taskId,
      author: 'human:wyat',
      body: 'Deeper',
      parentId: reply.id,
    });
    localChanged(taskId, [reply.id, deeper.id]);

    await sync.syncOnce();

    const sent = fake.commentList.filter((c) => c.id !== 'cm-root');
    expect(sent.map((c) => [c.body, c.parentId])).toEqual([
      ['Reply', 'cm-root'],
      ['Deeper', 'cm-root'],
    ]);
  });

  it('sends an edit and a delete made here', async () => {
    const { taskId } = await importWith((issue) => [
      remoteComment(issue, { id: 'cm-1', body: 'Edit me', userId: VIEWER.id }),
      remoteComment(issue, {
        id: 'cm-2',
        body: 'Delete me',
        userId: VIEWER.id,
      }),
    ]);
    const twin = (remoteId: string) => {
      const found = comments
        .list(taskId)
        .find((c) => c.external === `linear:${remoteId}`);
      if (found === undefined) throw new Error(`no twin for ${remoteId}`);
      return found;
    };
    const edit = twin('cm-1');
    const gone = twin('cm-2');
    comments.update(
      taskId,
      edit.id,
      { body: 'Edited here' },
      new Date(Date.now() + 1000).toISOString()
    );
    comments.remove(taskId, gone.id);
    localChanged(taskId, [edit.id, gone.id]);

    await sync.syncOnce();

    expect(fake.commentList.map((c) => [c.id, c.body])).toEqual([
      ['cm-1', 'Edited here'],
    ]);
  });

  it('lets the newer edit win when both sides changed a comment', async () => {
    const { taskId } = await importWith((issue) => [
      remoteComment(issue, { id: 'cm-x', body: 'Base', userId: VIEWER.id }),
    ]);
    const local = comments.list(taskId)[0];
    comments.update(
      taskId,
      local.id,
      { body: 'Local' },
      '2026-07-08T00:00:00.000Z'
    );
    const remote = fake.commentList[0];
    remote.body = 'Remote';
    remote.updatedAt = fake.stamp();

    await sync.syncOnce();

    expect(comments.get(taskId, local.id)?.body).toBe('Remote');
    expect(fake.commentList[0].body).toBe('Remote');
  });

  it('carries a new task’s comments along when its issue is created', async () => {
    await sync.syncOnce();
    const task = store.create(
      { title: 'Fresh' },
      new Date(Date.now() + 1000).toISOString()
    );
    comments.add({
      taskId: task.meta.id,
      author: 'human:wyat',
      body: 'Context',
    });

    await sync.syncOnce();

    const issue = fake.issues.find((i) => i.title === 'Fresh');
    expect(fake.commentList.map((c) => [c.issueId, c.body])).toEqual([
      [issue?.id ?? 'missing', 'Context'],
    ]);
  });
});
