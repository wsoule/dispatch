// The same rule as linear-person-writes.test.ts, end to end through the real
// HttpLinearClient and LinearAccounts: the owner's own edit reaches Linear's
// GraphQL endpoint with `Authorization: Bearer <their token>`, and an agent's
// with the project's bare API key. Linear is a fetch-level fake (GraphQL from
// linearGraphqlFake.ts, OAuth from linearOAuthFake.ts); nothing leaves the
// process.
import {
  TaskStore,
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

describe('person writes through the real client', () => {
  it("sends the owner's edit as Bearer and an agent's with the bare key", async () => {
    const imported = await call('POST', '/linear/import');
    expect(imported.status).toBe(200);
    const tasks = (await call('GET', '/tasks')).body as {
      meta: { id: string; external: string | null };
    }[];
    const id = tasks.find((t) => t.meta.external?.includes('iss-1') === true)
      ?.meta.id;
    if (id === undefined) throw new Error('the issue was not imported');
    const record = await signIn();

    let from = requests.length;
    await call('PATCH', `/tasks/${id}`, { title: 'Owner renamed' });
    await call('POST', '/linear/sync', { taskIds: [id] });
    expect(updatesSince(from)).toEqual([`Bearer ${record.accessToken}`]);
    expect(world.issues[0]?.title).toBe('Owner renamed');

    from = requests.length;
    await call(
      'PATCH',
      `/tasks/${id}`,
      { title: 'Agent renamed' },
      handle.tokens.agentToken
    );
    await call('POST', '/linear/sync', { taskIds: [id] });
    expect(updatesSince(from)).toEqual([PROJECT_KEY]);
    expect(world.issues[0]?.title).toBe('Agent renamed');

    // Reads (pulls, the identity lookup) all went with the project key.
    const reads = requests.filter((r) => r.operation !== 'IssueUpdate');
    expect(reads.length).toBeGreaterThan(0);
    for (const r of reads) expect(r.authorization).toBe(PROJECT_KEY);
    // No answer the API gave carries a token.
    for (const text of answers) expect(text).not.toContain('lin_oauth_');
  });
});
