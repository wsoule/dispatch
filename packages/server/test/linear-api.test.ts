import {
  ensureA2ALinkKeys,
  normalizeProjectPath,
  readCredentials,
  TaskStore,
  writeCredential,
  writeProjectCredential,
} from '@dispatch-foo/core';
import type { LinearWorkflowState } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { LINEAR_USAGE_LIMIT_MESSAGE } from '../src/linear/client.js';
import { emptyLinearState, writeLinearState } from '../src/linear/state.js';
import { json } from './json.js';
import { FakeLinearClient, STATES as LINKED_STATES } from './linearFake.js';
import { rawFetch, useTestAuth } from './testAuth.js';

const STATES: LinearWorkflowState[] = [
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-done', name: 'Done', type: 'completed' },
];
const DONE_STATE = LINKED_STATES[4];
const CANCELED_STATE = LINKED_STATES[5];

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
let stub: FakeLinearClient;
const originalHome = process.env.DISPATCH_HOME;
const originalKey = process.env.LINEAR_API_KEY;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-linear-api-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.LINEAR_API_KEY;
  root = mkdtempSync(join(tmpdir(), 'dispatch-linear-api-'));
  TaskStore.init(root);
  // Serves fixed metadata; the API tests never open a socket to Linear.
  stub = new FakeLinearClient();
  stub.states = STATES;
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    linearClient: stub,
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

// Links `dir` to the fake's team, with statuses matching the fake's states.
// Written to disk rather than PATCHed, so no sync timer starts.
function linkConfig(direction: 'both' | 'pull' = 'both', dir = root): void {
  writeFileSync(
    join(dir, '.dispatch', 'config.yml'),
    `statuses: [backlog, todo, in-progress, in-review, done, cancelled]\nautoCommit: false\nlinear:\n  enabled: true\n  teamId: team-1\n  direction: ${direction}\n`
  );
}

// A link made earlier, so a pass skips the first-sync baseline.
function seedLinked(): void {
  writeLinearState(root, {
    ...emptyLinearState(),
    bootstrappedAt: '2020-01-01T00:00:00.000Z',
  });
}

