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
// and PrManager.listRepoPrs need — real `gh`/`git` never touched. Extended
// (beyond just `listResult`) to also script `gh pr view`/`review`/`comment`/
// `gh api` for the by-number detail/review/comment endpoint tests below —
// each optional and defaulting to an explicit "no stub" failure so a test
// that forgets to script a call it actually needs fails loudly rather than
// silently falling through to the generic unhandled-command failure.
interface StubResults {
  listResult: CommandResult;
  viewResult?: CommandResult;
  reviewResult?: CommandResult;
  commentResult?: CommandResult;
  apiResult?: CommandResult;
}

function stubRunner(results: StubResults) {
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
      return results.listResult;
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'view') {
      return (
        results.viewResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no viewResult stubbed',
        }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'review') {
      return (
        results.reviewResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no reviewResult stubbed',
        }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'comment') {
      return (
        results.commentResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no commentResult stubbed',
        }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'api') {
      return results.apiResult ?? { ok: true, stdout: '[]', stderr: '' };
    }
    return { ok: false, stdout: '', stderr: 'unhandled stub command' };
  };
}

// The one repo PR every by-number test below resolves against — a fixed
// number/url pair mirroring bin.ts's own standalone fake PR (#7, dependabot).
const REPO_PR = {
  number: 7,
  title: 'Bump dependency versions',
  url: 'https://github.com/example/repo/pull/7',
  headRefName: 'deps/bump-versions',
  author: { login: 'dependabot' },
  isDraft: false,
  updatedAt: '2026-07-22T00:00:00Z',
};

function listResultWithRepoPr(): CommandResult {
  return { ok: true, stdout: JSON.stringify([REPO_PR]), stderr: '' };
}

function viewResultForRepoPr(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    stdout: JSON.stringify({
      number: REPO_PR.number,
      url: REPO_PR.url,
      title: REPO_PR.title,
      state: 'OPEN',
      isDraft: false,
      reviewDecision: null,
      mergeable: 'MERGEABLE',
      statusCheckRollup: [],
      additions: 4,
      deletions: 2,
      changedFiles: 1,
      reviews: [],
      comments: [],
      ...overrides,
    }),
    stderr: '',
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
        listResult: {
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
        },
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

// Item B's in-app review for a repo PR dispatch never opened itself: the same
// status/conversation/review/comment surface as GET/POST /api/runs/:id/pr*,
// but keyed by PR number (resolved to a url via listRepoPrs()) instead of a
// run id, since these rows have no run at all.
describe('GET /api/prs/:number/detail', () => {
  it('returns the PR detail for a known open repo PR number', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        listResult: listResultWithRepoPr(),
        viewResult: viewResultForRepoPr(),
      }),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/detail`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toMatchObject({
      number: REPO_PR.number,
      url: REPO_PR.url,
      title: REPO_PR.title,
      state: 'OPEN',
    });
    expect(body.conversation).toEqual([]);
  });

  it('404s a PR number that is not among the repo’s open PRs', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithRepoPr() }),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/999/detail`);
    expect(res.status).toBe(404);
    const body = await json(res);
    expect(body.error).toMatch(/PR not found/);
  });

  it('409s when the project lacks the pr capability', async () => {
    // No prCommandRunner override — mirrors GET /api/prs's own capability-off
    // 409 test: resolveRepoPrByNumber calls listRepoPrs() first, so the same
    // 409 fires before any number resolution happens.
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/detail`);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/prs/:number/review', () => {
  it('resolves the number to its url and invokes gh pr review with it', async () => {
    const calls: string[][] = [];
    const scripted = stubRunner({
      listResult: listResultWithRepoPr(),
      viewResult: viewResultForRepoPr(),
      reviewResult: { ok: true, stdout: '', stderr: '' },
    });
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: async (cwd, cmd) => {
        calls.push(cmd);
        return scripted(cwd, cmd);
      },
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'approve', body: '' }),
    });
    expect(res.status).toBe(200);
    const reviewCall = calls.find(
      (c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'review'
    );
    expect(reviewCall).toContain(REPO_PR.url);
    expect(reviewCall).toContain('--approve');
  });

  it('404s a PR number that is not among the repo’s open PRs', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithRepoPr() }),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/999/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'approve', body: '' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s a request-changes review with no body, same as the run-keyed route', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithRepoPr() }),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'request-changes', body: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('409s when the project lacks the pr capability', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'approve', body: '' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /api/prs/:number/comment', () => {
  it('resolves the number to its url and invokes gh pr comment with it', async () => {
    const calls: string[][] = [];
    const scripted = stubRunner({
      listResult: listResultWithRepoPr(),
      viewResult: viewResultForRepoPr(),
      commentResult: { ok: true, stdout: '', stderr: '' },
    });
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: async (cwd, cmd) => {
        calls.push(cmd);
        return scripted(cwd, cmd);
      },
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'looks good' }),
    });
    expect(res.status).toBe(200);
    const commentCall = calls.find(
      (c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'comment'
    );
    expect(commentCall).toContain(REPO_PR.url);
    expect(commentCall).toContain('looks good');
  });

  it('404s a PR number that is not among the repo’s open PRs', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithRepoPr() }),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/999/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'looks good' }),
    });
    expect(res.status).toBe(404);
  });

  it('400s an empty comment body, same as the run-keyed route', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithRepoPr() }),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('409s when the project lacks the pr capability', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'looks good' }),
    });
    expect(res.status).toBe(409);
  });
});
