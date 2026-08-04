# Review page ↔ GitHub sync — design

**Date:** 2026-08-04 **Status:** approved, pending implementation plan

Make the Review page a single surface for both local run diffs and GitHub pull
requests: every open PR appears in the review queue with live status, opens into
the same file-tree/inline-thread UI a local run gets, mirrors its line comments
bidirectionally with GitHub, and can be handed to an agent for review from a
freshly checked-out worktree.

## Why

The Review page is two disjoint surfaces wearing one name. `ReviewView.tsx:129`
is the fork:

```ts
if (run.prUrl !== undefined) {
  return <>{renderPr(run.id)}</>;
}
```

A run with a PR bails out of the entire review UI — file tree, viewed ticks,
inline comment threads, staged-then-submitted review — and lands in
`PullRequestsView` → `PrReviewPanel`, which offers a status header, a flat
chronological conversation list, and one textarea. The better surface and the
GitHub-backed data never meet.

Three consequences follow:

| Gap                                                                                          | Where it bites                                                                                                  |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Line comments on a PR can only be written as prose in a textarea                             | `PrReviewPanel.tsx:270` — one `Textarea` for the whole PR, no file:line anchor                                  |
| GitHub's own line comments are read but not anchored                                         | `getPrDetailByUrl` (`pr.ts:596`) fetches them with `path` + `line`, then flattens them into a time-ordered list |
| A PR Dispatch did not open has no run, so it has no diff, no comment store, and no queue row | `ReviewCommentStore` keys by `runId`; `buildReviewQueue` maps over `RunMeta[]`                                  |

The read path to GitHub is already good — `getPrDetailByUrl` pulls status,
reviews, PR-level comments, and code-line comments, and every `gh` call goes
through the injectable `CommandRunner` seam (`pr.ts:36`), which is what makes
all of this testable without a network. The work is not building a GitHub
client. It is unifying the surface and making the write path real.

## The spine: a ReviewTarget

Every piece below trips over the same assumption: the review stack is keyed to a
**run**. Comment storage keys by `runId`, the diff comes from
`GET /api/runs/:id/diff`, the queue is built from `RunMeta[]`. A GitHub PR that
Dispatch did not open has none of those.

One new concept absorbs that:

```ts
export type ReviewTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'pr'; number: number };
```

Comment storage, diff fetching, and queue rows key on `ReviewTarget` instead of
a run id. A Dispatch-opened PR is both: it resolves to `pr` for GitHub sync and
to `run` for the agent send-back. Introducing this once, in Phase 1, is what
stops the four phases from each inventing their own escape hatch.

Storage follows the same split. `reviewCommentsPath(rootDir, runId)` gains a
target-slug form: a `run` target keeps today's path exactly, and a `pr` target
writes to the `pr-<number>` slug in the same directory scheme. Existing on-disk
comment files are untouched.

## Decisions

