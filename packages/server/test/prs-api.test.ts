import { TaskStore } from '@dispatch/core';
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

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { FakeExecutor } from '../src/orchestrator/executors/fake.js';
import type { FakeExecutorScript } from '../src/orchestrator/executors/fake.js';
import type { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { reviewCommentsPath } from '../src/orchestrator/paths.js';
import type { CommandResult } from '../src/orchestrator/pr.js';
import type { ReviewComment } from '../src/reviewComments.js';
import type { ReviewTarget } from '../src/reviewTarget.js';
import { json } from './json.js';
import { runGitSync } from './orchestrator/helpers.js';
import { useTestAuth } from './testAuth.js';

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
  diffResult?: CommandResult;
  filesResult?: CommandResult;
  // `gh api --paginate --slurp .../pulls/N/comments` (GET) — the comment
  // mirror's pull half, read by PrManager.syncPrComments.
  commentsListResult?: CommandResult;
  // `gh api -X POST .../pulls/N/reviews` — the batch push,
  // PrManager.pushPrReview. Captured payloads land in `postedReviewPayloads`
  // below, read from the scratch file pushPrReview writes and cleans up.
  pushReviewResult?: CommandResult;
  // `gh api -X POST .../pulls/N/comments` (POST, with in_reply_to) — the
  // reply endpoint, PrManager.replyToComment.
  replyResult?: CommandResult;
  // `gh api graphql` — both the reviewThreads query (syncReviewThreads) and
  // the resolve/unresolveReviewThread mutation (resolveComment), routed on
  // whether the query text starts with `mutation`, same as pr.test.ts.
  reviewThreadsResult?: CommandResult;
  resolveThreadResult?: CommandResult;
  // `git push -u origin <branch>` and `gh pr create` — the two calls
  // PrManager.openPr makes before it stamps a run's `prUrl`, which the
  // Dispatch-opened-PR describe at the bottom of this file needs.
  pushBranchResult?: CommandResult;
  createResult?: CommandResult;
}

// Captures the JSON body pushPrReview writes to its scratch file, read at
// call time (the file is deleted before the call returns) — same "capture
// now, assert later" reasoning as pr.test.ts's own StubRunner.
function stubRunner(
  results: StubResults,
  postedReviewPayloads: Record<string, unknown>[] = [],
  // Every argv the seam saw. A verb that fell back to the local store
  // returns the same body as one that reached GitHub, so the call log is
  // the only way to tell the two apart.
  commandLog: string[][] = []
) {
  return async (_cwd: string, cmd: string[]): Promise<CommandResult> => {
    commandLog.push(cmd);
    if (cmd[0] === 'gh' && cmd[1] === '--version') {
      return Promise.resolve({
        ok: true,
        stdout: 'gh version 2.0.0',
        stderr: '',
      });
    }
    if (
      cmd[0] === 'git' &&
      cmd[1] === 'remote' &&
      cmd[2] === 'get-url' &&
      cmd[3] === 'origin'
    ) {
      return Promise.resolve({
        ok: true,
        stdout: 'https://github.com/example/repo.git',
        stderr: '',
      });
    }
    if (cmd[0] === 'git' && cmd[1] === 'push') {
      return Promise.resolve(
        results.pushBranchResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no pushBranchResult stubbed',
        }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'create') {
      return Promise.resolve(
        results.createResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no createResult stubbed',
        }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'list') {
      return Promise.resolve(results.listResult);
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'view') {
      return Promise.resolve(
        results.viewResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no viewResult stubbed',
        }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'review') {
      return Promise.resolve(
        results.reviewResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no reviewResult stubbed',
        }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'comment') {
      return Promise.resolve(
        results.commentResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no commentResult stubbed',
        }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'diff') {
      return Promise.resolve(
        results.diffResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no diffResult stubbed',
        }
      );
    }
    // '--paginate' precedes the path, so the endpoint is the last argument.
    if (
      cmd[0] === 'gh' &&
      cmd[1] === 'api' &&
      (cmd.at(-1)?.endsWith('/files') ?? false)
    ) {
      return Promise.resolve(
        results.filesResult ?? { ok: true, stdout: '[]', stderr: '' }
      );
    }
    // pushPrReview's POST — matched on argv content (its `--input <path>`
    // trails the endpoint, so the endpoint is not the last arg) and placed
    // ahead of the generic GET-shaped branches below, or it would be
    // swallowed by them. Mirrors pr.test.ts's StubRunner exactly.
    if (
      cmd[0] === 'gh' &&
      cmd[1] === 'api' &&
      cmd.includes('POST') &&
      cmd.some((arg) => /\/pulls\/\d+\/reviews$/.test(arg))
    ) {
      const inputIdx = cmd.indexOf('--input');
      const payloadPath = inputIdx >= 0 ? cmd[inputIdx + 1] : undefined;
      if (payloadPath !== undefined) {
        postedReviewPayloads.push(
          JSON.parse(readFileSync(payloadPath, 'utf8')) as Record<
            string,
            unknown
          >
        );
      }
      return (
        results.pushReviewResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no pushReviewResult stubbed',
        }
      );
    }
    // replyToComment's POST — also argv-matched, ahead of the generic
    // '/pulls/N/comments$' GET branch below, which would otherwise answer
    // it with the GET-shaped comments list instead of one created comment.
    if (
      cmd[0] === 'gh' &&
      cmd[1] === 'api' &&
      cmd.includes('POST') &&
      cmd.some((arg) => /\/pulls\/\d+\/comments$/.test(arg))
    ) {
      return (
        results.replyResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no replyResult stubbed',
        }
      );
    }
    // syncReviewThreads' query and resolveComment's mutation both hit `gh
    // api graphql`; distinguished by whether the query text starts with
    // the `mutation` keyword, same as pr.test.ts's StubRunner.
    if (cmd[0] === 'gh' && cmd[1] === 'api' && cmd[2] === 'graphql') {
      const queryArg = cmd.find((arg) => arg.startsWith('query='));
      const query = queryArg?.slice('query='.length).trimStart() ?? '';
      return query.startsWith('mutation')
        ? (results.resolveThreadResult ?? {
            ok: false,
            stdout: '',
            stderr: 'no resolveThreadResult stubbed',
          })
        : (results.reviewThreadsResult ?? {
            ok: false,
            stdout: '',
            stderr: 'no reviewThreadsResult stubbed',
          });
    }
    if (
      cmd[0] === 'gh' &&
      cmd[1] === 'api' &&
      cmd.some((arg) => /\/pulls\/\d+\/comments$/.test(arg))
    ) {
      return (
        results.commentsListResult ?? { ok: true, stdout: '[]', stderr: '' }
      );
    }
    if (cmd[0] === 'gh' && cmd[1] === 'api') {
      return Promise.resolve(
        results.apiResult ?? { ok: true, stdout: '[]', stderr: '' }
      );
    }
    return Promise.resolve({
      ok: false,
      stdout: '',
      stderr: 'unhandled stub command',
    });
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

