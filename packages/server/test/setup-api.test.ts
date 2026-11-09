import { credentialsPath, TaskStore } from '@dispatch-foo/core';
import type { SetupReport } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { setSetupCheckDepsForTest } from '../src/api/setup.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { OverseerManager } from '../src/orchestrator/overseer.js';
import { ClaudeOverseer } from '../src/orchestrator/overseers/claude.js';
import type { PlanManager } from '../src/orchestrator/plan.js';
import { ClaudePlanner } from '../src/orchestrator/planners/claude.js';
import { rawFetch, useTestAuth } from './testAuth.js';

let root: string;
let home: string;
let handle: ServerHandle;
let baseUrl: string;
// Names passed to registerExecutor after boot, to prove refresh never re-registers a live one.
let lateRegistrations: string[];
let planManager: PlanManager;
let overseerManager: OverseerManager;
const originalHome = process.env.DISPATCH_HOME;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = home;
  root = mkdtempSync(join(tmpdir(), 'dispatch-setup-api-'));
  TaskStore.init(root);
  // A machine with git and a signed-in Claude, nothing else.
  setSetupCheckDepsForTest(() => ({
    path: '/bin',
    which: (b) => (['git', 'claude'].includes(b) ? `/bin/${b}` : null),
    run: (_cmd, args) => {
      const key = args.join(' ');
      if (key === 'config --get user.name')
        return Promise.resolve({ status: 0, stdout: 'Ada', stderr: '' });
      if (key === 'config --get user.email')
        return Promise.resolve({ status: 0, stdout: 'a@b.c', stderr: '' });
      if (key === 'auth status --json')
        return Promise.resolve({
          status: 0,
          stdout: '{"loggedIn":true}',
          stderr: '',
        });
      if (key.endsWith('--is-inside-work-tree'))
        return Promise.resolve({ status: 0, stdout: 'true', stderr: '' });
      return Promise.resolve({ status: 0, stdout: 'v1', stderr: '' });
    },
    env: {},
    savedAgentKeys: {},
  }));
  handle = await startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    // Claude's planner and Overseer only, whether or not this machine has codex.
    registerPlanners: (manager) => {
      planManager = manager;
      manager.registerPlanner('claude', new ClaudePlanner(root));
    },
    registerOverseers: (manager) => {
      overseerManager = manager;
      manager.registerBackend('claude', new ClaudeOverseer(root));
    },
    registerExecutors: (o) => {
      lateRegistrations = [];
      o.registerExecutor(
        'claude',
        new FakeExecutor({ steps: [], finish: { state: 'finished' as const } })
      );
      const register = o.registerExecutor.bind(o);
      o.registerExecutor = (name, executor) => {
        lateRegistrations.push(name);
        register(name, executor);
      };
    },
  });
  useTestAuth(handle);
  baseUrl = `http://127.0.0.1:${handle.port}`;
});

