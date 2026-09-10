# Review ↔ GitHub — deferred follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the five deferred items left by Phases 1–4 of the Review ↔
GitHub work.

**Architecture:** Four are localized (a boot reconciliation, a ref cleanup, an
input validation, a closed-PR fallback). The fifth is a repo-wide inconsistency
in how `writes` is read, and is deliberately scoped to the one place it actually
breaks rather than a full unification.

**Tech Stack:** Bun, TypeScript, `bun:test`, the `gh` CLI behind the injectable
`CommandRunner` seam.

**Prior work:**
`docs/superpowers/specs/2026-08-04-review-github-sync-design.md`, and the phase
plans beside it.

## Already fixed — do not re-do

The sixth item on the original list ("a reply written on github.com appears in
the PR conversation but not in the inline threads") **is already closed**.
`partitionGitHubComments` and `attachGitHubReplies` land at
`packages/server/src/githubComments.ts:172`/`:193` and are wired into
`syncPrComments` at `packages/server/src/orchestrator/pr.ts:1031`/`:1039`. It
was carried as open from a stale PR description. Verify, do not rebuild.

## Global Constraints

- `export AGENT=1` at session start. Use `bun` only — never npm/pnpm/npx.
- **Every `gh`/`git` call through the injected `CommandRunner` seam.** Never
  `Bun.spawn`. `WorktreeManager` is the known exception — it calls `runGit`
  directly, which predates this work.
- **Do not weaken the fork gate.** `fetchPrHead` requires `{ confirmFork }`;
  `RepoPr.isCrossRepository` is a required field. Both are load-bearing safety
  properties, confirmed unbypassable across Phase 4's reviews.
- **Do not weaken the pending/`githubId` invariant**: a comment is never
  `pending: true` while carrying a `githubId`.
- Preserve trailing newlines.
- **Comments: 2-3 lines, within 80 columns** (`.oxfmtrc.json` `printWidth: 80`).
  `oxfmt` does NOT reflow comment prose. Count characters _and_ lines.
- **Lint must stay `0 warnings, 0 errors`; `bun run lint:deadcode` (knip) must
  stay exit 0** — CI gates on both.
- **Run tests in the FOREGROUND, focused files only.** **Never run the wide
  server suite** (`bun test` with no paths) — it holds a load-dependent hang
  (`BoardSyncer degradation…`), confirmed unrelated, passing 24/24 alone.
- **Never verify against a third-party GitHub repo.** Use stubs.

---

## Task 1: A restarted daemon retires the review it lost

`ReviewRunner.ingest` (`packages/server/src/orchestrator/review.ts:950-952`)
returns early when `this.pending` has no entry for the run. `pending` is an
**in-memory `Map`**, so a daemon restart mid-review loses it. The review run
then reaches a terminal state with nobody listening: its derived task stays
outstanding and its worktree is never cleaned.

Nothing leaks off-machine — both syncers skip derived tasks — but the user is
left with a stale board row and an orphan worktree they have to find.

**Files:** `packages/server/src/orchestrator/review.ts`; wherever boot
reconciliation lives (find it — the orchestrator already force-fails runs left
running by a crash).

- [ ] Find the existing boot reconciliation path and follow its pattern rather
      than inventing a second one.
- [ ] On startup, a review run that is terminal (or gets force-failed) with a
      derived task must run the same retirement `cleanupDerivedAuxRun` does:
      task to `done` + `archivedAt`, worktree removed, branch discarded.
- [ ] Test: a review run whose `pending` entry is absent still retires its task
      and removes its worktree.
- [ ] Commit.

**Do not** persist the whole `pending` map to disk unless you find that
genuinely simpler — the task carries `derivedFrom` already, which is the durable
signal.

---

## Task 2: `refs/dispatch/pr/<n>` is cleaned up

`fetchPrHead` creates the ref (`packages/server/src/orchestrator/pr.ts:920`) and
nothing ever deletes it. They accumulate forever, and each one is a standing
start-point for the Task 3 gap below.

**Files:** `packages/server/src/orchestrator/pr.ts`,
`packages/server/src/orchestrator/orchestrator.ts`.

- [ ] Delete the ref when a PR review run retires — the same hook Task 1 makes
      reliable. `cleanupDerivedAuxRun` is the natural home.
- [ ] A failed delete must not fail the retirement: a leftover ref is untidy, an
      unretired task is worse.
- [ ] Test: retiring a PR review deletes its ref; a delete failure still
      retires.
- [ ] Commit.

---

## Task 3: `POST /api/tasks/:id/review` validates its `head`

`startTaskReview` (`packages/server/src/api/review.ts:31`) accepts any non-empty
string as `head`. Once `refs/dispatch/pr/<n>` exists, a caller can name it and
cut a worktree from a fork's code **without passing the fork gate**.

Reaching it requires a _prior confirmed_ dispatch to have created the ref, so
this is hardening rather than an open door — but Task 2 makes refs
shorter-lived, not absent, and defence in depth is cheap here.

**Files:** `packages/server/src/api/review.ts`.

- [ ] Refuse a `head` that names a PR head ref. The narrow, honest rule is to
      reject the `refs/dispatch/pr/` prefix — that ref exists solely for the
      gated path and no legitimate caller of this route needs it.
- [ ] Consider whether a broader allow-list (a run branch, a task branch, a SHA)
      is feasible without breaking existing callers. If it is, prefer it and say
      why; if it is not, take the narrow rule and say why.
- [ ] Test both: the PR-head ref is refused, and every shape a real caller uses
      still works.
- [ ] Commit.

---

## Task 4: A closed PR does not strand its findings

`resolvePrForComments` (`pr.ts:958`) resolves through `listRepoPrs`, which is
`--state open`. So once a PR closes or merges, `syncPrComments` (`:1025`) and
`pushPrReview` (`:1081`) both 404 — and any staged comments sit in
`pr-<n>.review.json` unreachable and unsendable.

**Files:** `packages/server/src/orchestrator/pr.ts`, and the API/UI surface that
reports it.

- [ ] Reading must keep working for a closed PR — the comments are still worth
      seeing. `gh pr view <n>` sees closed PRs where `gh pr list` does not; use
      it as a fallback, or widen the list call's state.
- [ ] Pushing to a closed PR should fail with a message that **says the PR is
      closed**, not a bare 404. GitHub rejects review submissions on a closed
      PR, so this is about the message, not about forcing it through.
- [ ] Surface the state in the UI so a user with staged comments understands why
      they cannot send them.
- [ ] Test: a closed PR lists its comments, and a push reports the closure
      clearly.
- [ ] Commit.

---

## Task 5: `writes` stops meaning three different things — where it breaks

`writes` is read three ways across the repo:

- **glob** — `scanDestructiveWrites` and `undeclaredWrites` (`review.ts:168`,
  `:195`), via `Bun.Glob`
- **literal equality** — `conflicts.ts:20-29`, `a === b` with a trailing-`/**`
  directory rule
- **regex test** — `sharedSurfaceWrites` (`review.ts:151`), against
  `SHARED_SURFACE_PATTERNS`

Phase 4 escapes glob metacharacters when synthesizing a PR review task's
`writes`, which is correct for the glob consumers and **breaks the literal
one**: an escaped `pages/\[id\].tsx` never equals the unescaped path a human
wrote or `git status` reports, so conflict detection silently misses that pair.

**Scope this deliberately.** A full unification (making conflict detection
glob-aware) means pattern-vs-pattern intersection, which is a genuinely hard
problem and a behaviour change to scheduling. **Do not attempt it here.**

- [ ] Fix the actual break: normalize before comparing in `conflicts.ts`, so an
      escaped and an unescaped spelling of the same path compare equal. The
      existing conservative semantics stay; only the mismatch goes.
- [ ] Document the three readings at the `writes` field itself, so the next
      reader learns it from the type rather than from a bug.
- [ ] Test: an escaped path and its unescaped twin conflict; unrelated paths
      still do not.
- [ ] Commit.

If you conclude normalization is the wrong shape — for instance that escaping
should never have reached `writes` and the glob consumers should escape at read
time instead — **say so and stop**. That is a design question worth answering
before either fix.

---

## Self-Review

**Coverage.** Items 1-5 of the original list map to Tasks 1-5. The sixth was
already closed and is verified, not rebuilt.

**Risk.** Task 1 is the most valuable (it removes debris a user must hunt for)
and Task 5 is the most likely to be the wrong shape — it is the only one with an
explicit stop-and-ask.

**Out of scope.** Full `writes` unification; the untested live `pushPrReview`
write against real GitHub; `WorktreeManager` bypassing the `CommandRunner` seam.
