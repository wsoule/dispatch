import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { LinearDocsAdapter } from '../src/docs/linear.js';
import type { DocsService } from '../src/docs/service.js';
import { EventBus } from '../src/events.js';
import {
  emptyLinearState,
  readLinearState,
  writeLinearState,
} from '../src/linear/state.js';
import { LinearSync } from '../src/linear/sync.js';
import type { FakeDocsHost } from './docs/fakeHost.js';
import { DECIDER, makeService, OWNER, TEAMMATE } from './docs/fakeHost.js';
import { FakeLinearClient, VIEWER } from './linearFake.js';

// The P2 pass with Linear documents wired in: a fake Linear client, a real
// docs service on an in-memory store. Nothing here reaches a real Linear.
let root: string;
let store: TaskStore;
let fake: FakeLinearClient;
let service: DocsService;
let host: FakeDocsHost;
let taskId: string;
const originalHome = process.env.DISPATCH_HOME;

function writeConfig(direction: 'both' | 'pull' | 'push' = 'both'): void {
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    `statuses: [backlog, todo, in-progress, in-review, done, cancelled]\nautoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n  direction: ${direction}\n`
  );
}

function makeSync(): LinearSync {
  return new LinearSync({
    rootDir: root,
    store,
    cache: new TaskCache(),
    events: new EventBus(),
    client: fake,
    documents: {
      adapter: (link) => new LinearDocsAdapter({ ...link, service }),
      outstanding: () => service.linearOutstanding(),
    },
  });
}

beforeEach(() => {
  process.env.DISPATCH_HOME = mkdtempSync(join(tmpdir(), 'dispatch-ld-home-'));
  root = mkdtempSync(join(tmpdir(), 'dispatch-ld-'));
  store = TaskStore.init(root);
  fake = new FakeLinearClient();
  writeConfig();
  ({ service, host } = makeService());
  const task = store.create({ title: 'Linked' }, '2026-07-01T00:00:00.000Z');
  store.update(
    task.meta.id,
    { external: 'linear:iss-1' },
    '2026-07-01T00:00:00.000Z'
  );
  taskId = task.meta.id;
  host.tasks.set(taskId, {
    id: taskId,
    title: 'Linked',
    body: '',
    parent: null,
    risk: 'routine',
    labels: [],
  });
  fake.issues = [fake.issue({ id: 'iss-1', title: 'Linked' })];
  writeLinearState(root, {
    ...emptyLinearState(),
    bootstrappedAt: '2020-01-01T00:00:00.000Z',
    lastPushAt: '2030-01-01T00:00:00.000Z',
  });
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
});