afterEach(async () => {
  setSetupCheckDepsForTest(null);
  await handle.stop();
  if (originalHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const post = (path: string, body: unknown) =>
  fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('/api/setup', () => {
  it('reports git, project and agent for this root', async () => {
    const report = (await (
      await fetch(`${baseUrl}/api/setup`)
    ).json()) as SetupReport;
    expect(report.steps.map((s) => s.id)).toEqual(['git', 'project', 'agent']);
    expect(report.defaultProvider).toBe('claude');
  });

  it('saves and clears an agent API key in the machine-wide credentials', async () => {
    expect(
      (
        await post('/api/setup/agent-key', {
          provider: 'codex',
          apiKey: 'sk-1',
        })
      ).status
    ).toBe(200);
    const file = JSON.parse(readFileSync(credentialsPath(), 'utf8')) as {
      agents?: Record<string, string>;
    };
    expect(file.agents).toEqual({ OPENAI_API_KEY: 'sk-1' });
    await post('/api/setup/agent-key', { provider: 'codex', apiKey: null });
    expect(
      JSON.parse(readFileSync(credentialsPath(), 'utf8')).agents
    ).toBeUndefined();
  });

  it('rejects a provider that takes no API key', async () => {
    expect(
      (
        await post('/api/setup/agent-key', {
          provider: 'cursor-agent',
          apiKey: 'x',
        })
      ).status
    ).toBe(400);
    expect(
      (await post('/api/setup/agent-key', { provider: 'nope', apiKey: 'x' }))
        .status
    ).toBe(400);
  });

  it('refresh registers newly installed agents without disturbing live ones', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'dispatch-setup-bin-'));
    const originalPath = process.env.PATH;
    try {
      const names = async () =>
        (
          (await (await fetch(`${baseUrl}/api/executors`)).json()) as {
            executors: { name: string }[];
          }
        ).executors.map((e) => e.name);
      expect(await names()).toContain('claude');
      expect(await names()).not.toContain('gemini');

      writeFileSync(join(bin, 'gemini'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'gemini'), 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;

      const first = (await (await post('/api/setup/refresh', {})).json()) as {
        added: string[];
      };
      expect(first.added).toContain('gemini');
      expect(first.added).not.toContain('claude');
      const second = (await (await post('/api/setup/refresh', {})).json()) as {
        added: string[];
      };
      expect(second.added).toEqual([]);
      expect(await names()).toEqual(
        expect.arrayContaining(['claude', 'gemini'])
      );
      expect(lateRegistrations).not.toContain('claude');
    } finally {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('refresh brings up the Codex planner and Overseer once codex is installed', async () => {
    const bin = mkdtempSync(join(tmpdir(), 'dispatch-setup-bin-'));
    const originalPath = process.env.PATH;
    expect(planManager.registeredPlannerNames()).toEqual(['claude']);
    expect(overseerManager.registeredBackendNames()).toEqual(['claude']);
    try {
      writeFileSync(join(bin, 'codex'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(bin, 'codex'), 0o755);
      process.env.PATH = `${bin}:${originalPath ?? ''}`;
      expect((await post('/api/setup/refresh', {})).status).toBe(200);
      expect((await post('/api/setup/refresh', {})).status).toBe(200);

      const res = await post('/api/plan', { prompt: 'x', planner: 'nope' });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain('codex');
      expect(planManager.registeredPlannerNames()).toEqual(['claude', 'codex']);
      expect(overseerManager.registeredBackendNames()).toEqual([
        'claude',
        'codex',
      ]);
    } finally {
      process.env.PATH = originalPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  it('refuses the agent token on both writes', async () => {
    const asAgent = (path: string, body: unknown) =>
      rawFetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${handle.tokens.agentToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    expect(
      (
        await asAgent('/api/setup/agent-key', {
          provider: 'codex',
          apiKey: 'sk-1',
        })
      ).status
    ).toBe(403);
    expect((await asAgent('/api/setup/refresh', {})).status).toBe(403);
    expect(
      (
        await asAgent('/api/setup/accounts', {
          executor: 'claude',
          label: 'work',
          token: 'oat-1',
        })
      ).status
    ).toBe(403);
    expect(
      (
        await asAgent('/api/setup/accounts/failover', {
          executor: 'claude',
          enabled: true,
        })
      ).status
    ).toBe(403);
  });
});

describe('/api/setup/accounts', () => {
  interface AccountsBody {
    executors: {
      executor: string;
      failover: boolean;
      accounts: { label: string; addedAt?: string; limitedUntil?: string }[];
    }[];
  }
  const claude = async (res: Response) =>
    ((await res.json()) as AccountsBody).executors.find(
      (e) => e.executor === 'claude'
    )!;

  it('stores accounts in order, switches failover, and never returns a token', async () => {
    expect(await claude(await fetch(`${baseUrl}/api/setup/accounts`))).toEqual({
      executor: 'claude',
      failover: false,
      accounts: [{ label: 'default' }],
    });
    await post('/api/setup/accounts', {
      executor: 'claude',
      label: 'work',
      token: 'oat-secret',
    });
    const res = await post('/api/setup/accounts/failover', {
      executor: 'claude',
      enabled: true,
    });
    const text = await res.clone().text();
    expect(text).not.toContain('oat-secret');
    const entry = await claude(res);
    expect(entry.failover).toBe(true);
    expect(entry.accounts.map((a) => a.label)).toEqual(['default', 'work']);
    expect(entry.accounts[1].addedAt).toBeString();

    const removed = await fetch(`${baseUrl}/api/setup/accounts/claude/work`, {
      method: 'DELETE',
    });
    expect((await claude(removed)).accounts).toEqual([{ label: 'default' }]);
    expect(
      (
        await fetch(`${baseUrl}/api/setup/accounts/claude/work`, {
          method: 'DELETE',
        })
      ).status
    ).toBe(404);
  });

  it('rejects an unknown executor and a bad label', async () => {
    expect(
      (
        await post('/api/setup/accounts', {
          executor: 'codex',
          label: 'work',
          token: 't',
        })
      ).status
    ).toBe(400);
    expect(
      (
        await post('/api/setup/accounts', {
          executor: 'claude',
          label: 'default',
          token: 't',
        })
      ).status
    ).toBe(400);
  });
});