// A second fixed repo PR, distinct from REPO_PR, for the
// /api/prs/:number/comments* describe blocks below — carries `headRefOid`,
// which those tests need (it becomes `commit_id` on a pushed review) and
// REPO_PR's own fixture omits.
const COMMENT_PR = {
  number: 42,
  title: 'Line comments live here',
  url: 'https://github.com/example/repo/pull/42',
  headRefName: 'feature/comment-mirror',
  headRefOid: 'deadbeef42',
  author: { login: 'someone' },
  isDraft: false,
  updatedAt: '2026-07-22T00:00:00Z',
};

function listResultWithCommentPr(): CommandResult {
  return { ok: true, stdout: JSON.stringify([COMMENT_PR]), stderr: '' };
}

// One GitHub REST review comment on COMMENT_PR, shaped per the spec's
// verified payload facts (docs/superpowers/specs/2026-08-04-review-github-
// sync-design.md) — `diff_hunk`'s last line keeps its `+` prefix, which
// mapGitHubComment strips into `anchorText`.
function rawGitHubComment(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    id: 501,
    node_id: 'PRRC_1',
    path: 'src/a.ts',
    line: 3,
    original_line: 3,
    start_line: null,
    diff_hunk: '@@ -1,3 +1,4 @@\n context\n+const x = 1;',
    body: 'why one?',
    user: { login: 'teammate' },
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
    side: 'RIGHT',
    subject_type: 'line',
    ...overrides,
  };
}

function commentsListResultFor(
  ...comments: Record<string, unknown>[]
): CommandResult {
  return { ok: true, stdout: JSON.stringify(comments), stderr: '' };
}

// The reviewThreads GraphQL response syncReviewThreads reads — one thread
// whose only comment has `databaseId` 501, matching rawGitHubComment()'s
// default id, so the merged comment comes back tagged with a thread id.
function reviewThreadsResultFor(databaseId: number): CommandResult {
  return {
    ok: true,
    stdout: JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: 'PRRT_thread1',
                  comments: { nodes: [{ databaseId }] },
                },
              ],
            },
          },
        },
      },
    }),
    stderr: '',
  };
}

const RESOLVE_THREAD_RESULT: CommandResult = {
  ok: true,
  stdout: JSON.stringify({
    data: {
      resolveReviewThread: { thread: { id: 'PRRT_thread1' } },
      unresolveReviewThread: { thread: { id: 'PRRT_thread1' } },
    },
  }),
  stderr: '',
};

let fakeHome: string;
let root: string;
let handle: ServerHandle;
let baseUrl: string;
// Captured through startServer's registerExecutors hook — only the
// Dispatch-opened-PR describe at the bottom needs it.
let orchestrator: Orchestrator;
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
    // Exercises every field listRepoPrs() reads from `gh pr list --json`
    // (not just the pre-widening subset), so this pins the full wire shape
    // GET /api/prs actually returns — including real status values, not
    // just the zero/null defaults a sparser stub would produce.
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
              baseRefName: 'main',
              headRefOid: 'deadbeef',
              author: { login: 'someone' },
              isDraft: false,
              updatedAt: '2026-07-22T00:00:00Z',
              isCrossRepository: true,
              headRepositoryOwner: { login: 'someone-fork-owner' },
              reviewDecision: 'APPROVED',
              mergeable: 'MERGEABLE',
              statusCheckRollup: [
                { conclusion: 'SUCCESS' },
                { conclusion: 'SUCCESS' },
                { status: 'IN_PROGRESS' },
              ],
              additions: 7,
              deletions: 1,
              changedFiles: 3,
            },
          ]),
          stderr: '',
        },
      }),
    });
    useTestAuth(handle);
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
        baseRefName: 'main',
        headRefOid: 'deadbeef',
        author: 'someone',
        isDraft: false,
        updatedAt: '2026-07-22T00:00:00Z',
        isCrossRepository: true,
        headRepositoryOwner: 'someone-fork-owner',
        reviewDecision: 'APPROVED',
        mergeable: 'MERGEABLE',
        checks: { passed: 2, failed: 0, pending: 1, total: 3 },
        additions: 7,
        deletions: 1,
        changedFiles: 3,
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
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
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/comment`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'looks good' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('GET /api/prs/:number/diff', () => {
  it('returns the PR diff', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        listResult: listResultWithRepoPr(),
        diffResult: {
          ok: true,
          stdout: 'diff --git a/x.ts b/x.ts\n@@ -1 +1 @@\n-old\n+new\n',
          stderr: '',
        },
        filesResult: {
          ok: true,
          stdout: JSON.stringify([{ filename: 'x.ts', status: 'modified' }]),
          stderr: '',
        },
      }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/diff`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as { patch: string; files: unknown[] };
    expect(body.patch).toContain('diff --git');
    expect(body.files).toEqual([{ path: 'x.ts', status: 'M' }]);
  });

  it('404s for a PR that is not open', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithRepoPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/404/diff`);
    expect(res.status).toBe(404);
  });

  it('409s when the project lacks the pr capability', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/diff`);
    expect(res.status).toBe(409);
  });
});

