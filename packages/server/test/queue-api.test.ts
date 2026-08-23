import type { ScoredTask } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

interface QueueBody {
  factors: { key: string; label: string; describes: string }[];
  weights: Record<string, number>;
  generatedAt: string;
  tasks: ScoredTask[];
}

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

// Writes a task file straight to disk (rather than going through POST
// /api/tasks) so a test can set `created` to an arbitrary age.
function writeTask(
  id: string,
  fields: Record<string, string>,
  blockedBy: string[] = []
): void {
  const created = fields.created ?? '2026-01-01T00:00:00.000Z';
  const frontmatter = [
    '---',
    `id: ${id}`,
    `title: "${fields.title ?? id}"`,
    `status: ${fields.status ?? 'todo'}`,
    `kind: ${fields.kind ?? 'task'}`,
    'parent: null',
    'milestone: null',
    blockedBy.length === 0
      ? 'blocked-by: []'
      : `blocked-by:\n${blockedBy.map((b) => `  - ${b}`).join('\n')}`,
    'labels: []',
    `priority: ${fields.priority ?? 'none'}`,
    'assignee: none',
    `created: ${created}`,
    `updated: ${created}`,
    'external: null',
    'writes: []',
    '---',
    '',
    '## Description',
    '',
  ].join('\n');
  writeFileSync(join(root, '.dispatch', 'tasks', `${id}.md`), frontmatter);
}

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-queue-api-'));
  runGitSync(root, ['init', '-b', 'main']);
  runGitSync(root, ['config', 'user.email', 'test@example.com']);
  runGitSync(root, ['config', 'user.name', 'Test']);
  mkdirSync(join(root, '.dispatch', 'tasks'), { recursive: true });
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

// Started after the task files and config exist, since the cache is built at
// boot from whatever is on disk.
async function start(): Promise<void> {
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
}

function getQueue(query = ''): Promise<Response> {
  return fetch(`${baseUrl}/api/queue${query}`);
}

function patchConfig(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('GET /api/queue', () => {
  it('ranks ready tasks by score and explains each one', async () => {
    writeTask('t-aaaaaa', { priority: 'low' });
    writeTask('t-bbbbbb', { priority: 'urgent' });
    await start();

    const res = await getQueue();
    expect(res.status).toBe(200);
    const body = await json<QueueBody>(res);

    expect(body.tasks.map((entry) => entry.task.meta.id)).toEqual([
      't-bbbbbb',
      't-aaaaaa',
    ]);
    const top = body.tasks[0];
    expect(top.score).toBeGreaterThan(body.tasks[1].score);
    // The breakdown is the point of the endpoint: every factor, with the
    // reason it scored what it did.
    expect(top.factors.map((f): string => f.key)).toEqual(
      body.factors.map((f) => f.key)
    );
    expect(top.factors.find((f) => f.key === 'urgency')?.detail).toBe(
      'priority: urgent'
    );
    const summed = top.factors.reduce((sum, f) => sum + f.contribution, 0);
    expect(summed).toBeCloseTo(top.score, 10);
  });

  it('omits non-candidates but still counts real work they represent', async () => {
    writeTask('t-aaaaaa', {});
    writeTask('t-bbbbbb', {}, ['t-aaaaaa']);
    writeTask('t-cccccc', { status: 'backlog' });
    writeTask('e-dddddd', { kind: 'epic' });
    await start();

    const body = await json<QueueBody>(await getQueue());

    expect(body.tasks.map((entry) => entry.task.meta.id)).toEqual(['t-aaaaaa']);
    expect(
      body.tasks[0].factors.find((f) => f.key === 'unblocking')?.detail
    ).toBe('unblocks 1 of 1 downstream task');
  });

  it('reports the factor table and the weights the ranking used', async () => {
    writeTask('t-aaaaaa', {});
    await start();

    const body = await json<QueueBody>(await getQueue());

    expect(body.weights).toEqual({ urgency: 1, unblocking: 0.6, age: 0.3 });
    expect(body.factors).toEqual([
      {
        key: 'urgency',
        label: 'Urgency',
        describes: 'the priority a person set on the task',
      },
      {
        key: 'unblocking',
        label: 'Unblocking value',
        describes: 'how much other work finishing this task frees',
      },
      {
        key: 'age',
        label: 'Age',
        describes: 'how long the task has been waiting',
      },
    ]);
    expect(Date.parse(body.generatedAt)).not.toBeNaN();
  });

  // The whole point of tunable weights: the same task set reorders when a
  // project decides age matters more than the priority field.
  it('honours queue.weights from .dispatch/config.yml', async () => {
    writeTask('t-aaaaaa', {
      priority: 'urgent',
      created: new Date().toISOString(),
    });
    writeTask('t-bbbbbb', { priority: 'low', created: '2020-01-01T00:00:00Z' });
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'queue:\n  weights:\n    urgency: 0\n    unblocking: 0\n    age: 1\n'
    );
    await start();

    const body = await json<QueueBody>(await getQueue());

    expect(body.weights).toEqual({ urgency: 0, unblocking: 0, age: 1 });
    expect(body.tasks.map((entry) => entry.task.meta.id)).toEqual([
      't-bbbbbb',
      't-aaaaaa',
    ]);
  });

  it('applies ?limit after ranking', async () => {
    writeTask('t-aaaaaa', { priority: 'low' });
    writeTask('t-bbbbbb', { priority: 'urgent' });
    await start();

    const body = await json<QueueBody>(await getQueue('?limit=1'));

    expect(body.tasks.map((entry) => entry.task.meta.id)).toEqual(['t-bbbbbb']);
  });

  it('rejects a limit that is not a non-negative integer', async () => {
    writeTask('t-aaaaaa', {});
    await start();

    for (const bad of ['-1', '1.5', 'abc', '']) {
      const res = await getQueue(`?limit=${bad}`);
      expect(res.status).toBe(400);
      expect((await json<{ error: string }>(res)).error).toContain(
        'invalid limit'
      );
    }
  });

  it('returns an empty queue rather than an error when nothing is ready', async () => {
    await start();

    const body = await json<QueueBody>(await getQueue());

    expect(body.tasks).toEqual([]);
    expect(body.factors).toHaveLength(3);
  });

  // A blocker in review is dispatch-satisfied, so the orchestrator would start
  // its dependent. The queue must not hide work dispatch would take.
  it('includes a task whose blocker is in review', async () => {
    writeTask('t-aaaaaa', { status: 'in-review' });
    writeTask('t-bbbbbb', {}, ['t-aaaaaa']);
    await start();

    const body = await json<QueueBody>(await getQueue());

    expect(body.tasks.map((entry) => entry.task.meta.id)).toEqual(['t-bbbbbb']);
  });
});

