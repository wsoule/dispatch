import type { LinearAccountRecord } from '@dispatch-foo/core';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WorkspaceHost } from '../../src/hosting/host.js';

// One real hosted dispatchd per workspace, started, reached and stopped by
// the host. Slow-ish: it boots real daemons.

const ENTRY = join(import.meta.dir, '../../src/hosting/daemonEntry.ts');
let dataDir: string;
let host: WorkspaceHost;

beforeAll(() => {
  dataDir = realpathSync(mkdtempSync(join(tmpdir(), 'web-host-')));
  host = new WorkspaceHost({ dataDir, entry: ENTRY });
});
afterAll(async () => {
  await host.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const json = async (res: Response) =>
  (await res.json()) as Record<string, unknown>;

describe('WorkspaceHost', () => {
  it('boots a hosted planner per workspace that only answers planning routes', async () => {
    const who = await host.request('org-a', '/api/whoami');
    expect(who.status).toBe(200);
    expect((await host.request('org-a', '/api/terminals')).status).toBe(404);
    expect((await host.request('org-a', '/api/tasks')).status).toBe(200);
    const again = await host.ensure('org-a');
    expect(again.port).toBe((await host.ensure('org-a')).port);
  }, 60_000);

  it("mints a member's token, which reads at the decide tier", async () => {
    const minted = await host.request('org-a', '/api/team/tokens', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'ada@example.com',
        displayName: 'Ada',
        tier: 'decide',
      }),
    });
    expect(minted.status).toBe(201);
    const { token, handle } = (await minted.json()) as {
      token: string;
      handle: string;
    };
    const who = await json(
      await host.request('org-a', '/api/whoami', {}, token)
    );
    expect(who).toMatchObject({ ref: `human:${handle}`, tier: 'decide' });
  }, 60_000);

  it('takes an install as its Linear connection on the next boot', async () => {
    const record: LinearAccountRecord = {
      version: 1,
      clientId: 'client-1',
      accessToken: 'lin_oauth_install_access_00000001',
      refreshToken: 'lin_oauth_install_refresh_0000001',
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
      organization: { id: 'org-b', name: 'Bee', urlKey: 'bee' },
      signedInAt: new Date().toISOString(),
      refreshedAt: null,
    };
    expect(
      (await json(await host.request('org-b', '/api/linear/status'))).connected
    ).toBe(false);
    await host.install('org-b', record);
    expect(
      (await json(await host.request('org-b', '/api/linear/status'))).connected
    ).toBe(true);
  }, 60_000);

  it('starts a stopped workspace again on the next request', async () => {
    await host.stop('org-a');
    expect((await host.request('org-a', '/api/whoami')).status).toBe(200);
  }, 60_000);
});
