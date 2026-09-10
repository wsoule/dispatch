# Review page ↔ GitHub sync — Phase 3 (comment mirror) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A line comment written on a GitHub PR in Dispatch posts to GitHub, and
a line comment written on github.com appears anchored in Dispatch's diff —
bidirectionally, keyed by GitHub id.

**Architecture:** Phase 1-2 landed the surface; the composer is currently
disabled for PR targets because comments would have gone to local disk only.
This phase makes the local `ReviewCommentStore` a mirror rather than a silo:
records gain GitHub ids, the store keys on a review target instead of a run id,
a pure mapping function converts GitHub's REST payload to `ReviewComment`, and a
pure merge function resolves the six conflict rules. Push submits the pending
batch as one GitHub review; resolve needs a GraphQL call because REST cannot
resolve a thread.

**Tech Stack:** Bun, TypeScript, React 19, TanStack Query, `bun:test`, the `gh`
CLI behind the injectable `CommandRunner` seam.

**Spec:** `docs/superpowers/specs/2026-08-04-review-github-sync-design.md` §4

## Global Constraints

- `export AGENT=1` at session start. Use `bun` only — never npm/pnpm/npx.
- **Every `gh`/`git` call goes through the injected `CommandRunner` seam**
  (`this.run`, `packages/server/src/orchestrator/pr.ts:36`). Never `Bun.spawn`
  directly. This seam is the only reason these tests need no network.
- Never add dependency versions to package-level `package.json`; the root
  `workspaces.catalog` owns them.
- Preserve trailing newlines.
- **Comments: 1-2 lines each, every line within 80 columns** (`.oxfmtrc.json`
  `printWidth: 80`). `oxfmt` does NOT reflow comment prose, so an over-width
  comment survives `bun run format` silently. Count characters. In Phases 1-2,
  five of seven tasks shipped a comment defect that neither `oxfmt` nor `oxlint`
  caught — it is the single most reliable defect category in this repo.
- **Lint baseline: `0 errors, 156 warnings`** measured on this branch's base.
  Any lint **error** is yours. If the warning count moves, investigate and
  attribute it — do not self-certify a delta as acceptable.
- **Evidence rule:** for any task touching a shared or wire-facing type, the
  _wider package suite_ is the required evidence, not a focused file. In Phase 1
  a focused-file "31/31 passing" hid a broken test in another file for four
  tasks.

## Verified GitHub payload facts (do not re-derive)

Probed against `repos/shadcn-ui/ui/pulls/comments` on 2026-08-04:

- Fields present: `id`, `node_id`, `path`, `line`, `original_line`,
  `start_line`, `diff_hunk`, `updated_at`, `user`, `pull_request_review_id`,
  `side`, `subject_type`, `in_reply_to_id`.
- **`diff_hunk`'s last line carries its diff prefix** (`"+      ></circle>"`).
  The prefix must be stripped before storing as `anchorText`, or the anchor can
  never equal a real file line and `resolveAnchor` calls every synced comment
  outdated.
- `line: null` with `original_line` set is the **common** case (all three
  sampled), not a corner.
- `side` is `RIGHT`/`LEFT`; `subject_type` is `line`/`file`.

## File Structure

| File                                          | Responsibility                                      | Change     |
| --------------------------------------------- | --------------------------------------------------- | ---------- |
| `packages/server/src/reviewComments.ts`       | `ReviewComment` record + store, now target-keyed    | Modify     |
| `packages/server/src/orchestrator/paths.ts`   | `reviewCommentsPath` takes a target slug            | Modify     |
| `packages/server/src/reviewTarget.ts`         | Server-side `ReviewTarget` + slug helper            | **Create** |
| `packages/server/src/githubComments.ts`       | Pure mapping + merge (the two hard, testable cores) | **Create** |
| `packages/server/test/githubComments.test.ts` | Table-driven tests for mapping + all six rules      | **Create** |
| `packages/server/src/orchestrator/pr.ts`      | Pull/push/reply/resolve against GitHub              | Modify     |
| `packages/server/src/api.ts`                  | Target-keyed comment routes                         | Modify     |
| `packages/client/src/api.ts`                  | Target-keyed client methods                         | Modify     |
| `apps/desktop/src/views/ReviewView.tsx`       | Enable the composer for PR targets                  | Modify     |