1. **Full bidirectional comment mirror, keyed by GitHub id.** Every synced
   comment carries the GitHub ids needed to match it on the next pull. The
   alternative considered — GitHub owns, local only stages the unsubmitted batch
   — would have removed most of Phase 3's machinery. It was rejected
   deliberately; see [Risks](#risks-and-what-to-renegotiate-first).
2. **Agent review of a PR synthesizes a task.** `startReview` (`review.ts:764`)
   opens with `store.get(opts.taskId)` and then depends on `task.meta.risk` to
   pick a model and `task.meta.writes` for the destructive-write and
   shared-surface scans; `dispatchAuxRun` (`orchestrator.ts:395`) requires a
   task too. Findings, the ledger, and the merge queue are all task-keyed.
   Synthesizing a task keeps every one of those unmodified; making runs taskless
   would ripple through all of them.
3. **Same-repo PRs review without friction; fork PRs require confirmation.**
   Checking out a PR head and running an agent in it executes that PR's code.
   `isCrossRepository` (confirmed available on `gh pr list --json`) gates it at
   no extra API cost.
4. **One batched status call, never N.** `gh pr list --json` returns
   `statusCheckRollup` for every PR at once. Per-PR `gh pr view` for queue
   rendering is not acceptable — it is a subprocess per row.
5. **Phases ship independently of the mirror.** Phases 1, 2 and 4 do not depend
   on Phase 3. If the mirror slips, the rest still lands.

   The build order is otherwise **1 → 2 → 4**, with 3 attachable at any point
   after 2. Phase 1 introduces `ReviewTarget` and the widened `RepoPr` that
   Phases 2 and 4 both consume; Phase 2 adds the `pulls/N/files` fetch whose
   changed-file list Phase 4 uses to synthesize a task's `writes`. Phase 3 needs
   Phase 2's surface to render threads into, but nothing needs Phase 3.

## What is verified, and what is not

Verified against the local toolchain while writing this spec:

- `gh pr list --json` accepts `statusCheckRollup`, `reviewDecision`,
  `mergeable`, `isCrossRepository`, `headRepositoryOwner`, `headRefOid`,
  `additions`, `deletions`, `changedFiles`, `files`. Phase 1 is one call, and
  Phase 4's fork detection is free.
- `summarizeChecks` (`pr.ts:256`) already collapses exactly the
  `statusCheckRollup` shape that `pr list` returns, handling both CheckRun and
  legacy StatusContext nodes. Reusable unchanged.
- `worktree.diff()` (`worktree.ts:597`) does **no patch parsing**. It runs
  `git diff <mergeBase>` for a raw patch string and `git diff --name-status` for
  the `{path, status}` file list. `DiffResult.patch` is unmodified stdout.

**Not verified:** the live REST payload for PR review comments.
`wsoule/dispatch` had no open PRs when this was written, so the field mapping in
Phase 3 comes from the documented API, not from an observed response. The first
implementation task must probe a real payload and correct the mapping before the
sync logic is built on it.

## Phase 1 — Every PR in the review queue

`listRepoPrs()` (`pr.ts:395`) widens its `--json` field list and returns a
`RepoPr` carrying `checks: PrCheckSummary`, `reviewDecision`, `mergeable`,
`isDraft`, `isCrossRepository`, `headRepositoryOwner`, and `headRefOid`.

`buildReviewQueue` (`ReviewQueue.tsx:136`) takes runs **and** repo PRs and emits
one sorted list of `ReviewTarget`-bearing items. Deduplication is by PR URL: a
Dispatch-opened PR already appears via its run's `prUrl`, and must not also
appear as a repo PR. The run-backed item wins, because it is the one that can
reach the agent send-back.

Rows render the status pills `PrReviewPanel` already defines. `StatusPill` and
the `STATE_TONE` / `REVIEW_VERDICT` maps move out of `PrReviewPanel.tsx` into a
shared module so the row and the panel cannot drift apart.

Refresh is one query on a 60s interval, invalidated on any review action. It
rides alongside `PrManager.startPolling`'s existing 60s merge poll (`pr.ts:438`)
rather than introducing a second cadence.

## Phase 2 — One review surface

The bail-out at `ReviewView.tsx:129` is deleted. A `pr` target renders the same
frame a local run gets: queue rail, file tree with viewed ticks, one file's diff
in the middle, threads on the right.

A new `GET /api/prs/:number/diff` mirrors `worktree.diff()`'s two-call shape
exactly — no parsing is introduced:

| `worktree.diff()`        | PR equivalent                    | Yields                    |
| ------------------------ | -------------------------------- | ------------------------- |
| `git diff <mergeBase>`   | `gh pr diff <url>`               | `patch` (raw stdout)      |
| `git diff --name-status` | `gh api repos/O/R/pulls/N/files` | `files: {path, status}[]` |

GitHub's `status` strings map to the letters the UI already expects:
`added`→`A`, `modified`/`changed`→`M`, `removed`→`D`, `renamed`→`R`,
`copied`→`C`.

`PierreReviewDiff` takes `{patch, only}` and needs **no changes at all** — this
is why Phase 2 is far cheaper than it first appears.

`PrReviewPanel`'s status header moves into the page header. Its conversation
list becomes the right rail's non-line-anchored section: PR-level comments and
review verdicts carry no file:line, so they cannot be rendered inside the diff
and need a home beside it.

## Phase 3 — The bidirectional comment mirror

The largest phase, and the one carrying the chosen-deliberately complexity.

### Record shape

`ReviewComment` (`reviewComments.ts:23`) gains four fields:

```ts
  /** GitHub's REST id for this review comment, once it exists there. */
  githubId?: number;
  /** GraphQL node id of the owning review thread — required to resolve it. */
  githubThreadId?: string;
  /** GitHub's `updated_at` at last sync, for last-writer-wins on edits. */
  githubUpdatedAt?: string;
  /** Where this comment was born. */
  origin: 'local' | 'github';
```

### Field mapping

The useful accident: GitHub's `diff_hunk` **ends with the commented line**,
which is exactly what `anchorText` stores. `resolveAnchor`
(`reviewComments.ts:91`) and its exact/moved/outdated logic keep working
untouched.

| Local        | GitHub REST                             |
| ------------ | --------------------------------------- |
| `file`       | `path`                                  |
| `line`       | `line`, falling back to `original_line` |
| `startLine`  | `start_line`                            |
| `anchorText` | last line of `diff_hunk`                |
| _(outdated)_ | `line === null`                         |

### Push

The pending batch posts as **one** `POST /pulls/N/reviews` carrying a
`comments[]` array and an `event` derived from the verdict
(`APPROVE`/`REQUEST_CHANGES`/`COMMENT`). This is atomic, and it maps the
existing `pending` flag onto GitHub's own native pending-review concept — the
two designs already agree about what a review is.

Comment entries need `commit_id`, supplied by `headRefOid` from Phase 1.

Replies post individually via `POST /pulls/N/comments` with `in_reply_to` set to
the parent's `githubId`.

After a successful push, a pull backfills `githubId` and `githubThreadId` onto
the just-published records.

### Resolve is the awkward one

REST cannot resolve a review thread. Only the GraphQL `resolveReviewThread` /
`unresolveReviewThread` mutations can, addressed by thread node id. So
resolution needs a second call path (`gh api graphql`) and a `githubThreadId`
obtained from a GraphQL query — which is the entire reason that field is on the
record rather than just `githubId`.

### Conflict rules

"Full mirror" means owning these explicitly:

| Situation                                  | Rule                                                       |
| ------------------------------------------ | ---------------------------------------------------------- |
| Comment exists both sides                  | Match by `githubId`                                        |
| Local, `pending: true`, no `githubId`      | Never touched by a pull; it does not exist on GitHub yet   |
| Body differs                               | Last-writer-wins: GitHub `updated_at` vs `githubUpdatedAt` |
| Has `githubId` locally, absent from a pull | Deleted on GitHub → remove locally                         |
| Local, `pending: false`, no `githubId`     | Written before the PR existed → push as a new review       |
| GitHub-only                                | Insert locally with `origin: 'github'`                     |

`formatCommentsForAgent` (`reviewComments.ts:236`) is unchanged. It filters on
`resolved` and `pending`, and both survive the mirror intact.

## Phase 4 — An agent reviews a pull request

`isCrossRepository` gates the entry point. A same-repo PR reviews on click. A
fork PR shows a confirmation naming `headRepositoryOwner` before any worktree is
created, because from that point on the PR's code is on the machine.

The head is fetched with `git fetch origin pull/N/head:dispatch-pr-N`, which
works for forks as well as same-repo branches.

A task is synthesized from the PR: title and body from the PR itself, `writes`
derived from its changed files (already fetched in Phase 2), and a default risk.
Synthesized tasks are tagged so they are distinguishable on the board from tasks
a human wrote. `startReview` is then called with `base` set to the merge base
and `head` set to the fetched ref — unmodified, because Decision 2 gave it the
task it requires.

Agent findings post back as real GitHub review comments by riding Phase 3's push
path. Phase 4 can ship before Phase 3, in which case findings stay in-app until
the mirror exists.

## Testing

Every `gh` and `git` call already routes through the injected `CommandRunner`
(`pr.ts:36`), so all of this is testable with stubbed payloads and no network.
That seam is the single reason this design is tractable, and no phase may
introduce a call that bypasses it.

- **Phase 1** — `listRepoPrs` against a stubbed `pr list` payload; queue dedup
  when a run's `prUrl` matches a listed repo PR; `summarizeChecks` against mixed
  CheckRun/StatusContext rollups (already covered, extend).
- **Phase 2** — `GET /api/prs/:number/diff` builds `DiffResult` from stubbed
  `pr diff` + `pulls/N/files`; the status-letter mapping table above; a PR
  target rendering the file-tree frame rather than bailing out.
- **Phase 3** — the heaviest. A table-driven suite over the six conflict rules,
  each as an explicit case. Plus: `diff_hunk` → `anchorText` extraction,
  `line === null` → outdated, push batching one review rather than N comments,
  and reply `in_reply_to` threading.
- **Phase 4** — fork detection from `isCrossRepository`; the confirm gate
  blocking worktree creation until accepted; task synthesis producing a doc
  `startReview` accepts.

Baseline per `AGENTS.md`: `bun run format` and `bun run lint` from the root,
plus package-level `bun run tsc` and focused tests for each changed area.

## Risks and what to renegotiate first

**Phase 3 is roughly the size of Phases 1, 2 and 4 combined.** Full mirroring
means owning dedup, edit-wins, deletion detection, and a GraphQL call path that
exists solely so threads can be resolved. The rejected alternative — GitHub owns
the comments, the local store only stages the unsubmitted batch — deletes the
entire conflict-rules table, the `githubUpdatedAt` field, and the deletion
detection, at the cost of not surviving offline edits.

This was chosen with the tradeoff stated. But if the schedule tightens, Phase 3
is the phase to renegotiate, and Phases 1, 2 and 4 all ship without it.

**Second risk:** the unverified comment payload noted above. The field mapping
is the foundation of Phase 3 and is currently drawn from documentation. Probing
a real payload is the first implementation task, not an afterthought.
