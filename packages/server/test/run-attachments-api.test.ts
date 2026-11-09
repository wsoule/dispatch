import { TaskStore } from '@dispatch-foo/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RunAttachment } from '../src/api/attachments.js';
import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

// POST /api/runs/:id/attachments: files dropped or pasted into a run's
// follow-up composer land under .dispatch/attachments/runs/<runId>/ and come
// back with absolute paths, since the message naming them is read by an agent
// working in a worktree rather than the project root.

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-run-attachments-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

function formWith(...files: File[]): FormData {
  const form = new FormData();
  for (const file of files) form.append('files', file);
  return form;
}

describe('run attachments', () => {
  let fakeHome: string;
  let root: string;
  let handle: ServerHandle;
  let baseUrl: string;
  let runId: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = initDispatchGitRepo();
    TaskStore.init(root);
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      registerExecutors: (orchestrator) => {
        orchestrator.registerExecutor(
          'fake',
          new FakeExecutor({ finish: { state: 'finished' } })
        );
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'look at this screenshot' }),
      })
    );
    const run = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    runId = run.id;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('stores each dropped file in its own directory and answers absolute paths', async () => {
    const res = await fetch(`${baseUrl}/api/runs/${runId}/attachments`, {
      method: 'POST',
      body: formWith(
        new File(['png-bytes'], 'image.png', { type: 'image/png' }),
        new File(['png-again'], 'image.png', { type: 'image/png' })
      ),
    });
    expect(res.status).toBe(200);
    const { attachments } = (await json(res)) as {
      attachments: RunAttachment[];
    };
    expect(attachments).toHaveLength(2);
    const [first, second] = attachments;
    expect(first).toEqual(
      expect.objectContaining({
        name: 'image.png',
        mimeType: 'image/png',
        size: 9,
      })
    );
    const dir = join(root, '.dispatch', 'attachments', 'runs', runId);
    expect(first.path.startsWith(`${dir}/`)).toBe(true);
    expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path, 'utf8')).toBe('png-bytes');
    expect(readFileSync(second.path, 'utf8')).toBe('png-again');
  });

  it('refuses an unknown run, an empty form, and the agent token', async () => {
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    const unknown = await fetch(`${baseUrl}/api/runs/r-nope/attachments`, {
      method: 'POST',
      body: formWith(file),
    });
    expect(unknown.status).toBe(404);

    const empty = await fetch(`${baseUrl}/api/runs/${runId}/attachments`, {
      method: 'POST',
      body: new FormData(),
    });
    expect(empty.status).toBe(400);

    const agent = await fetch(`${baseUrl}/api/runs/${runId}/attachments`, {
      method: 'POST',
      headers: { authorization: `Bearer ${handle.tokens.agentToken}` },
      body: formWith(file),
    });
    expect(agent.status).toBe(403);
    expect(((await json(agent)) as { code: string }).code).toBe(
      'auth_agent_token'
    );
    expect(existsSync(join(root, '.dispatch', 'attachments', 'runs'))).toBe(
      false
    );
  });
});
