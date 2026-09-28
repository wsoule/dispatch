import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiContext } from '../src/api.js';
import { humanCredentialRef, routePrincipal } from '../src/api/caller.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { RunMeta } from '../src/orchestrator/types.js';
import { initGitRepo, StallingExecutor } from './orchestrator/helpers.js';
import { rawFetch, useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let base: string;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = realpathSync(mkdtempSync(join(tmpdir(), 'dispatch-home-')));
  process.env.DISPATCH_HOME = fakeHome;
  root = realpathSync(initGitRepo('dispatch-api-caller-'));
  handle = await startServer({
    rootDir: root,
    port: 0,
    webDistDir: null,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      orchestrator.registerExecutor('claude', new StallingExecutor());
    },
  });
  useTestAuth(handle);
  base = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

async function createTask(
  title: string,
  extra: Record<string, unknown> = {}
): Promise<string> {
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title, ...extra }),
  });
  expect(res.status).toBe(201);
  return (await json<{ meta: { id: string } }>(res)).meta.id;
}

// The app token rides on `fetch` (useTestAuth); any other bearer goes raw.
function post(path: string, body: unknown, bearer?: string) {
  return (bearer === undefined ? fetch : rawFetch)(`${base}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify(body),
  });
}

// Read back through GET /api/runs/:id, so the field is the one the run keeps.
async function operatorOf(res: Response): Promise<string | null | undefined> {
  expect(res.status).toBe(201);
  const { id } = await json<RunMeta>(res);
  const read = await fetch(`${base}/api/runs/${id}`);
  return (await json<{ meta: RunMeta }>(read)).meta.operator;
}

describe('who a route-started run acts for', () => {
  it('the dispatch route: the app token acts for the owner, a teammate for themselves, the shared agentToken for no one', async () => {
    const dispatchAs = async (title: string, bearer?: string) =>
      post(
        `/api/tasks/${await createTask(title)}/runs`,
        { executor: 'claude' },
        bearer
      );
    expect(await operatorOf(await dispatchAs('app'))).toBe('human:test');
    const ada = handle.team.teammates.issue('ada', 'request');
    expect(await operatorOf(await dispatchAs('teammate', ada))).toBe(
      'human:ada'
    );
    const shared = await dispatchAs('agent token', handle.tokens.agentToken);
    expect(await operatorOf(shared)).toBeNull();
  });

  it('a fan-out acts for the caller’s credential, and for no one under the agentToken', async () => {
    const variants = [
      { executor: 'claude' },
      { executor: 'claude', model: 'claude-other' },
    ];
    type Fanout = { variants: { run: RunMeta | null }[] };
    const mine = await json<Fanout>(
      await post(`/api/tasks/${await createTask('fan')}/fanout`, { variants })
    );
    expect(mine.variants.map((v) => v.run?.operator)).toEqual([
      'human:test',
      'human:test',
    ]);
    const shared = await json<Fanout>(
      await post(
        `/api/tasks/${await createTask('fan-agent')}/fanout`,
        { variants },
        handle.tokens.agentToken
      )
    );
    expect(shared.variants.map((v) => v.run?.operator)).toEqual([null, null]);
  });

  it('an epic started by a human records its operator and its auto-fill acts for them; the agentToken starts one for no one', async () => {
    type Session = { operator?: string };
    const liveOperator = async (child: string) => {
      const runs = await json<RunMeta[]>(await fetch(`${base}/api/runs`));
      return runs.find((r) => r.taskId === child)?.operator;
    };

    const shared = await createTask('shared epic', { kind: 'epic' });
    const sharedChild = await createTask('child', { parent: shared });
    const bySharedToken = await post(
      `/api/epics/${shared}/dispatch`,
      {},
      handle.tokens.agentToken
    );
    expect(bySharedToken.status).toBe(201);
    expect((await json<Session>(bySharedToken)).operator).toBeUndefined();
    expect(await liveOperator(sharedChild)).toBeNull();

    const mine = await createTask('my epic', { kind: 'epic' });
    const myChild = await createTask('child', { parent: mine });
    const byApp = await post(`/api/epics/${mine}/dispatch`, {});
    expect(byApp.status).toBe(201);
    expect((await json<Session>(byApp)).operator).toBe('human:test');
    expect(await liveOperator(myChild)).toBe('human:test');
  });
});

describe('humanCredentialRef and routePrincipal', () => {
  // Only the fields the two helpers read.
  const ctx = (fields: Partial<ApiContext>) =>
    ({
      actorContext: { humanRef: 'human:owner' },
      ...fields,
    }) as ApiContext;

  it('never make the shared agentToken a human', () => {
    const shared = ctx({
      caller: { handle: 'owner', ref: 'human:owner', tier: 'request' },
      viaAgentToken: true,
    });
    expect(humanCredentialRef(shared)).toBeNull();
    expect(routePrincipal(shared)).toEqual({
      address: 'human:owner',
      canDecide: false,
      kind: 'agent',
    });
  });

  it('a teammate is a human who decides only at decide tier', () => {
    const request = ctx({
      caller: { handle: 'ada', ref: 'human:ada', tier: 'request' },
    });
    expect(humanCredentialRef(request)).toBe('human:ada');
    expect(routePrincipal(request)).toEqual({
      address: 'human:ada',
      canDecide: false,
      kind: 'human',
    });
    const lead = ctx({
      caller: { handle: 'ada', ref: 'human:ada', tier: 'decide' },
    });
    expect(routePrincipal(lead)).toEqual({
      address: 'human:ada',
      canDecide: true,
      kind: 'human',
    });
  });

  it('a context with no caller is no one', () => {
    expect(humanCredentialRef(ctx({}))).toBeNull();
    expect(routePrincipal(ctx({})).kind).toBe('agent');
  });
});
