# Universal Job Runner — Phase A Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the seams that make Dispatch's pipeline generalizable —
job-spec fields on the task file, an executor that isn't an agent, an injectable
workspace layer, a pluggable merge-gate verifier, and a delivery dispatch table
— with **zero user-facing behavior change**. Every default reproduces today's
behavior exactly.

**Architecture:** Seven optional frontmatter fields land on `TaskMeta` with
omit-when-default serialization. The orchestrator's existing `registerExecutor`
map gains a `CommandExecutor` proving the `Executor` contract holds for plain
processes. `WorktreeManager` becomes injectable and dispatch-time workspace
lifecycle goes behind a `WorkspaceProvider` interface whose only Phase A
implementation wraps it. The merge queue's verify stage is extracted behind a
`GateVerifier` interface. Delivery gets a resolution function that maps a task's
`deliver` field onto the existing merge/pr/discard paths. No new job types ship
to users in this phase.

**Tech Stack:** Bun, TypeScript, tsdown, `bun test`, oxlint/oxfmt. No new
dependencies.

**Spec:** `docs/superpowers/specs/2026-08-05-universal-job-runner-design.md`

## Corrections to the spec discovered while mapping

The plan supersedes the spec on these points (spec updated alongside):

1. **The executor registry already exists.** `Orchestrator` holds
   `executors = new Map<string, Executor>()` (orchestrator.ts:181) with
   `registerExecutor` (:244), `registeredExecutorNames` (:251), lookup +
   `unknown executor` error at dispatch (:346-349), and
   `DEFAULT_EXECUTOR_NAME = 'claude'` (:117). Production wiring registers
   `'claude'` in `packages/server/src/index.ts:425-429`; `bin.ts:218-226` adds
   `'fake'` under `DISPATCH_ENABLE_FAKES`. Phase A adds an implementation, not a
   registry. (`orchestrator/registry.ts` is the _run_ registry — unrelated.)
2. **Build/test/lint does not live in `verify.ts`.** The command gate is
   `MergeQueue.verify()` (mergeQueue.ts:1054), driven by
   `config.verifySteps`/`config.verifyCommand`, run as
   `['bash','-lc', step.command]` in the run's worktree (`runVerifyStep`,
   :1096). `orchestrator/verify.ts` is the _agent_ verification pass (exercise
   the running app, JSON checks output, `exercised: true` on pass). Both are
   verifiers in the spec's sense; Phase A extracts the command gate and leaves
   `VerificationRunner` as-is.
3. **`WorktreeManager` is the one non-injectable collaborator.** Constructed at
   orchestrator.ts:210 without a `ctx` override, unlike
   `jj`/`ledgerStore`/`findingStore`/`digestCache`. It has ~40 call sites across
   merge/branches/restack — Phase A abstracts only the dispatch-time lifecycle,
   not all 40.

## Global Constraints

- `export AGENT=1` at the start of every terminal session.
- Use `bun` only. Never `npm`, `pnpm`, or `npx`.
- Verification baseline after every task: `bun run format` and `bun run lint`
  from the repo root (run `bun run build` first on a fresh clone — type-aware
  lint needs built project references), plus `bun run tsc` and focused
  `bun test` in each changed package.
- Preserve trailing newlines. Comments concrete and behavior-focused,
  function-level over inline.
- Agent-only scratch files go under `.agents/ignore/`.
- **Zero behavior change is the acceptance bar for every task.** A task file
  without new fields, a dispatch without an executor name, a merge without a
  `deliver` field must all behave byte-for-byte as today.
- Follow the existing test idiom: real `Orchestrator` over a temp git repo
  (`packages/server/test/orchestrator/helpers.js`), swapping only the
  `Executor`/`CommandRunner` seams. No mock orchestrators.

---

## File Structure

**Created:**

- `packages/server/src/orchestrator/executors/command.ts` — `CommandExecutor`
- `packages/server/src/orchestrator/workspace.ts` — `WorkspaceProvider`,
  `WorktreeWorkspaceProvider`
