// End to end: the daemon's own edits reach Linear with the signed-in
// person's token, and everything else with the project connection. The
// project connection is an in-memory FakeLinearClient; the person's client
// is the same fake behind a proxy that authorizes every call with the
// LinearAuth the daemon built (so refresh, 401 renewal and an ended sign-in
// run for real against the OAuth fake) and records which credential each
// write used.
import {
  FileCommentStore,
  readLinearAccount,
  TaskStore,
  writeLinearAccount,
} from '@dispatch-foo/core';
import type { LinearAccountRecord } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { LINEAR_SIGN_IN_ENDED_MESSAGE } from '../src/linear/accounts.js';
import type {
  LinearAuth,
  LinearClient,
  LinearFailure,
} from '../src/linear/client.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  fakeOAuthEndpoints,
} from '../src/linear/oauth.js';
import {
  emptyLinearState,
  readLinearState,
  writeLinearState,
} from '../src/linear/state.js';
import { json } from './json.js';
import { FakeLinearClient, STATES } from './linearFake.js';
import type { Method } from './linearFake.js';
import { LinearOAuthFake } from './linearOAuthFake.js';
import { initGitRepoAt, StallingExecutor } from './orchestrator/helpers.js';
import { licensedManager } from './team/licenseKeys.js';
import { useTestAuth } from './testAuth.js';

const REDIRECT = 'http://127.0.0.1:47823/linear/callback';
const endpoints = fakeOAuthEndpoints('http://linear.fake');
const WRITES: ReadonlySet<string> = new Set([
  'createIssue',
  'updateIssue',
  'archiveIssue',
  'unarchiveIssue',
  'createRelation',
  'deleteRelation',
  'linkAttachment',
  'deleteAttachment',
  'createComment',
  'updateComment',
  'deleteComment',
  'createDocument',
  'createLabel',
]);

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
let stub: FakeLinearClient;
let oauth: LinearOAuthFake;
/** Every write, in order, with the credential it went out with. */
let writes: { method: string; as: 'person' | 'project'; header?: string }[];
/** Every issue create and update, with the credential and the input sent. */
let issueInputs: {
  method: 'createIssue' | 'updateIssue';
  as: 'person' | 'project';
  input: Record<string, unknown>;
}[];
/** Methods the person's client is refused, as Linear would refuse a guest. */
let personRefuses: Set<string>;
const originalHome = process.env.DISPATCH_HOME;

// Records an issue create's or update's input, under who sent it.
function noteInput(
  method: string,
  as: 'person' | 'project',
  args: unknown[]
): void {
  if (method === 'createIssue')
    issueInputs.push({
      method,
      as,
      input: args[0] as Record<string, unknown>,
    });
  if (method === 'updateIssue')
    issueInputs.push({
      method,
      as,
      input: args[1] as Record<string, unknown>,
    });
}

// The project connection: the stub, recording its writes.
function projectClient(): LinearClient {
  return new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        if (WRITES.has(String(prop)))
          writes.push({ method: String(prop), as: 'project' });
        noteInput(String(prop), 'project', args);
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

// The person's client: authorizes each call through `auth` against the
// OAuth fake (one renewal after a dead token, as HttpLinearClient does).
function personClient(auth: LinearAuth): LinearClient {
  return new Proxy(stub, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return async (...args: unknown[]) => {
        let header = await auth.header();
        if (!header.ok) return header;
        if (!oauth.accessAlive(header.value.slice('Bearer '.length))) {
          const renewed = await auth.renew(header.value);
          header = await auth.header();
          if (!header.ok) return header;
          if (!renewed)
            return {
              ok: false,
              kind: 'auth',
              error: 'Authentication required',
            } satisfies LinearFailure;
        }
        const method = String(prop);
        if (WRITES.has(method))
          writes.push({ method, as: 'person', header: header.value });
        noteInput(method, 'person', args);
        if (personRefuses.has(method))
          return {
            ok: false,
            kind: 'graphql',
            error: 'Forbidden: guests cannot do that here',
          } satisfies LinearFailure;
        const result = (await (
          value as (...a: unknown[]) => Promise<unknown>
        ).apply(target, args)) as { ok: boolean; data?: { userId?: string } };
        // The fake answers as its own viewer; Linear would name the person.
        if (
          method === 'createComment' &&
          result.ok &&
          result.data !== undefined
        ) {
          result.data.userId = 'u-ada';
          const stored = stub.commentList.at(-1);
          if (stored !== undefined) stored.userId = 'u-ada';
        }
        return result;
      };
    },
  });
}

