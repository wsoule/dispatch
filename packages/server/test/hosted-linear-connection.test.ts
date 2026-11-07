// A hosted planner's Linear connection is the workspace install: an OAuth
// grant stored as its home's one Linear account, sent as `Bearer` and
// refreshed like a sign-in. There is no API key. A normal daemon never takes
// a sign-in as its project connection. Linear is a fetch-level fake.
import { TaskStore, writeLinearAccount } from '@dispatch-foo/core';
import type { LinearAccountRecord } from '@dispatch-foo/core';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { fakeOAuthEndpoints } from '../src/linear/oauth.js';
import {
  FakeLinearClient,
  LABELS,
  STATES,
  TEAMMATE,
  VIEWER,
} from './linearFake.js';
import { graphqlFetch } from './linearGraphqlFake.js';
import type { GraphqlRequest } from './linearGraphqlFake.js';
import { LinearOAuthFake } from './linearOAuthFake.js';
import { useTestAuth } from './testAuth.js';

const endpoints = fakeOAuthEndpoints('http://linear.fake');
const INSTALL_TOKEN = 'lin_oauth_install_access_token_0001';
const originalHome = process.env.DISPATCH_HOME;
let root: string;
let fakeHome: string;
let handle: ServerHandle | null = null;
let requests: GraphqlRequest[];

async function boot(hostedPlanner: boolean): Promise<string> {
  fakeHome = realpathSync(
    mkdtempSync(join(tmpdir(), 'dispatch-hosted-conn-home-'))
  );
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-hosted-conn-')));
  TaskStore.init(root);
  writeFileSync(
    join(root, '.dispatch', 'config.yml'),
    'autoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n  direction: both\n  oauthClientId: client-1\n'
  );
  const record: LinearAccountRecord = {
    version: 1,
    clientId: 'client-1',
    accessToken: INSTALL_TOKEN,
    refreshToken: 'lin_oauth_install_refresh_token_0001',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scope: ['read', 'write'],
    user: {
      id: 'u-app',
      name: 'Dispatch',
      displayName: 'dispatch',
      email: 'app@dispatch.foo',
      guest: false,
      admin: false,
    },
    organization: { id: 'org-1', name: 'Acme', urlKey: 'acme' },
    signedInAt: new Date().toISOString(),
    refreshedAt: null,
  };
  await writeLinearAccount(record);
  const shape = new FakeLinearClient();
  const graphql = graphqlFetch({
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
  });
  requests = graphql.requests;
  const oauth = new LinearOAuthFake();
  const linear = ((url: string, init?: RequestInit) =>
    url === endpoints.graphql
      ? graphql.fetch(url, init)
      : oauth.fetch(url, init)) as typeof fetch;
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    hubLink: false,
    hostedPlanner,
    linearOAuth: { endpoints, fetchImpl: linear },
  });
  useTestAuth(handle);
  return `http://127.0.0.1:${handle.port}/api`;
}

afterEach(async () => {
  await handle?.stop();
  handle = null;
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('a hosted planner connects to Linear through its workspace install', () => {
  it('reports connected and imports with the install token as Bearer', async () => {
    const api = await boot(true);
    const status = (await (await fetch(`${api}/linear/status`)).json()) as {
      connected: boolean;
    };
    expect(status.connected).toBe(true);
    const imported = await fetch(`${api}/linear/import`, { method: 'POST' });
    expect(imported.status).toBe(200);
    const auth = requests.map((r) => r.authorization);
    expect(auth.length).toBeGreaterThan(0);
    for (const header of auth) expect(header).toBe(`Bearer ${INSTALL_TOKEN}`);
  });

  it('leaves a normal daemon with only a sign-in unconnected, as before', async () => {
    const api = await boot(false);
    const status = (await (await fetch(`${api}/linear/status`)).json()) as {
      connected: boolean;
    };
    expect(status.connected).toBe(false);
  });
});
