import type { CommandRunner } from './orchestrator/pr.js';

// The patch every dispatch-created fake PR reports, and the files list that
// goes with it — the two must agree, since the review UI lists one and renders
// the other. `FAKE_OUTPUT.txt` is the file the fake executor actually writes.
const FAKE_PATCH = `diff --git a/FAKE_OUTPUT.txt b/FAKE_OUTPUT.txt
index 1111111..2222222 100644
--- a/FAKE_OUTPUT.txt
+++ b/FAKE_OUTPUT.txt
@@ -1,3 +1,4 @@
 dispatch fake run output
-marker: old
+marker: new
+trailing note added by the fake executor
 end of file
diff --git a/src/fake-feature.ts b/src/fake-feature.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/fake-feature.ts
@@ -0,0 +1,4 @@
+// Added by the fake PR so the review surface has a second file to open.
+export function fakeFeature(): string {
+  return 'hello from the fake PR';
+}
`;

const FAKE_FILES = [
  { filename: 'FAKE_OUTPUT.txt', status: 'modified' },
  { filename: 'src/fake-feature.ts', status: 'added' },
];

// The standalone (non-dispatch) PR's own diff — a dependency bump, matching
// what its title and author claim, so demo mode has two unlike diffs to open.
const BUMP_PATCH = `diff --git a/package.json b/package.json
index 4444444..5555555 100644
--- a/package.json
+++ b/package.json
@@ -8,2 +8,2 @@
   "dependencies": {
-    "left-pad": "1.3.0"
+    "left-pad": "1.3.1"
`;

interface FakePr {
  number: number;
  url: string;
  title: string;
  headRefName: string;
  author: string;
  state: string;
  isDraft: boolean;
  mergeable: string;
  /** Raw `statusCheckRollup` nodes, shared by `pr list` and `pr view` so the
   *  queue row and the review panel cannot report different check counts. */
  statusCheckRollup: Array<Record<string, unknown>>;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** What `gh pr diff` returns for this PR. */
  patch: string;
  /** What `gh api …/pulls/N/files` returns — must match `patch`'s paths. */
  files: Array<Record<string, unknown>>;
  reviews: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  lineComments: Array<Record<string, unknown>>;
}

// GitHub's own aggregate verdict, derived from whatever reviews the fake has
// accumulated — so approving in the app changes what the next read reports.
function reviewDecision(pr: FakePr | undefined): string {
  if (pr?.reviews.some((r) => r.state === 'APPROVED') === true) {
    return 'APPROVED';
  }
  if (pr?.reviews.some((r) => r.state === 'CHANGES_REQUESTED') === true) {
    return 'CHANGES_REQUESTED';
  }
  return 'REVIEW_REQUIRED';
}

/**
 * An in-memory stand-in for the `gh`/`git` CLI, gated on DISPATCH_FAKE_GH so
 * the PR review surface is fully demoable/testable without a real remote. It
 * keeps per-PR state (created PRs, their reviews and comments) so that posting
 * a review or comment through the app actually shows up on the next status
 * read — the whole open -> review -> see-your-review loop works against it.
 *
 * Every PR carries the same fields the real `gh pr list --json …` reports,
 * including the check rollup, mergeability and diffstat the review queue
 * renders: a fake that answered with less would hide exactly the status this
 * surface exists to show.
 */
