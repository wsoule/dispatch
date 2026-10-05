import { FileCommentStore, TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TaskCache } from '../src/cache.js';
import { EventBus } from '../src/events.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { readLinearState, writeLinearState } from '../src/linear/state.js';
import { LinearSync } from '../src/linear/sync.js';
import {
  parseWebhook,
  verifyLinearSignature,
  webhookFresh,
  webhookUrlFor,
} from '../src/linear/webhook.js';
import { FakeLinearClient, TEAMMATE, VIEWER } from './linearFake.js';
import { rawFetch, useTestAuth } from './testAuth.js';

const SECRET = 'a'.repeat(64);
const HOOK_URL = 'https://dispatch.example.com/api/linear/webhook';

function sign(body: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

function delivery(
  type: string,
  action: 'create' | 'update' | 'remove',
  data: Record<string, unknown>,
  webhookTimestamp = Date.now()
): string {
  return JSON.stringify({
    action,
    type,
    data,
    createdAt: new Date().toISOString(),
    organizationId: 'org',
    webhookId: 'wh-1',
    webhookTimestamp,
  });
}

describe('signature and payload checks', () => {
  const body = delivery('Issue', 'update', { id: 'i-1' });

  it('accepts only the HMAC of the exact body under the secret', () => {
    expect(verifyLinearSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyLinearSignature(body, sign(body).toUpperCase(), SECRET)).toBe(
      true
    );
    expect(verifyLinearSignature(`${body} `, sign(body), SECRET)).toBe(false);
    expect(
      verifyLinearSignature(body, sign(body, 'b'.repeat(64)), SECRET)
    ).toBe(false);
  });

  it('refuses a missing, short or non-hex signature before comparing', () => {
    expect(verifyLinearSignature(body, null, SECRET)).toBe(false);
    expect(verifyLinearSignature(body, sign(body).slice(2), SECRET)).toBe(
      false
    );
    expect(verifyLinearSignature(body, 'z'.repeat(64), SECRET)).toBe(false);
  });

  it('refuses a delivery more than a minute off our clock', () => {
    const now = Date.now();
    expect(webhookFresh(now - 30_000, now)).toBe(true);
    expect(webhookFresh(now - 61_000, now)).toBe(false);
    expect(webhookFresh(now + 61_000, now)).toBe(false);
    expect(webhookFresh(String(now), now)).toBe(false);
  });

  it('parses a delivery and rejects anything else', () => {
    expect(
      parseWebhook(delivery('Comment', 'remove', { id: 'c-1' }))
    ).toMatchObject({
      action: 'remove',
      type: 'Comment',
      id: 'c-1',
    });
    expect(parseWebhook('not json')).toBeNull();
    expect(
      parseWebhook(
        JSON.stringify({ action: 'update', type: 'Issue', data: {} })
      )
    ).toBeNull();
    expect(
      parseWebhook(
        JSON.stringify({ action: 'poke', type: 'Issue', data: { id: 'x' } })
      )
    ).toBeNull();
  });

  it('delivers only to a public https origin', () => {
    expect(webhookUrlFor(['http://dispatch.example.com'])).toBeNull();
    expect(
      webhookUrlFor(['https://localhost:8443', 'https://192.168.1.4:8443'])
    ).toBeNull();
    expect(
      webhookUrlFor(['http://a.example.com', 'https://dispatch.example.com/'])
    ).toBe(HOOK_URL);
  });
});

describe('LinearSync webhooks', () => {
  let root: string;
  let store: TaskStore;
  let comments: FileCommentStore;
  let fake: FakeLinearClient;
  let sync: LinearSync;
  const originalHome = process.env.DISPATCH_HOME;

  function writeConfig(enabled = true): void {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      `autoCommit: false\nlinear:\n  enabled: ${enabled}\n  teamId: team-1\n`
    );
  }

  function makeSync(webhookUrl: string | null = HOOK_URL): LinearSync {
    return new LinearSync({
      rootDir: root,
      store,
      cache: new TaskCache(),
      events: new EventBus(),
      comments,
      client: fake,
      localHumanRef: 'human:wyat',
      webhookUrl,
      webhookDebounceMs: 0,
      pushDebounceMs: 60_000,
    });
  }

  // Lets the debounced targeted pass start and finish.
  async function settle(s: LinearSync): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await s.idle();
  }

  function deliver(s: LinearSync, body: string) {
    return s.handleWebhook(
      body,
      sign(body, readLinearState(root).webhook?.secret)
    );
  }

  beforeEach(() => {
    process.env.DISPATCH_HOME = mkdtempSync(
      join(tmpdir(), 'dispatch-lwh-home-')
    );
    root = mkdtempSync(join(tmpdir(), 'dispatch-lwh-'));
    store = TaskStore.init(root);
    comments = new FileCommentStore(root);
    fake = new FakeLinearClient();
    fake.members = [VIEWER, TEAMMATE];
    writeConfig();
    sync = makeSync();
    sync.start();
  });

  afterEach(async () => {
    await sync.stop();
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
  });

  it('registers a webhook for the team and slows polling to a safety net', async () => {
    await sync.syncOnce();

    const [hook] = [...fake.webhooks.values()];
    expect(hook).toMatchObject({
      url: HOOK_URL,
      teamId: 'team-1',
      label: 'Dispatch',
    });
    expect(hook.resourceTypes).toContain('Issue');
    expect(hook.resourceTypes).toContain('Comment');
    const status = sync.status().webhook;
    expect(status.state).toBe('active');
    expect(status.pollSec).toBeGreaterThanOrEqual(300);
    expect(readLinearState(root).webhook?.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps polling and says why when registration fails, retrying only later', async () => {
    fake.failures.createWebhook = {
      ok: false,
      kind: 'graphql',
      error: 'admin required',
    };
    await sync.syncOnce();
    expect(sync.status().webhook).toMatchObject({
      state: 'error',
      error: 'admin required',
      pollSec: 30,
    });

    fake.calls = [];
    await sync.syncOnce();
    expect(fake.calls).not.toContain('createWebhook');
  });

  it('removes the webhook when the daemon loses its public URL, or sync turns off', async () => {
    await sync.syncOnce();
    await sync.stop();
    sync = makeSync(null);
    sync.start();
    await sync.syncOnce();
    expect(fake.webhooks.size).toBe(0);
    expect(sync.status().webhook.state).toBe('polling');

    await sync.stop();
    sync = makeSync();
    sync.start();
    await sync.syncOnce();
    expect(fake.webhooks.size).toBe(1);
    writeConfig(false);
    sync.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.webhooks.size).toBe(0);
  });

  it('removes the webhook before forgetting the key', async () => {
    await sync.syncOnce();
    await sync.disconnect();
    expect(fake.webhooks.size).toBe(0);
    expect(readLinearState(root).webhook).toBeNull();
  });

  it('answers 404 with no webhook, 401 for a bad or stale signature', async () => {
    const body = delivery('Issue', 'update', { id: 'x' });
    expect(sync.handleWebhook(body, sign(body)).status).toBe(404);
    await sync.syncOnce();
    expect(sync.handleWebhook(body, sign(body, 'f'.repeat(64))).status).toBe(
      401
    );
    const stale = delivery(
      'Issue',
      'update',
      { id: 'x' },
      Date.now() - 120_000
    );
    expect(deliver(sync, stale).status).toBe(401);
    expect(deliver(sync, 'garbage').status).toBe(400);
  });

  it('applies an issue update at once, through the same mapping', async () => {
    const issue = fake.issue({ title: 'Before' });
    fake.issues.push(issue);
    await sync.importIssues();
    await sync.syncOnce();
    issue.title = 'After';
    issue.priority = 1;
    issue.updatedAt = fake.stamp();
    fake.calls = [];

    const reply = deliver(
      sync,
      delivery('Issue', 'update', { id: issue.id, updatedAt: issue.updatedAt })
    );
    await settle(sync);

    expect(reply.status).toBe(200);
    expect(fake.calls).toContain('issuesByIds');
    expect(fake.calls).not.toContain('issuesUpdatedSince');
    const doc = store
      .list()
      .find((d) => d.meta.external === `linear:${issue.id}`);
    expect(doc?.meta.title).toBe('After');
    expect(doc?.meta.priority).toBe('urgent');
  });

  it('archives and unlinks the task of an issue deleted in Linear', async () => {
    const issue = fake.issue();
    fake.issues.push(issue);
    await sync.importIssues();
    await sync.syncOnce();

    deliver(sync, delivery('Issue', 'remove', { id: issue.id }));
    await settle(sync);

    const doc = store.list()[0];
    expect(doc.meta.external).toBeNull();
    expect(doc.meta.archivedAt).toBeDefined();
  });

  it('adds a comment made in Linear, and removes one deleted there', async () => {
    const issue = fake.issue();
    fake.issues.push(issue);
    await sync.importIssues();
    await sync.syncOnce();
    const at = fake.stamp();
    fake.commentList.push({
      id: 'cm-new',
      issueId: issue.id,
      body: 'Hello from Linear',
      userId: TEAMMATE.id,
      parentId: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
    });
    const taskId = store.list()[0].meta.id;

    deliver(
      sync,
      delivery('Comment', 'create', { id: 'cm-new', updatedAt: at })
    );
    await settle(sync);
    expect(comments.list(taskId).map((c) => c.body)).toEqual([
      'Hello from Linear',
    ]);

    deliver(sync, delivery('Comment', 'remove', { id: 'cm-new' }));
    await settle(sync);
    expect(comments.list(taskId)).toEqual([]);
  });

  it('skips a delivery that only echoes its own write', async () => {
    const issue = fake.issue();
    fake.issues.push(issue);
    await sync.importIssues();
    await sync.syncOnce();
    const doc = store.list()[0];
    store.update(
      doc.meta.id,
      { title: 'Pushed' },
      new Date(Date.now() + 1000).toISOString()
    );
    await sync.syncOnce();
    const echoed = fake.issues[0];
    fake.calls = [];

    deliver(
      sync,
      delivery('Issue', 'update', {
        id: echoed.id,
        updatedAt: echoed.updatedAt,
      })
    );
    await settle(sync);

    expect(fake.calls).not.toContain('issuesByIds');
  });
});