// Ada's sign-in, issued by the OAuth fake and stored like a real one.
async function signIn(
  overrides: Partial<LinearAccountRecord> = {}
): Promise<LinearAccountRecord> {
  const pkce = createPkcePair();
  const back = new URL(
    oauth.authorize(
      buildAuthorizeUrl({
        endpoints,
        clientId: 'client-1',
        redirectUri: REDIRECT,
        state: 's',
        challenge: pkce.challenge,
      })
    ) ?? ''
  );
  const tokens = await exchangeCode(
    {
      code: back.searchParams.get('code') ?? '',
      verifier: pkce.verifier,
      clientId: 'client-1',
      redirectUri: REDIRECT,
    },
    { endpoints, fetchImpl: oauth.fetch }
  );
  const record: LinearAccountRecord = {
    version: 1,
    clientId: 'client-1',
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: tokens.scope,
    user: {
      id: 'u-ada',
      name: 'Ada Lovelace',
      displayName: 'ada',
      email: 'ada@example.com',
      guest: false,
      admin: false,
    },
    organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    signedInAt: new Date().toISOString(),
    refreshedAt: null,
    ...overrides,
  };
  await writeLinearAccount(record);
  return record;
}

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-linear-person-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-linear-person-'));
  TaskStore.init(root);
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    'statuses: [backlog, todo, in-progress, in-review, done, cancelled]\nautoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n  direction: both\n  oauthClientId: client-1\n'
  );
  writeLinearState(root, {
    ...emptyLinearState(),
    bootstrappedAt: '2020-01-01T00:00:00.000Z',
  });
  stub = new FakeLinearClient();
  stub.states = STATES;
  oauth = new LinearOAuthFake();
  oauth.registerApp('client-1', [REDIRECT]);
  writes = [];
  issueInputs = [];
  personRefuses = new Set();
  await boot();
});