export function makeFakeGhRunner(): CommandRunner {
  const prs = new Map<string, FakePr>();
  let counter = 41;
  const ok = (stdout = '') => Promise.resolve({ ok: true, stdout, stderr: '' });
  const flagValue = (cmd: string[], name: string): string | undefined => {
    const i = cmd.indexOf(name);
    return i >= 0 && i < cmd.length - 1 ? cmd[i + 1] : undefined;
  };

  // The one standalone fake PR (#7, dependabot) that `gh pr list` has always
  // reported without dispatch ever "creating" it via `gh pr create` below —
  // so the review queue has a real non-dispatch row in demo mode. Seeded
  // straight into `prs` (rather than assembled ad hoc inside the `list`
  // handler, as it used to be) so `gh pr view`/`diff`/`review`/`comment` of
  // this PR — the in-app review surface for those rows — resolve against the
  // same map every dispatch-created PR does, instead of map-missing into the
  // generic "PR not found" default below.
  //
  // It fails a check and conflicts on purpose: the queue's checks/conflicts
  // pills are only worth demoing against a row that is not all green.
  const standaloneUrl = 'https://github.com/dispatch-demo/repo/pull/7';
  prs.set(standaloneUrl, {
    number: 7,
    url: standaloneUrl,
    title: 'Bump dependency versions',
    headRefName: 'deps/bump-versions',
    author: 'dependabot',
    state: 'OPEN',
    isDraft: false,
    mergeable: 'CONFLICTING',
    statusCheckRollup: [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }],
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    patch: BUMP_PATCH,
    files: [{ filename: 'package.json', status: 'modified' }],
    reviews: [],
    comments: [
      {
        author: { login: 'dependabot' },
        body: 'Superseded by a newer version bump — should still be safe to merge as-is.',
        createdAt: new Date().toISOString(),
      },
    ],
    lineComments: [],
  });

  return (_cwd, cmd) => {
    const [bin, sub, action] = cmd;
    const now = new Date().toISOString();

    if (bin === 'gh' && sub === '--version')
      return ok('gh version 2.0.0 (fake)');
    if (bin === 'git' && sub === 'remote') {
      return ok('https://github.com/dispatch-demo/repo.git');
    }
    if (bin === 'git' && sub === 'push') return ok();

    if (bin === 'gh' && sub === 'pr' && action === 'create') {
      counter += 1;
      const url = `https://github.com/dispatch-demo/repo/pull/${counter}`;
      prs.set(url, {
        number: counter,
        url,
        title: flagValue(cmd, '--title') ?? 'Pull request',
        headRefName: `dispatch/fake-${counter}`,
        author: 'you',
        state: 'OPEN',
        isDraft: false,
        mergeable: 'MERGEABLE',
        // Mixed on purpose: two green and one still running is what a real PR
        // looks like minutes after it opens, and it exercises the amber pill.
        statusCheckRollup: [
          { conclusion: 'SUCCESS' },
          { conclusion: 'SUCCESS' },
          { status: 'IN_PROGRESS' },
        ],
        additions: 6,
        deletions: 1,
        changedFiles: 2,
        patch: FAKE_PATCH,
        files: FAKE_FILES,
        reviews: [],
        comments: [
          {
            author: { login: 'teammate' },
            body: 'Thanks for opening this — taking a look now.',
            createdAt: now,
          },
        ],
        lineComments: [
          {
            user: { login: 'teammate' },
            body: 'Nit: could this marker string be a named constant?',
            created_at: now,
            path: 'FAKE_OUTPUT.txt',
            line: 1,
          },
        ],
      });
      return ok(url);
    }

    if (bin === 'gh' && sub === 'pr' && action === 'list') {
      // Every open PR in `prs` — every one this fake has "opened" via
      // `gh pr create` above, plus the standalone fake PR (#7, dependabot)
      // seeded above. Reports the full widened shape `listRepoPrs()` asks
      // for, reading each field off the PR itself so `pr view` of the same
      // PR agrees with the row the queue drew from this call.
      const open = [...prs.values()]
        .filter((pr) => pr.state === 'OPEN')
        .map((pr) => ({
          number: pr.number,
          title: pr.title,
          url: pr.url,
          headRefName: pr.headRefName,
          headRefOid: `fakesha${pr.number}`,
          author: { login: pr.author },
          isDraft: pr.isDraft,
          updatedAt: now,
          isCrossRepository: false,
          headRepositoryOwner: { login: 'dispatch-demo' },
          reviewDecision: reviewDecision(pr),
          mergeable: pr.mergeable,
          statusCheckRollup: pr.statusCheckRollup,
          additions: pr.additions,
          deletions: pr.deletions,
          changedFiles: pr.changedFiles,
        }));
      return ok(JSON.stringify(open));
    }

    if (bin === 'gh' && sub === 'pr' && action === 'diff') {
      return ok(prs.get(cmd[3] ?? '')?.patch ?? '');
    }

    if (bin === 'gh' && sub === 'pr' && action === 'view') {
      const url = cmd[3];
      const pr = prs.get(url);
      if (flagValue(cmd, '--json') === 'state') {
        return ok(JSON.stringify({ state: pr?.state ?? 'OPEN' }));
      }
      return ok(
        JSON.stringify({
          number: pr?.number ?? 0,
          url,
          title: pr?.title ?? 'Pull request',
          state: pr?.state ?? 'OPEN',
          isDraft: pr?.isDraft ?? false,
          reviewDecision: reviewDecision(pr),
          mergeable: pr?.mergeable ?? 'MERGEABLE',
          statusCheckRollup: pr?.statusCheckRollup ?? [],
          additions: pr?.additions ?? 0,
          deletions: pr?.deletions ?? 0,
          changedFiles: pr?.changedFiles ?? 0,
          reviews: pr?.reviews ?? [],
          comments: pr?.comments ?? [],
        })
      );
    }

    if (bin === 'gh' && sub === 'api') {
      // The REST path is whichever argument is not a flag: the files call
      // passes `--paginate` first, so reading a fixed index picked that up
      // instead and answered every request with the line comments.
      const path = cmd.slice(2).find((arg) => !arg.startsWith('-')) ?? '';
      const match = /pulls\/(\d+)\/(comments|files)/.exec(path);
      const pr = [...prs.values()].find((p) => String(p.number) === match?.[1]);
      if (match?.[2] === 'files') return ok(JSON.stringify(pr?.files ?? []));
      return ok(JSON.stringify(pr?.lineComments ?? []));
    }

    if (bin === 'gh' && sub === 'pr' && action === 'review') {
      const pr = prs.get(cmd[3]);
      const state = cmd.includes('--approve')
        ? 'APPROVED'
        : cmd.includes('--request-changes')
          ? 'CHANGES_REQUESTED'
          : 'COMMENTED';
      pr?.reviews.push({
        author: { login: 'you' },
        body: flagValue(cmd, '--body') ?? '',
        state,
        submittedAt: now,
      });
      return ok();
    }

    if (bin === 'gh' && sub === 'pr' && action === 'comment') {
      const pr = prs.get(cmd[3]);
      pr?.comments.push({
        author: { login: 'you' },
        body: flagValue(cmd, '--body') ?? '',
        createdAt: now,
      });
      return ok();
    }

    return ok();
  };
}
