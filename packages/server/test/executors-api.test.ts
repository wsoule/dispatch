import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { CODEX_EXECUTOR_PROFILE } from '../src/orchestrator/executors/codex.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { ExecutorInfo } from '../src/orchestrator/types.js';
import { useTestAuth } from './testAuth.js';

function json<T>(res: Response): Promise<T> {
  return res.json() as Promise<T>;
}

let root: string;
let fakeHome: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = mkdtempSync(join(tmpdir(), 'dispatch-executors-api-'));
  TaskStore.init(root);
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    registerExecutors: (orchestrator) => {
      const script = { steps: [], finish: { state: 'finished' as const } };
      orchestrator.registerExecutor('claude', new FakeExecutor(script));
      orchestrator.registerExecutor('fake', new FakeExecutor(script));
      // A fake wearing Codex's profile, so the flags come from the profile
      // rather than from any real Codex binary on this machine.
      orchestrator.registerExecutor(
        'codex',
        Object.assign(new FakeExecutor(script), {
          profile: CODEX_EXECUTOR_PROFILE,
        })
      );
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  await handle.stop();
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function patchConfig(body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/config`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface ExecutorsResponse {
  executors: ExecutorInfo[];
  default: string;
}

describe('GET /api/executors', () => {
  it('lists every registered executor with its profile and the configured default', async () => {
    const body = await json<ExecutorsResponse>(
      await fetch(`${baseUrl}/api/executors`)
    );
    expect(body.default).toBe('claude');
    expect(body.executors).toEqual([
      {
        name: 'claude',
        reportsCost: true,
        reportsTurns: true,
        enforcesCaps: true,
      },
      {
        name: 'codex',
        reportsCost: false,
        reportsTurns: true,
        enforcesCaps: false,
      },
      {
        name: 'fake',
        reportsCost: true,
        reportsTurns: true,
        enforcesCaps: true,
      },
    ]);
  });

  it('follows a PATCHed default executor', async () => {
    const res = await patchConfig({ executor: 'fake' });
    expect(res.status).toBe(200);
    const body = await json<ExecutorsResponse>(
      await fetch(`${baseUrl}/api/executors`)
    );
    expect(body.default).toBe('fake');
    expect((await patchConfig({ executor: 3 })).status).toBe(400);
    expect((await patchConfig({ executor: '' })).status).toBe(400);
  });
});

describe('PATCH /api/config — executors', () => {
  it('writes per-executor models and they round-trip through GET', async () => {
    const res = await patchConfig({
      executors: { codex: { models: { execute: 'gpt-5.5' } } },
    });
    expect(res.status).toBe(200);
    const config = await json<{
      executors: Record<string, { models: { execute?: string } }>;
    }>(await fetch(`${baseUrl}/api/config`));
    expect(config.executors.codex?.models.execute).toBe('gpt-5.5');
    expect(
      (await patchConfig({ executors: { codex: { models: { draft: 'x' } } } }))
        .status
    ).toBe(400);
    expect((await patchConfig({ executors: [] })).status).toBe(400);
  });
});
