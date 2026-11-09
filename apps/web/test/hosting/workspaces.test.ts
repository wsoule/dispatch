import type { LinearAccountRecord } from '@dispatch-foo/core';
import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamDb } from '../../src/db.js';
import { WorkspaceHost } from '../../src/hosting/host.js';
import { HostedWorkspaces } from '../../src/hosting/workspaces.js';
import { Sealer } from '../../src/linear.js';
import { GrantGone, LinearGrants } from '../../src/planner/grants.js';

// Installed workspaces: the install becomes the daemon's connection, each
// member reaches it with their own teammate token, and a member's Linear
// grant moves to the daemon once it accepts it.

const ORG = { id: 'org-1', name: 'Acme', urlKey: 'acme' };
const ADA = {
  name: 'Ada Lovelace',
  displayName: 'ada',
  email: 'ada@acme.test',
  guest: false,
  admin: false,
};
const TOKENS = {
  accessToken: 'lin_oauth_ada_access',
  refreshToken: 'ada-refresh',
  expiresAt: Date.now() + 3_600_000,
};

const record = (): LinearAccountRecord => ({
  version: 1,
  clientId: 'lin-client',
  accessToken: 'lin_oauth_app_access',
  refreshToken: 'app-refresh',
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  scope: ['read', 'write'],
  user: {
    id: 'app',
    name: 'Dispatch',
    displayName: 'dispatch',
    email: 'app@users.linear.app',
    guest: false,
    admin: false,
  },
  organization: ORG,
  signedInAt: new Date().toISOString(),
  refreshedAt: null,
});

interface Call {
  path: string;
  method: string;
  token: string | undefined;
  body: string | null;
}

// A WorkspaceHost stand-in that records what reaches "the daemon".
function fakeHost(answer: (call: Call) => Response) {
  const calls: Call[] = [];
  const installs: string[] = [];
  const host = {
    install: (orgId: string) => {
      installs.push(orgId);
      return Promise.resolve();
    },
    ensure: () => Promise.resolve({ port: 1, appToken: 'app' }),
    request: async (
      _orgId: string,
      path: string,
      init: RequestInit = {},
      token?: string
    ) => {
      const call = {
        path,
        method: init.method ?? 'GET',
        token,
        body:
          init.body === undefined || init.body === null
            ? null
            : typeof init.body === 'string'
              ? init.body
              : new TextDecoder().decode(init.body as ArrayBuffer),
      };
      calls.push(call);
      return Promise.resolve(answer(call));
    },
  };
  return { host: host as unknown as WorkspaceHost, calls, installs };
}

let db: TeamDb;
let grants: LinearGrants;
const sealer = new Sealer('secret');

beforeEach(() => {
  db = new TeamDb(':memory:');
  grants = new LinearGrants(db.db, sealer, 'lin-client');
  grants.save('u-ada', ORG, 'lin-ada', TOKENS, ADA);
});

