import { describe, expect, it } from 'bun:test';

import { approvedClient, useSeedBase } from '../a2a/seed.js';
import { useTestAuth } from '../testAuth.js';
import type { World } from './world.js';
import { call, liveRun, startRun, useWorld } from './world.js';

// XH-R2: A2A provenance follows lineage. A task an A2A-origin run creates,
// edits or dispatches is A2A-origin too, so its runs act for no one and read
// what an A2A run reads; and no other run may message an A2A run.

const world = useWorld();

// A client's handoff, approved by the owner; returns its task.
async function handoff(
  w: World,
  client: string,
  body: string,
  title: string
): Promise<string> {
  useTestAuth(w.handle);
  useSeedBase(w.base);
  const { caller } = await approvedClient(client);
  const opened = await w.handle.a2a.port!.open(caller, {
    clientMessageId: `c-${client}`,
    contextId: null,
    kind: 'handoff',
    to: null,
    replyTo: null,
    body,
    refs: [],
    work: { skill: 'handoff', title },
  });
  if (opened.kind !== 'task') throw new Error('expected a task');
  const row = w.handle.a2a.store!.getTask(opened.taskId)!;
  await w.handle.messaging.engine.reply(
    row.gate!,
    { body: '', choice: 'approve' },
    { address: 'human:test', canDecide: true }
  );
  return row.dispatchTask!;
}

// An approved client handoff's task, dispatched by the owner: an A2A run.
async function a2aRun(
  w: World
): Promise<{ taskId: string; runId: string; runToken: string }> {
  const taskId = await handoff(
    w,
    'acme',
    'Please add limits.',
    'Rate-limit uploads'
  );
  const run = await startRun(w, w.app, taskId);
  expect(run.meta.operator ?? null).toBeNull();
  return { taskId, runId: run.runId, runToken: run.runToken };
}

const origin = (w: World, taskId: string) => w.handle.a2a.taskOrigin(taskId);

describe('A2A lineage', () => {
  it('a task an A2A run creates is A2A-origin, and so are its runs', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const child = await call(w, a2a.runToken, 'POST', '/api/tasks', {
      title: 'helper: recite project memory',
    });
    expect(child.status).toBe(201);
    const childId = child.json.meta.id as string;
    expect(origin(w, childId)).toBe('a2a');

    // Even the owner's dispatch of it acts for no one.
    const run = await startRun(w, w.app, childId);
    expect(run.meta.operator ?? null).toBeNull();
  });

  it('a task an A2A run edits or dispatches becomes A2A-origin', async () => {
    const w = world();
    const edited = await call(w, w.app, 'POST', '/api/tasks', {
      title: 'owner task',
    });
    const dispatched = await call(w, w.app, 'POST', '/api/tasks', {
      title: 'another owner task',
    });
    const a2a = await a2aRun(w);
    expect(origin(w, edited.json.meta.id)).toBeNull();

    const patch = await call(
      w,
      a2a.runToken,
      'PATCH',
      `/api/tasks/${edited.json.meta.id}`,
      { body: 'rewritten by an A2A run\n' }
    );
    expect(patch.status).toBe(200);
    expect(origin(w, edited.json.meta.id)).toBe('a2a');

    const run = await startRun(w, a2a.runToken, dispatched.json.meta.id);
    expect(origin(w, dispatched.json.meta.id)).toBe('a2a');
    expect(run.meta.operator ?? null).toBeNull();
  });

  it("an ordinary run's tasks stay the project's own", async () => {
    const w = world();
    const run = await liveRun(w, w.app, 'owner work');
    const child = await call(w, run.runToken, 'POST', '/api/tasks', {
      title: 'ordinary child',
    });
    expect(origin(w, child.json.meta.id)).toBeNull();
  });
});