function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/linear/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createTask(title: string, status = 'todo'): Promise<string> {
  const res = await fetch(`${baseUrl}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, status }),
  });
  expect(res.status).toBe(201);
  return ((await json(res)) as { meta: { id: string } }).meta.id;
}

// Bulk routes answer before their pass ends; status says when it has.
async function settled(): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const res = await fetch(`${baseUrl}/api/linear/status`);
    const status = (await json(res)) as Record<string, unknown>;
    if (status.running === null && status.syncing === false) return status;
    if (Date.now() > deadline) throw new Error('Linear pass still running');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('GET /api/linear/status', () => {
  it('reports the disabled default without a key', async () => {
    const body = await json(await fetch(`${baseUrl}/api/linear/status`));
    expect(body.enabled).toBe(false);
    expect(body.teamId).toBeNull();
    expect(body.direction).toBe('both');
    expect(body.intervalSec).toBe(30);
    expect(body.statusMap.landed).toBe('Done');
    expect(body.keySource).toBeNull();
    expect(body.lastSyncAt).toBeNull();
  });
});

describe('PATCH /api/config', () => {
  it('writes the linear block and leaves the rest of the file alone', async () => {
    writeFileSync(
      join(root, '.dispatch', 'config.yml'),
      '# keep me\nautoCommit: false\n'
    );
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        linear: { enabled: true, teamId: 'team-1', direction: 'pull' },
      }),
    });
    expect(res.status).toBe(200);
    const config = await json(res);
    expect(config.linear).toMatchObject({
      enabled: true,
      teamId: 'team-1',
      direction: 'pull',
    });
    const file = readFileSync(join(root, '.dispatch', 'config.yml'), 'utf8');
    expect(file).toContain('# keep me');
  });

  it('refuses an API key smuggled through config', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linear: { apiKey: 'lin_api_nope' } }),
    });
    expect(res.status).toBe(400);
    const file = readFileSync(join(root, '.dispatch', 'config.yml'), 'utf8');
    expect(file).not.toContain('lin_api_nope');
  });

  it('rejects an interval below the polling floor', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ linear: { intervalSec: 1 } }),
    });
    expect(res.status).toBe(400);
  });

  it('writes linear.archiveFinished and refuses a value that is not a boolean', async () => {
    const patch = (archiveFinished: unknown) =>
      fetch(`${baseUrl}/api/config`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ linear: { archiveFinished } }),
      });
    const configPath = join(root, '.dispatch', 'config.yml');

    const res = await patch(true);
    expect(res.status).toBe(200);
    expect((await json(res)).linear.archiveFinished).toBe(true);
    const written = readFileSync(configPath, 'utf8');
    expect(written).toContain('archiveFinished: true');

    const refused = await patch('yes');
    expect(refused.status).toBe(400);
    expect((await json(refused)).error).toContain('archiveFinished');
    expect(readFileSync(configPath, 'utf8')).toBe(written);
  });
});

describe('GET /api/linear/teams and /states', () => {
  it('lists teams', async () => {
    const body = await json(await fetch(`${baseUrl}/api/linear/teams`));
    expect(body).toEqual([{ id: 'team-1', key: 'HYD', name: 'Hydrogen' }]);
  });

  it('lists a team’s workflow states', async () => {
    const res = await fetch(`${baseUrl}/api/linear/states?teamId=team-1`);
    expect(await json(res)).toEqual(STATES);
  });

  it('requires a teamId', async () => {
    const res = await fetch(`${baseUrl}/api/linear/states`);
    expect(res.status).toBe(400);
  });
});

describe('POST /api/linear/connect', () => {
  it('rejects a missing key before it ever calls out', async () => {
    const res = await fetch(`${baseUrl}/api/linear/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: '  ' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/linear/sync', () => {
  it('returns a summary explaining why an unconfigured project cannot sync', async () => {
    // Body-less, but still typed: every mutating route rejects a POST without
    // the JSON content-type, which is the daemon's CSRF defence.
    const res = await fetch(`${baseUrl}/api/linear/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(res.status).toBe(200);
    const summary = await json(res);
    expect(summary.errors).toEqual(['no Linear team selected']);
    expect(summary.pulled).toBe(0);
  });

  it('rejects a taskIds value that is not a list of strings', async () => {
    const res = await fetch(`${baseUrl}/api/linear/sync`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taskIds: 't-abc123' }),
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/linear/links', () => {
  it('returns an empty map before anything is linked', async () => {
    expect(await json(await fetch(`${baseUrl}/api/linear/links`))).toEqual({});
  });
});

describe('POST /api/linear/import', () => {
  it('reports why an unconfigured project cannot import', async () => {
    const res = await fetch(`${baseUrl}/api/linear/import`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await json(res)).errors).toEqual(['no Linear team selected']);
  });
});

describe('GET /api/linear/export', () => {
  it('counts what each scope would send without calling Linear', async () => {
    linkConfig();
    await createTask('Open');
    await createTask('Also open', 'in-progress');
    await createTask('Finished', 'done');

    const res = await fetch(`${baseUrl}/api/linear/export`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      open: 2,
      all: 3,
      allArchiveFinished: 3,
      finished: 1,
      archived: 0,
      derived: 0,
      containers: 0,
    });
    expect(stub.calls).toEqual([]);
  });
});

describe('POST /api/linear/export', () => {
  beforeEach(() => {
    stub.states = LINKED_STATES;
  });

  it('rejects a missing or unknown scope', async () => {
    for (const body of [{}, { scope: 'everything' }, { scope: 7 }]) {
      const res = await postJson('export', body);
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe(
        'scope must be open|all|all-archive-finished'
      );
    }
  });

  it('refuses with 409 while no team is linked, or the link only pulls', async () => {
    const unlinked = await postJson('export', { scope: 'open' });
    expect(unlinked.status).toBe(409);
    expect((await json(unlinked)).error).toBe('no Linear team selected');

    linkConfig('pull');
    const pullOnly = await postJson('export', { scope: 'open' });
    expect(pullOnly.status).toBe(409);
    expect((await json(pullOnly)).error).toBe(
      'sync direction is pull only; export needs push'
    );
    expect(stub.created).toEqual([]);
  });

  it('answers 200 without starting anything when no task is in scope', async () => {
    linkConfig();
    seedLinked();
    await createTask('Finished', 'done');

    const res = await postJson('export', { scope: 'open' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ started: false, candidates: 0 });
    expect((await settled()).lastExport).toBeNull();
  });

  it('starts with 202 and creates issues for open work only', async () => {
    linkConfig();
    seedLinked();
    await createTask('Open');
    await createTask('Finished', 'done');

    const res = await postJson('export', { scope: 'open' });
    expect(res.status).toBe(202);
    const started = await json(res);
    expect(started).toMatchObject({ started: true, candidates: 1 });
    expect(typeof started.startedAt).toBe('string');

    const status = await settled();
    expect(stub.created.map((c) => c.title)).toEqual(['Open']);
    expect(status.lastExport).toMatchObject({
      action: 'export',
      scope: 'open',
      startedAt: started.startedAt,
      candidates: 1,
      done: 1,
      remaining: 0,
      halted: null,
    });
  });

  it('archives finished tasks on arrival under all-archive-finished', async () => {
    linkConfig();
    seedLinked();
    await createTask('Open');
    await createTask('Finished', 'done');

    const res = await postJson('export', { scope: 'all-archive-finished' });
    expect(res.status).toBe(202);
    expect((await json(res)).candidates).toBe(2);
    await settled();

    const archived = stub.issues.filter((i) => i.archivedAt !== null);
    expect(stub.issues).toHaveLength(2);
    expect(archived.map((i) => i.title)).toEqual(['Finished']);
  });

  it('refuses every other bulk action while an export runs', async () => {
    linkConfig();
    seedLinked();
    await createTask('Open');
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const createIssue = stub.createIssue.bind(stub);
    stub.createIssue = async (input) => {
      await gate;
      return createIssue(input);
    };

    try {
      expect((await postJson('export', { scope: 'open' })).status).toBe(202);
      const running = await json(await fetch(`${baseUrl}/api/linear/status`));
      expect(running.running.action).toBe('export');
      for (const [path, body] of [
        ['export', { scope: 'all' }],
        ['retry', {}],
        ['archive-closed', {}],
      ] as const) {
        const res = await postJson(path, body);
        expect(res.status).toBe(409);
        expect((await json(res)).error).toBe(
          'an export or archive is already running'
        );
      }
    } finally {
      release();
    }
    await settled();
    expect(stub.created.map((c) => c.title)).toEqual(['Open']);
  });
});

describe('Linear routes without a key', () => {
  it('refuses export, archive and capacity with 409', async () => {
    const keyless = mkdtempSync(join(tmpdir(), 'dispatch-linear-api-keyless-'));
    TaskStore.init(keyless);
    linkConfig('both', keyless);
    const other = await startServer({
      rootDir: keyless,
      port: 0,
      webDistDir: null,
      writeDaemonFile: false,
    });
    useTestAuth(other);
    const url = `http://127.0.0.1:${other.port}/api/linear`;
    const post = (path: string, body: unknown) =>
      fetch(`${url}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    try {
      for (const res of [
        await post('export', { scope: 'open' }),
        await post('retry', {}),
        await post('archive-closed', {}),
        await fetch(`${url}/capacity`),
      ]) {
        expect(res.status).toBe(409);
        expect((await json(res)).error).toBe('no Linear API key configured');
      }
      // Coverage reads the board only, so it answers while disconnected.
      expect((await fetch(`${url}/coverage`)).status).toBe(200);
    } finally {
      await other.stop();
    }
  });
});

describe('GET /api/linear/coverage', () => {
  it('reports an empty board without calling Linear', async () => {
    const res = await fetch(`${baseUrl}/api/linear/coverage`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      total: 0,
      linked: 0,
      notLinked: 0,
      excluded: { derived: 0 },
      byEntity: { issue: 0, project: 0, milestone: 0, initiative: 0 },
      counts: {
        failed: 0,
        'at-capacity': 0,
        queued: 0,
        'moved-out': 0,
        'pull-only': 0,
        'held-back': 0,
        pending: 0,
      },
      unlinked: [],
    });
    expect(stub.calls).toEqual([]);
  });

  it('counts linked tasks and says why each other one is unlinked', async () => {
    stub.states = LINKED_STATES;
    linkConfig();
    seedLinked();
    await createTask('Open');
    const finished = await createTask('Finished', 'done');
    await postJson('export', { scope: 'open' });
    const status = await settled();

    const coverage = await json(await fetch(`${baseUrl}/api/linear/coverage`));
    expect(coverage).toMatchObject({
      total: 2,
      linked: 1,
      notLinked: 1,
      byEntity: { issue: 1 },
      unlinked: [
        {
          id: finished,
          title: 'Finished',
          finished: true,
          archived: false,
          reason: 'pending',
          attempts: 0,
          lastError: null,
        },
      ],
    });
    expect(status.coverage).toMatchObject({
      total: 2,
      linked: 1,
      notLinked: 1,
      failed: 0,
    });
  });
});

describe('POST /api/linear/retry and /forget', () => {
  beforeEach(() => {
    stub.states = LINKED_STATES;
  });

  // A create Linear refused, which leaves the task queued for a retry.
  async function failedCreate(): Promise<string> {
    linkConfig();
    seedLinked();
    const id = await createTask('Open');
    stub.createFailure = { ok: false, kind: 'graphql', error: 'nope' };
    const summary = await json(await postJson('sync', { taskIds: [id] }));
    expect(summary.failedTaskIds).toEqual([id]);
    stub.createFailure = null;
    return id;
  }

  it('rejects taskIds that are not a list of strings', async () => {
    for (const path of ['retry', 'forget']) {
      const res = await postJson(path, { taskIds: 't-abc123' });
      expect(res.status).toBe(400);
      expect((await json(res)).error).toBe('taskIds must be a list of strings');
    }
    // Forget names its tasks; retry without them takes every queued one.
    expect((await postJson('forget', {})).status).toBe(400);
  });

  it('sends a failed create again with 202', async () => {
    const id = await failedCreate();
    const before = await json(await fetch(`${baseUrl}/api/linear/coverage`));
    expect(before.unlinked[0]).toMatchObject({
      id,
      reason: 'failed',
      lastError: 'nope',
    });

    const res = await postJson('retry', {});
    expect(res.status).toBe(202);
    expect(await json(res)).toMatchObject({ started: true, candidates: 1 });
    const status = await settled();

    expect(stub.created.map((c) => c.title)).toEqual(['Open']);
    expect(status.lastExport).toMatchObject({ action: 'retry', done: 1 });
  });

  it('stops retrying a forgotten task', async () => {
    const id = await failedCreate();

    const res = await postJson('forget', { taskIds: [id, 't-missing'] });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ forgotten: 1 });

    const coverage = await json(await fetch(`${baseUrl}/api/linear/coverage`));
    expect(coverage.unlinked[0]).toMatchObject({ id, reason: 'held-back' });
    const retry = await postJson('retry', {});
    expect(await json(retry)).toEqual({ started: false, candidates: 0 });
  });
});

describe('GET /api/linear/capacity', () => {
  beforeEach(() => {
    stub.states = LINKED_STATES;
    linkConfig();
    stub.issues = [
      stub.issue({ state: DONE_STATE }),
      stub.issue({ state: CANCELED_STATE }),
      stub.issue(),
      stub.issue({ state: DONE_STATE, archivedAt: '2026-07-01T00:00:00.000Z' }),
    ];
  });

  it('counts live issues per linked team against the free-plan limit', async () => {
    const res = await fetch(`${baseUrl}/api/linear/capacity`);
    expect(res.status).toBe(200);
    const capacity = await json(res);
    expect(capacity).toMatchObject({
      teams: [
        {
          id: 'team-1',
          key: 'HYD',
          name: 'Hydrogen',
          active: 3,
          completed: 1,
          canceled: 1,
        },
      ],
      active: 3,
      activeScope: 'workspace',
      limit: 250,
      limitSource: 'plan',
      plan: 'free',
      limitHitAt: null,
      truncated: false,
    });
    expect(typeof capacity.checkedAt).toBe('string');
  });

  it('serves the last measurement until refresh=1', async () => {
    const read = async (query = '') => {
      const res = await fetch(`${baseUrl}/api/linear/capacity${query}`);
      return ((await json(res)) as { active: number }).active;
    };
    expect(await read()).toBe(3);
    stub.issues.push(stub.issue());

    expect(await read()).toBe(3);
    expect(await read('?refresh=1')).toBe(4);
    expect(stub.calls.filter((c) => c === 'capacity')).toHaveLength(2);
  });

  it('answers 402 when Linear says the workspace is at its issue limit', async () => {
    stub.failures.capacity = {
      ok: false,
      kind: 'usage-limit',
      error: LINEAR_USAGE_LIMIT_MESSAGE,
    };
    const res = await fetch(`${baseUrl}/api/linear/capacity?refresh=1`);
    expect(res.status).toBe(402);
    expect((await json(res)).error).toBe(LINEAR_USAGE_LIMIT_MESSAGE);
  });
});

describe('POST /api/linear/archive-closed', () => {
  beforeEach(() => {
    stub.states = LINKED_STATES;
    linkConfig();
    stub.issues = [
      stub.issue({ title: 'Done', state: DONE_STATE }),
      stub.issue({ title: 'Canceled', state: CANCELED_STATE }),
      stub.issue({ title: 'Going' }),
    ];
  });

  it('rejects an includeCanceled that is not a boolean', async () => {
    seedLinked();
    const res = await postJson('archive-closed', { includeCanceled: 'yes' });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toBe('includeCanceled must be a boolean');
  });

  it('refuses before the link exists', async () => {
    const res = await postJson('archive-closed', {});
    expect(res.status).toBe(409);
    expect((await json(res)).error).toBe(
      'Linear is not linked yet; sync once first'
    );
  });

  it('archives completed issues, and canceled ones only when asked', async () => {
    seedLinked();
    const res = await postJson('archive-closed', {});
    expect(res.status).toBe(202);
    const started = await json(res);
    expect(started.started).toBe(true);
    await settled();
    const archived = () =>
      stub.issues
        .filter((i) => i.archivedAt !== null)
        .map((i) => i.title)
        .sort();
    expect(archived()).toEqual(['Done']);

    expect(
      (await postJson('archive-closed', { includeCanceled: true })).status
    ).toBe(202);
    const status = await settled();
    expect(archived()).toEqual(['Canceled', 'Done']);
    expect(status.lastArchive).toMatchObject({
      action: 'archive',
      includeCanceled: true,
      done: 1,
    });
  });
});

// The stored key decides whose Linear account, and which workspace, the board
// is sent to, so only the owner may set or remove it. Using the key once it
// is set (sync, import, the pickers) stays on the request tier.
describe('who may change the Linear key', () => {
  function post(path: string, token: string, body?: unknown) {
    return rawFetch(`${baseUrl}/api/linear/${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  it('refuses connect and disconnect below the operator tier, before any call out', async () => {
    writeProjectCredential(root, 'linear', { apiKey: 'lin_api_owner_key' });
    const lead = handle.team.teammates.issue('ada', 'decide');
    for (const token of [handle.tokens.agentToken, lead]) {
      const connect = await post('connect', token, {
        apiKey: 'lin_api_someone_else',
      });
      expect(connect.status).toBe(403);
      expect(((await json(connect)) as { code: string }).code).toBe(
        'auth_insufficient_tier'
      );
      expect((await post('disconnect', token)).status).toBe(403);
    }
    expect(
      readCredentials().projects?.[normalizeProjectPath(root)]?.linear?.apiKey
    ).toBe('lin_api_owner_key');
  });

  it('leaves sync and import to the agent token', async () => {
    const agent = handle.tokens.agentToken;
    expect((await post('sync', agent)).status).toBe(200);
    expect((await post('import', agent)).status).toBe(200);
  });

  // Export and retry push no more than sync {taskIds} may; the reads show
  // board data the caller can already list.
  it('leaves export, retry, forget and the coverage reads to the agent token', async () => {
    const agent = handle.tokens.agentToken;
    const get = (path: string) =>
      rawFetch(`${baseUrl}/api/linear/${path}`, {
        headers: { authorization: `Bearer ${agent}` },
      });
    for (const path of ['export', 'coverage', 'capacity']) {
      expect((await get(path)).status).toBe(200);
    }
    // 409 is the engine's refusal (no team yet), past the tier check.
    expect((await post('export', agent, { scope: 'open' })).status).toBe(409);
    expect((await post('retry', agent, {})).status).toBe(409);
    expect((await post('forget', agent, { taskIds: [] })).status).toBe(200);
  });

  it('refuses archive-closed to the agent token and lets a decide teammate start it', async () => {
    linkConfig();
    seedLinked();
    stub.states = LINKED_STATES;
    stub.issues = [stub.issue({ title: 'Done', state: DONE_STATE })];

    const refused = await post('archive-closed', handle.tokens.agentToken, {});
    expect(refused.status).toBe(403);
    expect(((await json(refused)) as { code: string }).code).toBe(
      'auth_insufficient_tier'
    );
    expect(stub.calls).not.toContain('closedIssues');

    const lead = handle.team.teammates.issue('ada', 'decide');
    expect((await post('archive-closed', lead, {})).status).toBe(202);
    await settled();
    expect(stub.issues[0].archivedAt).not.toBeNull();
  });
});

describe('POST /api/linear/disconnect', () => {
  it('clears the stored key and reports the resulting status', async () => {
    writeProjectCredential(root, 'linear', { apiKey: 'lin_api_project_key' });
    await fetch(`${baseUrl}/api/linear/disconnect`, { method: 'POST' });

    expect(
      readCredentials().projects?.[normalizeProjectPath(root)]?.linear
    ).toBeUndefined();
    const status = await json(await fetch(`${baseUrl}/api/linear/status`));
    expect(status.keySource).toBeNull();
  });

  it('clears only the Linear key, never the A2A keys beside it', async () => {
    await ensureA2ALinkKeys(root, () => ({
      signPriv: 'sign-private',
      signPub: 'sign-public',
      sealPriv: 'seal-private',
      sealPub: 'seal-public',
    }));
    writeProjectCredential(root, 'linear', { apiKey: 'lin_api_project_key' });
    const before =
      readCredentials().projects?.[normalizeProjectPath(root)]?.a2a;
    expect(before?.linkKeys).toBeDefined();
    await fetch(`${baseUrl}/api/linear/disconnect`, { method: 'POST' });

    const after = readCredentials().projects?.[normalizeProjectPath(root)];
    expect(after?.linear).toBeUndefined();
    expect(after?.a2a).toEqual(before);
  });

  it('leaves a machine-wide key intact and reports it as the fallback', async () => {
    writeCredential('linear', { apiKey: 'lin_api_global_key' });
    await fetch(`${baseUrl}/api/linear/disconnect`, { method: 'POST' });

    expect(readCredentials().linear?.apiKey).toBe('lin_api_global_key');
    const status = await json(await fetch(`${baseUrl}/api/linear/status`));
    expect(status.keySource).toBe('global');
    expect(status.connected).toBe(true);
  });
});

describe('POST /api/docs/:ref/share-linear', () => {
  it("creates a Linear document under the doc's task's issue for the owner, and refuses a doc with no synced task", async () => {
    const tasks = TaskStore.init(root);
    const task = tasks.create({ title: 'Linked' });
    tasks.update(task.meta.id, { external: 'linear:iss-1' });
    const post = (path: string, body: unknown) =>
      fetch(`${baseUrl}/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const made = await post('/docs', {
      title: 'Design',
      body: 'x\n',
      links: [{ target: `task:${task.meta.id}`, rel: 'spec' }],
    });
    expect(made.status).toBe(201);
    expect((await post('/docs', { title: 'Loose', body: 'l\n' })).status).toBe(
      201
    );
    const loose = await post('/docs/loose/share-linear', {});
    expect(loose.status).toBe(400);
    expect(stub.documentCreates).toEqual([]);

    const res = await post('/docs/design/share-linear', {});
    expect(res.status).toBe(201);
    const { documentId } = await json(res);
    expect(stub.documentCreates).toEqual([
      { title: 'Design', content: 'x\n', issueId: 'iss-1' },
    ]);
    const doc = await json(await fetch(`${baseUrl}/api/docs/design`));
    expect(doc.doc.origin).toBe(`linear:${documentId}`);
  });
});
