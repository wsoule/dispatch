# Review page ↔ GitHub sync — Phase 4 (agent reviews a PR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hand any open GitHub PR to a review agent — it checks the PR's head
into a fresh worktree, reviews it, and posts its findings back as real GitHub
review comments.

**Architecture:** `startReview` is task-anchored (it reads `task.meta.risk` to
pick a model and `task.meta.writes` for its destructive-write scan), and a PR
Dispatch never opened has no task. So a PR review **synthesizes** one. The head
is fetched into a local ref so `dispatchAuxRun` can cut a worktree from it.
Findings then ride Phase 3's push path — which requires first removing a
hardcoded `{kind: 'run'}` that makes them run-only today.

**Tech Stack:** Bun, TypeScript, React 19, `bun:test`, the `gh` CLI behind the
injectable `CommandRunner` seam.

**Spec:** `docs/superpowers/specs/2026-08-04-review-github-sync-design.md` §5,
and Decisions 2 and 3.

## Global Constraints

- `export AGENT=1` at session start. Use `bun` only — never npm/pnpm/npx.
- **Every `gh`/`git` call goes through the injected `CommandRunner` seam**
  (`this.run`, `pr.ts`). Never `Bun.spawn` — that seam is the only reason these
  tests need no network.
- Never add dependency versions to package-level `package.json`.
- Preserve trailing newlines.
- **Comments: 2-3 lines, every line within 80 columns** (`.oxfmtrc.json`
  `printWidth: 80`). `oxfmt` does NOT reflow comment prose, so an over-width
  comment survives `bun run format` silently. Count characters _and_ lines.
- **Lint baseline: `0 warnings, 0 errors`. `bun run lint:deadcode` (knip) must
  stay exit 0** — CI gates on both.
- **Run tests in the FOREGROUND, focused files only.** Several agents in Phase 3
  stalled by backgrounding a long run. **Never run the wide server suite**
  (`bun test` with no paths) — it holds a load-dependent hang
  (`BoardSyncer degradation…`) confirmed unrelated, passing 24/24 alone.
- **Never verify against a third-party GitHub repo.** A Phase 3 round
  accidentally posted a real comment to `tailwindlabs/tailwindcss`. Use stubs;
  if live verification is needed, use a repo Wyat owns.

## Safety decision (spec Decision 3) — this is the point of Task 4

Checking out a PR head and running an agent in it **executes that PR's code on
this machine**. A same-repo PR reviews on click. A **fork** PR must show a
confirmation naming `headRepositoryOwner` before any worktree exists.
`isCrossRepository` is already on `RepoPr` (`pr.ts:274`) at no extra API cost.

## File Structure

| File                                                 | Responsibility                                                | Change     |
| ---------------------------------------------------- | ------------------------------------------------------------- | ---------- |
| `packages/server/src/orchestrator/review.ts`         | `PendingReview` carries a `ReviewTarget`; findings post to it | Modify     |
| `packages/server/src/orchestrator/pr.ts`             | `fetchPrHead`, merge-base resolution                          | Modify     |
| `packages/server/src/orchestrator/prReviewTask.ts`   | Synthesize a task from a PR                                   | **Create** |
| `packages/server/src/api.ts`                         | `POST /api/prs/:number/review-agent`                          | Modify     |
| `packages/client/src/api.ts`                         | `startPrAgentReview`                                          | Modify     |
| `apps/desktop/src/components/runs/PrReviewPanel.tsx` | The button and the fork confirm                               | Modify     |

---

## Task 1: Findings post to a review target, not always a run

**Files:** Modify `packages/server/src/orchestrator/review.ts` (`PendingReview`,
and the hardcoded target at `:994`). Test:
`packages/server/test/orchestrator/review.test.ts`.

**Produces:** `PendingReview.target?: ReviewTarget`, consumed by Task 5.

`review.ts:994` hardcodes `const target: ReviewTarget = { kind: 'run', runId }`.
That makes agent findings run-only — they can never reach a PR, which is Phase
4's whole output.

- [ ] **Step 1: Write the failing test** — a review whose pending record carries
      `{kind:'pr', number}` posts its findings to the PR's comment store, not a
      run's.
- [ ] **Step 2: Run it; expect FAIL** (findings land under the run slug).
- [ ] **Step 3:** add `target?: ReviewTarget` to `PendingReview`; use it at
      `:994`, falling back to `{kind:'run', runId}` when absent so every
      existing caller is unchanged.
- [ ] **Step 4: GREEN**, plus the existing review tests still pass.
- [ ] **Step 5: Commit.**

**Note:** a run **with a PR** should arguably also route here — Phase 3 added
`commentTargetForRun` in `api.ts` for exactly that resolution. Do **not** change
that behaviour in this task; note it in your report and let Task 5 decide
deliberately.

---

## Task 2: Fetch a PR's head into a local ref