// Starts the daemon on `root` against the stub and the OAuth fake, then
// runs one pass: it renames the statuses to the team's workflow, a change no
// person made, before any task is written.
async function boot(
  registerExecutors?: Parameters<typeof startServer>[0]['registerExecutors']
): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    linearClient: projectClient(),
    linearCreateClient: (credential) =>
      typeof credential === 'string'
        ? projectClient()
        : personClient(credential),
    linearOAuth: { endpoints, fetchImpl: oauth.fetch },
    ...(registerExecutors === undefined ? {} : { registerExecutors }),
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
  await call('POST', '/linear/sync', {});
  writes = [];
  issueInputs = [];
}

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function call(
  method: string,
  path: string,
  body?: unknown,
  token?: string
): Promise<Response> {
  return fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createTask(title: string, token?: string): Promise<string> {
  const res = await call('POST', '/tasks', { title }, token);
  expect(res.status).toBe(201);
  return ((await json(res)) as { meta: { id: string } }).meta.id;
}

async function patchTask(
  id: string,
  patch: Record<string, unknown>,
  token?: string
): Promise<void> {
  const res = await call('PATCH', `/tasks/${id}`, patch, token);
  expect(res.status).toBe(200);
}

// Runs an explicit push of `ids` and answers its summary.
async function sync(ids: string[]): Promise<{ errors: string[] }> {
  const res = await call('POST', '/linear/sync', { taskIds: ids });
  expect(res.status).toBe(200);
  return (await json(res)) as { errors: string[] };
}

// A task created as `token` and pushed, so it has an issue; writes reset.
async function linkedTask(title: string, token?: string): Promise<string> {
  const id = await createTask(title, token);
  await sync([id]);
  expect(stub.issues).toHaveLength(1);
  writes = [];
  return id;
}

function only(method: Method): typeof writes {
  return writes.filter((w) => w.method === method);
}

describe('issue writes', () => {
  it("creates the owner's new task as the signed-in person", async () => {
    const record = await signIn();
    const id = await createTask('Owner task');
    await sync([id]);
    expect(only('createIssue')).toEqual([
      {
        method: 'createIssue',
        as: 'person',
        header: `Bearer ${record.accessToken}`,
      },
    ]);
  });

  it("updates the owner's edit as the person, and an agent's as the connection", async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    await patchTask(id, { title: 'Owner renamed' });
    await sync([id]);
    expect(only('updateIssue').map((w) => w.as)).toEqual(['person']);
    writes = [];
    await patchTask(id, { title: 'Agent renamed' }, handle.tokens.agentToken);
    await sync([id]);
    expect(only('updateIssue').map((w) => w.as)).toEqual(['project']);
  });

  it("pushes a teammate's edit through the connection", async () => {
    handle.team.license = licensedManager(10);
    await signIn();
    const issued = await call('POST', '/team/tokens', {
      email: 'bo@example.com',
      displayName: 'Bo',
      tier: 'decide',
    });
    const teammate = ((await json(issued)) as { token: string }).token;
    const id = await linkedTask('Owner task');
    await patchTask(id, { title: 'Bo renamed' }, teammate);
    await sync([id]);
    expect(only('updateIssue').map((w) => w.as)).toEqual(['project']);
  });

  it("a push mixing the owner's field with an agent's sends each with its writer's credential", async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    await patchTask(id, { priority: 'high' }, handle.tokens.agentToken);
    await patchTask(id, { title: 'Owner renamed' });
    await sync([id]);
    const updates = issueInputs.filter((i) => i.method === 'updateIssue');
    expect(updates.map((u) => [u.as, Object.keys(u.input)])).toEqual([
      ['person', ['title']],
      ['project', ['priority']],
    ]);
    expect(stub.issues[0]?.title).toBe('Owner renamed');
  });

  it("an agent's value that restores one the owner once set is the agent's", async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    // The owner renames, then changes their mind before the pass: nothing
    // is pushed, and the ledger still remembers their last title.
    await patchTask(id, { title: 'Draft rename' });
    await patchTask(id, { title: 'Owner task' });
    await sync([id]);
    expect(only('updateIssue')).toEqual([]);
    // A teammate renames the issue in Linear, and a pass pulls it.
    const issue = stub.issues[0];
    if (issue === undefined) throw new Error('no issue');
    issue.title = 'Teammate title';
    issue.updatedAt = new Date(Date.now() + 60_000).toISOString();
    await call('POST', '/linear/sync', {});
    const pulled = (await json(await call('GET', `/tasks/${id}`))) as {
      meta: { title: string };
    };
    expect(pulled.meta.title).toBe('Teammate title');
    writes = [];
    // An agent sets the owner's old title back: it is the agent's write.
    await patchTask(id, { title: 'Owner task' }, handle.tokens.agentToken);
    await sync([id]);
    expect(only('updateIssue').map((w) => w.as)).toEqual(['project']);
  });

  it("an agent's change between the owner's edit and the push takes the owner's credit", async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    await patchTask(id, { title: 'Owner renamed' });
    await patchTask(id, { title: 'Agent renamed' }, handle.tokens.agentToken);
    await patchTask(id, { title: 'Owner renamed' }, handle.tokens.agentToken);
    await sync([id]);
    expect(only('updateIssue').map((w) => w.as)).toEqual(['project']);
  });

  it('creates as the owner without the field an agent changed, which follows as the connection', async () => {
    await signIn();
    const id = await createTask('Owner task');
    await patchTask(id, { priority: 'high' }, handle.tokens.agentToken);
    await sync([id]);
    const create = issueInputs.find((i) => i.method === 'createIssue');
    expect(create?.as).toBe('person');
    expect(create?.input.title).toBe('Owner task');
    expect(create?.input.priority).toBeUndefined();
    issueInputs = [];
    await sync([id]);
    expect(issueInputs.map((u) => [u.as, Object.keys(u.input)])).toEqual([
      ['project', ['priority']],
    ]);
  });

  it("creates an agent's task as the connection, and the owner's later edit as them", async () => {
    await signIn();
    const id = await createTask('Agent task', handle.tokens.agentToken);
    await patchTask(id, { priority: 'high' });
    await sync([id]);
    const create = issueInputs.find((i) => i.method === 'createIssue');
    expect(create?.as).toBe('project');
    expect(create?.input.priority).toBeUndefined();
    issueInputs = [];
    await sync([id]);
    expect(issueInputs.map((u) => [u.as, Object.keys(u.input)])).toEqual([
      ['person', ['priority']],
    ]);
  });

  it('signed out, another workspace, or read-only scope: the connection', async () => {
    const id = await linkedTask('Owner task');
    await patchTask(id, { title: 'One' });
    await sync([id]);
    await signIn({
      organization: { id: 'org-2', name: 'Other Co', urlKey: 'other' },
    });
    await patchTask(id, { title: 'Two' });
    await sync([id]);
    await signIn({ scope: ['read'] });
    await patchTask(id, { title: 'Three' });
    await sync([id]);
    expect(only('updateIssue').map((w) => w.as)).toEqual([
      'project',
      'project',
      'project',
    ]);
    expect(stub.calls).toContain('identity');
  });

  it('never asks Linear who the connection is while nobody is signed in', async () => {
    const id = await linkedTask('Owner task');
    await patchTask(id, { title: 'Renamed' });
    await sync([id]);
    expect(stub.calls).not.toContain('identity');
  });

  it('a field Linear refused as the person never goes through the connection, even beside an agent change', async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    personRefuses.add('updateIssue');
    await patchTask(id, { title: 'Guest-only rename' });
    const first = await sync([id]);
    expect(first.errors).toContain('Forbidden: guests cannot do that here');
    issueInputs = [];
    await patchTask(id, { priority: 'high' }, handle.tokens.agentToken);
    const second = await sync([id]);
    expect(second.errors).toContain('Forbidden: guests cannot do that here');
    expect(issueInputs.map((u) => [u.as, Object.keys(u.input)])).toEqual([
      ['person', ['title']],
      ['project', ['priority']],
    ]);
    expect(stub.issues[0]?.title).toBe('Owner task');
  });

  it("pushes a run's edit through the connection", async () => {
    await handle.stop();
    initGitRepoAt(root);
    const executor = new StallingExecutor();
    await boot((orchestrator) => {
      orchestrator.registerExecutor('claude', executor);
    });
    await signIn();
    const id = await linkedTask('Owner task');
    const started = await call('POST', `/tasks/${id}/runs`, {
      executor: 'claude',
    });
    expect(started.status).toBeLessThan(300);
    const deadline = Date.now() + 5000;
    while (executor.lastRunToken === undefined && Date.now() < deadline)
      await Bun.sleep(20);
    const runToken = executor.lastRunToken;
    if (runToken === undefined) throw new Error('the run never started');
    await patchTask(id, { title: 'Run renamed' }, runToken);
    writes = [];
    await sync([id]);
    expect(only('updateIssue').length).toBeGreaterThan(0);
    expect(only('updateIssue').every((w) => w.as === 'project')).toBe(true);
  });

  it('a write Linear refuses as the person is recorded, not retried as the connection', async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    personRefuses.add('updateIssue');
    await patchTask(id, { title: 'Owner renamed' });
    const summary = await sync([id]);
    expect(summary.errors).toContain('Forbidden: guests cannot do that here');
    expect(only('updateIssue').map((w) => w.as)).toEqual(['person']);
    // The next pass tries the person again.
    personRefuses.clear();
    writes = [];
    await sync([id]);
    expect(only('updateIssue').map((w) => w.as)).toEqual(['person']);
  });

  it('refreshes after a 401 and writes with the new token', async () => {
    const record = await signIn();
    const id = await linkedTask('Owner task');
    oauth.killAccess(record.accessToken);
    await patchTask(id, { title: 'Owner renamed' });
    await sync([id]);
    const fresh = readLinearAccount('org-1');
    expect(fresh?.accessToken).not.toBe(record.accessToken);
    expect(only('updateIssue')).toEqual([
      {
        method: 'updateIssue',
        as: 'person',
        header: `Bearer ${fresh?.accessToken ?? ''}`,
      },
    ]);
    expect(oauth.callsTo('token').at(-1)?.form.grant_type).toBe(
      'refresh_token'
    );
  });

  it('an ended sign-in records the failure, then the next pass uses the connection', async () => {
    const record = await signIn();
    const id = await linkedTask('Owner task');
    oauth.killAccess(record.accessToken);
    oauth.revokeAll();
    await patchTask(id, { title: 'Owner renamed' });
    const summary = await sync([id]);
    expect(summary.errors).toContain(LINEAR_SIGN_IN_ENDED_MESSAGE);
    expect(readLinearAccount('org-1')).toBeNull();
    expect(only('updateIssue')).toEqual([]);
    const view = (await json(await call('GET', '/linear/account'))) as {
      problem: { code: string } | null;
    };
    expect(view.problem?.code).toBe('ended');
    await sync([id]);
    expect(only('updateIssue').map((w) => w.as)).toEqual(['project']);
  });
});