`githubComments.ts` is a separate module from `pr.ts` on purpose: the mapping
and the merge are pure functions over data, and pure functions are where this
phase's real risk lives. Keeping them out of the class that shells out to `gh`
is what makes them exhaustively testable without a `CommandRunner` at all.

---

## Task 1: Server-side ReviewTarget and target-keyed storage

Today `ReviewCommentStore` keys by `runId` and `reviewCommentsPath` writes
`<runId>.review.json`. A PR that Dispatch never opened has no run, so it has
nowhere to put comments.

**Files:**

- Create: `packages/server/src/reviewTarget.ts`
- Modify: `packages/server/src/orchestrator/paths.ts:51` (`reviewCommentsPath`)
- Modify: `packages/server/src/reviewComments.ts` (every `runId: string`
  parameter)
- Test: `packages/server/test/review-comments.test.ts`

**Interfaces:**

- Produces:
  - `type ReviewTarget = { kind: 'run'; runId: string } | { kind: 'pr'; number: number }`
  - `reviewTargetSlug(target: ReviewTarget): string` — `run` → the bare run id
    (**today's filename, unchanged**), `pr` → `pr-<number>`
  - `ReviewCommentStore` methods taking `ReviewTarget` instead of `runId`

  Tasks 4-7 all consume these.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/review-comments.test.ts`:

```ts
import { reviewTargetSlug } from '../src/reviewTarget.js';

test('a run target keeps its existing on-disk filename', () => {
  expect(reviewTargetSlug({ kind: 'run', runId: 'r-abc' })).toBe('r-abc');
});

test('a pr target gets its own slug that cannot collide with a run id', () => {
  expect(reviewTargetSlug({ kind: 'pr', number: 9 })).toBe('pr-9');
});
```

Then a store test proving a PR target round-trips:

```ts
test('a pr target stores and lists its own comments', () => {
  const store = new ReviewCommentStore(rootDir);
  const target = { kind: 'pr', number: 9 } as const;
  store.add(target, {
    file: 'src/a.ts',
    line: 3,
    anchorText: 'const x = 1;',
    body: 'why one?',
  });
  expect(store.list(target)).toHaveLength(1);
  expect(store.list({ kind: 'run', runId: 'r-abc' })).toHaveLength(0);
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
export AGENT=1
cd packages/server && bun test test/review-comments.test.ts
```

Expected: FAIL — `reviewTarget.js` does not resolve.

- [ ] **Step 3: Create the target module**

```ts
/**
 * What a review is looking at: a local run's diff, or a GitHub pull request.
 * Mirrors apps/desktop/src/lib/reviewTarget.ts, which the UI keys on.
 */
export type ReviewTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'pr'; number: number };

/**
 * The on-disk slug for a target's comment file. A run keeps its bare run id,
 * so every review file written before PR targets existed still resolves.
 */
export function reviewTargetSlug(target: ReviewTarget): string {
  return target.kind === 'run' ? target.runId : `pr-${target.number}`;
}
```

- [ ] **Step 4: Widen the path helper and the store**

`reviewCommentsPath(rootDir, target: ReviewTarget)` →
`join(runsDir(rootDir), \`${reviewTargetSlug(target)}.review.json\`)`.

Then change every `runId: string` parameter in `ReviewCommentStore` (`list`,
`add`, `reply`, `setResolved`, `remove`, `publishPending`, `pendingCount`) to
`target: ReviewTarget`. Update every call site the compiler flags.

**Backward compatibility matters here:** a run target must produce the
_identical_ path it produced before, so existing `<runId>.review.json` files
keep resolving. Do not add a `run-` prefix.

- [ ] **Step 5: Run the wider server suite**

```bash
cd packages/server && bun test
```

Expected: PASS. Per the Global Constraints evidence rule, the wider suite — not
the focused file — is the evidence for this task, because it changes a shared
type.

- [ ] **Step 6: Typecheck and commit**

```bash
cd packages/server && bun run tsc
git add -A && git commit -F - <<'COMMIT'
feat(server): key review comments on a target, not a run id

A pull request dispatch never opened has no run, so the comment store had
nowhere to put a note left on its diff — the store, and the path helper
under it, both keyed on a run id.

A run target still resolves to exactly the filename it always did, so
every review file written before this keeps loading.
COMMIT
```

---

## Task 2: Map a GitHub comment to a ReviewComment

The pure function the whole pull path depends on, and where the one confirmed
spec error lives.

**Files:**

- Create: `packages/server/src/githubComments.ts`
- Create: `packages/server/test/githubComments.test.ts`

**Interfaces:**

- Consumes: `ReviewComment` from `../reviewComments.js`.
- Produces:
  `mapGitHubComment(raw: Record<string, unknown>): ReviewComment | null` —
  `null` for a payload with no usable `path`.

  Task 3 consumes it.

- [ ] **Step 1: Write the failing tests**

```ts
import { expect, test } from 'bun:test';

import { mapGitHubComment } from '../src/githubComments.js';

const base = {
  id: 101,
  node_id: 'PRRC_abc',
  path: 'src/a.ts',
  line: 12,
  original_line: 9,
  start_line: null,
  diff_hunk: '@@ -1,3 +1,4 @@\n context\n+const x = 1;',
  body: 'why one?',
  user: { login: 'teammate' },
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  side: 'RIGHT',
  subject_type: 'line',
};

test('strips the diff prefix from the anchor line', () => {
  // The whole mirror rests on this: GitHub's diff_hunk keeps the +/-/space
  // marker, and an anchor that keeps it can never equal a real file line.
  expect(mapGitHubComment(base)?.anchorText).toBe('const x = 1;');
});

test('carries the GitHub ids needed to match it on the next pull', () => {
  const c = mapGitHubComment(base);
  expect(c?.githubId).toBe(101);
  expect(c?.githubUpdatedAt).toBe('2026-08-02T00:00:00Z');
  expect(c?.origin).toBe('github');
  expect(c?.pending).toBe(false);
});

test('falls back to original_line when the comment has gone outdated', () => {
  expect(mapGitHubComment({ ...base, line: null })?.line).toBe(9);
});

test('a LEFT-side comment is stored with no usable anchor', () => {
  // The local model only has new-side line numbers, so inventing one would
  // point the reader at unrelated code. An empty anchor reads as outdated.
  expect(mapGitHubComment({ ...base, side: 'LEFT' })?.anchorText).toBe('');
});

test('a file-level comment gets line 0 rather than a fake line', () => {
  const c = mapGitHubComment({
    ...base,
    subject_type: 'file',
    line: null,
    original_line: null,
  });
  expect(c?.line).toBe(0);
});

test('a payload with no path is dropped rather than stored half-formed', () => {
  expect(mapGitHubComment({ ...base, path: undefined })).toBeNull();
});
```

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/server && bun test test/githubComments.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the mapping**

Write `mapGitHubComment` in `packages/server/src/githubComments.ts`.
Requirements, each pinned by a test above:

- `file` ← `path`; return `null` when it is not a non-empty string.
- `line` ← `line ?? original_line ?? 0`.
- `startLine` ← `start_line` when it is a number and differs from `line`.
- `anchorText` ← the last line of `diff_hunk` **with its first character
  dropped**, but `''` when `side === 'LEFT'` or `subject_type === 'file'`.
- `githubId` ← `id`; `githubUpdatedAt` ← `updated_at`; `origin: 'github'`;
  `pending: false`; `resolved: false`.
- `author` ← `user.login`, falling back to `'someone'` (reuse the same shape
  `authorLogin` uses in `pr.ts`).
- `id` ← a locally generated `rc-*` id, so a synced comment is addressable by
  the same routes as a local one.
- `replies: []` — threading is Task 5.

- [ ] **Step 4: Run to verify they pass**

```bash
cd packages/server && bun test test/githubComments.test.ts
```

Expected: PASS, all six.

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -F - <<'COMMIT'
feat(server): map a GitHub review comment onto a ReviewComment

The pull half of the mirror. Every field the local record needs exists on
GitHub's payload, with one trap: diff_hunk's last line keeps its +/-/space
marker, so an anchor stored verbatim could never equal a file line and
resolveAnchor would call every synced comment outdated.

A LEFT-side or file-level comment gets an empty anchor rather than a
new-side line it does not have — reading as outdated is honest, pointing
at unrelated code is not.
COMMIT
```

---

## Task 3: Merge local and remote comments — the six conflict rules

The other pure core. "Full bidirectional mirror" means owning these explicitly.

**Files:**

- Modify: `packages/server/src/githubComments.ts`
- Modify: `packages/server/test/githubComments.test.ts`

**Interfaces:**

- Consumes: `mapGitHubComment` (Task 2), `ReviewComment`.
- Produces:
  `mergeComments(local: ReviewComment[], remote: ReviewComment[]): ReviewComment[]`.

- [ ] **Step 1: Write the failing tests — one per rule, table-driven**

```ts
test('rule 1: a comment on both sides is matched by githubId, not by text', () => {
  /* … */
});
test('rule 2: a local pending comment is never touched by a pull', () => {
  /* … */
});
test('rule 3: a newer remote body wins over the stored one', () => {
  /* … */
});
test('rule 3b: a remote body no newer than githubUpdatedAt does not clobber', () => {
  /* … */
});
test('rule 4: a comment with a githubId absent from the pull was deleted upstream', () => {
  /* … */
});
test('rule 5: a published local comment with no githubId survives, to be pushed', () => {
  /* … */
});
test('rule 6: a remote-only comment is inserted', () => {
  /* … */
});
```

Fill each body against `mergeComments`. Every test must fail if its rule is
removed — a test that passes with the rule deleted has not covered it.

- [ ] **Step 2: Run to verify they fail**

```bash
cd packages/server && bun test test/githubComments.test.ts
```

- [ ] **Step 3: Implement `mergeComments`**

| Situation                              | Rule                                                         |
| -------------------------------------- | ------------------------------------------------------------ |
| Present both sides                     | Match on `githubId`                                          |
| Local, `pending: true`, no `githubId`  | Keep untouched; it does not exist upstream yet               |
| Bodies differ                          | Last-writer-wins on `updated_at` vs stored `githubUpdatedAt` |
| Has `githubId`, absent from pull       | Deleted upstream → drop locally                              |
| Local, `pending: false`, no `githubId` | Keep; Task 4 pushes it as a new review                       |
| Remote only                            | Insert with `origin: 'github'`                               |

Preserve local `resolved` state across a merge — GitHub's resolution lives on
the thread, not the comment, and Task 5 owns syncing it.

- [ ] **Step 4: Run to verify they pass, then commit**

```bash
cd packages/server && bun test test/githubComments.test.ts
git add -A && git commit -F - <<'COMMIT'
feat(server): merge local and GitHub review comments

The rules a full bidirectional mirror has to own, stated once and tested
one case each: match on GitHub id, never touch an unsent local comment,
last-writer-wins on edits, treat an id missing from a pull as an upstream
delete, keep a published local comment that has no id yet so the push can
claim it, and insert anything only GitHub has.

Local `resolved` survives a merge — GitHub keeps resolution on the thread
rather than the comment, and that is a separate call.
COMMIT
```

---

## Task 4: Pull and push against GitHub

**Files:**

- Modify: `packages/server/src/orchestrator/pr.ts`
- Test: `packages/server/test/orchestrator/pr.test.ts`

**Interfaces:**

- Consumes: `mapGitHubComment`, `mergeComments`, `parsePrUrl`, `this.run`,
  `ReviewCommentStore`.
- Produces on `PrManager`:
  - `syncPrComments(number: number): Promise<ReviewComment[]>` — pull, merge,
    persist, return
  - `pushPrReview(number, verdict, body): Promise<{ pushed: number }>` — submit
    the pending batch as one review

- [ ] **Step 1: Write the failing tests**

Against `StubRunner`, following the file's existing conventions. Cover:

- a pull maps and persists a stubbed `pulls/N/comments` payload;
- a push sends **one** `POST .../pulls/N/reviews` carrying every pending
  comment, not N separate calls;
- the verdict maps to `APPROVE` / `REQUEST_CHANGES` / `COMMENT`;
- each comment entry carries `path`, `line`, `side: 'RIGHT'`, and the
  `commit_id` from `headRefOid`;
- a failed push leaves the comments still `pending` (the reviewer's writing must
  survive).

**Stub ordering:** put the `/pulls/N/comments` branch before the generic
`gh api` branch, or it will be swallowed — this exact mistake cost a round in
Phase 2.

- [ ] **Step 2-4: Run red, implement, run green**

Push builds its argv as
`['gh', 'api', '-X', 'POST', 'repos/O/R/pulls/N/reviews', '--input', '-']` with
the JSON body on stdin, or the `-F`/`-f` form if the runner cannot supply stdin
— check `CommandRunner`'s signature before choosing, and say which you used in
your report.

After a successful push, re-pull so the just-published comments get their
`githubId` backfilled.

- [ ] **Step 5: Wider suite, typecheck, commit**

```bash
cd packages/server && bun test && bun run tsc
```

---

## Task 5: Replies and resolution

**Files:**

- Modify: `packages/server/src/orchestrator/pr.ts`
- Test: `packages/server/test/orchestrator/pr.test.ts`

- [ ] **Step 1: Replies**

`POST repos/O/R/pulls/N/comments` with `in_reply_to` set to the parent's
`githubId`. Test that a reply to a comment with no `githubId` is refused with
`OrchestratorConflictError` rather than silently posting a new top-level
comment.

- [ ] **Step 2: Resolution needs GraphQL**

REST cannot resolve a review thread. Fetch thread node ids with a GraphQL query
over `pullRequest.reviewThreads`, store them as `githubThreadId` on each
comment, and resolve with the `resolveReviewThread` / `unresolveReviewThread`
mutations via `gh api graphql`.

Test both the query parsing and that resolving a comment with no
`githubThreadId` fails loudly rather than reporting success.

- [ ] **Step 3: Wider suite, typecheck, commit**

---

## Task 6: Target-keyed routes and client methods

**Files:**

- Modify: `packages/server/src/api.ts`, `packages/client/src/api.ts`
- Test: `packages/server/test/review-api.test.ts`

- [ ] Add `/api/prs/:number/comments` mirroring the existing
      `/api/runs/:id/comments` verbs (GET, POST, PATCH `:commentId`, POST
      `:commentId/reply`), plus `POST /api/prs/:number/review` to submit the
      batch.
- [ ] Resolve `:number` through `resolveRepoPrByNumber`, exactly as the diff
      route does — never accept a caller-supplied URL.
- [ ] Mirror the client methods, taking a `ReviewTarget` rather than a run id.
- [ ] Wider suites for both packages; rebuild so the desktop app resolves the
      new client surface.

---

## Task 7: Turn the composer back on for PR targets

The payoff. Phase 2 disabled it because a comment would have gone to local disk
only; that is no longer true.

**Files:**

- Modify: `apps/desktop/src/views/ReviewView.tsx`,
  `apps/desktop/src/hooks/useRepoPrDetail.ts`

- [ ] Pass a real `onAdd` for PR targets and render `ReviewThreadIndex`
      alongside the PR conversation.
- [ ] Update the comment at `ReviewView.tsx` that currently explains _why_ the
      composer is off — it will be stale and actively misleading.
- [ ] Verify in a running app against a public repo with review comments, as
      Phase 2's Task 7 did. If you cannot, say so plainly rather than claiming
      it.
- [ ] Full desktop suite, `tsc`, lint at 0 errors, then commit.

---

## Self-Review

**Spec coverage (§4).** Record fields → Task 1-2; field mapping incl. the prefix
strip → Task 2; the six conflict rules → Task 3; push as one review → Task 4;
replies + GraphQL resolve → Task 5; routes/client → Task 6; composer → Task 7.

**Deliberately out of scope.** Phase 4 (agent review of a PR) gets its own plan.
`formatCommentsForAgent` is unchanged — it filters on `resolved`/`pending`, both
of which survive the mirror.

**Risk carried.** Tasks 4 and 5 are the only ones whose GitHub calls are
unverified against a live write path; the payload _shapes_ are confirmed, but no
write has been exercised. Both are stub-tested, so the first real push is the
moment to watch.
