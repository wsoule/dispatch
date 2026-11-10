// On a shared host each teammate's own edits reach Linear with their own
// grant, end to end through the real HttpLinearClient and LinearAccounts: a
// teammate's edit goes out as `Bearer <their token>`, the owner's as theirs,
// an agent's with the project's bare API key. Linear is a fetch-level fake (GraphQL from
// linearGraphqlFake.ts, OAuth from linearOAuthFake.ts); nothing leaves the
// process.
import {
  readLinearAccount,
  TaskStore,
  teammateGrantKey,
  writeLinearAccount,
  writeProjectCredential,
} from '@dispatch-foo/core';
import type { LinearAccountRecord } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import {
  buildAuthorizeUrl,
  createPkcePair,
  exchangeCode,
  fakeOAuthEndpoints,
} from '../src/linear/oauth.js';
import {
  FakeLinearClient,
  LABELS,
  STATES,
  TEAMMATE,
  VIEWER,
} from './linearFake.js';
import { graphqlFetch } from './linearGraphqlFake.js';
import type { GraphqlRequest, GraphqlWorld } from './linearGraphqlFake.js';
import { LinearOAuthFake } from './linearOAuthFake.js';
import { rawFetch } from './testAuth.js';
import { useTestAuth } from './testAuth.js';

const REDIRECT = 'http://127.0.0.1:47823/linear/callback';
const PROJECT_KEY = 'lin_api_project_key';
const endpoints = fakeOAuthEndpoints('http://linear.fake');

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
let world: GraphqlWorld;
let requests: GraphqlRequest[];
let oauth: LinearOAuthFake;
/** Every API answer this test read, for the leak sweep. */
let answers: string[];
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-person-http-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-person-http-'));
  TaskStore.init(root);
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    'autoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n  direction: both\n  oauthClientId: client-1\n'
  );
  writeProjectCredential(root, 'linear', { apiKey: PROJECT_KEY });
  const shape = new FakeLinearClient();
  world = {
    viewer: VIEWER,
    members: [VIEWER, TEAMMATE],
    states: STATES,
    labels: LABELS,
    issues: [
      shape.issue({
        id: 'iss-1',
        identifier: 'HYD-1',
        title: 'From Linear',
        url: 'https://linear.app/acme/issue/HYD-1',
      }),
    ],
    projects: [],
  };
  const graphql = graphqlFetch(world);
  requests = graphql.requests;
  oauth = new LinearOAuthFake();
  oauth.registerApp('client-1', [REDIRECT]);
  // GraphQL to the world, OAuth to the OAuth fake: both are "Linear".
  const linear = ((url: string, init?: RequestInit) =>
    url === endpoints.graphql
      ? graphql.fetch(url, init)
      : oauth.fetch(url, init)) as typeof fetch;
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    linearOAuth: { endpoints, fetchImpl: linear },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
  answers = [];
});

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
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${baseUrl}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  answers.push(text);
  return {
    status: res.status,
    body: text === '' ? null : (JSON.parse(text) as unknown),
  };
}

// Ada signs in at the OAuth fake; the record is stored as a real one is.
async function signIn(): Promise<LinearAccountRecord> {
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
  };
  await writeLinearAccount(record);
  return record;
}

// The authorization header of every IssueUpdate since `from`.
function updatesSince(from: number): (string | null)[] {
  return requests
    .slice(from)
    .filter((r) => r.operation === 'IssueUpdate')
    .map((r) => r.authorization);
}

const BOB_TOKEN = 'lin_oauth_bob_teammate_access_000001';

async function teammate(): Promise<string> {
  const minted = await call('POST', '/team/tokens', {
    email: 'bob@example.com',
    displayName: 'Bob',
    tier: 'decide',
  });
  expect(minted.status).toBe(201);
  return (minted.body as { token: string }).token;
}

function bobGrant(orgId = 'org-1'): LinearAccountRecord {
  return {
    version: 1,
    clientId: 'client-1',
    accessToken: BOB_TOKEN,
    refreshToken: 'lin_oauth_bob_teammate_refresh_00001',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: ['read', 'write'],
    user: {
      id: 'u-bob',
      name: 'Bob',
      displayName: 'bob',
      email: 'bob@example.com',
      guest: false,
      admin: false,
    },
    organization: { id: orgId, name: 'Acme', urlKey: 'acme' },
    signedInAt: new Date().toISOString(),
    refreshedAt: null,
  };
}