- `packages/server/src/orchestrator/gateVerifier.ts` — `GateVerifier`,
  `StepGateVerifier` (extracted from mergeQueue)
- `packages/server/src/orchestrator/delivery.ts` — `DeliverAction`,
  `resolveDeliverAction`
- `packages/server/test/orchestrator/command-executor.test.ts`
- `packages/server/test/orchestrator/workspace.test.ts`
- `packages/server/test/orchestrator/delivery.test.ts`

**Modified:**

- `packages/core/src/types.ts` — job-spec fields + unions on `TaskMeta`;
  `extras` on `TaskDoc`
- `packages/core/src/taskfile.ts` — parse/serialize/validate new fields;
  preserve unknown frontmatter keys
- `packages/core/src/store.ts` — `CreateInput`/`UpdatePatch` passthrough
- `packages/core/test/taskfile.test.ts`, `packages/core/test/store.test.ts`
- `packages/mcp/src/tools.ts` — `taskMetaShape` additions (read surface)
- `packages/server/src/orchestrator/orchestrator.ts` — injectable worktrees,
  workspace provider at dispatch, delivery resolution
- `packages/server/src/orchestrator/mergeQueue.ts` — consume `GateVerifier`
- `packages/server/src/api.ts` — dispatch executor default from task meta
- `packages/server/src/bin.ts` / `index.ts` — register `'command'`
- `docs/superpowers/specs/2026-08-05-universal-job-runner-design.md` —
  corrections above

---

### Task 1: Job-spec fields on the task file

