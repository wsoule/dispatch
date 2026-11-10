import { IpLimiter } from '@dispatch-foo/a2a';
import type { IntakeRequestRow, TaskFacts } from '@dispatch-foo/a2a';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import type { IntakeWebhookPayload } from '../../src/a2a/intake.js';
import {
  IntakeNotifier,
  IntakePages,
  mintIntakeLink,
  redactIntakePath,
  requestBody,
} from '../../src/a2a/intake.js';
import { useTempProject, waitFor } from '../messaging/harness.js';
import { bridgeFixture } from './fixture.js';

const project = useTempProject();
let f: Awaited<ReturnType<typeof bridgeFixture>>;
let pages: IntakePages;
let limiter: IpLimiter;
let submitted: { request: IntakeRequestRow; path: string; facts: TaskFacts }[];

const BASE = 'https://requests.example.com';
const clientStatus = (address: string) =>
  f.messaging.store.getAgent(address)?.status ?? null;

beforeEach(async () => {
  f = await bridgeFixture(project.root());
  limiter = new IpLimiter();
  submitted = [];
  pages = new IntakePages({
    store: f.store,
    port: f.port,
    clientStatus,
    limiter,
    submitted: (request, path, facts) =>
      submitted.push({ request, path, facts }),
  });
});
afterEach(() => f.close());

function mint(label = 'Feature requests') {
  return mintIntakeLink(f.store, clientStatus, {
    client: f.caller.address,
    label,
    createdBy: 'human:wyat',
  });
}

const get = (path: string, ip = '203.0.113.5') =>
  pages.handle(new Request(`${BASE}${path}`), ip);

const post = (
  path: string,
  fields: Record<string, string>,
  ip = '203.0.113.5'
) =>
  pages.handle(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
    }),
    ip
  );

// Submits the form and returns the status path the 303 points at.
async function submit(
  token: string,
  fields: Record<string, string> = {
    title: 'Export to CSV',
    details: 'We need the report as CSV.',
    name: 'Jane Doe',
    contact: 'jane@example.com',
  }
): Promise<string> {
  const res = await post(`/r/${token}`, fields);
  expect(res.status).toBe(303);
  const location = res.headers.get('location')!;
  expect(location).toMatch(/^\.\.\/s\/[0-9a-f]{64}$/);
  return location.slice('..'.length);
}

const page = async (path: string) => {
  const res = await get(path);
  return { status: res.status, text: await res.text(), res };
};

// The one request this test submitted: its A2A row, gate and draft.
function only() {
  expect(submitted).toHaveLength(1);
  const row = f.store.getTask(submitted[0].request.taskId)!;
  return { row, draft: f.tasks.get(row.dispatchTask!)! };
}

const decide = (gate: string, choice: 'approve' | 'decline') =>
  f.messaging.engine.reply(
    gate,
    { body: '', choice },
    { address: 'human:wyat', canDecide: true }
  );

describe('intake links', () => {
  it('mints only for an approved client, and keeps only the token hash', () => {
    const { row, token } = mint();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(f.store.intakeLink(row.id)?.tokenHash).not.toBe(token);
    expect(() =>
      mintIntakeLink(f.store, clientStatus, {
        client: 'agent:wyat/a2a.nobody',
        label: 'x',
        createdBy: 'human:wyat',
      })
    ).toThrow('no A2A client');
    const pending = f.addClient('pending');
    f.messaging.store.putAgent({
      ...f.messaging.store.getAgent(pending.address)!,
      status: 'pending',
    });
    expect(() =>
      mintIntakeLink(f.store, clientStatus, {
        client: pending.address,
        label: 'x',
        createdBy: 'human:wyat',
      })
    ).toThrow('not approved');
    expect(() => mint('   ')).toThrow('label');
  });

  it('serves the form with headers that keep the capability URL private', async () => {
    const { token } = mint('Ask the <b>team</b>');
    const { status, text, res } = await page(`/r/${token}`);
    expect(status).toBe(200);
    expect(text).toContain('Ask the &lt;b&gt;team&lt;/b&gt;');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-security-policy')).toContain(
      "default-src 'none'"
    );
    expect(res.headers.get('content-security-policy')).toContain(
      "form-action 'self'"
    );
  });

  it('answers unknown tokens with one 404 and locks out an IP that keeps guessing', async () => {
    const miss = await page(`/r/${'0'.repeat(64)}`);
    expect(miss.status).toBe(404);
    expect((await page('/s/not-a-token')).status).toBe(404);
    // The listener's limiter locks an IP out past ten misses a minute.
    for (let i = 0; i < 11; i++)
      await get(`/s/${'1'.repeat(64)}`, '198.51.100.9');
    const locked = await get(`/r/${mint().token}`, '198.51.100.9');
    expect(locked.status).toBe(429);
    // A malformed token is a miss too.
    for (let i = 0; i < 11; i++) await get('/s/not-a-token', '198.51.100.11');
    expect((await get(`/r/${mint().token}`, '198.51.100.11')).status).toBe(429);
    // Another IP is unaffected.
    expect((await get(`/r/${mint().token}`, '198.51.100.10')).status).toBe(200);
  });

  it('redacts tokens from logged paths', () => {
    expect(redactIntakePath(`/r/${'a'.repeat(64)}`)).toBe('/r/…');
    expect(redactIntakePath(`/s/${'b'.repeat(64)}`)).toBe('/s/…');
    expect(redactIntakePath('/a2a/v1/tasks')).toBe('/a2a/v1/tasks');
  });
});

