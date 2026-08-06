import {
  normalizeProjectPath,
  readCredentials,
  TaskStore,
  writeCredential,
  writeProjectCredential,
} from '@dispatch/core';
import type {
  LinearIssue,
  LinearIssueInput,
  LinearLabel,
  LinearWorkflowState,
} from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type {
  LinearClient,
  LinearIssuePage,
  LinearIssueRef,
  LinearResult,
  LinearTeam,
  LinearViewer,
} from '../src/linear/client.js';
import { json } from './json.js';
import { useTestAuth } from './testAuth.js';

const STATES: LinearWorkflowState[] = [
  { id: 's-todo', name: 'Todo', type: 'unstarted' },
  { id: 's-done', name: 'Done', type: 'completed' },
];

// Serves fixed metadata and records writes; the API tests never open a socket to
// Linear, and never mutate anything but this object.
class StubLinearClient implements LinearClient {
  created: LinearIssueInput[] = [];

  viewer(): Promise<LinearResult<LinearViewer>> {
    return Promise.resolve({
      ok: true,
      data: { id: 'u-1', name: 'Test', email: 'test@example.com' },
    });
  }

  teams(): Promise<LinearResult<LinearTeam[]>> {
    return Promise.resolve({
      ok: true,
      data: [{ id: 'team-1', key: 'HYD', name: 'Hydrogen' }],
    });
  }

  workflowStates(): Promise<LinearResult<LinearWorkflowState[]>> {
    return Promise.resolve({ ok: true, data: STATES });
  }

  labels(): Promise<LinearResult<LinearLabel[]>> {
    return Promise.resolve({ ok: true, data: [] });
  }

  issuesUpdatedSince(): Promise<LinearResult<LinearIssuePage>> {
    return Promise.resolve({
      ok: true,
      data: { issues: [], truncated: false },
    });
  }

  issueLinks(): Promise<LinearResult<LinearIssueRef[]>> {
    return Promise.resolve({ ok: true, data: [] });
  }

  createIssue(input: LinearIssueInput): Promise<LinearResult<LinearIssue>> {
    this.created.push(input);
    return Promise.resolve({
      ok: false,
      kind: 'graphql',
      error: 'not exercised',
    });
  }

  updateIssue(): Promise<LinearResult<LinearIssue>> {
    return Promise.resolve({
      ok: false,
      kind: 'graphql',
      error: 'not exercised',
    });
  }
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
let stub: StubLinearClient;
const originalHome = process.env.DISPATCH_HOME;
const originalKey = process.env.LINEAR_API_KEY;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-linear-api-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  delete process.env.LINEAR_API_KEY;
  root = mkdtempSync(join(tmpdir(), 'dispatch-linear-api-'));
  TaskStore.init(root);
  stub = new StubLinearClient();
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

describe('GET /api/linear/status', () => {
  it('reports the disabled default without a key', async () => {
    const body = await json(await fetch(`${baseUrl}/api/linear/status`));
    expect(body.enabled).toBe(false);
    expect(body.teamId).toBeNull();
    expect(body.direction).toBe('both');
    expect(body.intervalSec).toBe(300);
    expect(body.statusMap.done).toBe('Done');
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

describe('POST /api/linear/disconnect', () => {
  it('clears the stored key and reports the resulting status', async () => {
    writeProjectCredential(root, 'linear', { apiKey: 'lin_api_project_key' });
    await fetch(`${baseUrl}/api/linear/disconnect`, { method: 'POST' });

    expect(
      readCredentials().projects?.[normalizeProjectPath(root)]
    ).toBeUndefined();
    const status = await json(await fetch(`${baseUrl}/api/linear/status`));
    expect(status.keySource).toBeNull();
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
