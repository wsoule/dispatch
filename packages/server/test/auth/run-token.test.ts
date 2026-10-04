import { describe, expect, it } from 'bun:test';

import { a2aRun } from './a2a.js';
import { call, invite, liveRun, startRun, useWorld } from './world.js';

// XH-R2: a run's MCP presents the run's own token rather than the shared
// agent token, so the daemon knows which run made a write. The run token
// reaches the request tier and nothing above it, and stops at the run's end.

const world = useWorld();

describe('a run token on the request-tier routes', () => {
  it('creates and edits tasks as the run, never the owner or the CLI', async () => {
    const w = world();
    const run = await liveRun(w, w.app, 'parent');
    const made = await call(w, run.runToken, 'POST', '/api/tasks', {
      title: 'spawned by a run',
    });
    expect(made.status).toBe(201);
    // The owner's run is credited under the owner's handle, as their agent.
    expect(made.json.meta.creator).toBe(`agent:test/${run.runId}`);

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
    expect(patched.json.body).toContain(`agent:test/${run.runId}`);

    const comment = await call(
      w,
      run.runToken,
      'POST',
      `/api/tasks/${made.json.meta.id}/comments`,
      { body: 'noted' }
    );
    expect(comment.json.author).toBe(`agent:test/${run.runId}`);
  });

  it('credits a run that acts for no one as agent:run/<id>', async () => {
    const w = world();
    const t = await call(w, w.agent, 'POST', '/api/tasks', { title: 'cli' });
    const run = await startRun(w, w.agent, t.json.meta.id);
    expect(run.meta.operator ?? null).toBeNull();
    const made = await call(w, run.runToken, 'POST', '/api/tasks', {
      title: 'orphan',
    });
    expect(made.json.meta.creator).toBe(`agent:run/${run.runId}`);
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

  it('whoami names the run and its operator, never the owner', async () => {
    const w = world();
    const ada = await invite(w, 'ada@x.io', 'request');
    const adas = await liveRun(w, ada.token, 'ada work');
    expect((await call(w, adas.runToken, 'GET', '/api/whoami')).json).toEqual({
      ref: `run:${adas.runId}`,
      operator: 'ada',
      tier: 'request',
      runToken: true,
    });
    const t = await call(w, w.agent, 'POST', '/api/tasks', { title: 'cli' });
    const orphan = await startRun(w, w.agent, t.json.meta.id);
    expect((await call(w, orphan.runToken, 'GET', '/api/whoami')).json).toEqual(
      {
        ref: `run:${orphan.runId}`,
        operator: null,
        tier: 'request',
        runToken: true,
      }
    );
  });

  it('whoami for an A2A run omits any operator', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const me = await call(w, a2a.runToken, 'GET', '/api/whoami');
    expect(me.json).toEqual({
      ref: `run:${a2a.runId}`,
      tier: 'request',
      runToken: true,
    });
    expect(me.text).not.toContain('human:test');
  });
});
