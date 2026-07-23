import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import { runGitSync } from './orchestrator/helpers.js';

// Item B: GET /api/prs — every open PR in the repo (not just ones dispatch
// itself opened). Same escape hatch as every other *-api.test.ts file:
// `Response.json()` types as `Promise<unknown>` under this repo's strict,
// DOM-less tsconfig.
function json(res: Response): Promise<any> {
  return res.json();
}

function initDispatchGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-prs-api-'));
  runGitSync(dir, ['init', '-b', 'main']);
  runGitSync(dir, ['config', 'user.email', 'test@example.com']);
  runGitSync(dir, ['config', 'user.name', 'Test']);
  writeFileSync(join(dir, 'README.md'), '# test repo\n');
  runGitSync(dir, ['add', '-A']);
  runGitSync(dir, ['commit', '-m', 'initial commit']);
  return dir;
}

// A scripted gh/git CommandRunner answering exactly what detectPrCapability
// and PrManager.listRepoPrs need — real `gh`/`git` never touched.
function stubRunner(listResult: CommandResult) {
  return async (_cwd: string, cmd: string[]): Promise<CommandResult> => {
    if (cmd[0] === 'gh' && cmd[1] === '--version') {
      return { ok: true, stdout: 'gh version 2.0.0', stderr: '' };
    }
    if (
      cmd[0] === 'git' &&
      cmd[1] === 'remote' &&
      cmd[2] === 'get-url' &&
      cmd[3] === 'origin'
    ) {
      return {
        ok: true,
        stdout: 'https://github.com/example/repo.git',
        stderr: '',
      };
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
      return listResult;
    }
    return { ok: false, stdout: '', stderr: 'unhandled stub command' };
  };
}

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
const originalDispatchHome = process.env.DISPATCH_HOME;

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
  process.env.DISPATCH_HOME = fakeHome;
  root = initDispatchGitRepo();
  TaskStore.init(root);
});

afterEach(async () => {
  if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
  else process.env.DISPATCH_HOME = originalDispatchHome;
  await handle.stop();
  rmSync(fakeHome, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/prs', () => {
  it('returns the parsed list of open repo PRs when the project has pr capability', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        ok: true,
        stdout: JSON.stringify([
          {
            number: 3,
            title: 'A repo PR',
            url: 'https://github.com/example/repo/pull/3',
            headRefName: 'some-branch',
            author: { login: 'someone' },
            isDraft: false,
            updatedAt: '2026-07-22T00:00:00Z',
          },
        ]),
        stderr: '',
      }),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body).toEqual([
      {
        number: 3,
        title: 'A repo PR',
        url: 'https://github.com/example/repo/pull/3',
        headRefName: 'some-branch',
        author: 'someone',
        isDraft: false,
        updatedAt: '2026-07-22T00:00:00Z',
      },
    ]);
  });

  it('409s when the project lacks the pr capability', async () => {
    // No prCommandRunner override at all — the real defaultCommandRunner
    // against a repo with no configured remote reports pr:false, same as
    // every other "no gh/remote" 409 in the PR surface.
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs`);
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toMatch(/gh CLI/);
  });
});