**Files:** Modify `packages/server/src/orchestrator/pr.ts`. Test:
`packages/server/test/orchestrator/pr.test.ts`.

**Produces:** `fetchPrHead(number): Promise<{ ref: string; base: string }>` —
consumed by Task 5.

- `git fetch origin pull/<n>/head:dispatch-pr-<n>` — works for forks as well as
  same-repo branches, which is why it beats `gh pr checkout`.
- Resolve the merge base against the PR's base branch; that is `startReview`'s
  `base`.
- A failed fetch throws `OrchestratorConflictError` with the git error text —
  never a silent empty ref.
- Re-fetching an existing ref must **update** it, not fail. A second review of
  the same PR after new commits is the normal case.

- [ ] TDD as above, against `StubRunner`. **Place any new stub branch before the
      generic `gh api` branch** — that ordering has cost two rounds in this
      project.
- [ ] Commit.

---

## Task 3: Synthesize a task from a PR

**Files:** Create `packages/server/src/orchestrator/prReviewTask.ts` + its test.

**Produces:**
`buildPrReviewTask(pr: RepoPr, files: {path:string}[]): CreateInput`.

Keep it a **pure** function returning a `CreateInput` — the store call belongs
to Task 5. Pure is what made Phase 3's hard parts testable.

- Title from the PR title, prefixed so it is obvious on the board (e.g.
  `Review PR #12: <title>`).
- Body from the PR body, plus the PR URL.
- `writes` from the PR's changed files (Phase 2 already fetches these via
  `pulls/N/files`).
- A default risk, and a marker making a synthesized task distinguishable from
  one a human wrote. Use whatever `CreateInput` already supports — read
  `packages/core/src/store.ts`'s `CreateInput` before inventing a field.

- [ ] TDD. Cover: an empty PR body, a PR with no changed files, and a title
      needing no mangling.
- [ ] Commit.

---

## Task 4: The fork gate

**Files:** Modify `packages/server/src/api.ts` and
`apps/desktop/src/components/runs/PrReviewPanel.tsx`.

The route accepts `confirmFork?: boolean`. When the PR `isCrossRepository` and
`confirmFork` is not `true`, respond **409** with a message naming
`headRepositoryOwner` — and **create nothing**: no ref, no worktree, no task. A
same-repo PR needs no confirmation.

The UI shows a review button on a PR target. For a fork it first shows a
confirmation naming the owner and saying plainly that the PR's code will run on
this machine.

- [ ] Test that a fork without `confirmFork` creates nothing — assert the stub
      saw **no** `git fetch`, and that no task was created. A 409 that already
      made a worktree is the failure this task exists to prevent.
- [ ] Test that a same-repo PR needs no confirmation, and that a fork **with**
      `confirmFork: true` proceeds.
- [ ] Commit.

---

## Task 5: Wire the dispatch

**Files:** Modify `packages/server/src/api.ts`, `packages/client/src/api.ts`.

`POST /api/prs/:number/review-agent`:

1. Resolve the number through `resolveRepoPrByNumber` — never a caller-supplied
   URL. Every PR route in this codebase does this; it is what keeps dispatchd
   from being an open proxy.
2. Apply Task 4's fork gate.
3. `fetchPrHead` (Task 2).
4. Synthesize and create the task (Task 3).
5. Call `startReview` with `base` = the merge base, `head` = the fetched ref,
   and a `PendingReview.target` of `{kind:'pr', number}` (Task 1) so findings
   land on the PR.

Decide deliberately, and say so in your report: should a run **with** a PR also
get `{kind:'pr'}` here? Task 1 deliberately left that alone.

- [ ] TDD through the HTTP layer. Cover the ordering: a failure at any step
      leaves nothing half-created.
- [ ] Commit.

---

## Task 6: Findings reach GitHub end to end

**Files:** whatever the seam requires; likely test-only.

Prove the whole chain against stubs: dispatch a PR review → the run produces
findings → they land in the PR's comment store → a push sends them to GitHub as
review comments.

- [ ] One end-to-end test through the real seam, with no network.
- [ ] Confirm the Phase 3 invariant still holds: a comment is never
      `pending: true` while carrying a `githubId`.
- [ ] Full verification: focused suites, `tsc`, `bun run build`, lint 0/0, knip
      exit 0.
- [ ] Commit.

---

## Self-Review

**Spec coverage (§5).** Fork gate → Task 4 (Decision 3). Head fetch → Task 2.
Task synthesis → Task 3 (Decision 2). `startReview` unmodified → Task 5.
Findings riding Phase 3's push path → Tasks 1 and 6.

**Risk carried.** Task 5 is the only task that creates real state (a ref, a
worktree, a task, a run) and the only one where a partial failure leaves debris.
Its ordering test is the most valuable in this plan.

**Out of scope.** Reviewing a closed or merged PR; re-reviewing on new commits
automatically; the run-with-PR finding-target question, which Task 5 records as
a decision rather than silently changing.