// A `queue:` block that will not parse must fail the queue loudly without
// taking every other config-reading route down with it.
describe('GET /api/queue with a broken queue block', () => {
  beforeEach(() => {
    writeTask('t-aaaaaa', {});
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'queue:\n  weights:\n    urgncy: 2\n'
    );
  });

  it('422s the queue with the reason', async () => {
    await start();

    const res = await getQueue();
    expect(res.status).toBe(422);
    expect((await json<{ error: string }>(res)).error).toMatch(
      /unknown queue\.weights factor "urgncy"/
    );
  });

  it('leaves unrelated config-reading routes working', async () => {
    await start();

    for (const path of ['/api/config', '/api/tasks', '/api/health']) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status).toBe(200);
    }
  });

  it('surfaces the error on GET /api/config so a UI can explain it', async () => {
    await start();

    const config = await json<{
      queue: { weights: Record<string, number>; error?: string };
    }>(await fetch(`${baseUrl}/api/config`));

    expect(config.queue.error).toMatch(/urgncy/);
    // Still renderable: the defaults stand in so a Settings form has values.
    expect(config.queue.weights).toEqual({
      urgency: 1,
      unblocking: 0.6,
      age: 0.3,
    });
  });
});

// The Settings weights UI is a PATCH away from useless if the allow-list does
// not carry `queue` through to updateConfig.
describe('PATCH /api/config queue.weights', () => {
  it('persists a weight change and reranks the queue', async () => {
    writeTask('t-aaaaaa', {
      priority: 'urgent',
      created: new Date().toISOString(),
    });
    writeTask('t-bbbbbb', { priority: 'low', created: '2020-01-01T00:00:00Z' });
    await start();

    expect(
      (await json<QueueBody>(await getQueue())).tasks.map((e) => e.task.meta.id)
    ).toEqual(['t-aaaaaa', 't-bbbbbb']);

    const res = await patchConfig({
      queue: { weights: { urgency: 0, unblocking: 0, age: 1 } },
    });
    expect(res.status).toBe(200);

    const after = await json<QueueBody>(await getQueue());
    expect(after.weights).toEqual({ urgency: 0, unblocking: 0, age: 1 });
    expect(after.tasks.map((e) => e.task.meta.id)).toEqual([
      't-bbbbbb',
      't-aaaaaa',
    ]);
  });

  it('leaves weights the patch omits alone', async () => {
    writeTask('t-aaaaaa', {});
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      'queue:\n  weights:\n    age: 5\n'
    );
    await start();

    await patchConfig({ queue: { weights: { urgency: 2 } } });

    expect((await json<QueueBody>(await getQueue())).weights).toEqual({
      urgency: 2,
      unblocking: 0.6,
      age: 5,
    });
  });

  it('400s a bad weight without writing it to disk', async () => {
    writeTask('t-aaaaaa', {});
    await start();

    const res = await patchConfig({ queue: { weights: { age: -3 } } });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(
      /queue\.weights\.age/
    );
    // The queue still answers, so nothing invalid reached the file.
    expect((await getQueue()).status).toBe(200);
  });

  it('400s an unknown factor key', async () => {
    writeTask('t-aaaaaa', {});
    await start();

    const res = await patchConfig({ queue: { weights: { urgncy: 1 } } });
    expect(res.status).toBe(400);
    expect((await json<{ error: string }>(res)).error).toMatch(
      /invalid queue\.weights factor/
    );
  });

  it('400s a non-object queue or weights', async () => {
    writeTask('t-aaaaaa', {});
    await start();

    expect((await patchConfig({ queue: 3 })).status).toBe(400);
    expect((await patchConfig({ queue: { weights: [] } })).status).toBe(400);
  });
});