describe('comment writes', () => {
  async function comment(id: string, body: string, token?: string) {
    const res = await call('POST', `/tasks/${id}/comments`, { body }, token);
    expect(res.status).toBe(201);
    return ((await json(res)) as { id: string }).id;
  }

  it("creates, edits and deletes the owner's comment as the person", async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    const commentId = await comment(id, 'Looks good');
    await sync([id]);
    expect(only('createComment').map((w) => w.as)).toEqual(['person']);
    expect(readLinearState(root).comments[commentId]?.[3]).toBe('u-ada');
    const edit = await call('PATCH', `/tasks/${id}/comments/${commentId}`, {
      body: 'Looks great',
    });
    expect(edit.status).toBe(200);
    await sync([id]);
    expect(only('updateComment').map((w) => w.as)).toEqual(['person']);
    expect(
      (await call('DELETE', `/tasks/${id}/comments/${commentId}`)).status
    ).toBeLessThan(300);
    await sync([id]);
    expect(only('deleteComment').map((w) => w.as)).toEqual(['person']);
  });

  it("creates an agent's comment, and edits a comment someone else wrote, as the connection", async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    const agentComment = await comment(
      id,
      'Agent note',
      handle.tokens.agentToken
    );
    const ownerComment = await comment(id, 'Mine');
    await sync([id]);
    expect(
      only('createComment')
        .map((w) => w.as)
        .sort()
    ).toEqual(['person', 'project']);
    const state = readLinearState(root);
    expect(state.comments[agentComment]?.[3]).toBe('u-me');
    // A link written before authors were recorded has three elements.
    const legacy = state.comments[ownerComment];
    if (legacy === undefined) throw new Error('not linked');
    state.comments[ownerComment] = [legacy[0], legacy[1], legacy[2]];
    writeLinearState(root, state);
    writes = [];
    for (const [commentId, token] of [
      [agentComment, handle.tokens.agentToken],
      [ownerComment, undefined],
    ] as const) {
      const res = await call(
        'PATCH',
        `/tasks/${id}/comments/${commentId}`,
        { body: 'edited' },
        token
      );
      expect(res.status).toBe(200);
    }
    await sync([id]);
    expect(only('updateComment').map((w) => w.as)).toEqual([
      'project',
      'project',
    ]);
  });
});