describe('what an A2A run reads', () => {
  it("never another A2A task: only its own, its own children and the project's", async () => {
    const w = world();
    const owner = await call(w, w.app, 'POST', '/api/tasks', {
      title: 'owner task',
    });
    const other = await handoff(
      w,
      'rival',
      'PRIVATE-HANDOFF: our merger term sheet',
      'PRIVATE-TITLE secret project'
    );
    const a2a = await a2aRun(w);
    const child = await call(w, a2a.runToken, 'POST', '/api/tasks', {
      title: 'my child',
    });

    for (const path of ['/api/tasks', '/api/tasks?fields=meta']) {
      const list = await call(w, a2a.runToken, 'GET', path);
      expect(list.status).toBe(200);
      expect(list.text).not.toContain('PRIVATE-');
      const ids = (list.json as { meta: { id: string } }[]).map(
        (t) => t.meta.id
      );
      expect(ids).toContain(a2a.taskId);
      expect(ids).toContain(child.json.meta.id);
      expect(ids).toContain(owner.json.meta.id);
      expect(ids).not.toContain(other);
    }
    expect(
      (await call(w, a2a.runToken, 'GET', `/api/tasks/${other}`)).status
    ).toBe(404);
    const patch = await call(w, a2a.runToken, 'PATCH', `/api/tasks/${other}`, {
      appendActivity: 'x',
    });
    expect(patch.status).toBe(404);
    expect(patch.text).not.toContain('PRIVATE-');
    expect(
      (await call(w, a2a.runToken, 'GET', `/api/tasks/${other}/comments`))
        .status
    ).toBe(404);
    expect(
      (await call(w, a2a.runToken, 'GET', `/api/tasks/${a2a.taskId}`)).status
    ).toBe(200);
    expect(
      (await call(w, a2a.runToken, 'GET', `/api/tasks/${child.json.meta.id}`))
        .status
    ).toBe(200);
    // The owner still sees every task.
    expect((await call(w, w.app, 'GET', `/api/tasks/${other}`)).status).toBe(
      200
    );
  });
});

describe('lineage through every way a run makes tasks', () => {
  it('a fan-out by an A2A run is refused or yields only A2A-origin tasks', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const fan = await call(
      w,
      a2a.runToken,
      'POST',
      `/api/tasks/${a2a.taskId}/fanout`,
      {
        variants: [
          { executor: 'claude', model: 'one' },
          { executor: 'claude', model: 'two' },
        ],
      }
    );
    // The A2A lane may refuse a run's fan-out outright; either is contained.
    expect([201, 403]).toContain(fan.status);
    if (fan.status === 201) {
      for (const v of fan.json.variants as {
        task: { meta: { id: string } };
        run: { operator?: string | null } | null;
      }[]) {
        expect(origin(w, v.task.meta.id)).toBe('a2a');
        expect(v.run?.operator ?? null).toBeNull();
      }
    }
  });

  it('a subtask an A2A run files under any parent is A2A-origin', async () => {
    const w = world();
    const epic = await call(w, w.app, 'POST', '/api/tasks', {
      title: 'owner epic',
      kind: 'epic',
    });
    const a2a = await a2aRun(w);
    const sub = await call(w, a2a.runToken, 'POST', '/api/tasks', {
      title: 'sub',
      parent: epic.json.meta.id,
    });
    expect(sub.status).toBe(201);
    expect(origin(w, sub.json.meta.id)).toBe('a2a');
  });
});

describe('messages into an A2A run', () => {
  it('are refused from any other run', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const other = await liveRun(w, w.app, 'owner work');
    for (const to of [`run:${a2a.runId}`, `task:${a2a.taskId}`]) {
      const sent = await call(w, other.runToken, 'POST', '/api/messages', {
        to: [to],
        kind: 'message',
        body: 'PROJECT-SECRET: hunter2',
      });
      expect(sent.status).toBe(403);
    }
    // Nor by replying into a thread the A2A run started.
    const asked = await call(w, a2a.runToken, 'POST', '/api/messages', {
      to: [`run:${other.runId}`],
      kind: 'message',
      body: 'hello',
    });
    expect(asked.status).toBe(201);
    const reply = await call(
      w,
      other.runToken,
      'POST',
      `/api/messages/${asked.json.message.id}/reply`,
      { body: 'PROJECT-SECRET: hunter2' }
    );
    expect(reply.status).toBe(403);

    const mailbox = await call(w, a2a.runToken, 'GET', '/api/mailbox');
    expect(mailbox.text).not.toContain('PROJECT-SECRET');
  });

  it('still reach it from a human', async () => {
    const w = world();
    const a2a = await a2aRun(w);
    const sent = await call(w, w.app, 'POST', '/api/messages', {
      to: [`run:${a2a.runId}`],
      kind: 'message',
      body: 'carry on',
    });
    expect(sent.status).toBe(201);
  });
});