// The comment mirror's HTTP surface (Task 6): the PR-keyed twin of the
// /api/runs/:id/comments verbs, plus the review-submit batch push. Every
// route resolves `number` through PrManager itself (never a caller-supplied
// URL) before any `gh` call — see requirePrNumberParam and each PrManager
// method's own resolvePrForComments.
describe('GET /api/prs/:number/comments', () => {
  it('pulls GitHub comments, merges them, and tags each with its thread id', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        listResult: listResultWithCommentPr(),
        commentsListResult: commentsListResultFor(rawGitHubComment()),
        reviewThreadsResult: reviewThreadsResultFor(501),
      }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${COMMENT_PR.number}/comments`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as Array<{
      file: string;
      body: string;
      anchorText: string;
      githubId: number;
      githubThreadId: string;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0].file).toBe('src/a.ts');
    expect(body[0].body).toBe('why one?');
    // The diff_hunk's last line keeps its `+` prefix — this is the one
    // spec-verified trap the whole mapping rests on.
    expect(body[0].anchorText).toBe('const x = 1;');
    expect(body[0].githubId).toBe(501);
    expect(body[0].githubThreadId).toBe('PRRT_thread1');
  });

  // Route-level guard for the "don't lose the reviewer's writing"
  // invariant: mergeComments' own rule 2 (a local pending comment with no
  // githubId is never touched by a pull) is pinned in
  // githubComments.test.ts, but this is the first thing to make it
  // reachable through the actual GET route — add, then GET, then confirm
  // the draft is still exactly what was written.
  it('keeps a local pending draft through a GET sync', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        listResult: listResultWithCommentPr(),
        commentsListResult: commentsListResultFor(),
        reviewThreadsResult: reviewThreadsResultFor(0),
      }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const addRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/a.ts',
          line: 3,
          anchorText: 'const x = 1;',
          body: 'still mine',
        }),
      }
    );
    expect(addRes.status).toBe(201);
    const draft = (await json(addRes)) as { id: string };

    const res = await fetch(`${baseUrl}/api/prs/${COMMENT_PR.number}/comments`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as Array<{
      id: string;
      body: string;
      pending: boolean;
    }>;
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe(draft.id);
    expect(body[0].body).toBe('still mine');
    expect(body[0].pending).toBe(true);
  });

  it('404s a PR number that is not among the repo’s open PRs', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/999/comments`);
    expect(res.status).toBe(404);
  });

  it('400s a malformed PR number, without shelling out at all', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/not-a-number/comments`);
    expect(res.status).toBe(400);
  });

  it('409s when the project lacks the pr capability', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/${COMMENT_PR.number}/comments`);
    expect(res.status).toBe(409);
  });
});

describe('POST /api/prs/:number/comments', () => {
  it('adds a pending local draft against a real, resolved PR', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/b.ts',
          line: 5,
          anchorText: 'const y = 2;',
          body: 'why two?',
        }),
      }
    );
    expect(res.status).toBe(201);
    const body = (await json(res)) as {
      file: string;
      body: string;
      pending: boolean;
    };
    expect(body.file).toBe('src/b.ts');
    expect(body.body).toBe('why two?');
    expect(body.pending).toBe(true);
  });

  it('400s a missing body', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file: 'src/b.ts', line: 5, body: '' }),
      }
    );
    expect(res.status).toBe(400);
  });

  // Review finding: `pending: false` was accepted here, and pushPrReview
  // only ever pushes what is pending — so such a record could never reach
  // GitHub, and its Reply and Resolve would 409 forever. The run-keyed
  // route has no push step and still takes it.
  it('400s pending:false, which could never reach GitHub', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/b.ts',
          line: 5,
          anchorText: 'const y = 2;',
          body: 'why two?',
          pending: false,
        }),
      }
    );
    expect(res.status).toBe(400);

    // The other half of the asymmetry, asserted here so the two cannot
    // drift apart: the run-keyed route publishes locally and still takes it.
    const runRes = await fetch(`${baseUrl}/api/runs/run-x/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/b.ts',
        line: 5,
        anchorText: 'const y = 2;',
        body: 'why two?',
        pending: false,
      }),
    });
    expect(runRes.status).toBe(201);
  });

  // Review finding: this was the only PR-comment route that skipped
  // resolveRepoPrByNumber, so it 201ed a draft against a PR number that
  // was never checked against the repo's actual open PRs.
  it('404s a PR number that is not among the repo’s open PRs', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/999/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/b.ts',
        line: 5,
        anchorText: '',
        body: 'why two?',
      }),
    });
    expect(res.status).toBe(404);
  });

  it('409s when the project lacks the pr capability', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/b.ts',
          line: 5,
          anchorText: '',
          body: 'why two?',
        }),
      }
    );
    expect(res.status).toBe(409);
  });
});

describe('PATCH /api/prs/:number/comments/:commentId', () => {
  it('resolves via GraphQL once GET has synced the thread id', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        listResult: listResultWithCommentPr(),
        commentsListResult: commentsListResultFor(rawGitHubComment()),
        reviewThreadsResult: reviewThreadsResultFor(501),
        resolveThreadResult: RESOLVE_THREAD_RESULT,
      }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const listRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`
    );
    const [synced] = (await json(listRes)) as Array<{ id: string }>;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments/${synced.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      }
    );
    expect(res.status).toBe(200);
    const body = (await json(res)) as { resolved: boolean };
    expect(body.resolved).toBe(true);
  });

  it('409s a comment GET never tagged with a thread id', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const addRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/a.ts',
          line: 3,
          anchorText: '',
          body: 'draft',
        }),
      }
    );
    const draft = (await json(addRes)) as { id: string };

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments/${draft.id}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      }
    );
    expect(res.status).toBe(409);
  });

  it('404s an unknown comment id', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments/nope`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolved: true }),
      }
    );
    expect(res.status).toBe(404);
  });

  it('400s a non-boolean resolved value', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments/whatever`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ resolved: 'yes' }),
      }
    );
    expect(res.status).toBe(400);
  });
});