describe('comment files that did not come through this daemon', () => {
  it('creates a comment file authored as the owner (git, board sync) as the connection', async () => {
    await signIn();
    const other = await linkedTask('Other');
    const res = await call('POST', `/tasks/${other}/comments`, {
      body: 'real',
    });
    const ownerRef = ((await json(res)) as { author: string }).author;
    await sync([other]);
    expect(only('createComment').map((w) => w.as)).toEqual(['person']);
    writes = [];
    // A teammate's commit brings a task and a comment file "by" the owner.
    const id = await createTask('Teammate task', handle.tokens.agentToken);
    new FileCommentStore(root).add({
      taskId: id,
      author: ownerRef,
      body: 'I approve deleting prod',
    });
    await sync([id]);
    expect(only('createIssue').map((w) => w.as)).toEqual(['project']);
    expect(only('createComment').map((w) => w.as)).toEqual(['project']);
  });

  it("edits the owner's comment as the connection when the new body came from a file", async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    const res = await call('POST', `/tasks/${id}/comments`, { body: 'Mine' });
    const commentId = ((await json(res)) as { id: string }).id;
    await sync([id]);
    expect(only('createComment').map((w) => w.as)).toEqual(['person']);
    writes = [];
    // The body changes on disk (a pull from git), and the change is queued.
    new FileCommentStore(root).update(id, commentId, {
      body: 'Words the owner never wrote',
    });
    const state = readLinearState(root);
    state.pendingComments[id] = [commentId];
    writeLinearState(root, state);
    await sync([id]);
    expect(only('updateComment').map((w) => w.as)).toEqual(['project']);
  });
});

