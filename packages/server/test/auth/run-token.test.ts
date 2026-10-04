import { describe, expect, it } from 'bun:test';

import { call, liveRun, useWorld } from './world.js';

// XH-R2: a run's MCP presents the run's own token rather than the shared
// agent token, so the daemon knows which run made a write. The run token
// reaches the request tier and nothing above it, and stops at the run's end.

const world = useWorld();

describe('a run token on the request-tier routes', () => {
  it('creates and edits tasks as agent:dispatch, never the owner', async () => {
    const w = world();
    const run = await liveRun(w, w.app, 'parent');
    const made = await call(w, run.runToken, 'POST', '/api/tasks', {
      title: 'spawned by a run',
    });
    expect(made.status).toBe(201);
    expect(made.json.meta.creator).toBe('agent:dispatch');

    const list = await call(w, run.runToken, 'GET', '/api/tasks');
    expect(list.status).toBe(200);

    const patched = await call(
      w,
      run.runToken,
      'PATCH',
      `/api/tasks/${made.json.meta.id}`,
      { appendActivity: 'looked' }
    );
    expect(patched.status).toBe(200);
    expect(patched.json.body).toContain('agent:dispatch');
  });

  it('never reaches the decide or operator tier', async () => {
    const w = world();
    const run = await liveRun(w, w.app);
    expect(
      (await call(w, run.runToken, 'GET', '/api/team/tokens')).status
    ).toBe(403);
    expect((await call(w, run.runToken, 'GET', '/api/terminals')).status).toBe(
      403
    );
  });

  it('stops working when the run ends', async () => {
    const w = world();
    const run = await liveRun(w, w.app);
    await w.handle.orchestrator.cancel(run.runId);
    const after = await call(w, run.runToken, 'GET', '/api/tasks');
    expect(after.status).toBe(401);
  });
});