describe('POST /api/linear/webhook', () => {
  let handle: ServerHandle;
  let base: string;
  let root: string;
  const originalHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    process.env.DISPATCH_HOME = mkdtempSync(
      join(tmpdir(), 'dispatch-lwa-home-')
    );
    root = mkdtempSync(join(tmpdir(), 'dispatch-lwa-'));
    TaskStore.init(root);
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
      linearClient: new FakeLinearClient(),
    });
    useTestAuth(handle);
    base = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalHome;
  });

  it('reaches the signature check without a daemon token', async () => {
    const body = delivery('Issue', 'update', { id: 'x' });
    const noHook = await rawFetch(`${base}/api/linear/webhook`, {
      method: 'POST',
      body,
    });
    expect(noHook.status).toBe(404);

    const state = readLinearState(root);
    state.webhook = {
      id: 'wh',
      url: HOOK_URL,
      secret: SECRET,
      teamId: 'team-1',
      createdAt: '',
    };
    writeLinearState(root, state);
    const forged = await rawFetch(`${base}/api/linear/webhook`, {
      method: 'POST',
      body,
      headers: { 'linear-signature': sign(body, 'c'.repeat(64)) },
    });
    expect(forged.status).toBe(401);
    const signed = await rawFetch(`${base}/api/linear/webhook`, {
      method: 'POST',
      body,
      headers: { 'linear-signature': sign(body) },
    });
    expect(signed.status).toBe(200);
  });

  it('opens nothing else: every neighboring route still wants a token', async () => {
    for (const [method, path] of [
      ['GET', '/api/linear/webhook'],
      ['POST', '/api/linear/webhook/extra'],
      ['POST', '/api/linear/sync'],
      ['GET', '/api/linear/status'],
      ['POST', '/api/linear/webhooks'],
    ] as const) {
      const res = await rawFetch(`${base}${path}`, { method });
      expect(`${method} ${path} ${res.status}`).toBe(`${method} ${path} 401`);
    }
  });

  it('refuses an oversized delivery before reading it', async () => {
    const res = await rawFetch(`${base}/api/linear/webhook`, {
      method: 'POST',
      body: 'x'.repeat(1_000_001),
    });
    expect(res.status).toBe(413);
  });

  // A body that never ends: the daemon must stop reading near the cap rather
  // than buffer until the server's own request limit.
  it('cuts off an oversized delivery that declares no length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const res = await rawFetch(`${base}/api/linear/webhook`, {
      method: 'POST',
      body,
    });
    expect(res.status).toBe(413);
    expect(sent).toBeLessThan(16 * 1024 * 1024);
  });
});
