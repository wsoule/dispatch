import { describe, expect, it } from 'bun:test';

import { plannerResponse } from '../../src/planner/api.js';
import { createShowcaseWorkspace } from '../../src/planner/linear/showcase.js';
import { toDispatch } from '../../src/planner/toDispatch.js';

// The read-only daemon a hosted workspace answers as, route by route.

const model = toDispatch(
  createShowcaseWorkspace('2026-11-06'),
  '2026-11-06T12:00:00.000Z'
);
const ctx = { key: 'demo', model, viewer: model.people[0].ref };

async function get(
  path: string,
  method = 'GET'
): Promise<{ status: number; body: unknown }> {
  const res = plannerResponse(path, method, ctx);
  return { status: res.status, body: await res.json() };
}

describe('plannerResponse', () => {
  it('lists every task as meta only, and serves each one in full', async () => {
    const list = await get('/api/tasks?archived=1&fields=meta');
    expect(list.status).toBe(200);
    const items = list.body as { meta: { id: string }; body?: string }[];
    expect(items.length).toBe(model.tasks.length);
    expect(items[0]).toEqual({ meta: model.tasks[0].meta });
    const one = await get(`/api/tasks/${model.tasks[0].meta.id}`);
    expect(one.body).toEqual(model.tasks[0]);
    expect((await get('/api/tasks/t-0000000000')).status).toBe(404);
    expect(
      (await get(`/api/tasks/${model.tasks[0].meta.id}/comments`)).body
    ).toEqual([]);
  });

  it("answers config with the workspace's statuses", async () => {
    const config = (await get('/api/config')).body as {
      statuses: string[];
      statusDefinitions: unknown[];
    };
    expect(config.statusDefinitions).toEqual(model.statusDefinitions);
    expect(config.statuses).toEqual(model.statusDefinitions.map((d) => d.name));
  });

  it('names the viewer at the read-only tier', async () => {
    const who = (await get('/api/whoami')).body as {
      ref: string;
      tier: string;
    };
    expect(who).toMatchObject({ ref: ctx.viewer, tier: 'request' });
    const people = (await get('/api/people')).body as {
      me: string;
      people: unknown[];
    };
    expect(people.me).toBe(ctx.viewer);
    expect(people.people).toEqual(model.people);
    expect((await get('/api/linear/links')).body).toEqual(model.links);
  });

  it('reports setup done and no agents, so no first-run gate appears', async () => {
    const setup = (await get('/api/setup')).body as {
      steps: { status: string }[];
    };
    expect(setup.steps.length).toBeGreaterThan(0);
    for (const step of setup.steps) expect(step.status).toBe('ok');
    expect((await get('/api/executors')).body).toMatchObject({ executors: [] });
    expect((await get('/api/runs')).body).toEqual([]);
  });

  it('answers the polled routes as a fresh daemon would, rooted at the workspace', async () => {
    expect((await get('/api/inbox')).body).toEqual([]);
    expect((await get('/api/decisions?resolved=1')).body).toEqual({
      items: [],
    });
    expect((await get('/api/health')).body).toMatchObject({
      ok: true,
      rootDir: '/w/demo',
      pr: false,
    });
  });

  it('refuses every write, except the focus ping the app sends on its own', async () => {
    expect((await get('/api/tasks', 'POST')).status).toBe(403);
    expect(
      (await get(`/api/tasks/${model.tasks[0].meta.id}`, 'PATCH')).status
    ).toBe(403);
    expect((await get('/api/presence/focus', 'POST')).status).toBe(200);
    expect((await get('/api/nothing-here')).status).toBe(404);
  });
});