describe('POST /api/prs/:number/comments/:commentId/reply', () => {
  it('posts to GitHub via in_reply_to and appends the reply locally', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        listResult: listResultWithCommentPr(),
        commentsListResult: commentsListResultFor(rawGitHubComment()),
        reviewThreadsResult: reviewThreadsResultFor(501),
        replyResult: {
          ok: true,
          stdout: JSON.stringify({
            id: 901,
            body: 'thanks for the catch',
            user: { login: 'teammate' },
            created_at: '2026-08-05T00:00:00Z',
          }),
          stderr: '',
        },
      }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const listRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`
    );
    const [synced] = (await json(listRes)) as Array<{ id: string }>;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments/${synced.id}/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'thanks for the catch' }),
      }
    );
    expect(res.status).toBe(200);
    const body = (await json(res)) as { replies: Array<{ body: string }> };
    expect(body.replies).toHaveLength(1);
    expect(body.replies[0].body).toBe('thanks for the catch');
  });

  it('409s a comment that was never pushed to GitHub', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const addRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/a.ts',
          line: 3,
          anchorText: '',
          body: 'draft',
        }),
      }
    );
    const draft = (await json(addRes)) as { id: string };

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments/${draft.id}/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'ok' }),
      }
    );
    expect(res.status).toBe(409);
  });

  it('400s an empty reply body', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments/whatever/reply`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '' }),
      }
    );
    expect(res.status).toBe(400);
  });
});

// The batch push (Task 6's named trap): deliberately NOT at
// /api/prs/:number/review, which stays reviewRepoPr's one-shot `gh pr
// review` verdict (tested above) — reusing that path here would fire both
// on one submit. See submitPrReview's own doc comment for the full
// reasoning.
describe('POST /api/prs/:number/review-submit', () => {
  it('pushes every pending comment as one GitHub review', async () => {
    const postedReviewPayloads: Record<string, unknown>[] = [];
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner(
        {
          listResult: listResultWithCommentPr(),
          pushReviewResult: { ok: true, stdout: '{}', stderr: '' },
          commentsListResult: commentsListResultFor(),
        },
        postedReviewPayloads
      ),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const addRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/a.ts',
          line: 3,
          anchorText: 'const x = 1;',
          body: 'why one?',
        }),
      }
    );
    expect(addRes.status).toBe(201);

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'approve', body: 'lgtm' }),
      }
    );
    expect(res.status).toBe(200);
    const body = (await json(res)) as { pushed: number };
    expect(body.pushed).toBe(1);
    expect(postedReviewPayloads).toHaveLength(1);
    expect(postedReviewPayloads[0]).toMatchObject({
      commit_id: COMMENT_PR.headRefOid,
      event: 'APPROVE',
      body: 'lgtm',
    });
    expect(postedReviewPayloads[0].comments).toHaveLength(1);
  });

  // The Pull requests tab submits through this route, and a resubmit here
  // always carries a body — so nothing pending is not enough on its own to
  // stop a second review landing on the real PR.
  it('does not post a second review when the same submit is retried', async () => {
    const postedReviewPayloads: Record<string, unknown>[] = [];
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner(
        {
          listResult: listResultWithCommentPr(),
          pushReviewResult: { ok: true, stdout: '{}', stderr: '' },
          commentsListResult: commentsListResultFor(),
        },
        postedReviewPayloads
      ),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const submit = (): Promise<Response> =>
      fetch(`${baseUrl}/api/prs/${COMMENT_PR.number}/review-submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'comment', body: 'lgtm' }),
      });

    expect((await submit()).status).toBe(200);
    expect(postedReviewPayloads).toHaveLength(1);

    const retry = await submit();
    expect(retry.status).toBe(200);
    expect(((await json(retry)) as { pushed: number }).pushed).toBe(0);
    expect(postedReviewPayloads).toHaveLength(1);
  });

  // Route-level guard for pushPrReview's "a failed push must never lose
  // the reviewer's writing" invariant — unit-tested already
  // (pr.test.ts:1344, :1394), but not previously exercised through HTTP.
  it('409s a failed push, leaving the pending batch intact', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        listResult: listResultWithCommentPr(),
        pushReviewResult: { ok: false, stdout: '', stderr: 'boom' },
        commentsListResult: commentsListResultFor(),
        reviewThreadsResult: reviewThreadsResultFor(0),
      }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const addRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/a.ts',
          line: 3,
          anchorText: 'const x = 1;',
          body: 'why one?',
        }),
      }
    );
    expect(addRes.status).toBe(201);

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'approve', body: '' }),
      }
    );
    expect(res.status).toBe(409);

    const listRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`
    );
    const comments = (await json(listRes)) as Array<{
      body: string;
      pending: boolean;
    }>;
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe('why one?');
    expect(comments[0].pending).toBe(true);
  });

  it('400s an invalid verdict', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'bogus', body: '' }),
      }
    );
    expect(res.status).toBe(400);
  });

  it('400s a request-changes review with no body', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'request-changes', body: '' }),
      }
    );
    expect(res.status).toBe(400);
  });

  // The trap named in the task brief: GitHub 422s a `comment` review with
  // both an empty body and an empty comments array. This must never reach
  // `gh` at all — it is a clean 400 instead of that raw error string.
  it('400s a comment verdict with no body and nothing pending', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'comment', body: '' }),
      }
    );
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string };
    expect(body.error).toMatch(/nothing to submit/);
  });

  // Review finding: a `comment` verdict with an empty body used to sail
  // through once anything was pending, reaching `gh` and surfacing its raw
  // 422 string. The body requirement is unconditional now, same as
  // request-changes — a pending batch does not substitute for it.
  it('400s a comment verdict with no body even with a pending comment', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const addRes = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/a.ts',
          line: 3,
          anchorText: 'const x = 1;',
          body: 'why one?',
        }),
      }
    );
    expect(addRes.status).toBe(201);

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'comment', body: '' }),
      }
    );
    expect(res.status).toBe(400);
    const body = (await json(res)) as { error: string };
    expect(body.error).toMatch(/comment review requires a body/);
  });

  it('404s a PR number that is not among the repo’s open PRs', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({ listResult: listResultWithCommentPr() }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(`${baseUrl}/api/prs/999/review-submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'approve', body: '' }),
    });
    expect(res.status).toBe(404);
  });

  it('409s when the project lacks the pr capability', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const res = await fetch(
      `${baseUrl}/api/prs/${COMMENT_PR.number}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'approve', body: '' }),
      }
    );
    expect(res.status).toBe(409);
  });
});