describe('submitting a request', () => {
  it('becomes a fenced A2A draft awaiting the owner, with the sender named', async () => {
    const { token } = mint();
    const statusPath = await submit(token);
    const { row, draft } = only();
    expect(row.client).toBe(f.caller.address);
    expect(row.skill).toBe('handoff');
    expect(row.gate).not.toBeNull();
    expect(draft.meta.status).toBe('draft');
    expect(draft.meta.labels).toContain('a2a');
    expect(draft.meta.risk).toBe('critical');
    expect(draft.meta.title).toBe('Export to CSV');
    expect(draft.body).toContain('From: Jane Doe (jane@example.com)');
    expect(draft.body).toContain('name and contact are unverified');
    expect(submitted[0].path).toBe(statusPath);
    expect(submitted[0].request.contact).toBe('jane@example.com');
    const status = await page(statusPath);
    expect(status.status).toBe(200);
    expect(status.text).toContain(
      'Received: waiting for the team to accept it.'
    );
    // Open requests refresh; the page names no task id or client.
    expect(status.text).toContain('http-equiv="refresh"');
    expect(status.text).not.toContain(draft.meta.id);
    expect(status.text).not.toContain(f.caller.address);
  });

  it('re-renders the form with the error and the values when a field is missing', async () => {
    const { token } = mint();
    const res = await post(`/r/${token}`, {
      title: '',
      name: 'Jane',
      details: 'keep me',
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain('Please fill in what you need.');
    expect(text).toContain('keep me');
    expect(submitted).toHaveLength(0);
  });

  it('refuses a body that is not a urlencoded form', async () => {
    const { token } = mint();
    // Well-formed pairs under another type: only the type refuses them.
    const res = await pages.handle(
      new Request(`${BASE}/r/${token}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: 'title=x&name=y',
      }),
      '203.0.113.5'
    );
    expect(res.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });

  it('escapes what the requester wrote on the status page', async () => {
    const { token } = mint();
    const path = await submit(token, {
      title: '<script>alert(1)</script>',
      name: 'Jane',
    });
    const { text } = await page(path);
    expect(text).not.toContain('<script>alert(1)</script>');
    expect(text).toContain('&lt;script&gt;');
  });

  it('stops taking requests once the link or its client is revoked, while sent requests stay readable', async () => {
    const { row: link, token } = mint();
    const path = await submit(token);
    f.store.revokeIntakeLink(link.id, new Date().toISOString());
    expect((await page(`/r/${token}`)).status).toBe(404);
    expect((await page(path)).status).toBe(200);

    const second = mint();
    f.messaging.store.putAgent({
      ...f.messaging.store.getAgent(f.caller.address)!,
      status: 'revoked',
    });
    expect((await page(`/r/${second.token}`)).status).toBe(404);
  });

  it("tells the requester when the client's daily handoff limit is used up", async () => {
    await f.close();
    f = await bridgeFixture(project.root(), { handoffsPerDay: 1 });
    pages = new IntakePages({
      store: f.store,
      port: f.port,
      clientStatus,
      limiter,
    });
    const { token } = mint();
    await submit(token);
    const res = await post(`/r/${token}`, { title: 'Again', name: 'Jane' });
    expect(res.status).toBe(429);
    expect(await res.text()).toContain('taking no more requests today');
  });
});

describe('the status page', () => {
  it('follows the task from received to done', async () => {
    const { token } = mint();
    const path = await submit(token);
    const { row, draft } = only();
    const headline = async () => (await page(path)).text;

    await decide(row.gate!, 'approve');
    expect(await headline()).toContain('Accepted: queued for work.');
    f.deps.updateTask(draft.meta.id, { status: 'working' });
    expect(await headline()).toContain('In progress.');
    f.deps.updateTask(draft.meta.id, { status: 'review' });
    expect(await headline()).toContain('In review.');
    f.deps.updateTask(draft.meta.id, { status: 'landed' });
    const done = await headline();
    expect(done).toContain('Done: the change has landed.');
    // A finished request stops refreshing.
    expect(done).not.toContain('http-equiv="refresh"');
  });

  it('shows a declined request as declined', async () => {
    const { token } = mint();
    const path = await submit(token);
    await decide(only().row.gate!, 'decline');
    expect((await page(path)).text).toContain(
      'The team declined this request.'
    );
  });

  it("shows the team's question with a reply form, and a reply answers it", async () => {
    const { token } = mint();
    const path = await submit(token);
    const { row, draft } = only();
    await decide(row.gate!, 'approve');
    const { message: q } = await f.messaging.engine.send(
      {
        to: [f.caller.address],
        kind: 'question',
        blocking: true,
        body: 'Which columns?',
        choices: ['all', 'visible'],
      },
      { address: `task:${draft.meta.id}`, canDecide: false }
    );
    const asked = (await page(path)).text;
    expect(asked).toContain('The team has a question for you.');
    expect(asked).toContain('Which columns?');
    expect(asked).toContain('name="choice" value="visible"');

    const res = await post(path, { choice: 'visible', body: '' });
    expect(res.status).toBe(303);
    expect(f.messaging.engine.answerOf(q.id)).toMatchObject({
      choice: 'visible',
    });
    // With no question open, the page is not a channel into the project.
    const again = await post(path, { body: 'one more thing' });
    expect(again.status).toBe(409);
  });
});

describe('request.changed', () => {
  it('posts once per step, carries the status URL only on the first, and survives a restart', async () => {
    const posts: IntakeWebhookPayload[] = [];
    const fetchImpl = ((_url: string, init: RequestInit) => {
      posts.push(JSON.parse(init.body as string) as IntakeWebhookPayload);
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;
    const notifier = () =>
      new IntakeNotifier({
        rootDir: project.root(),
        store: f.store,
        webhook: () => 'https://hooks.example.com/x',
        publicUrl: () => BASE,
        fetch: fetchImpl,
      });
    const n = notifier();
    const { token } = mint();
    const path = await submit(token);
    const { request, facts } = submitted[0];
    await n.changed(request.taskId, facts, path);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      event: 'request.changed',
      request: {
        id: request.id,
        step: 'received',
        name: 'Jane Doe',
        contact: 'jane@example.com',
        title: 'Export to CSV',
        statusUrl: `${BASE}${path}`,
      },
    });

    // The same step again posts nothing.
    await n.changed(request.taskId, facts);
    expect(posts).toHaveLength(1);

    await decide(only().row.gate!, 'approve');
    const accepted = (await f.port.facts(f.caller, request.taskId))!;
    await n.changed(request.taskId, accepted);
    expect(posts).toHaveLength(2);
    expect(posts[1].request.step).toBe('accepted');
    expect(posts[1].request.statusUrl).toBeUndefined();

    // A new notifier over the same a2a.db (a daemon restart) does not re-send.
    await notifier().changed(request.taskId, accepted);
    expect(posts).toHaveLength(2);
  });

  it('ignores A2A tasks no intake request owns, and posts nothing without a webhook', async () => {
    let calls = 0;
    const fetchImpl = (() => {
      calls += 1;
      return Promise.resolve(new Response('ok'));
    }) as unknown as typeof fetch;
    const n = new IntakeNotifier({
      rootDir: project.root(),
      store: f.store,
      webhook: () => undefined,
      publicUrl: () => BASE,
      fetch: fetchImpl,
    });
    const { token } = mint();
    await submit(token);
    const { request, facts } = submitted[0];
    await n.changed(request.taskId, facts);
    await n.changed('m-unrelated', facts);
    expect(calls).toBe(0);
    // The step is still recorded, so a webhook added later starts from now.
    await waitFor(
      () =>
        f.store.intakeRequestForTask(request.taskId)?.notifiedStep ===
        'received'
    );
  });
});

describe('requestBody', () => {
  it('names the sender and marks the claim unverified', () => {
    expect(requestBody({ name: 'Jo', contact: '', details: '' })).toBe(
      'From: Jo\nSent through an intake link; name and contact are unverified.'
    );
  });
});