describe('LinearSync documents', () => {
  it('pulls a Linear document under a linked issue into a draft linked to its task, and keeps a cursor', async () => {
    fake.documentList = [
      {
        id: 'doc-a',
        title: 'Plan',
        content: '# Plan\n',
        updatedAt: '2026-09-26T10:00:00.000Z',
        updatedBy: VIEWER.id,
        parent: { kind: 'issue', id: 'iss-1' },
      },
    ];
    const summary = await makeSync().syncOnce();
    expect(summary.errors).toEqual([]);
    const plan = service.read(service.actorFor(OWNER), 'plan');
    expect(plan.doc).toMatchObject({
      origin: 'linear:doc-a',
      unreviewed: true,
    });
    expect(plan.links.map((l) => l.target.id)).toEqual([taskId]);
    expect(readLinearState(root).documentCursor).toBe(
      '2026-09-26T10:00:00.000Z'
    );
    // The next pass asks only for what changed since.
    fake.documentSince = [];
    await makeSync().syncOnce();
    expect(fake.documentSince).toEqual(['2026-09-26T10:00:00.000Z']);
  });

  it("pushes a Linear-origin doc's local edit on the next pass, and never in pull-only mode", async () => {
    fake.documentList = [
      {
        id: 'doc-a',
        title: 'Plan',
        content: 'v1\n',
        updatedAt: '2026-09-26T10:00:00.000Z',
        updatedBy: null,
        parent: null,
      },
    ];
    await makeSync().syncOnce();
    const owner = service.actorFor(OWNER);
    service.edit(owner, 'plan', { ops: [{ op: 'append', text: 'local' }] });
    service.seal(owner, 'plan');
    writeConfig('pull');
    await makeSync().syncOnce();
    expect(fake.documentWrites).toEqual([]);
    writeConfig('both');
    const summary = await makeSync().syncOnce();
    expect(summary.errors).toEqual([]);
    expect(fake.documentWrites).toEqual([
      { id: 'doc-a', content: 'v1\nlocal\n' },
    ]);
    expect(service.linearOutstanding()).toEqual([]);
  });

  it('wakes an idle poll for a Linear document edit or a local doc edit, and stays idle otherwise', async () => {
    const at = (offsetMs: number) =>
      new Date(Date.now() + offsetMs).toISOString();
    fake.documentList = [
      {
        id: 'doc-a',
        title: 'Plan',
        content: 'v1\n',
        updatedAt: at(0),
        updatedBy: null,
        parent: null,
      },
    ];
    const sync = makeSync();
    await sync.syncOnce();
    fake.documentSince = [];
    await sync.pollOnce();
    expect(fake.documentSince).toEqual([]);

    fake.documentList[0] = {
      ...fake.documentList[0],
      content: 'v2\n',
      updatedAt: at(60_000),
    };
    await sync.pollOnce();
    expect(service.read(service.actorFor(OWNER), 'plan').text).toBe('v2\n');

    const owner = service.actorFor(OWNER);
    service.edit(owner, 'plan', { ops: [{ op: 'append', text: 'local' }] });
    await sync.pollOnce();
    expect(fake.documentWrites.at(-1)?.content).toBe('v2\nlocal\n');
  });

  it('shares a doc to the Linear issue its task mirrors, decide tier only', async () => {
    service.create(service.actorFor(OWNER), {
      title: 'Design',
      body: 'x\n',
      links: [{ target: { type: 'task', id: taskId }, rel: 'spec' }],
    });
    const sync = makeSync();
    await expect(
      sync.shareDocument(service.actorFor(TEAMMATE), 'design')
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(fake.calls).toEqual([]);
    const id = await sync.shareDocument(service.actorFor(DECIDER), 'design');
    expect(fake.documentCreates).toEqual([
      { title: 'Design', content: 'x\n', issueId: 'iss-1' },
    ]);
    expect(service.read(service.actorFor(OWNER), 'design').doc.origin).toBe(
      `linear:${id}`
    );
  });
});

describe('LinearSync document webhooks', () => {
  const HOOK_URL = 'https://dispatch.example.com/api/linear/webhook';
  const deliver = (s: LinearSync, data: Record<string, unknown>) => {
    const body = JSON.stringify({
      action: 'update',
      type: 'Document',
      data,
      webhookTimestamp: Date.now(),
    });
    const secret = readLinearState(root).webhook?.secret ?? '';
    return s.handleWebhook(
      body,
      createHmac('sha256', secret).update(body).digest('hex')
    );
  };
  const hooked = () =>
    new LinearSync({
      rootDir: root,
      store,
      cache: new TaskCache(),
      events: new EventBus(),
      client: fake,
      webhookUrl: HOOK_URL,
      webhookDebounceMs: 0,
      pushDebounceMs: 60_000,
      documents: {
        adapter: (link) => new LinearDocsAdapter({ ...link, service }),
        outstanding: () => service.linearOutstanding(),
      },
    });

  it('subscribes to documents, and applies a delivered document edit at once', async () => {
    const sync = hooked();
    sync.start();
    await sync.syncOnce();
    const [hook] = [...fake.webhooks.values()];
    expect(hook.resourceTypes).toContain('Document');
    fake.documentList = [
      {
        id: 'doc-a',
        title: 'Plan',
        content: 'v1\n',
        updatedAt: fake.stamp(),
        updatedBy: null,
        parent: { kind: 'issue', id: 'iss-1' },
      },
    ];
    fake.calls = [];
    expect(deliver(sync, { id: 'doc-a' }).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await sync.idle();
    expect(fake.calls).toContain('document');
    expect(fake.calls).not.toContain('documents');
    const plan = service.read(service.actorFor(OWNER), 'plan');
    expect(plan.text).toBe('v1\n');
    expect(plan.links.map((l) => l.target.id)).toEqual([taskId]);
    await sync.stop();
  });

  it('re-registers a hook made before documents were subscribed', async () => {
    const sync = hooked();
    await sync.syncOnce();
    const before = readLinearState(root).webhook;
    if (before === null) throw new Error('no webhook registered');
    // A registration from before Document joined the subscribed types.
    const { resourceTypes: _types, ...legacy } = before;
    writeLinearState(root, { ...readLinearState(root), webhook: legacy });
    await sync.syncOnce();
    const [hook] = [...fake.webhooks.values()];
    expect(fake.webhooks.size).toBe(1);
    expect(hook.resourceTypes).toContain('Document');
    expect(readLinearState(root).webhook?.id).not.toBe(before.id);
    await sync.stop();
  });
});