// Stores Bob's grant while Linear answers as Bob, so the daemon's check of
// who the grant belongs to passes.
async function postGrant(record = bobGrant()): Promise<number> {
  const was = world.viewer;
  world.viewer = {
    ...was,
    id: 'u-bob',
    name: 'Bob',
    displayName: 'bob',
    email: 'bob@example.com',
  };
  try {
    return (await call('POST', '/team/tokens/bob/linear', record)).status;
  } finally {
    world.viewer = was;
  }
}

describe("teammates' writes through the real client", () => {
  it("sends a teammate's edit with their grant, and the owner's with theirs", async () => {
    const imported = await call('POST', '/linear/import');
    expect(imported.status).toBe(200);
    const tasks = (await call('GET', '/tasks')).body as {
      meta: { id: string; external: string | null };
    }[];
    const id = tasks.find((t) => t.meta.external?.includes('iss-1') === true)
      ?.meta.id;
    if (id === undefined) throw new Error('the issue was not imported');
    const owner = await signIn();
    const bobToken = await teammate();
    expect(await postGrant()).toBe(204);

    let from = requests.length;
    await call('PATCH', `/tasks/${id}`, { title: 'Bob renamed' }, bobToken);
    await call('POST', '/linear/sync', { taskIds: [id] });
    expect(updatesSince(from)).toEqual([`Bearer ${BOB_TOKEN}`]);
    expect(world.issues[0]?.title).toBe('Bob renamed');

    from = requests.length;
    await call('PATCH', `/tasks/${id}`, { title: 'Owner renamed' });
    await call('POST', '/linear/sync', { taskIds: [id] });
    expect(updatesSince(from)).toEqual([`Bearer ${owner.accessToken}`]);

    from = requests.length;
    await call(
      'PATCH',
      `/tasks/${id}`,
      { title: 'Agent renamed' },
      handle.tokens.agentToken
    );
    await call('POST', '/linear/sync', { taskIds: [id] });
    expect(updatesSince(from)).toEqual([PROJECT_KEY]);

    for (const text of answers) expect(text).not.toContain('lin_oauth_');
  });

  it('keeps no grant for another workspace, and takes one only from the operator', async () => {
    await call('POST', '/linear/import');
    const bobToken = await teammate();
    expect(
      (await call('POST', '/team/tokens/bob/linear', bobGrant('org-other')))
        .status
    ).toBe(409);
    const asBob = await rawFetch(`${baseUrl}/api/team/tokens/bob/linear`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bobToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(bobGrant()),
    });
    expect(asBob.status).toBe(403);
  });

  it('refuses a grant for the owner or for anyone without a teammate token', async () => {
    await call('POST', '/linear/import');
    expect(
      (await call('POST', '/team/tokens/nobody/linear', bobGrant())).status
    ).toBe(404);
    const ownerHandle = (await call('GET', '/whoami')).body as {
      handle: string;
    };
    expect(
      (
        await call(
          'POST',
          `/team/tokens/${ownerHandle.handle}/linear`,
          bobGrant()
        )
      ).status
    ).toBe(404);
  });

  it("forgets a teammate's grant when their token is revoked, and stops using it", async () => {
    const imported = await call('POST', '/linear/import');
    expect(imported.status).toBe(200);
    const tasks = (await call('GET', '/tasks')).body as {
      meta: { id: string; external: string | null };
    }[];
    const id =
      tasks.find((t) => t.meta.external?.includes('iss-1') === true)?.meta.id ??
      '';
    const bobToken = await teammate();
    expect(await postGrant()).toBe(204);
    await call('PATCH', `/tasks/${id}`, { title: 'Bob renamed' }, bobToken);
    expect((await call('DELETE', '/team/tokens/bob')).status).toBe(200);
    expect(readLinearAccount(teammateGrantKey('bob', 'org-1'))).toBeNull();
    const from = requests.length;
    await call('POST', '/linear/sync', { taskIds: [id] });
    for (const auth of updatesSince(from))
      expect(auth).not.toBe(`Bearer ${BOB_TOKEN}`);
  });

  it("keeps only a grant Linear confirms, from this daemon's own app", async () => {
    await call('POST', '/linear/import');
    await teammate();
    // Linear answers as someone else: the record's claim is not enough.
    expect(
      (await call('POST', '/team/tokens/bob/linear', bobGrant())).status
    ).toBe(409);
    expect(await postGrant({ ...bobGrant(), clientId: 'another-app' })).toBe(
      400
    );
    expect(await postGrant()).toBe(204);
    expect((await call('DELETE', '/team/tokens/bob/linear')).status).toBe(204);
    expect((await call('DELETE', '/team/tokens/bob/linear')).status).toBe(404);
  });
});
