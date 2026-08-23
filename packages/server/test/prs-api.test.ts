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
  // `gh pr view <n> --json <the RepoPr field set>` — PrManager.findRepoPr's
  // fallback for a PR the open list no longer has. Unset means the repo has
  // no such PR at all, which is what every by-number 404 below relies on.
  viewRepoPrResult?: CommandResult;
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
  // `git fetch --force origin pull/N/head:refs/dispatch/pr/N <base>` and the
  // `git merge-base origin/<base> <ref>` after it — PrManager.fetchPrHead's
  // two calls, the agent-review dispatch's only side effect on the repo.
  fetchResult?: CommandResult;
  mergeBaseResult?: CommandResult;
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
    if (cmd[0] === 'git' && cmd[1] === 'fetch') {
      return Promise.resolve(
        results.fetchResult ?? { ok: true, stdout: '', stderr: '' }
      );
    }
    // The head-ref delete a retiring PR review schedules. Answered here so the
    // call log records it (see the retirement test below) rather than falling
    // through to the unhandled-command failure at the bottom.
    if (cmd[0] === 'git' && cmd[1] === 'update-ref') {
      return Promise.resolve({ ok: true, stdout: '', stderr: '' });
    }
    if (cmd[0] === 'git' && cmd[1] === 'merge-base') {
      return Promise.resolve(
        results.mergeBaseResult ?? {
          ok: false,
          stdout: '',
          stderr: 'no mergeBaseResult stubbed',
        }
      );
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
      // findRepoPr's fallback is the only caller that asks for
      // `isCrossRepository`, which is how its answer is told apart from
      // getPrDetailByUrl's — two different shapes behind one verb.
      const fields = cmd[cmd.indexOf('--json') + 1] ?? '';
      if (fields.includes('isCrossRepository')) {
        return Promise.resolve(
          results.viewRepoPrResult ?? {
            ok: false,
            stdout: '',
            stderr: `no pull requests found for ${cmd[3] ?? ''}`,
          }
        );
      }
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
  baseRefName: 'main',
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

// Task 4: a PR that merged while the reviewer had it open. `gh pr list
// --state open` no longer returns it, so it exists only behind findRepoPr's
// `gh pr view` fallback — which is exactly the case that used to 404.
const MERGED_PR_NUMBER = 43;

function viewResultForMergedPr(): CommandResult {
  return {
    ok: true,
    stdout: JSON.stringify({
      number: MERGED_PR_NUMBER,
      title: 'Merged out from under the reviewer',
      url: `https://github.com/example/repo/pull/${MERGED_PR_NUMBER}`,
      headRefName: 'feature/already-merged',
      baseRefName: 'main',
      headRefOid: 'deadbeef43',
      author: { login: 'someone' },
      isDraft: false,
      updatedAt: '2026-08-07T00:00:00Z',
      state: 'MERGED',
      isCrossRepository: false,
      headRepositoryOwner: { login: 'example' },
      reviewDecision: 'APPROVED',
      mergeable: null,
      statusCheckRollup: [],
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    }),
    stderr: '',
  };
}

// One GitHub REST review comment on COMMENT_PR, shaped per the spec's
// verified payload facts (docs/archive/specs/2026-08-04-review-github-
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
              state: 'OPEN',
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
        state: 'OPEN',
        isCrossRepository: true,
        headRepositoryOwner: 'someone-fork-owner',
        reviewDecision: 'APPROVED',
        mergeable: 'MERGEABLE',
        checks: {
          passed: 2,
          failed: 0,
          pending: 1,
          total: 3,
          runs: [
            { name: 'check', conclusion: 'SUCCESS', url: '' },
            { name: 'check', conclusion: 'SUCCESS', url: '' },
            { name: 'check', conclusion: 'PENDING', url: '' },
          ],
        },
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

  // The other door to the same GitHub POST. Once findRepoPr resolved closed
  // PRs, this route stopped 404ing and started reaching GitHub — so it needs
  // review-submit's refusal too, not just review-submit.
  it('409s a merged PR by name rather than reaching gh pr review', async () => {
    const calls: string[][] = [];
    const scripted = stubRunner({
      listResult: listResultWithCommentPr(),
      viewRepoPrResult: viewResultForMergedPr(),
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

    const res = await fetch(`${baseUrl}/api/prs/${MERGED_PR_NUMBER}/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ event: 'approve', body: '' }),
    });
    expect(res.status).toBe(409);
    const body = (await json(res)) as { error: string };
    expect(body.error).toContain(`PR #${MERGED_PR_NUMBER} is merged`);
    expect(
      calls.some((c) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'review')
    ).toBe(false);
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

  // Task 4: the whole point of the fallback. This route used to 404 the
  // moment the PR merged, taking the reviewer's own staged notes with it.
  it('still lists a merged PR’s comments, and the drafts staged on it', async () => {
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner({
        listResult: listResultWithCommentPr(),
        viewRepoPrResult: viewResultForMergedPr(),
        commentsListResult: commentsListResultFor(rawGitHubComment()),
        reviewThreadsResult: reviewThreadsResultFor(501),
      }),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const addRes = await fetch(
      `${baseUrl}/api/prs/${MERGED_PR_NUMBER}/comments`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          file: 'src/b.ts',
          line: 5,
          anchorText: '',
          body: 'staged before it merged',
        }),
      }
    );
    expect(addRes.status).toBe(201);

    const res = await fetch(`${baseUrl}/api/prs/${MERGED_PR_NUMBER}/comments`);
    expect(res.status).toBe(200);
    const body = (await json(res)) as Array<{ body: string; pending: boolean }>;
    expect(body.map((c) => c.body).sort()).toEqual([
      'staged before it merged',
      'why one?',
    ]);
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

  // Task 4: GitHub rejects a review on a PR that is no longer open. What
  // reached the reviewer for it was the reviews endpoint's bare 404; this
  // pins the message that replaced it, and that the batch stayed on disk.
  it('409s a merged PR with a message that says so, and posts nothing', async () => {
    const commandLog: string[][] = [];
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
      prCommandRunner: stubRunner(
        {
          listResult: listResultWithCommentPr(),
          viewRepoPrResult: viewResultForMergedPr(),
          commentsListResult: commentsListResultFor(),
          reviewThreadsResult: reviewThreadsResultFor(0),
        },
        [],
        commandLog
      ),
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const addRes = await fetch(
      `${baseUrl}/api/prs/${MERGED_PR_NUMBER}/comments`,
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
      `${baseUrl}/api/prs/${MERGED_PR_NUMBER}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'comment', body: 'one more thing' }),
      }
    );
    expect(res.status).toBe(409);
    const body = (await json(res)) as { error: string };
    expect(body.error).toBe(
      `PR #${MERGED_PR_NUMBER} is merged on GitHub, which does not accept ` +
        'reviews on a pull request that is no longer open. Your 1 staged ' +
        'comment is still saved here.'
    );
    expect(
      commandLog.some((cmd) =>
        cmd.some((arg) => /\/pulls\/\d+\/reviews$/.test(arg))
      )
    ).toBe(false);
    // The note is still there to send somewhere else.
    const after = await fetch(
      `${baseUrl}/api/prs/${MERGED_PR_NUMBER}/comments`
    );
    const kept = (await json(after)) as Array<{ pending: boolean }>;
    expect(kept).toHaveLength(1);
    expect(kept[0]?.pending).toBe(true);
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

// A fork PR: its head branch lives in someone else's repo, so checking it
// out and running an agent in it executes a stranger's code on this machine.
const FORK_PR = {
  number: 11,
  title: 'Fix a typo from outside',
  url: 'https://github.com/example/repo/pull/11',
  headRefName: 'patch-1',
  baseRefName: 'main',
  headRefOid: 'f0rkbeef',
  author: { login: 'outsider' },
  isDraft: false,
  updatedAt: '2026-08-07T00:00:00Z',
  isCrossRepository: true,
  headRepositoryOwner: { login: 'outsider-org' },
};

// Both PRs in one list so every gate test resolves against the same stub —
// REPO_PR omits isCrossRepository entirely, which parses to false (same-repo).
function listResultWithForkAndRepoPr(): CommandResult {
  return {
    ok: true,
    stdout: JSON.stringify([REPO_PR, FORK_PR]),
    stderr: '',
  };
}

// The PR body and changed-file list the dispatch reads before it fetches
// anything — `gh pr view --json body` and `gh api .../pulls/N/files`.
function bodyViewResult(body: string): CommandResult {
  return { ok: true, stdout: JSON.stringify({ body }), stderr: '' };
}

function filesResultFor(...paths: string[]): CommandResult {
  return {
    ok: true,
    stdout: JSON.stringify(
      paths.map((filename) => ({ filename, status: 'modified' }))
    ),
    stderr: '',
  };
}

// The stub answers `git fetch` without touching the repo, so a dispatch test
// creates the head ref itself — `git worktree add` resolves it for real.
function createPrHeadRef(number: number): string {
  const head = runGitSync(root, ['rev-parse', 'HEAD']).trim();
  runGitSync(root, ['update-ref', `refs/dispatch/pr/${number}`, head]);
  return head;
}

// A review run reporting a critical finding with nowhere to anchor — "this
// approach is wrong" — which is exactly what a line comment cannot carry.
function reportsUnlocatedFinding(): FakeExecutorScript {
  return {
    steps: [
      {
        entry: {
          ts: '2026-08-07T00:00:00Z',
          kind: 'assistant',
          text: JSON.stringify({
            findings: [
              {
                severity: 'critical',
                title: 'the whole approach leaks the token',
                detail: 'no single line is wrong; the design is',
                file: null,
                line: null,
              },
            ],
          }),
        },
      },
    ],
    finish: { state: 'finished' },
  };
}

// A review run that reports one located finding. `readReviewOutput` falls back
// to the last assistant entry holding JSON, so no findings file is needed.
function reportsFinding(file: string, line: number): FakeExecutorScript {
  return {
    steps: [
      {
        entry: {
          ts: '2026-08-07T00:00:00Z',
          kind: 'assistant',
          text: JSON.stringify({
            findings: [
              {
                severity: 'important',
                title: 'unchecked input',
                detail: 'the parsed value is trusted',
                file,
                line,
              },
            ],
          }),
        },
      },
    ],
    finish: { state: 'finished' },
  };
}

// Starts a server whose PR seam records every argv, and returns the log. The
// executor is always a fake: a review dispatch that got past the gate would
// otherwise start the real agent.
function startWithCallLog(
  overrides: Partial<StubResults> = {},
  script: FakeExecutorScript = { finish: { state: 'finished' } },
  // Bodies pushPrReview POSTed, for the end-to-end test that follows one
  // finding from the agent all the way into that request's `comments[]`.
  postedReviewPayloads: Record<string, unknown>[] = [],
  // Awaited before each command answers, so a test can hold one request
  // inside a specific `await` while it drives a second one.
  onCommand: (cmd: string[]) => Promise<void> = () => Promise.resolve()
): Promise<string[][]> {
  const calls: string[][] = [];
  const scripted = stubRunner(
    {
      listResult: listResultWithForkAndRepoPr(),
      viewResult: bodyViewResult('Fixes a typo.'),
      filesResult: filesResultFor('README.md'),
      mergeBaseResult: {
        ok: true,
        stdout: `${runGitSync(root, ['rev-parse', 'HEAD']).trim()}\n`,
        stderr: '',
      },
      ...overrides,
    },
    postedReviewPayloads
  );
  return startServer({
    rootDir: root,
    port: 0,
    writeDaemonFile: false,
    prCommandRunner: async (cwd, cmd) => {
      calls.push(cmd);
      await onCommand(cmd);
      return scripted(cwd, cmd);
    },
    registerExecutors: (o) => {
      orchestrator = o;
      o.registerExecutor('claude', new FakeExecutor(script));
    },
  }).then((h) => {
    handle = h;
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
    return calls;
  });
}

function postReviewAgent(
  number: number,
  body: Record<string, unknown>
): Promise<Response> {
  return fetch(`${baseUrl}/api/prs/${number}/review-agent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Spec Decision 3, and the whole point of the fork gate: a same-repo PR is
// work the user already trusts, a fork PR is a stranger's code. The gate has
// to refuse BEFORE the head is fetched — a 409 issued after the fetch has
// already put that code on the machine.
describe('POST /api/prs/:number/review-agent', () => {
  it('409s a fork PR without confirmFork, naming the head owner', async () => {
    await startWithCallLog();

    const res = await postReviewAgent(FORK_PR.number, {});
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toContain('outsider-org');
    expect(body.error).toContain('confirmFork');
  });

  it('creates nothing at all when it refuses a fork PR', async () => {
    const calls = await startWithCallLog();
    const before = calls.length;

    const res = await postReviewAgent(FORK_PR.number, {});
    expect(res.status).toBe(409);

    // No ref: the only command the refused request may run is the `gh pr
    // list` that resolves the number. Anything else is a side effect the
    // gate was supposed to precede.
    const during = calls.slice(before);
    expect(during.map((c) => c.slice(0, 3))).toEqual([['gh', 'pr', 'list']]);
    expect(during.some((c) => c[0] === 'git' && c[1] === 'fetch')).toBe(false);
    // No task: a synthesized review task is the other thing a dispatch
    // creates, and it must not exist either.
    expect(new TaskStore(root).list()).toEqual([]);
  });

  // Both tests below assert the gate let the request through, not what the
  // dispatch then produced — the `not.toBe(409)` is the load-bearing half.
  it('lets a fork PR through once confirmFork is true', async () => {
    await startWithCallLog();
    createPrHeadRef(FORK_PR.number);

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(202);
  });

  it('needs no confirmation for a same-repo PR', async () => {
    await startWithCallLog();
    createPrHeadRef(REPO_PR.number);

    const res = await postReviewAgent(REPO_PR.number, {});
    expect(res.status).not.toBe(409);
    expect(res.status).toBe(202);
  });

  it('404s a PR number that is not among the repo’s open PRs', async () => {
    await startWithCallLog();

    const res = await postReviewAgent(999, { confirmFork: true });
    expect(res.status).toBe(404);
  });
});

// The dispatch itself: one route call turns a GitHub PR into a synthesized
// task, a local ref, a worktree and a review run. Every test here asserts
// what survives the call, not just its status code.
describe('POST /api/prs/:number/review-agent dispatch', () => {
  async function waitFor(check: () => boolean | Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('waitFor timed out');
  }

  function tasks() {
    return new TaskStore(root).list();
  }

  function stored(target: ReviewTarget): ReviewComment[] {
    const path = reviewCommentsPath(root, target);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8')) as ReviewComment[];
  }

  // A review run parked at an approval nobody answers — non-terminal for as
  // long as a test needs, with no timer still ticking after teardown.
  const STAYS_LIVE: FakeExecutorScript = {
    steps: [{ approval: { requestId: 'gate', toolName: 'noop', input: {} } }],
    finish: { state: 'finished' },
  };

  it('synthesizes a task from the PR and dispatches a review of its head', async () => {
    const calls = await startWithCallLog({
      viewResult: bodyViewResult('Removes the stray semicolon.'),
      filesResult: filesResultFor('src/a.ts', 'src/b.ts'),
    });
    createPrHeadRef(FORK_PR.number);

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(res.status).toBe(202);
    const meta = await json(res);
    expect(meta.kind).toBe('review');
    expect(meta.baseBranch).toBe(`refs/dispatch/pr/${FORK_PR.number}`);

    // The task carries the PR: its title, body, changed files and the label
    // that marks it synthesized rather than authored.
    const [task] = tasks();
    expect(task.meta.title).toContain(`Review PR #${FORK_PR.number}`);
    expect(task.meta.labels).toContain('github-pr');
    expect(task.meta.derivedFrom).toBe(`github-pr:${FORK_PR.number}`);
    expect(task.meta.writes).toEqual(['src/a.ts', 'src/b.ts']);
    expect(task.body).toContain('Removes the stray semicolon.');
    expect(task.meta.id).toBe(meta.taskId);

    // The user's answer reached the fetch, and it fetched the PR's head —
    // not a branch name a caller supplied.
    const fetched = calls.find((c) => c[0] === 'git' && c[1] === 'fetch');
    expect(fetched).toContain(
      `pull/${FORK_PR.number}/head:refs/dispatch/pr/${FORK_PR.number}`
    );
    // One `gh pr view` for the body, not one per queue row.
    expect(calls.filter((c) => c[1] === 'pr' && c[2] === 'view')).toHaveLength(
      1
    );
  });

  // The synthesized task lands on the board looking like any other todo. Its
  // body is the PR author's prose, so handing it to an execute agent would run
  // a stranger's instructions in a worktree with write access.
  it('refuses to dispatch an execute run for the synthesized task', async () => {
    await startWithCallLog({}, STAYS_LIVE);
    createPrHeadRef(FORK_PR.number);

    expect(
      (await postReviewAgent(FORK_PR.number, { confirmFork: true })).status
    ).toBe(202);
    const [task] = tasks();

    const res = await fetch(`${baseUrl}/api/tasks/${task.meta.id}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ executor: 'claude' }),
    });
    expect(res.status).toBe(400);
    expect((await json(res)).error).toMatch(/derived from github-pr/);
    // Still only the review run — no execute run was provisioned.
    expect(orchestrator.list().map((r) => r.kind)).toEqual(['review']);
  });

  it('files the review’s findings on the PR, not on a run', async () => {
    await startWithCallLog(
      { filesResult: filesResultFor('README.md') },
      reportsFinding('README.md', 1)
    );
    createPrHeadRef(FORK_PR.number);

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(res.status).toBe(202);
    const meta = await json(res);

    const target: ReviewTarget = { kind: 'pr', number: FORK_PR.number };
    await waitFor(() => stored(target).length > 0);
    expect(stored(target)[0].body).toContain('unchecked input');
    // The review run is not the thing being reviewed, so its own comment
    // file must stay empty — that is the run-target fallback firing.
    expect(stored({ kind: 'run', runId: meta.id as string })).toHaveLength(0);
  });

  // A finding with no file/line has nowhere to hang as a line comment, and a
  // PR target has no run findings panel behind it — so without this route the
  // agent's most serious verdicts reach no surface at all.
  it('serves an unlocated finding that could never be a line comment', async () => {
    await startWithCallLog(
      { filesResult: filesResultFor('README.md') },
      reportsUnlocatedFinding()
    );
    createPrHeadRef(FORK_PR.number);

    expect(
      (await postReviewAgent(FORK_PR.number, { confirmFork: true })).status
    ).toBe(202);

    const url = `${baseUrl}/api/prs/${FORK_PR.number}/findings`;
    await waitFor(async () => (await json(await fetch(url))).length > 0);
    const findings = await json(await fetch(url));
    expect(findings).toHaveLength(1);
    expect(findings[0].title).toContain('leaks the token');
    expect(findings[0].file).toBeNull();
    // Non-vacuous: this is the finding the comment store cannot hold.
    expect(stored({ kind: 'pr', number: FORK_PR.number })).toEqual([]);
  });

  it('serves an empty findings list for a PR no agent has reviewed', async () => {
    await startWithCallLog();

    const res = await fetch(`${baseUrl}/api/prs/${REPO_PR.number}/findings`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);
  });

  // Local-only by design: the panel refetches this on every mount and focus,
  // and resolving the number against `gh pr list` would spend a subprocess per
  // refetch to 404 a number the caller read off a PR it is already showing.
  it('runs no gh command to serve findings', async () => {
    const calls = await startWithCallLog();
    const before = calls.length;

    const res = await fetch(`${baseUrl}/api/prs/999/findings`);
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual([]);
    expect(calls.slice(before)).toEqual([]);
  });

  it('400s findings for a PR number that is not a number', async () => {
    await startWithCallLog();

    const res = await fetch(`${baseUrl}/api/prs/abc/findings`);
    expect(res.status).toBe(400);
    expect((await json(res)).error).toContain('invalid PR number');
  });

  // Nothing else would ever close it: aux runs leave their task alone, so a
  // synthesized task sits `todo` forever — permanently outstanding work that
  // BoardSyncer pushes to trunk and LinearSync files as an issue.
  it('retires the synthesized task once the review run ends', async () => {
    const calls = await startWithCallLog(
      { filesResult: filesResultFor('README.md') },
      reportsFinding('README.md', 1)
    );
    createPrHeadRef(FORK_PR.number);

    expect(
      (await postReviewAgent(FORK_PR.number, { confirmFork: true })).status
    ).toBe(202);
    await waitFor(() => tasks()[0]?.meta.status === 'landed');

    const [task] = tasks();
    expect(task.meta.archivedAt).not.toBeUndefined();
    // The ref fetchPrHead parked the head at goes with the review — through
    // the same seam, from a daemon wired the way production wires one.
    await waitFor(() =>
      calls.some(
        (cmd) =>
          cmd[0] === 'git' &&
          cmd[1] === 'update-ref' &&
          cmd[3] === `refs/dispatch/pr/${FORK_PR.number}`
      )
    );
    // The findings were filed before the task retired, not lost with it.
    const filed = await json(
      await fetch(`${baseUrl}/api/tasks/${task.meta.id}/findings`)
    );
    expect(filed).toHaveLength(1);
  });

  it('creates nothing when the PR body cannot be read', async () => {
    const calls = await startWithCallLog({
      viewResult: { ok: false, stdout: '', stderr: 'gh pr view exploded' },
    });

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(res.status).toBe(409);
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'fetch')).toBe(false);
    expect(tasks()).toEqual([]);
    expect(orchestrator.list()).toEqual([]);
  });

  it('creates nothing when the changed-file list cannot be read', async () => {
    const calls = await startWithCallLog({
      filesResult: { ok: false, stdout: '', stderr: 'gh api exploded' },
    });

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(res.status).toBe(409);
    expect(calls.some((c) => c[0] === 'git' && c[1] === 'fetch')).toBe(false);
    expect(tasks()).toEqual([]);
    expect(orchestrator.list()).toEqual([]);
  });

  it('creates no task when the head cannot be fetched', async () => {
    await startWithCallLog({
      fetchResult: { ok: false, stdout: '', stderr: 'no such pull request' },
    });

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(res.status).toBe(409);
    expect(tasks()).toEqual([]);
    expect(orchestrator.list()).toEqual([]);
  });

  it('creates no task when the merge base cannot be resolved', async () => {
    await startWithCallLog({
      mergeBaseResult: { ok: false, stdout: '', stderr: 'no merge base' },
    });

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(res.status).toBe(409);
    expect(tasks()).toEqual([]);
    expect(orchestrator.list()).toEqual([]);
  });

  // The last step, and the only one with a task already on disk behind it:
  // the head ref is never created here, so `git worktree add` fails and the
  // synthesized task has to go away again rather than linger unreviewed.
  it('removes the task it synthesized when the review cannot start', async () => {
    await startWithCallLog();

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    // 409, not a 500: WorktreeManager throws a bare Error, and the 500 that
    // becomes carries no CORS headers — the webview would see only a network
    // failure with no way to tell what, if anything, was created.
    expect(res.status).toBe(409);
    const body = await json(res);
    expect(body.error).toMatch(/could not start the PR review/);
    expect(body.error).toMatch(/worktree add/);
    expect(tasks()).toEqual([]);
    expect(orchestrator.list()).toEqual([]);
  });

  // The other half of the rollback: once a run exists, deleting the task
  // would strand that run's taskId, so the task stays. Induced for real —
  // the worktree cut succeeds (the ref exists) and buildPrompt then fails on
  // a base that is not a commit, which is exactly dispatchAuxRun's own
  // buildPrompt catch.
  it('keeps the task when a run already references it', async () => {
    await startWithCallLog({
      mergeBaseResult: {
        ok: true,
        stdout: '0000000000000000000000000000000000000000\n',
        stderr: '',
      },
    });
    createPrHeadRef(FORK_PR.number);

    const res = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(res.status).not.toBe(202);

    const surviving = tasks();
    expect(surviving).toHaveLength(1);
    const runs = orchestrator.list();
    expect(runs).toHaveLength(1);
    expect(runs[0].taskId).toBe(surviving[0].meta.id);
    expect(runs[0].state).toBe('failed');
  });

  // Every dispatch mints a fresh task, so dispatchAuxRun's per-task live-run
  // guard can never fire here. Without a PR-level one, a double click files
  // two runs' findings on the same PR — and the eventual submit posts every
  // line comment to GitHub twice.
  it('refuses a second review while one is still running', async () => {
    await startWithCallLog({}, STAYS_LIVE);
    createPrHeadRef(FORK_PR.number);

    const first = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(first.status).toBe(202);
    const second = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    expect(second.status).toBe(409);
    expect((await json(second)).error).toMatch(/already being reviewed/);

    // And it refused before creating anything: still one task, one run.
    expect(tasks()).toHaveLength(1);
    expect(orchestrator.list()).toHaveLength(1);
  });

  // The live-run check above only sees runs that exist. Between it and the
  // run there are five awaits (`gh pr view`, `gh api …/files`, `git fetch`,
  // `git merge-base`, the worktree cut), and a double click lands both
  // requests inside that window — where neither can see the other.
  it('refuses a second review dispatched concurrently with the first', async () => {
    // Holds the first request inside its `gh pr view` await — the first of
    // the five it makes before any task or run exists — until released.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inWindow = () => {};
    const reached = new Promise<void>((resolve) => {
      inWindow = resolve;
    });
    let firstView = true;
    await startWithCallLog({}, STAYS_LIVE, [], async (cmd) => {
      if (cmd[1] !== 'pr' || cmd[2] !== 'view' || !firstView) return;
      firstView = false;
      inWindow();
      await held;
    });
    createPrHeadRef(FORK_PR.number);

    const first = postReviewAgent(FORK_PR.number, { confirmFork: true });
    await reached;
    const second = await postReviewAgent(FORK_PR.number, { confirmFork: true });
    release();

    expect((await first).status).toBe(202);
    expect(second.status).toBe(409);
    // One review, one task: two would file both sets of findings on the same
    // PR and post every line comment to GitHub twice.
    expect(tasks()).toHaveLength(1);
    expect(orchestrator.list()).toHaveLength(1);
  });

  // The claim is released when the dispatch finishes, not held for the run's
  // life — a failed dispatch must not lock the PR out of ever being reviewed.
  it('lets a review start again after a failed dispatch', async () => {
    await startWithCallLog({}, STAYS_LIVE);

    // No head ref yet, so `git worktree add` fails and the dispatch rolls back.
    expect(
      (await postReviewAgent(FORK_PR.number, { confirmFork: true })).status
    ).toBe(409);
    createPrHeadRef(FORK_PR.number);
    expect(
      (await postReviewAgent(FORK_PR.number, { confirmFork: true })).status
    ).toBe(202);
  });

  // The guard is per PR, not a global "one review at a time" lock.
  it('allows a review of a different PR while one is running', async () => {
    await startWithCallLog({}, STAYS_LIVE);
    createPrHeadRef(FORK_PR.number);
    createPrHeadRef(REPO_PR.number);

    expect(
      (await postReviewAgent(FORK_PR.number, { confirmFork: true })).status
    ).toBe(202);
    expect((await postReviewAgent(REPO_PR.number, {})).status).toBe(202);
    expect(tasks()).toHaveLength(2);
  });
});

// Phase 4's whole chain in one pass, against stubs with no network: a PR
// dispatch runs a review, its finding lands in the PR's comment store, and a
// submit carries that finding's own bytes into the review POST GitHub gets.
// Every earlier task proved one link; nothing proved they connect.
describe('agent PR review findings reach GitHub', () => {
  async function waitFor(check: () => boolean) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (check()) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('waitFor timed out');
  }

  function stored(target: ReviewTarget): ReviewComment[] {
    const path = reviewCommentsPath(root, target);
    if (!existsSync(path)) return [];
    return JSON.parse(readFileSync(path, 'utf8')) as ReviewComment[];
  }

  // What reportsFinding's severity/title/detail become once review.ts has
  // rendered them into a comment body — the exact bytes that must survive
  // every hop between the agent and GitHub.
  const FINDING_BODY =
    '**important: unchecked input**\n\nthe parsed value is trusted';

  const TARGET: ReviewTarget = { kind: 'pr', number: FORK_PR.number };

  // Drives dispatch → review run → finding → PR comment store → push, and
  // hands back the review bodies the command seam captured. Both tests below
  // need the whole chain; only their assertions differ.
  async function reviewAndPush(): Promise<Record<string, unknown>[]> {
    const posted: Record<string, unknown>[] = [];
    await startWithCallLog(
      {
        filesResult: filesResultFor('README.md'),
        pushReviewResult: { ok: true, stdout: '{}', stderr: '' },
        // The pull pushPrReview makes right after its POST: GitHub now has
        // the comment, and hands back the id that ends its local-only life.
        commentsListResult: commentsListResultFor(
          rawGitHubComment({
            id: 777,
            path: 'README.md',
            line: 1,
            body: FINDING_BODY,
            diff_hunk: '@@ -0,0 +1 @@\n+# test repo',
          })
        ),
      },
      reportsFinding('README.md', 1),
      posted
    );
    createPrHeadRef(FORK_PR.number);

    const dispatched = await postReviewAgent(FORK_PR.number, {
      confirmFork: true,
    });
    expect(dispatched.status).toBe(202);

    await waitFor(() => stored(TARGET).length > 0);
    // The agent's finding really is what the store holds, before any push —
    // so a payload mismatch below is the push losing it, not the run.
    expect(stored(TARGET)[0].body).toBe(FINDING_BODY);

    const res = await fetch(
      `${baseUrl}/api/prs/${FORK_PR.number}/review-submit`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'comment', body: 'agent review' }),
      }
    );
    expect(res.status).toBe(200);
    expect(((await json(res)) as { pushed: number }).pushed).toBe(1);
    return posted;
  }

  it('puts the finding’s own text in the pushed comments[]', async () => {
    const posted = await reviewAndPush();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      commit_id: FORK_PR.headRefOid,
      event: 'COMMENT',
      body: 'agent review',
    });
    // The load-bearing assertion of the whole phase: what the agent wrote is
    // what GitHub would receive, anchored where the agent anchored it.
    expect(posted[0].comments).toEqual([
      { path: 'README.md', line: 1, side: 'RIGHT', body: FINDING_BODY },
    ]);
  });

  // Phase 3's rule, re-checked now that a comment can originate from an agent
  // rather than the composer: `pending` and `githubId` are assigned together,
  // so a record carrying an id is never still a draft.
  it('never leaves a comment pending once it carries a githubId', async () => {
    await reviewAndPush();

    const after = stored(TARGET);
    expect(after).toHaveLength(1);
    // Non-vacuous: the record genuinely acquired a GitHub identity, so the
    // pair check below has something to be false about.
    expect(after[0].githubId).toBe(777);
    expect(after.filter((c) => c.pending && c.githubId !== undefined)).toEqual(
      []
    );
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
