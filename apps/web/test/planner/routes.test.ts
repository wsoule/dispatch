import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { WorkspaceSource } from '../../src/planner/routes.js';
import { demoWorkspace, plannerHandler } from '../../src/planner/routes.js';

// Who may open which hosted workspace, and what the page and its daemon
// routes give them.

const ORIGIN = 'http://team.test';
let dist: string;
let loads = 0;

const demo = demoWorkspace(() => Date.parse('2026-11-06T12:00:00Z'));
// A private workspace only user `usr_ada` may open.
const acme: WorkspaceSource = {
  name: 'Acme',
  viewerFor: (userId) => (userId === 'usr_ada' ? 'human:ada' : null),
  load: () => {
    loads++;
    return demo.load();
  },
};

function planner(clock = { now: 0 }) {
  return plannerHandler({
    origin: ORIGIN,
    distDir: dist,
    userOf: (req) => req.headers.get('x-user'),
    workspace: (key) => (key === 'demo' ? demo : key === 'acme' ? acme : null),
    now: () => clock.now,
  });
}

async function open(p: ReturnType<typeof planner>, key: string, user?: string) {
  const res = await p.fetch(
    new Request(`${ORIGIN}/w/${key}/`, {
      headers: user === undefined ? {} : { 'x-user': user },
    })
  );
  const html = res === null ? '' : await res.text();
  const config = /window\.__DISPATCH_DEMO__=(\{.*?\})<\/script>/.exec(
    html
  )?.[1];
  return {
    status: res?.status ?? 0,
    config:
      config === undefined
        ? null
        : (JSON.parse(config) as { agentToken: string; baseUrl: string }),
  };
}

function api(
  p: ReturnType<typeof planner>,
  key: string,
  token: string,
  path = '/api/whoami'
) {
  return p.fetch(
    new Request(`${ORIGIN}/w/${key}${path}`, {
      headers: { authorization: `Bearer ${token}` },
    })
  );
}

beforeAll(() => {
  dist = mkdtempSync(join(tmpdir(), 'planner-dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(
    join(dist, 'index.html'),
    '<!doctype html><html><head><script src="/assets/app.js"></script></head></html>'
  );
  writeFileSync(join(dist, 'assets', 'app.js'), 'console.log(1)');
});
afterAll(() => rmSync(dist, { recursive: true, force: true }));

describe('hosted planner routes', () => {
  it('serves the demo to anyone, pointed at its own daemon routes', async () => {
    const p = planner();
    const page = await open(p, 'demo');
    expect(page.status).toBe(200);
    expect(page.config?.baseUrl).toBe(`${ORIGIN}/w/demo`);
    const who = await api(p, 'demo', page.config!.agentToken);
    expect(await who!.json()).toMatchObject({
      ref: 'human:guest',
      tier: 'request',
    });
  });

  it('hides a workspace from anyone it does not belong to', async () => {
    const p = planner();
    expect((await open(p, 'acme')).status).toBe(404);
    expect((await open(p, 'acme', 'usr_eve')).status).toBe(404);
    expect((await open(p, 'nope', 'usr_ada')).status).toBe(404);
    const ada = await open(p, 'acme', 'usr_ada');
    expect(ada.status).toBe(200);
    expect(
      await (await api(p, 'acme', ada.config!.agentToken))!.json()
    ).toMatchObject({ ref: 'human:ada' });
  });

  it("never lets one workspace's token read another's", async () => {
    const p = planner();
    const page = await open(p, 'demo');
    expect((await api(p, 'acme', page.config!.agentToken))!.status).toBe(401);
    expect((await api(p, 'demo', 'made-up'))!.status).toBe(401);
    expect(p.watches('demo', page.config!.agentToken)).toBe(true);
    expect(p.watches('acme', page.config!.agentToken)).toBe(false);
  });

  it('expires view tokens after 12 hours', async () => {
    const clock = { now: 0 };
    const p = planner(clock);
    const page = await open(p, 'demo');
    clock.now = 12 * 3_600_000 + 1;
    expect((await api(p, 'demo', page.config!.agentToken))!.status).toBe(401);
  });

  it('fetches a workspace once a minute however many requests come', async () => {
    const clock = { now: 0 };
    const p = planner(clock);
    const token = (await open(p, 'acme', 'usr_ada')).config!.agentToken;
    loads = 0;
    for (const path of [
      '/api/tasks?fields=meta',
      '/api/config',
      '/api/people',
      '/api/linear/links',
    ])
      expect((await api(p, 'acme', token, path))!.status).toBe(200);
    expect(loads).toBe(1);
    clock.now = 60_001;
    await api(p, 'acme', token, '/api/tasks');
    expect(loads).toBe(2);
  });

  it('serves the bundle assets and nothing outside the dist', async () => {
    const p = planner();
    const asset = await p.fetch(new Request(`${ORIGIN}/assets/app.js`));
    expect(await asset!.text()).toBe('console.log(1)');
    expect(
      await p.fetch(new Request(`${ORIGIN}/assets/%2e%2e/index.html`))
    ).toBeNull();
    expect(await p.fetch(new Request(`${ORIGIN}/teams`))).toBeNull();
  });
});