describe('HostedWorkspaces', () => {
  it('installs: hands over the connection, links every team, imports', async () => {
    const fake = fakeHost((call) =>
      call.path === '/api/linear/teams'
        ? Response.json([{ id: 't1' }, { id: 't2' }])
        : Response.json({})
    );
    const hosted = new HostedWorkspaces(
      db.db,
      sealer,
      fake.host,
      grants,
      'lin-client'
    );
    await hosted.install('u-ada', record());
    expect(fake.installs).toEqual(['org-1']);
    expect(fake.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /api/linear/teams',
      'PATCH /api/config',
      'POST /api/linear/import',
    ]);
    expect(JSON.parse(fake.calls[1]?.body ?? '{}')).toEqual({
      linear: { enabled: true, teamIds: ['t1', 't2'] },
    });
    expect(hosted.byKey('acme')).toEqual({ orgId: 'org-1', name: 'Acme' });
    expect(hosted.byKey('other')).toBeNull();
  });

  it("sends a member's request with their own minted token, and only safe headers", async () => {
    const fake = fakeHost((call) => {
      if (call.path === '/api/team/tokens')
        return Response.json(
          { token: 'tm-ada', handle: 'ada' },
          { status: 201 }
        );
      if (call.path.endsWith('/linear'))
        return new Response(null, { status: 204 });
      return Response.json({ ok: true }, { headers: { 'set-cookie': 'x=1' } });
    });
    const hosted = new HostedWorkspaces(
      db.db,
      sealer,
      fake.host,
      grants,
      'lin-client'
    );
    const req = new Request('https://app.dispatch.foo/w/acme/api/tasks', {
      headers: { cookie: 'dt_session=abc', authorization: 'Bearer view-token' },
    });
    const res = await hosted.request('u-ada', 'org-1', '/api/tasks', req);
    expect(res.headers.get('set-cookie')).toBeNull();
    const mint = fake.calls[0];
    expect(mint?.token).toBeUndefined(); // the host's app token
    expect(JSON.parse(mint?.body ?? '{}')).toEqual({
      email: 'ada@acme.test',
      displayName: 'ada',
      tier: 'decide',
    });
    // The grant goes to the daemon, then the tokens leave this db.
    const handoff = fake.calls[1];
    expect(handoff?.path).toBe('/api/team/tokens/ada/linear');
    expect(JSON.parse(handoff?.body ?? '{}')).toMatchObject({
      clientId: 'lin-client',
      accessToken: 'lin_oauth_ada_access',
      refreshToken: 'ada-refresh',
      user: { id: 'lin-ada', email: 'ada@acme.test' },
      organization: ORG,
    });
    expect(grants.handoff('u-ada', 'org-1')).toBeNull();
    expect(grants.member('u-ada', 'org-1')).toEqual({
      linearUserId: 'lin-ada',
    });
    await expect(grants.accessToken('u-ada', 'org-1')).rejects.toBeInstanceOf(
      GrantGone
    );
    const sent = fake.calls[2];
    expect(sent).toMatchObject({ path: '/api/tasks', token: 'tm-ada' });

    // Next time: the stored token, no mint and nothing more to hand off.
    await hosted.request('u-ada', 'org-1', '/api/tasks', req);
    expect(fake.calls.slice(3).map((c) => [c.path, c.token])).toEqual([
      ['/api/tasks', 'tm-ada'],
    ]);
  });

  it('gives guests a request-tier token', async () => {
    grants.save('u-gus', ORG, 'lin-gus', TOKENS, {
      ...ADA,
      email: 'gus@x.test',
      guest: true,
    });
    const fake = fakeHost((call) =>
      call.path === '/api/team/tokens'
        ? Response.json({ token: 'tm-gus', handle: 'gus' }, { status: 201 })
        : new Response(null, { status: 204 })
    );
    const hosted = new HostedWorkspaces(
      db.db,
      sealer,
      fake.host,
      grants,
      'lin-client'
    );
    await hosted.request(
      'u-gus',
      'org-1',
      '/api/whoami',
      new Request('https://x/')
    );
    expect(JSON.parse(fake.calls[0]?.body ?? '{}')).toMatchObject({
      tier: 'request',
    });
  });

  it('keeps a grant the daemon refuses, and re-mints a token the daemon forgot', async () => {
    let minted = 0;
    const fake = fakeHost((call) => {
      if (call.path === '/api/team/tokens') {
        minted += 1;
        return Response.json(
          { token: `tm-${String(minted)}`, handle: 'ada' },
          { status: 201 }
        );
      }
      if (call.path.endsWith('/linear'))
        return Response.json({ error: 'no' }, { status: 400 });
      return call.token === 'tm-1'
        ? Response.json({ error: 'unknown token' }, { status: 401 })
        : Response.json({ ok: true });
    });
    const hosted = new HostedWorkspaces(
      db.db,
      sealer,
      fake.host,
      grants,
      'lin-client'
    );
    const res = await hosted.request(
      'u-ada',
      'org-1',
      '/api/tasks',
      new Request('https://x/')
    );
    expect(res.status).toBe(200);
    expect(minted).toBe(2);
    expect(grants.handoff('u-ada', 'org-1')).not.toBeNull();
  });

  it('refuses someone with no recorded profile', async () => {
    grants.save('u-old', ORG, 'lin-old', TOKENS);
    const fake = fakeHost(() => Response.json({}));
    const hosted = new HostedWorkspaces(
      db.db,
      sealer,
      fake.host,
      grants,
      'lin-client'
    );
    await expect(
      hosted.request('u-old', 'org-1', '/api/tasks', new Request('https://x/'))
    ).rejects.toThrow(/again/);
    expect(fake.calls).toEqual([]);
  });
});

describe('HostedWorkspaces on a real daemon', () => {
  const dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'web-hosted-')));
  const host = new WorkspaceHost({
    dataDir,
    entry: join(import.meta.dir, '../../src/hosting/daemonEntry.ts'),
  });
  afterAll(async () => {
    await host.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('answers each member as themselves at their tier', async () => {
    const hosted = new HostedWorkspaces(
      db.db,
      sealer,
      host,
      grants,
      'lin-client'
    );
    grants.save('u-gus', ORG, 'lin-gus', TOKENS, {
      ...ADA,
      name: 'Gus',
      displayName: 'gus',
      email: 'gus@acme.test',
      guest: true,
    });
    const who = async (userId: string) =>
      (await (
        await hosted.request(
          userId,
          'org-1',
          '/api/whoami',
          new Request('https://x/')
        )
      ).json()) as { ref: string; tier: string };
    expect(await who('u-ada')).toMatchObject({ tier: 'decide' });
    expect(await who('u-gus')).toMatchObject({ tier: 'request' });
    expect((await who('u-ada')).ref).not.toBe((await who('u-gus')).ref);
    const closed = await hosted.request(
      'u-ada',
      'org-1',
      '/api/terminals',
      new Request('https://x/')
    );
    expect(closed.status).toBe(404);
  }, 60_000);
});