// A PR Dispatch opened itself is BOTH targets (spec §Review): it resolves to
// `pr` so a line comment reaches GitHub, and stays a `run` so the review can
// still travel back to the agent. The ReviewQueue dedups such a PR to its
// run-backed row, so every assertion below drives the /api/runs/:id/*
// routes — the only ones that row can reach.
describe('run review routes on a Dispatch-opened PR', () => {
  // A run that finishes immediately: enough to reach openPr, which requires
  // a terminal run before it will push a branch and stamp `prUrl`.
  const FINISHES: FakeExecutorScript = { finish: { state: 'finished' } };

  // Same, but reporting a session id — what `sendMessage(resume: true)`
  // needs before it will re-dispatch a terminal run into its own worktree.
  const RESUMABLE: FakeExecutorScript = {
    finish: { state: 'finished', sessionId: 's-1' },
  };

  // Pauses at an approval gate, so a test can act on a deterministically
  // live run — the mid-run message path, not the resume one.
  const STAYS_LIVE: FakeExecutorScript = {
    steps: [{ approval: { requestId: 'gate', toolName: 'noop', input: {} } }],
    finish: { state: 'finished', sessionId: 's-1' },
  };

  const OK: CommandResult = { ok: true, stdout: '', stderr: '' };

  // `gh pr create`'s only stdout is the new PR's url; returning COMMENT_PR's
  // makes the run resolve to PR #42, the one listResultWithCommentPr serves.
  const CREATES_COMMENT_PR: CommandResult = {
    ok: true,
    stdout: `${COMMENT_PR.url}\n`,
    stderr: '',
  };

  async function start(
    results: StubResults,
    script: FakeExecutorScript,
    postedReviewPayloads?: Record<string, unknown>[],
    commandLog?: string[][]
  ): Promise<void> {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner(results, postedReviewPayloads, commandLog),
      registerExecutors: (o) => {
        orchestrator = o;
        o.registerExecutor('fake', new FakeExecutor(script));
      },
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }

  async function waitFor(check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('waitFor timed out');
  }

  // Reads a target's comment file straight off disk — the only way to prove
  // WHICH store a run's comment actually landed in, since the run routes now
  // serve both.
  function stored(target: ReviewTarget): ReviewComment[] {
    const path = reviewCommentsPath(root, target);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8')) as ReviewComment[];
  }

  async function dispatchRun(): Promise<string> {
    const task = await json(
      await fetch(`${baseUrl}/api/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'PR me' }),
      })
    );
    const run = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ executor: 'fake' }),
      })
    );
    return run.id as string;
  }

  // Dispatches a run, waits for it to finish, then opens its PR through the
  // production route (POST /api/runs/:id/review { action: 'pr' }) rather than
  // stamping `prUrl` behind the API's back.
  async function runWithOpenPr(): Promise<string> {
    const runId = await dispatchRun();
    await waitFor(async () => {
      const run = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
      return run.meta.state === 'finished';
    });
    const res = await fetch(`${baseUrl}/api/runs/${runId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pr' }),
    });
    expect(res.status).toBe(200);
    return runId;
  }

  function addComment(runId: string, body: string): Promise<Response> {
    return fetch(`${baseUrl}/api/runs/${runId}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        file: 'src/a.ts',
        line: 3,
        anchorText: 'const x = 1;',
        body,
      }),
    });
  }

  // `postToGitHub` is left out of the body entirely when undefined, so a
  // caller that omits it exercises the real default rather than an explicit
  // false.
  function submitReview(
    runId: string,
    verdict: string,
    body: string,
    postToGitHub?: boolean
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/runs/${runId}/review-submit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict,
        body,
        ...(postToGitHub === undefined ? {} : { postToGitHub }),
      }),
    });
  }

  function sendBack(runId: string, note: string): Promise<Response> {
    return fetch(`${baseUrl}/api/runs/${runId}/send-back`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ note }),
    });
  }

  function replyToComment(
    runId: string,
    commentId: string,
    body: string
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/runs/${runId}/comments/${commentId}/reply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
  }

  function setResolved(
    runId: string,
    commentId: string,
    resolved: boolean
  ): Promise<Response> {
    return fetch(`${baseUrl}/api/runs/${runId}/comments/${commentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resolved }),
    });
  }

  // Leaves one comment and submits it, so what comes back is the record
  // GitHub's own pull replaced the draft with — the `githubId`-carrying
  // state every reply/resolve below starts from.
  async function pushedComment(runId: string): Promise<ReviewComment> {
    expect((await addComment(runId, 'why one?')).status).toBe(201);
    expect(
      (await submitReview(runId, 'comment', 'one note', true)).status
    ).toBe(200);
    const listed = (await json(
      await fetch(`${baseUrl}/api/runs/${runId}/comments`)
    )) as ReviewComment[];
    expect(listed).toHaveLength(1);
    expect(listed[0].githubId).toBe(777);
    return listed[0];
  }

  // The stubs a submit needs end to end: the branch push and `gh pr create`
  // that stamp `prUrl`, the review POST, and the pull that follows it.
  function pushStubs(): StubResults {
    return {
      listResult: listResultWithCommentPr(),
      pushBranchResult: OK,
      createResult: CREATES_COMMENT_PR,
      pushReviewResult: { ok: true, stdout: '{}', stderr: '' },
      commentsListResult: commentsListResultFor(
        rawGitHubComment({ id: 777, body: 'why one?' })
      ),
    };
  }

  // A run is reviewed AFTER it finishes, so a terminal run is the send-back's
  // normal case — and the plain message path refuses one outright.
  it("resumes a finished run's send-back instead of refusing it", async () => {
    await start({ listResult: listResultWithCommentPr() }, RESUMABLE);
    const runId = await dispatchRun();
    await waitFor(async () => {
      const run = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
      return run.meta.state === 'finished';
    });

    const res = await sendBack(runId, 'please fix x');
    expect(res.status).toBe(200);
    const resumed = await json(res);
    expect(resumed.id).not.toBe(runId);
    expect(resumed.resumedFrom).toBe(runId);
  });

  // The ruling: resuming pushes more commits onto the same branch, which is
  // exactly how the request-changes loop updates a PR — nothing is torn down.
  it('resumes a finished run that has an open PR', async () => {
    await start(
      {
        listResult: listResultWithCommentPr(),
        pushBranchResult: OK,
        createResult: CREATES_COMMENT_PR,
      },
      RESUMABLE
    );
    const runId = await runWithOpenPr();

    const res = await sendBack(runId, 'please fix x');
    expect(res.status).toBe(200);
    expect((await json(res)).resumedFrom).toBe(runId);
  });

  it('keeps a live run on the mid-run message path', async () => {
    await start({ listResult: listResultWithCommentPr() }, STAYS_LIVE);
    const runId = await dispatchRun();
    await waitFor(async () => {
      const run = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
      return run.meta.state === 'awaiting-approval';
    });

    const res = await sendBack(runId, 'while you are in there');
    expect(res.status).toBe(200);
    const meta = await json(res);
    expect(meta.id).toBe(runId);
    expect(meta.resumedFrom).toBeUndefined();
  });

  it('writes a run-with-PR comment to the PR store, not the run store', async () => {
    await start(
      {
        listResult: listResultWithCommentPr(),
        pushBranchResult: OK,
        createResult: CREATES_COMMENT_PR,
      },
      FINISHES
    );
    const runId = await runWithOpenPr();

    expect((await addComment(runId, 'why one?')).status).toBe(201);
    expect(
      stored({ kind: 'pr', number: COMMENT_PR.number }).map((c) => c.body)
    ).toEqual(['why one?']);
    expect(stored({ kind: 'run', runId })).toEqual([]);

    // And the run route still serves it: the ReviewQueue row is run-keyed.
    const listRes = await fetch(`${baseUrl}/api/runs/${runId}/comments`);
    expect(listRes.status).toBe(200);
    expect((await json(listRes)).map((c: ReviewComment) => c.body)).toEqual([
      'why one?',
    ]);
  });

  it('leaves a run without a PR on its own store', async () => {
    await start({ listResult: listResultWithCommentPr() }, FINISHES);
    const runId = await dispatchRun();

    expect((await addComment(runId, 'local only')).status).toBe(201);
    expect(stored({ kind: 'run', runId }).map((c) => c.body)).toEqual([
      'local only',
    ]);
    expect(stored({ kind: 'pr', number: COMMENT_PR.number })).toEqual([]);
  });

  // The migration case: comments written before the PR existed sit in the
  // run's own file, which nothing would read once the resolver points at the
  // PR. They move across on the first run-comment request after the PR opens.
  it('carries comments written before the PR onto the PR store', async () => {
    await start(
      {
        listResult: listResultWithCommentPr(),
        pushBranchResult: OK,
        createResult: CREATES_COMMENT_PR,
      },
      FINISHES
    );
    const runId = await dispatchRun();
    await waitFor(async () => {
      const run = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
      return run.meta.state === 'finished';
    });
    expect((await addComment(runId, 'written before the PR')).status).toBe(201);
    expect(stored({ kind: 'run', runId })).toHaveLength(1);

    const prRes = await fetch(`${baseUrl}/api/runs/${runId}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'pr' }),
    });
    expect(prRes.status).toBe(200);

    const listRes = await fetch(`${baseUrl}/api/runs/${runId}/comments`);
    expect((await json(listRes)).map((c: ReviewComment) => c.body)).toEqual([
      'written before the PR',
    ]);
    expect(stored({ kind: 'pr', number: COMMENT_PR.number })).toHaveLength(1);
    expect(stored({ kind: 'run', runId })).toEqual([]);
  });

  it('pushes a run-with-PR submit to GitHub as one review', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(
      {
        listResult: listResultWithCommentPr(),
        pushBranchResult: OK,
        createResult: CREATES_COMMENT_PR,
        pushReviewResult: { ok: true, stdout: '{}', stderr: '' },
        commentsListResult: commentsListResultFor(
          rawGitHubComment({ id: 777, body: 'why one?' })
        ),
      },
      FINISHES,
      payloads
    );
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    const res = await submitReview(runId, 'comment', 'one note', true);
    expect(res.status).toBe(200);
    expect((await json(res)).published).toBe(1);

    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      commit_id: COMMENT_PR.headRefOid,
      event: 'COMMENT',
      body: 'one note',
    });
    expect(payloads[0].comments).toHaveLength(1);

    // The surviving record came back from GitHub's own pull carrying its id,
    // which is what pushPrReview does and publishPending cannot: a local
    // publish would leave `githubId` undefined.
    const after = stored({ kind: 'pr', number: COMMENT_PR.number });
    expect(after).toHaveLength(1);
    expect(after[0].githubId).toBe(777);
    expect(after[0].pending).toBe(false);
  });

  it('publishes a run-without-PR submit locally and never shells out', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start({ listResult: listResultWithCommentPr() }, FINISHES, payloads);
    const runId = await dispatchRun();
    expect((await addComment(runId, 'local only')).status).toBe(201);

    const res = await submitReview(runId, 'comment', '');
    expect(res.status).toBe(200);
    expect((await json(res)).published).toBe(1);
    expect(payloads).toEqual([]);
    expect(stored({ kind: 'run', runId })[0].pending).toBe(false);
    expect(stored({ kind: 'run', runId })[0].githubId).toBeUndefined();
  });

  // The "both" the spec asks for: the comment reaches GitHub AND the same
  // comment is rendered into what the agent is told. `prUrl` is stamped
  // directly here because openPr only ever runs on a terminal run, and a
  // terminal run cannot be messaged at all — see the next test.
  it('still renders a run-with-PR comment into the agent send-back', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(
      {
        listResult: listResultWithCommentPr(),
        pushReviewResult: { ok: true, stdout: '{}', stderr: '' },
        commentsListResult: commentsListResultFor(
          rawGitHubComment({ id: 777, body: 'why one?' })
        ),
      },
      {
        steps: [
          { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
        ],
        finish: { state: 'finished' },
      },
      payloads
    );
    const runId = await dispatchRun();
    await waitFor(async () => {
      const run = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
      return run.meta.state === 'awaiting-approval';
    });
    orchestrator.setRunPrUrl(runId, COMMENT_PR.url);
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    const res = await submitReview(
      runId,
      'request-changes',
      'please fix',
      true
    );
    expect(res.status).toBe(200);
    expect(payloads).toHaveLength(1);

    const run = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
    const sent = run.entries
      .filter((e: { kind: string }) => e.kind === 'message')
      .map((e: { text: string }) => e.text)
      .join('\n');
    expect(sent).toContain('please fix');
    expect(sent).toContain('why one?');
    expect(sent).toContain('Line 3');
  });

  // A resume can still be refused — FINISHES reports no session id, so this
  // run has nothing to resume into. What matters is that the GitHub half is
  // reported alongside the refusal rather than silently swallowed.
  it('reports the resume refusal without losing the GitHub push', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(
      {
        listResult: listResultWithCommentPr(),
        pushBranchResult: OK,
        createResult: CREATES_COMMENT_PR,
        pushReviewResult: { ok: true, stdout: '{}', stderr: '' },
        commentsListResult: commentsListResultFor(
          rawGitHubComment({ id: 777, body: 'why one?' })
        ),
      },
      FINISHES,
      payloads
    );
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    const res = await submitReview(
      runId,
      'request-changes',
      'please fix',
      true
    );
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.published).toBe(1);
    expect(body.error).toBeString();
    expect(payloads).toHaveLength(1);
  });

  // The default is the quiet one: publish locally, tell the agent, leave the
  // PR alone. Reaching GitHub is something the reviewer opts into.
  it('leaves GitHub untouched by default on a run-with-PR', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(pushStubs(), RESUMABLE, payloads);
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    const res = await submitReview(runId, 'comment', 'one note');
    expect(res.status).toBe(200);
    expect((await json(res)).published).toBe(1);
    expect(payloads).toEqual([]);

    const after = stored({ kind: 'pr', number: COMMENT_PR.number });
    expect(after[0].pending).toBe(false);
    expect(after[0].githubId).toBeUndefined();
  });

  it('pushes once and still sends back with postToGitHub: true', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(pushStubs(), RESUMABLE, payloads);
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    const res = await submitReview(
      runId,
      'request-changes',
      'please fix',
      true
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(payloads).toHaveLength(1);
    expect(body.run.resumedFrom).toBe(runId);
  });

  // The marker's whole job: nothing pending and the same (verdict, body) as
  // the last successful push means there is nothing new to say.
  it('posts exactly one review when the same submit is retried', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(pushStubs(), FINISHES, payloads);
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    expect(
      (await submitReview(runId, 'comment', 'one note', true)).status
    ).toBe(200);
    expect(payloads).toHaveLength(1);

    const retry = await submitReview(runId, 'comment', 'one note', true);
    expect(retry.status).toBe(200);
    expect((await json(retry)).published).toBe(0);
    expect(payloads).toHaveLength(1);
  });

  it('posts again when the note changed since the last push', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(pushStubs(), FINISHES, payloads);
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    expect(
      (await submitReview(runId, 'comment', 'one note', true)).status
    ).toBe(200);
    expect(payloads).toHaveLength(1);

    const second = await submitReview(
      runId,
      'comment',
      'second thoughts',
      true
    );
    expect(second.status).toBe(200);
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toMatchObject({ body: 'second thoughts' });
  });

  // A summary with no line comments is a legitimate review. The blanket
  // "nothing pending, do not push" rule the marker replaces silenced it.
  it('posts a note-only submit with nothing pending', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(
      { ...pushStubs(), commentsListResult: commentsListResultFor() },
      FINISHES,
      payloads
    );
    const runId = await runWithOpenPr();

    const res = await submitReview(
      runId,
      'comment',
      'looks good overall',
      true
    );
    expect(res.status).toBe(200);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toMatchObject({
      event: 'COMMENT',
      body: 'looks good overall',
    });
  });

  // The default publishes locally, which clears `pending` — so a push that
  // selected on `pending` would find nothing and send a review body pointing
  // at line comments GitHub never received.
  it('pushes line comments a default submit already published locally', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(pushStubs(), FINISHES, payloads);
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    expect((await submitReview(runId, 'comment', 'first pass')).status).toBe(
      200
    );
    expect(payloads).toEqual([]);

    const res = await submitReview(runId, 'comment', 'second pass', true);
    expect(res.status).toBe(200);
    expect(payloads).toHaveLength(1);
    expect(payloads[0].comments).toEqual([
      { path: 'src/a.ts', line: 3, side: 'RIGHT', body: 'why one?' },
    ]);
  });

  // The POST lands, then the backfill pull fails. GitHub has the review and
  // the comments already; a retry has to recognise that from disk, not from
  // the return value of a call that threw.
  it('does not post a second review when the pull after the push fails', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(
      {
        ...pushStubs(),
        commentsListResult: { ok: false, stdout: '', stderr: 'rate limited' },
      },
      FINISHES,
      payloads
    );
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    expect(
      (await submitReview(runId, 'comment', 'one note', true)).status
    ).toBe(409);
    expect(payloads).toHaveLength(1);

    const retry = await submitReview(runId, 'comment', 'one note', true);
    expect(retry.status).toBe(200);
    expect(payloads).toHaveLength(1);
  });

  it('400s postToGitHub: true on a run with no PR', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start({ listResult: listResultWithCommentPr() }, FINISHES, payloads);
    const runId = await dispatchRun();
    expect((await addComment(runId, 'local only')).status).toBe(201);

    const res = await submitReview(runId, 'comment', 'one note', true);
    expect(res.status).toBe(400);
    expect(payloads).toEqual([]);
    expect(stored({ kind: 'run', runId })[0].pending).toBe(true);
  });

  // The 409 above invites a retry, and the batch has already left: pushing
  // again would land a second REQUEST_CHANGES review on a real PR, since
  // only the line comments are protected by the `pending` flip.
  it('does not push a second review when the refused submit is retried', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(pushStubs(), FINISHES, payloads);
    const runId = await runWithOpenPr();
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    expect(
      (await submitReview(runId, 'request-changes', 'please fix', true)).status
    ).toBe(409);
    expect(payloads).toHaveLength(1);

    const retry = await submitReview(
      runId,
      'request-changes',
      'please fix',
      true
    );
    expect(retry.status).toBe(409);
    expect((await json(retry)).published).toBe(0);
    expect(payloads).toHaveLength(1);
  });

  // listRepoPrs only sees open PRs, so a closed or merged one 404s on every
  // push. Falling back to the local publish is what keeps those comments
  // from sitting `pending` forever, invisible to GitHub and to the agent.
  it('publishes locally when the PR is no longer open', async () => {
    const payloads: Record<string, unknown>[] = [];
    await start(
      { listResult: { ok: true, stdout: '[]', stderr: '' } },
      {
        steps: [
          { approval: { requestId: 'gate', toolName: 'noop', input: {} } },
        ],
        finish: { state: 'finished' },
      },
      payloads
    );
    const runId = await dispatchRun();
    await waitFor(async () => {
      const run = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
      return run.meta.state === 'awaiting-approval';
    });
    orchestrator.setRunPrUrl(runId, COMMENT_PR.url);
    expect((await addComment(runId, 'why one?')).status).toBe(201);

    const res = await submitReview(
      runId,
      'request-changes',
      'please fix',
      true
    );
    expect(res.status).toBe(200);
    expect((await json(res)).published).toBe(1);
    expect(payloads).toEqual([]);
    expect(stored({ kind: 'pr', number: COMMENT_PR.number })[0].pending).toBe(
      false
    );

    // And the agent half still happens — a published comment is one
    // formatCommentsForAgent will render.
    const run = await json(await fetch(`${baseUrl}/api/runs/${runId}`));
    const sent = run.entries
      .filter((e: { kind: string }) => e.kind === 'message')
      .map((e: { text: string }) => e.text)
      .join('\n');
    expect(sent).toContain('why one?');
  });

  it('replies to a pushed run-with-PR comment through GitHub', async () => {
    const log: string[][] = [];
    await start(
      {
        ...pushStubs(),
        replyResult: {
          ok: true,
          stdout: JSON.stringify({
            id: 999,
            body: 'because',
            user: { login: 'teammate' },
            created_at: '2026-08-02T00:00:00Z',
          }),
          stderr: '',
        },
      },
      FINISHES,
      [],
      log
    );
    const runId = await runWithOpenPr();
    const comment = await pushedComment(runId);

    const res = await replyToComment(runId, comment.id, 'because');
    expect(res.status).toBe(200);
    const replies = ((await json(res)) as ReviewComment).replies;
    // GitHub's own author and id, which the local append cannot produce.
    expect(replies).toHaveLength(1);
    expect(replies[0].author).toBe('teammate');
    expect(replies[0].githubId).toBe(999);
    expect(
      log.some(
        (cmd) =>
          cmd.includes('POST') &&
          cmd.some((arg) => arg.endsWith('/pulls/42/comments'))
      )
    ).toBe(true);
  });

  it('keeps a reply on a run without a PR local', async () => {
    const log: string[][] = [];
    await start({ listResult: listResultWithCommentPr() }, FINISHES, [], log);
    const runId = await dispatchRun();
    const added = (await json(
      await addComment(runId, 'why one?')
    )) as ReviewComment;

    const res = await replyToComment(runId, added.id, 'because');
    expect(res.status).toBe(200);
    const replies = ((await json(res)) as ReviewComment).replies;
    expect(replies).toHaveLength(1);
    expect(replies[0].githubId).toBeUndefined();
    expect(log.some((cmd) => cmd.includes('POST'))).toBe(false);
  });

  // A pending draft exists nowhere but here: there is no GitHub thread to
  // reply into, and pushPrReview carries the local reply forward when the
  // batch lands.
  it('keeps a reply to an unpushed draft local', async () => {
    const log: string[][] = [];
    await start(
      {
        listResult: listResultWithCommentPr(),
        pushBranchResult: OK,
        createResult: CREATES_COMMENT_PR,
      },
      FINISHES,
      [],
      log
    );
    const runId = await runWithOpenPr();
    const added = (await json(
      await addComment(runId, 'why one?')
    )) as ReviewComment;

    const res = await replyToComment(runId, added.id, 'because');
    expect(res.status).toBe(200);
    expect(((await json(res)) as ReviewComment).replies).toHaveLength(1);
    expect(log.some((cmd) => cmd.includes('POST'))).toBe(false);
  });

  // Resolution lives on the GitHub review *thread*, and the run surface
  // never syncs thread ids — so the resolve has to fetch one before it has
  // anything to act on.
  it('resolves a pushed run-with-PR comment on GitHub', async () => {
    const log: string[][] = [];
    await start(
      {
        ...pushStubs(),
        reviewThreadsResult: reviewThreadsResultFor(777),
        resolveThreadResult: RESOLVE_THREAD_RESULT,
      },
      FINISHES,
      [],
      log
    );
    const runId = await runWithOpenPr();
    const comment = await pushedComment(runId);

    const res = await setResolved(runId, comment.id, true);
    expect(res.status).toBe(200);
    expect(((await json(res)) as ReviewComment).resolved).toBe(true);
    const graphql = log.filter((cmd) => cmd[2] === 'graphql');
    expect(
      graphql.some((cmd) =>
        cmd.some((arg) => arg.includes('resolveReviewThread(input:'))
      )
    ).toBe(true);
  });

  it('keeps resolve on a run without a PR local', async () => {
    const log: string[][] = [];
    await start({ listResult: listResultWithCommentPr() }, FINISHES, [], log);
    const runId = await dispatchRun();
    const added = (await json(
      await addComment(runId, 'why one?')
    )) as ReviewComment;

    const res = await setResolved(runId, added.id, true);
    expect(res.status).toBe(200);
    expect(((await json(res)) as ReviewComment).resolved).toBe(true);
    expect(log.some((cmd) => cmd[2] === 'graphql')).toBe(false);
  });
});