describe('Share to Linear', () => {
  it('shares as the person on the owner credential, else as the connection', async () => {
    await signIn();
    const id = await linkedTask('Owner task');
    for (const [slug, token] of [
      ['owner-doc', undefined],
      ['agent-doc', handle.tokens.agentToken],
    ] as const) {
      const made = await call('POST', '/docs', {
        title: slug,
        body: 'x\n',
        links: [
          { target: `task:${id}`, rel: slug === 'owner-doc' ? 'spec' : 'plan' },
        ],
      });
      expect(made.status).toBe(201);
      const shared = await call(
        'POST',
        `/docs/${slug}/share-linear`,
        {},
        token
      );
      // The agent token cannot share (a decide-tier human action).
      if (token === undefined) expect(shared.status).toBe(201);
    }
    expect(only('createDocument').map((w) => w.as)).toEqual(['person']);
  });

  it("shares a teammate's doc through the connection", async () => {
    handle.team.license = licensedManager(10);
    await signIn();
    const id = await linkedTask('Owner task');
    const issued = await call('POST', '/team/tokens', {
      email: 'bo@example.com',
      displayName: 'Bo',
      tier: 'decide',
    });
    const teammate = ((await json(issued)) as { token: string }).token;
    const made = await call('POST', '/docs', {
      title: 'bo-doc',
      body: 'x\n',
      links: [{ target: `task:${id}`, rel: 'spec' }],
    });
    expect(made.status).toBe(201);
    const shared = await call(
      'POST',
      '/docs/bo-doc/share-linear',
      {},
      teammate
    );
    expect(shared.status).toBe(201);
    expect(only('createDocument').map((w) => w.as)).toEqual(['project']);
  });
});