The schema is purely additive. Field defaults: `job: 'code'`,
`trigger: 'manual'`, `executor: null` (null means "registry default", so files
don't all say `claude`), `workspace: 'worktree'`, `verify: []` (empty means
"profile default"), `deliver: null` (null means today's review flow),
`scopes: null`. Serialization is omit-when-default, matching `risk`/`model`
(taskfile.ts:143-144).

**Files:** `packages/core/src/types.ts`, `packages/core/src/taskfile.ts`,
`packages/core/test/taskfile.test.ts`

- [ ] **Step 1:** Add to `types.ts`: `JobKind`
      (`'code' | 'agent' | 'command' | 'app'`) + `JOB_KINDS` const array;
      `WorkspaceKind` (`'worktree' | 'none'` — `dir:<path>` handled as a
      prefixed string, validated not enumerated) ; `JobScopes`
      (`{ folders?: string[]; network?: string[]; credentials?: string[] }`).
      Follow the `TaskRisk`/`TASK_RISKS` pattern (types.ts:13, :74).
- [ ] **Step 2:** Add optional fields to `TaskMeta` with doc comments:
      `job: JobKind`, `trigger: string`, `executor: string | null`,
      `workspace: string`, `verify: string[]`, `deliver: string | null`,
      `scopes: JobScopes | null`. All required-with-default in the parsed shape
      (like `risk`), so readers never null-check absent frontmatter.
- [ ] **Step 3:** Write failing tests in `taskfile.test.ts` mirroring the
      `writes / risk / model frontmatter` describe block (taskfile.test.ts:362):
      non-default round-trip for each field, omit-when-default, defaults on a
      minimal 6-key frontmatter, `TaskParseError` on bad enum (`job: banana`),
      bad type (`verify: 12`), bad `scopes` shape, and malformed `trigger`
      prefix (`cron` without expression).
- [ ] **Step 4:** Implement parse: validation blocks in the taskfile.ts:53-94
      range (`job` against `JOB_KINDS`; `trigger` is `manual` or
      `cron:`/`watch:`/`webhook:` with non-empty remainder; `workspace` is
      `worktree`/`none`/`dir:<non-empty>`; `verify` string-array via the
      existing loop at :83; `scopes` object of string arrays), defaults in the
      meta literal (:95-117).
- [ ] **Step 5:** Implement serialize: conditionally-spread entries in the
      :123-149 literal, omitted at default values, kebab-case not needed (all
      single words).
- [ ] **Step 6:** Verify: `bun run tsc` + `bun test taskfile` in
      `packages/core`; root `bun run format && bun run lint`.

### Task 2: Preserve unknown frontmatter keys

`parseTaskFile` currently drops any key it doesn't know and the next serialize
loses it (taskfile.ts builds fixed literals). Task files are git-synced across
Dispatch versions, so an old daemon editing a task authored by a newer one
silently strips the newer fields. The merge driver is already key-agnostic
(mergeTask.ts:81-107 iterates the union of keys); the parser is the only lossy
stage.

**Files:** `packages/core/src/types.ts`, `packages/core/src/taskfile.ts`,
`packages/core/test/taskfile.test.ts`

- [ ] **Step 1:** Failing tests: a frontmatter with `future-field: x`
      round-trips it verbatim; a known-but-invalid key still throws; extras
      never shadow known fields; `serializeTaskFile` emits extras after all
      known keys in first-seen order.
- [ ] **Step 2:** Add `extras?: Record<string, unknown>` to `TaskDoc`
      (types.ts:52) — on the doc, not `TaskMeta`, so meta consumers stay typed.
      Collect leftover `raw` keys at the end of `parseTaskFile`; spread them
      last in `serializeTaskFile`.
- [ ] **Step 3:** Check `TaskStore.update` (store.ts:236-253) and `create`
      (:138-157) carry `extras` through unchanged; add a store-level round-trip
      test.
- [ ] **Step 4:** Verify baseline as in Task 1, plus `bun test mergeTask` (merge
      driver already passes unknown keys — confirm no regression).

### Task 3: Store and MCP read surface for job fields

Write access from CLI/MCP is deliberately **not** in Phase A (no job type ships
that needs it); the read surface must not strip the fields.

**Files:** `packages/core/src/store.ts`, `packages/mcp/src/tools.ts`,
`packages/core/test/store.test.ts`

- [ ] **Step 1:** Add the seven fields to `CreateInput` (store.ts:41-56) and
      `UpdatePatch` (:58-92) as optional, and to the `create()` meta literal
      (:138-157) with the same defaults as the parser. The update path spreads
      (:249) so no change beyond the type.
- [ ] **Step 2:** Failing store test: `create({ job: 'command', ... })` persists
      and re-reads; `update` of `trigger` round-trips.
- [ ] **Step 3:** Add the fields to `taskMetaShape`
      (packages/mcp/src/tools.ts:107-115) so `task_get` structured output stops
      stripping them (the declared `outputSchema` governs even though
      `meta: doc.meta` is passed whole at :1107). Leave `taskSummaryShape` and
      `task_save` inputs untouched.
- [ ] **Step 4:** Verify: `bun run tsc` + focused tests in `packages/core` and
      `packages/mcp`; root format/lint.

### Task 4: CommandExecutor

Proves the `Executor` contract (orchestrator/types.ts:132) holds for a plain
process, and gives Phase B's command jobs their engine. Registered but reachable
only by explicit executor name — no UI or planner exposure.

**Files:** `packages/server/src/orchestrator/executors/command.ts`,
`packages/server/src/bin.ts`, `packages/server/src/index.ts`,
`packages/server/src/api.ts`,
`packages/server/test/orchestrator/command-executor.test.ts`

- [ ] **Step 1:** Failing tests (idiom: real Orchestrator over a temp repo, per
      `verify.test.ts`'s inline-executor style): a dispatched command run
      streams stdout lines as `NormalizedEntry {kind:'system'}` and exit 0 →
      `onFinish {state:'finished'}`; non-zero exit → `{state:'failed', error}`
      including the code; `interrupt()` kills the process and the run cancels;
      `requestStop()` finishes after the current process (no new work to decline
      — document that equivalence); `send()`/`approve()` are safe no-ops.
- [ ] **Step 2:** Implement `CommandExecutor implements Executor` with
      `Bun.spawn(['bash','-lc', opts.prompt], { cwd: opts.cwd })` — matching the
      merge queue's step invocation shape (mergeQueue.ts:1096). `opts.prompt`
      carries the command line; that is the existing contract's one text channel
      and Phase B's job schema feeds it. Stream stdout/stderr as entries; map
      exit code in `onFinish`; wire `interrupt` to `proc.kill()`.
- [ ] **Step 3:** Register `'command'` alongside `'claude'` in
      `index.ts:425-429`'s default branch and in `bin.ts:218-226`.
- [ ] **Step 4:** Dispatch default from task meta: in `api.ts:494-495`, replace
      the hardcoded `'claude'` fallback with `task.meta.executor ?? 'claude'`
      (the task is already loaded for the dispatch). Test: a task with
      `executor: command` dispatches to the command executor without the HTTP
      body naming one; body still wins when present.
- [ ] **Step 5:** Confirm auto-commit-on-finish (orchestrator.ts:2694) behaves
      for command runs (it is executor-agnostic — test a command that writes a
      file and assert the wip commit lands).
- [ ] **Step 6:** Verify: `bun run tsc` + new test file in `packages/server`;
      root format/lint.

### Task 5: WorkspaceProvider seam

Abstract only the dispatch-time lifecycle. The ~40 merge/branch/restack call
sites stay on `WorktreeManager` directly — they are the code profile's delivery
machinery, not workspace lifecycle.

**Files:** `packages/server/src/orchestrator/workspace.ts`,
`packages/server/src/orchestrator/orchestrator.ts`,
`packages/server/test/orchestrator/workspace.test.ts`

- [ ] **Step 1:** Make `WorktreeManager` injectable first:
      `ctx.worktrees ?? new WorktreeManager(ctx.rootDir)` at
      orchestrator.ts:210, matching the `jj`/`ledgerStore` pattern (:211-214).
      Pure refactor; existing tests must pass unchanged.
- [ ] **Step 2:** Define in `workspace.ts`:
      `WorkspaceHandle { path: string; branch?: string }` and
      `WorkspaceProvider { prepare(spec): WorkspaceHandle; remove(handle, runId?): void; resolveCommit(ref): string }`
      where `spec` is `{ runId, branch, baseBranch }`. Keep it narrow — it is
      exactly the dispatch-time surface (orchestrator.ts:363, :385, :452, :482),
      nothing more.
- [ ] **Step 3:** Implement `WorktreeWorkspaceProvider` wrapping the injected
      `WorktreeManager` + `worktreePath()` (paths.ts:103). Unit test against a
      temp repo: prepare creates worktree + branch, remove cleans both,
      prepare-after-crash reuses `add`'s prune/retry.
- [ ] **Step 4:** Route `dispatch()` (orchestrator.ts:363) and
      `dispatchAuxRun()` (:452, :482) through `this.workspaces` (a
      `ctx.workspaceProvider ??     new WorktreeWorkspaceProvider(...)` field).
      `requestChanges`/ `resumeRun` inherit paths verbatim and need no change.
- [ ] **Step 5:** Full `packages/server` orchestrator test suite green
      (`bun test orchestrator`), plus stacked-dispatch and aux-cleanup tests
      specifically (they exercise :363/:452/:482 hardest). Root format/lint.

### Task 6: GateVerifier extraction from the merge queue

The merge gate (config `verifySteps`/`verifyCommand`) becomes an injected
interface so Phase B can add checklist/agent-judge/browser gates without
touching queue mechanics.

**Files:** `packages/server/src/orchestrator/gateVerifier.ts`,
`packages/server/src/orchestrator/mergeQueue.ts`,
`packages/server/test/merge-queue.test.ts`

- [ ] **Step 1:** Define
      `GateVerifier { verify(input): Promise<VerifyStepResult[]> }` with
      `input = { worktreePath, onChunk(runId, chunk), timeoutSec }`.
      `VerifyStepResult` (mergeQueue.ts:74) moves to `gateVerifier.ts`;
      mergeQueue re-exports it so `events.ts`-style external imports keep
      resolving (same constraint as `FixLoopStop`, events.ts:2).
- [ ] **Step 2:** Move `MergeQueue.verify()`'s step-running body (:1054-1146,
      `runVerifyStep` :1096) into `StepGateVerifier`, which reads `loadConfig`
      fresh per call exactly as today (:1059-1064, empty ⇒ skip :1065). The
      queue keeps state transitions (`verifying`, `steps` on the entry,
      `merge-queue.log` chunk events) and delegates execution.
- [ ] **Step 3:** `MergeQueueContext` (mergeQueue.ts:135) gains `gateVerifier?`
      defaulting to `StepGateVerifier`. No wiring change in `index.ts`.
- [ ] **Step 4:** merge-queue.test.ts (3002 lines) green unchanged — that is the
      no-behavior-change proof. Add one new test injecting a stub `GateVerifier`
      to show a failing gate still produces the `failed` entry state + step
      results.
- [ ] **Step 5:** Verify baseline; root format/lint.

### Task 7: Delivery resolution

A dispatch table, not a rewrite: the entangled merge/PR/discard machinery
(orchestrator.review :1358, mergeRun :1534, markRunMergedViaPr :1477,
PrManager.openPr, MergeQueue.merge :1147) stays exactly where it is.

**Files:** `packages/server/src/orchestrator/delivery.ts`,
`packages/server/src/api.ts`,
`packages/server/test/orchestrator/delivery.test.ts`

- [ ] **Step 1:** Define `DeliverAction = 'review-merge' | 'review-pr'` (Phase B
      adds `checkpoint`/`files`/`artifact`/`notify`) and pure
      `resolveDeliverAction(meta: TaskMeta): DeliverAction` —
      `deliver:     null | 'merge'` → `'review-merge'`, `'pr'` → `'review-pr'`,
      any Phase B value → throw
      `OrchestratorClientError('deliver kind not yet     supported: ...')` so a
      hand-authored future task file fails loudly, not silently as a merge.
- [ ] **Step 2:** Unit tests for the resolution table including the loud
      failure.
- [ ] **Step 3:** Consume it at the one seam that chooses today: the review API
      route (api.ts:569-592) keeps honoring the explicit request body action (a
      human clicking Merge always wins), and the merge queue's auto path stays
      as-is. Wire `resolveDeliverAction` into `MergeQueue.merge()`'s local-vs-pr
      branch (:1147-1180) only as an assertion that the task's `deliver` field
      is a supported kind — behavior unchanged for null/merge/pr.
- [ ] **Step 4:** Verify baseline; root format/lint.

### Task 8: Spec sync and full baseline

- [ ] **Step 1:** Update the spec's Why bullet on verification and the
      Interfaces section to match the corrections at the top of this plan
      (registry exists; two verifier kinds; workspace seam scope).
- [ ] **Step 2:** Full baseline from root: `bun run build`, `bun run format`,
      `bun run lint`, `bun run tsc`, `bun run test`.
- [ ] **Step 3:** Confirm zero-behavior-change bar: `git grep` for the seven new
      field names in `apps/desktop` returns nothing (no UI exposure shipped),
      and a `.dispatch/tasks` file from before this change parses and serializes
      byte-identically (existing round-trip tests cover this; spot-check one
      real task file if the repo has one).

---

## Explicitly out of scope for Phase A

- Any new job type reaching users (Phase B).
- Trigger scheduling, file watchers, webhooks (Phase C).
- `workspace: none` / `dir:` implementations — the field parses and validates,
  but dispatch still always uses the worktree provider; honoring the field is
  Phase B.
- CLI/MCP/desktop write access to the new fields.
- Abstracting `VerificationRunner` (agent verification) or the fix loop — both
  already sit behind the run-terminal hook seam and need no change until new
  verifier kinds exist.
- Renaming anything user-visible (UI overhaul is its own workstream, per the
  spec).
