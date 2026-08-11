# Landing PR Table Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A unified "what lands and when" surface: a server-side landing feed
joining GitHub PRs with merge-queue entries, GitHub-state gating for PR-routed
queue entries, a shadcn table as a new Landing sidebar destination, and
on-demand auto-synced PR review worktrees.

**Architecture:** `PrManager` grows a cached, richer poll (full `RepoPr` set
incl. per-check detail) that broadcasts `landing.changed`. A new pure
`landing.ts` joins runs + queue + PRs into `LandingSnapshot` served at
`GET /api/landing`. The merge queue gains a `waiting-github` resting state
consulting the same cache. A new `PrWorktreeManager` reuses
`fetchPrHead`/`refs/dispatch/pr/N` for human worktrees at
`../<repoName>-worktrees/pr-<n>`. The desktop adds a `landing` view: pure
`lib/landingView.ts` + a table composed only from `src/ui/` shadcn primitives.

**Tech Stack:** Bun, TypeScript, tsdown, `bun test`, React 19, Tailwind v4 +
shadcn primitives in `apps/desktop/src/ui/`.

**Spec:** `docs/superpowers/specs/2026-08-10-landing-pr-table-design.md`

## Global Constraints

- `export AGENT=1` at the start of every terminal session.
- `bun` only; never npm/pnpm/npx.
- Fresh worktree: `bun install` then `bun run build` before tsc/tests
  (`@dispatch/*` resolve via `dist/`).
- Verification baseline per task: package-local `bun run tsc` + focused
  `bun test <name>`; root `bun run format && bun run lint` before commit.
- No lint-suppression comments — fix findings for real.
- UI: compose ONLY from existing `apps/desktop/src/ui/` shadcn primitives
  (Table, Badge, Tooltip, Popover, DropdownMenu, Sheet, …). No bespoke
  table/popover components.
- Server tests use the existing fake `CommandRunner` idiom (see
  `packages/server/test/` PR tests): inject a runner returning canned
  `{ok, stdout, stderr}` per argv match; never a real `gh`.
- Server test suite is timing-flaky under aggregate load: re-run the failing
  test file alone before blaming your change.
- Comments: 1–2 lines max, concrete, no incident narratives.

---

### Task 1: Preserve per-check detail in `summarizeChecks`

**Files:**

- Modify: `packages/server/src/orchestrator/pr.ts:209-216` (PrCheckSummary),
  `:419-451` (summarizeChecks)
- Test: `packages/server/test/pr-checks.test.ts` (create)

**Interfaces:**

- Produces:
  `export interface PrCheckRun { name: string; conclusion: string; url: string }`
  and `PrCheckSummary` gains `runs: PrCheckRun[]`. Both exported from `pr.ts`
  (PrCheckSummary is currently non-exported — export it). Additive: every
  existing consumer (`PrChecksPill`, `toRepoPr`) keeps working.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test } from 'bun:test';
import { summarizeChecks } from '../src/orchestrator/pr';

describe('summarizeChecks', () => {
  test('preserves per-check name, conclusion, and url', () => {
    const rollup = [
      {
        name: 'build',
        status: 'COMPLETED',
        conclusion: 'SUCCESS',
        detailsUrl: 'https://github.com/x/y/runs/1',
      },
      {
        name: 'test',
        status: 'IN_PROGRESS',
        conclusion: null,
        detailsUrl: 'https://github.com/x/y/runs/2',
      },
      {
        context: 'legacy-ci',
        state: 'FAILURE',
        targetUrl: 'https://ci.example/3',
      },
    ];
    const summary = summarizeChecks(rollup);
    expect(summary).toMatchObject({
      passed: 1,
      failed: 1,
      pending: 1,
      total: 3,
    });
    expect(summary.runs).toEqual([
      {
        name: 'build',
        conclusion: 'SUCCESS',
        url: 'https://github.com/x/y/runs/1',
      },
      {
        name: 'test',
        conclusion: 'PENDING',
        url: 'https://github.com/x/y/runs/2',
      },
      { name: 'legacy-ci', conclusion: 'FAILURE', url: 'https://ci.example/3' },
    ]);
  });

  test('non-array rollup yields empty runs', () => {
    expect(summarizeChecks(undefined).runs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/server && bun test pr-checks` Expected: FAIL —
`summarizeChecks` is not exported / `runs` undefined.

- [ ] **Step 3: Implement**

Export `summarizeChecks` and `PrCheckSummary`. Add `PrCheckRun`. In the loop,
alongside the counters (keep them exactly as-is), push one run per node.
CheckRun nodes carry `name`/`detailsUrl`; legacy StatusContext nodes carry
`context`/`targetUrl`. When neither name is present use `'check'`. The per-run
`conclusion` is the same normalized verdict the counters use, with
not-clearly-done mapped to `'PENDING'`:

```ts
export interface PrCheckRun {
  name: string;
  conclusion: string; // SUCCESS | FAILURE | PENDING | … (normalized verdict)
  url: string;
}

// inside summarizeChecks, per node, after computing `verdict`:
const node = raw as {
  name?: unknown;
  context?: unknown;
  detailsUrl?: unknown;
  targetUrl?: unknown;
};
summary.runs.push({
  name: ghString(node.name ?? node.context) || 'check',
  conclusion:
    verdict === ''
      ? 'PENDING'
      : summaryBucket === 'pending'
        ? 'PENDING'
        : verdict,
  url: ghString(node.detailsUrl ?? node.targetUrl),
});
```

(Refactor the existing if/else chain to compute a
`summaryBucket: 'passed'|'failed'|'pending'` once, increment the counter from
it, and reuse it for the run's conclusion — do not duplicate the verdict lists.)

`REPO_PR_FIELDS` needs no change — `statusCheckRollup` is already requested.

- [ ] **Step 4: Run to verify pass, then the package's existing PR tests**

Run: `bun test pr-checks && bun test pr` (in `packages/server`) Expected: PASS
(existing tests unaffected — `runs` is additive).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/orchestrator/pr.ts packages/server/test/pr-checks.test.ts
git commit -m "feat(server): preserve per-check detail in PR check summaries"
```

### Task 2: Cached PR state, richer poll, `landing.changed` event

**Files:**

- Modify: `packages/server/src/orchestrator/pr.ts` (PrManagerContext ~:180-207,
  pollOnce :699-721, startPolling :670), `packages/server/src/events.ts:18-103`
  (ServerEvent union), `packages/server/src/index.ts` (PrManager construction —
  pass the EventBus)
- Test: `packages/server/test/pr-poll-cache.test.ts` (create)

**Interfaces:**

- Consumes: `RepoPr`, `toRepoPr`, `REPO_PR_FIELDS`, `EventBus.broadcast`
  (`packages/server/src/events.ts:142`).
- Produces:
  - `PrManager.cachedPrs(): RepoPr[]` — last poll's open-PR set (empty before
    first poll).
  - `PrManager.cachedPrByUrl(url: string): RepoPr | undefined`.
  - New `ServerEvent` member: `| { type: 'landing.changed' }`.
  - `PrManagerContext` gains `events: EventBus`.

- [ ] **Step 1: Write the failing test**

Use the existing PrManager test idiom (fake CommandRunner keyed on argv).
Assert: (a) `pollOnce` issues ONE `gh pr list --json REPO_PR_FIELDS` call and
fills the cache; (b) a second poll with identical stdout broadcasts nothing; (c)
a changed `headRefOid` in the payload broadcasts `landing.changed`; (d) the
existing merged-run flip still works (a run whose `prUrl` matches a listed PR
with `state: 'MERGED'`… note: merged PRs leave `--state open` listings, so keep
the per-run `gh pr view --json state` merged-check exactly as today — the test
asserts both calls happen).

```ts
test('pollOnce caches the repo PR list and broadcasts on delta', async () => {
  const events: string[] = [];
  const bus = { broadcast: (e: { type: string }) => events.push(e.type) };
  // fake runner: argv containing 'pr','list' -> listPayload; 'pr','view' -> viewPayload
  ...
  await manager.pollOnce();
  expect(manager.cachedPrs()).toHaveLength(2);
  expect(events).toEqual(['landing.changed']);   // first fill is a delta
  await manager.pollOnce();
  expect(events).toEqual(['landing.changed']);   // no new event, same payload
  // mutate listPayload's headRefOid, poll again:
  expect(events).toEqual(['landing.changed', 'landing.changed']);
});
```

- [ ] **Step 2: Run to verify it fails** (`bun test pr-poll-cache`).

- [ ] **Step 3: Implement**

In `pollOnce`, before the per-run merged loop, when capability is present: call
the same gh invocation `listRepoPrs()` uses (extract its argv-building into a
private helper both share), map with `toRepoPr`, store on
`private cache: RepoPr[] = []`. Delta = `JSON.stringify` of a stable projection
(number, headRefOid, state, mergeable, reviewDecision, checks, isDraft,
updatedAt) differing from the previous poll's; on delta,
`this.ctx.events.broadcast({ type: 'landing.changed' })`. Add the two cache
accessors. Wire `events` through PrManagerContext in `index.ts` (the EventBus
already exists there for MergeQueueContext — same instance).

- [ ] **Step 4: Run** `bun test pr-poll-cache && bun test pr` — PASS;
      `bun run tsc`.

- [ ] **Step 5: Commit**
      `feat(server): cache PR state in the poll and broadcast landing.changed`

### Task 3: List recently merged PRs

**Files:**

- Modify: `packages/server/src/orchestrator/pr.ts` (beside `listRepoPrs`)
- Test: extend `packages/server/test/pr-poll-cache.test.ts` or the existing
  listRepoPrs test file

**Interfaces:**

- Produces: `PrManager.listMergedPrs(limit = 20): Promise<RepoPr[]>` — same
  409-on-no-capability behavior as `listRepoPrs`, argv
  `['gh','pr','list','--json',REPO_PR_FIELDS,'--state','merged','--limit',String(limit)]`,
  mapped through `toRepoPr`, sorted by `updatedAt` desc.

- [ ] **Step 1: Failing test** — fake runner returns two merged PRs out of
      order; assert sorted-desc result and the exact argv (state flag `merged`).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — mirror `listRepoPrs` body; only the state flag,
      limit, and sort differ. Share the parse loop via a private
      `parsePrList(stdout): RepoPr[]` helper used by both.
- [ ] **Step 4: Run** the test file + `bun run tsc`. PASS.
- [ ] **Step 5: Commit** `feat(server): list recently merged PRs`

### Task 4: The landing feed — pure join + gate computation

**Files:**

- Create: `packages/server/src/landing.ts`
- Test: `packages/server/test/landing.test.ts`

**Interfaces:**

- Consumes: `RepoPr` (pr.ts), `MergeQueueEntry`, `MergeQueueSnapshot`
  (mergeQueue.ts), `RunMeta` (orchestrator/types.ts).
- Produces (all exported from `landing.ts`; Task 5 serves them, Task 8+9 consume
  them via `@dispatch/client` re-export):

```ts
export type GateStatus =
  | 'ready'
  | 'waiting-checks'
  | 'waiting-review'
  | 'conflicts'
  | 'draft'
  | 'queue-position'
  | 'verifying'
  | 'merging'
  | 'blocked'
  | 'none';

export interface LandingGate {
  status: GateStatus;
  detail: string;
}

export interface LandingWorktree {
  path: string;
  syncState: 'synced' | 'behind' | 'dirty-hold';
  headOid: string;
}

export interface LandingRow {
  id: string; // 'pr-<n>' | 'run-<runId>' — queue rows keep their run id
  kind: 'pr' | 'run-pr' | 'queue-local';
  title: string;
  taskId?: string;
  runId?: string;
  pr?: RepoPr;
  queue?: { position: number; entry: MergeQueueEntry };
  gate: LandingGate;
  worktree?: LandingWorktree;
}

export interface LandedRow {
  id: string;
  title: string;
  via: 'pr' | 'local';
  prNumber?: number;
  mergeCommit?: string;
  finishedAt: string;
}

export interface LandingSnapshot {
  rows: LandingRow[];
  landed: LandedRow[];
  generatedAt: string;
}

export function computeGate(input: {
  pr?: RepoPr;
  queue?: { position: number; entry: MergeQueueEntry };
}): LandingGate;

export function buildLandingSnapshot(input: {
  runs: RunMeta[];
  queue: MergeQueueSnapshot;
  openPrs: RepoPr[];
  mergedPrs: RepoPr[];
  worktrees: Map<number, LandingWorktree>; // by PR number; Task 7 provides
  now: string; // injected — no Date.now inside
}): LandingSnapshot;
```

- [ ] **Step 1: Write failing tests for `computeGate`** — table-driven, one
      assertion per precedence rule, in this order (first match wins):

```ts
const cases: Array<[string, Parameters<typeof computeGate>[0], GateStatus]> = [
  ['queue merging', { queue: q('merging') }, 'merging'],
  ['queue verifying', { queue: q('verifying') }, 'verifying'],
  ['queue failed/blocked', { queue: q('blocked-environment') }, 'blocked'],
  ['pr conflicts', { pr: pr({ mergeable: 'CONFLICTING' }) }, 'conflicts'],
  ['pr draft', { pr: pr({ isDraft: true }) }, 'draft'],
  [
    'failing checks',
    { pr: pr({ checks: c({ failed: 1 }) }) },
    'waiting-checks',
  ],
  [
    'pending checks',
    { pr: pr({ checks: c({ pending: 2 }) }) },
    'waiting-checks',
  ],
  [
    'changes requested',
    { pr: pr({ reviewDecision: 'CHANGES_REQUESTED' }) },
    'waiting-review',
  ],
  [
    'review required',
    { pr: pr({ reviewDecision: 'REVIEW_REQUIRED' }) },
    'waiting-review',
  ],
  ['queued but green', { pr: pr({}), queue: q('queued', 3) }, 'queue-position'],
  ['green, not queued', { pr: pr({}) }, 'ready'],
  ['nothing known', {}, 'none'],
];
```

Also assert `detail` strings: `'waiting on CI · 2 running'`,
`'1 check failing'`, `'#3 in queue'`, `'changes requested'`. `waiting-blockers`
queue state maps to `queue-position` with detail `'waiting on blockers'`.

- [ ] **Step 2: Write failing tests for `buildLandingSnapshot`** — the join
      rules:
  - A run with `prUrl` matching an open PR ⇒ ONE row, `kind: 'run-pr'`, carrying
    both `pr` and (if enqueued) `queue`. Never two rows.
  - A queue entry whose run has no `prUrl` ⇒ `kind: 'queue-local'`, `pr`
    undefined.
  - An open PR with no matching run ⇒ `kind: 'pr'`.
  - Row order: group rank (needs-you < in-queue < waiting-github < open) then
    queue position, then `updatedAt` desc. (Group rank derives from
    `gate.status`: conflicts/waiting-review-changes-requested/failing-checks ⇒
    needs-you; queue-position/verifying/merging/blocked ⇒ in-queue;
    waiting-checks-pending/waiting-review-required/draft ⇒ waiting-github;
    ready/none ⇒ open. Export `groupForGate(gate, pr): LandingGroup` —
    `export type LandingGroup = 'needs-you'|'in-queue'|'waiting-github'|'open'`
    — the desktop reuses it in Task 8.)
  - `landed`: queue history entries (via `'local'`, or `'pr'` when the run meta
    has `prUrl`) unioned with `mergedPrs` (deduped by PR number when a history
    entry already covers it), newest `finishedAt`/`updatedAt` first.
  - Runs already reviewed (`reviewedAt` set) produce no `rows` entry.
- [ ] **Step 3: Run both to verify fail** (`bun test landing`).
- [ ] **Step 4: Implement `landing.ts`** — pure functions only, no I/O, no Date.
      Match the tests exactly.
- [ ] **Step 5: Run** `bun test landing` — PASS. `bun run tsc`.
- [ ] **Step 6: Commit** `feat(server): landing feed join and gate computation`

### Task 5: `GET /api/landing` + client binding

**Files:**

- Modify: `packages/server/src/api.ts` (route dispatch — add
  `segments[0] === 'landing'` beside the `'prs'` block at :4014),
  `packages/client/src/` (add `getLanding()` — read `packages/client/src/` first
  to copy the exact fetch-helper idiom used by the merge-queue/prs getters),
  re-export the landing types from the client's type barrel.
- Test: `packages/server/test/landing-api.test.ts`

**Interfaces:**

- Consumes: `buildLandingSnapshot` (Task 4), `PrManager.cachedPrs` (Task 2),
  `PrManager.listMergedPrs` (Task 3), `MergeQueue`'s snapshot accessor (read
  `mergeQueue.ts` for its public snapshot method — the one `GET` merge-queue
  route already serves), `ctx.orchestrator.list()`.
- Produces: `GET /api/landing` → `LandingSnapshot` (200 JSON);
  `client.getLanding(): Promise<LandingSnapshot>`.

- [ ] **Step 1: Failing API test** — boot the test server (existing
      `startServer` idiom with fake CommandRunner + `DISPATCH_ENABLE_FAKES`),
      seed one finished run with `prUrl` and one open repo PR via the fake gh
      payload, `await fetch('/api/landing')`, assert one `run-pr` row and
      `generatedAt` present. When the project lacks pr capability the route
      still returns 200 with `openPrs`-derived rows empty (queue-local rows
      survive) — assert that too; the feed must not 409 for local-only repos.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — the handler gathers inputs (`mergedPrs` via a
      try/catch that degrades to `[]` when capability is absent), calls
      `buildLandingSnapshot` with `now: new Date().toISOString()`, and serves
      it. `worktrees` passes an empty Map until Task 7 wires the real one.
- [ ] **Step 4: Run** the test + `bun run tsc` in server and client. PASS.
- [ ] **Step 5: Commit** `feat(server): serve GET /api/landing`

### Task 6: Merge-queue gating on GitHub state (`waiting-github`)

**Files:**

- Modify: `packages/server/src/orchestrator/mergeQueue.ts`
  (`MergeQueueEntryState` union :55-71, `MergeQueueContext` :135-145, the
  process pipeline around `merge()` :1147), `packages/server/src/index.ts`
  (inject the lookup + pump-on-event wiring)
- Test: `packages/server/test/merge-queue-github-gate.test.ts`

**Interfaces:**

- Consumes: `PrManager.cachedPrByUrl` (Task 2), `PrCheckSummary` (Task 1).
- Produces:
  - New entry state `'waiting-github'` (resting, like `waiting-blockers`: NOT in
    `MID_FLIGHT_STATES`, retried on every pump, hydrates unchanged).
  - `MergeQueueContext` gains `prState?: (url: string) => RepoPr | undefined`
    (optional: absent ⇒ today's behavior, merge blind — keeps every existing
    test green).
  - `export function githubHoldReason(pr: RepoPr | undefined): string | null` —
    null means clear to merge. Exported for direct unit tests.

- [ ] **Step 1: Failing unit tests for `githubHoldReason`:**

```ts
expect(githubHoldReason(undefined)).toBe('PR state unknown (poll pending)');
expect(githubHoldReason(pr({ isDraft: true }))).toBe('draft');
expect(githubHoldReason(pr({ mergeable: 'CONFLICTING' }))).toBe(
  'conflicts with base'
);
expect(githubHoldReason(pr({ checks: c({ failed: 2 }) }))).toBe(
  '2 checks failing'
);
expect(githubHoldReason(pr({ checks: c({ pending: 1 }) }))).toBe(
  'waiting on CI (1 running)'
);
expect(githubHoldReason(pr({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe(
  'changes requested'
);
expect(githubHoldReason(pr({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe(
  'review required'
);
expect(githubHoldReason(pr({}))).toBeNull(); // green: OPEN, checks 0-failed 0-pending
expect(githubHoldReason(pr({ checks: c({ total: 0 }) }))).toBeNull(); // no CI configured ⇒ clear
```

- [ ] **Step 2: Failing queue tests** — existing merge-queue test harness: a
      PR-routed entry whose `ctx.prState` returns a red PR settles in
      `'waiting-github'` with `reason` set and is NOT merged; flipping the fake
      to green and pumping again merges it (assert the `gh pr merge` argv
      fired). A PR-routed entry with `prState` **absent** merges immediately
      (back-compat). A local entry never consults `prState`.
- [ ] **Step 3: Run to verify fail.**
- [ ] **Step 4: Implement** — in the pipeline immediately before
      `this.merge(entry, meta)` and only when
      `meta.prUrl !== undefined && ctx.prState`, compute
      `githubHoldReason(ctx.prState(meta.prUrl))`; non-null ⇒
      `setEntryState(entry, 'waiting-github')`, set `reason`, `broadcast()`, and
      return the entry to rest (mirror the `waiting-blockers` control flow). In
      `index.ts`: `prState: (url) => prManager.cachedPrByUrl(url)`, and
      subscribe the queue's pump to `landing.changed` so a poll delta re-checks
      holds (read how `index.ts` already wires run-terminal → queue pump and
      copy that pattern). Also in `startPolling`, tighten the interval: when any
      queue entry is `waiting-github`, poll every 15s (implement as: `pollOnce`
      self-schedules the next tick with 15s vs 60s based on a
      `hasGithubHolds: () => boolean` callback added to `PrManagerContext`,
      wired from index.ts; replace the fixed `setInterval` with a self-rearming
      `setTimeout` chain — `stopPolling` clears it identically).
- [ ] **Step 5: Run** the new tests + the FULL existing merge-queue file
      (`bun test merge-queue`) — all green, isolation-re-run if flaky.
- [ ] **Step 6: Commit**
      `feat(server): gate PR-routed merge-queue entries on GitHub state`

### Task 7: PR review worktrees

**Files:**

- Create: `packages/server/src/orchestrator/prWorktree.ts`
- Modify: `packages/core/src/configTypes.ts` (config key `prWorktreeDir`,
  optional string, default undefined — follow the existing optional-field
  pattern; parse/serialize in `packages/core/src/config.ts`),
  `packages/server/src/api.ts` (routes), `packages/server/src/index.ts`
  (construct + hook into poll), `packages/server/src/orchestrator/pr.ts` (call
  sync/cleanup from `pollOnce`), Task 5's landing handler (real worktree Map
  instead of empty).
- Test: `packages/server/test/pr-worktree.test.ts`

**Interfaces:**

- Consumes: `PrManager.fetchPrHead(number, opts)` (pr.ts — the fork gate; read
  its exact signature and the `confirmFork` flow before wiring),
  `PR_HEAD_REF_PREFIX = 'refs/dispatch/pr/'`, `RepoPr`.
- Produces:

```ts
export interface PrWorktreeState {
  prNumber: number;
  path: string;
  headOid: string; // git rev-parse HEAD in the worktree
  dirty: boolean; // git status --porcelain non-empty
  behind: boolean; // headOid !== the PR's current headRefOid
}

export class PrWorktreeManager {
  constructor(ctx: {
    rootDir: string;
    run: CommandRunner;
    prWorktreeDir?: string;
  });
  worktreePathFor(prNumber: number): string;
  // Fetches refs/dispatch/pr/N (caller has already passed the fork gate),
  // then `git worktree add --detach <path> refs/dispatch/pr/N`.
  async create(prNumber: number): Promise<PrWorktreeState>;
  // No-op when absent. Clean+behind ⇒ fetch + `git -C <path> reset --hard
  // refs/dispatch/pr/N`. Dirty ⇒ untouched (dirty-hold).
  async sync(
    prNumber: number,
    headRefOid: string
  ): Promise<PrWorktreeState | null>;
  // Clean ⇒ `git worktree remove <path>` + delete the pr head ref.
  // Dirty ⇒ kept; returns the state so callers can flag it.
  async removeIfClean(prNumber: number): Promise<PrWorktreeState | null>;
  // Scans disk (git worktree list + per-path status) — stateless across boots.
  async list(): Promise<PrWorktreeState[]>;
}

export function toLandingWorktree(s: PrWorktreeState): LandingWorktree; // maps
// dirty ⇒ 'dirty-hold', behind ⇒ 'behind', else 'synced'
```

Default `worktreePathFor`:
`join(dirname(rootDir), basename(rootDir) + '-worktrees', 'pr-' + n)`,
overridden by `config.prWorktreeDir` when set.

- [ ] **Step 1: Failing tests** in a temp git repo with a bare "origin" (copy
      the temp-repo helper idiom from
      `packages/server/test/orchestrator/helpers.js`): create → path exists,
      detached at the fetched oid; sync after a new commit lands on the pr ref →
      fast-forwarded when clean; sync with a local edit → untouched,
      `dirty: true`; removeIfClean on clean → gone; on dirty → kept.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement `prWorktree.ts`** per the interface block. Every git
      call through the injected `CommandRunner`.
- [ ] **Step 4: Wire the routes** in `api.ts` under the existing
      `segments[0] === 'prs'` block: `POST /api/prs/:n/worktree` (resolve the PR
      via `listRepoPrs` like the sibling routes, run the fork gate via
      `fetchPrHead` with the same `confirmFork` body param the agent-review
      route uses — read `dispatchPrAgentReview` at api.ts:2293 and mirror it —
      then `create`); `DELETE /api/prs/:n/worktree` (`removeIfClean`; 409 with
      the dirty state when dirty). Both broadcast `landing.changed`. In
      `PrManager.pollOnce`, after the cache update: for each cached open PR with
      an existing worktree, `sync(n, headRefOid)`; for each worktree whose PR is
      now MERGED/CLOSED (or absent from the open list — confirm via
      `findRepoPr`), `removeIfClean`. Landing handler: replace the empty Map
      with `toLandingWorktree` over `list()`.
- [ ] **Step 5: API test** — POST creates (assert path in response), landing
      snapshot now carries `worktree` on that row, DELETE removes.
- [ ] **Step 6: Run** `bun test pr-worktree && bun test landing-api`;
      `bun run tsc`. PASS.
- [ ] **Step 7: Commit**
      `feat(server): on-demand auto-synced PR review worktrees`

### Task 8: Desktop pure view logic — `lib/landingView.ts`

**Files:**

- Create: `apps/desktop/src/lib/landingView.ts`
- Test: `apps/desktop/src/lib/landingView.test.ts` (colocate — match how the
  existing `lib/` tests sit, check `mergeQueueView`'s test location first)

**Interfaces:**

- Consumes: `LandingSnapshot`, `LandingRow`, `LandingGroup`, `groupForGate` (via
  `@dispatch/client` re-export from Task 5).
- Produces (zero React — the Pierre/happy-dom constraint makes this file the
  testable seam):

```ts
export interface LandingFilters {
  query: string; // matches title, author, branch, #number
  author: string | null; // facet chip
  gate: GateStatus | null; // facet chip
}
export const EMPTY_FILTERS: LandingFilters;

export type LandingViewRow =
  | { type: 'group'; id: LandingGroup; label: string; count: number }
  | { type: 'row'; row: LandingRow };

export function visibleLandingRows(
  snapshot: LandingSnapshot,
  filters: LandingFilters
): LandingViewRow[]; // filter → group by groupForGate →
// interleave headers, omit empty groups

export const GROUP_LABELS: Record<LandingGroup, string>;
// 'needs-you' → 'Needs you', 'in-queue' → 'In queue',
// 'waiting-github' → 'Waiting on GitHub', 'open' → 'Open'

export function gateChipLabel(row: LandingRow): string;
// 'Ready · next' (position 1) / '#3 · behind <taskTitle>' / 'Waiting on CI · 2 running'
// / 'Verifying · 2/4' (from queue.entry.steps) / 'Conflicts' / 'Draft' / gate.detail fallback

export function landingNavBadge(snapshot: LandingSnapshot): number;
// count of needs-you rows — the sidebar badge

export function readLandingFilters(raw: string | null): LandingFilters; // localStorage
export function serializeLandingFilters(f: LandingFilters): string;
export function relativeTime(iso: string, now: number): string;
// 'Nm ago' <60m, 'Nh ago' <24h, 'Nd ago' <7d, else locale date — reuse an
// existing helper if one exists in lib/ (grep for 'ago' first); otherwise add here
```

- [ ] **Step 1: Failing tests** — grouping order and omission of empty groups;
      facet filtering (author chip narrows, gate chip narrows, query matches
      `#123`); `gateChipLabel` for each gate status incl. the `Verifying · 2/4`
      steps-derived case; `landingNavBadge`; `readLandingFilters` returns
      `EMPTY_FILTERS` on garbage/null.
- [ ] **Step 2: Run to verify fail** (`bun test landingView` in `apps/desktop` —
      confirm the app's test script name in its package.json first).
- [ ] **Step 3: Implement.** Pure functions, no Date.now inside (take `now`
      params).
- [ ] **Step 4: Run — PASS.** `bun run tsc` in `apps/desktop`.
- [ ] **Step 5: Commit** `feat(desktop): landing view pure logic`

### Task 9: The Landing view — table, nav, data wiring

**Files:**

- Create: `apps/desktop/src/views/LandingTableView.tsx`,
  `apps/desktop/src/components/landing/LandingRow.tsx` (row + cells),
  `apps/desktop/src/components/landing/ChecksPopover.tsx`
- Modify: `apps/desktop/src/hooks/useDispatchProject.ts` (landing query; copy
  the `repoPrs` query at :982 — key `['landing']`, fetch `client.getLanding()`,
  `staleTime: 15_000`, invalidated by the WS `landing.changed` event: find where
  `merge-queue.changed` invalidates and register `landing.changed` the same
  way), `apps/desktop/src/App.tsx` (sidebar item "Landing" + badge via
  `landingNavBadge`, new `projectView === 'landing'` branch — copy the exact
  shape of the existing `'review'` nav entry at :758-763)
- Test: none for components (Pierre/happy-dom constraint); all logic already
  tested in Task 8. Visual verification is handed to Wyat at the end.

**Interfaces:**

- Consumes: everything from Task 8; shadcn primitives
  `Table, TableHeader, TableBody, TableRow, TableHead, TableCell`
  (`src/ui/table.tsx:79`), `Badge`, `Tooltip`, `Popover`, `DropdownMenu`,
  `Button`, `Input`, `Collapsible` (landed section); `StatusPill`,
  `PrChecksPill`, `STATE_TONE` (`components/runs/PrStatusPills.tsx`);
  `StepStrip`/`phaseSteps` (`lib/mergeQueueView.ts`) for in-queue rows;
  run-state tokens + mono density scale from `tokens.css`.
- Produces: `<LandingTableView />` registered under the `landing` view.

- [ ] **Step 1: Build the table skeleton** — header per the spec's column table
      (dot / Pull request / Lands / Checks / Changes / Review / Worktree), body
      mapping `visibleLandingRows()`: group rows as a full-width
      `<TableCell colSpan={7}>` with label + count `Badge` (tinted
      `bg-muted/20`); PR rows per the column spec. Progressive disclosure:
      Changes `hidden sm:table-cell`, Checks + Review `hidden md:table-cell`
      (Hydrogen's pattern). Status dot: inline `style` color from the gate
      status → CSS token map (use the run-state tokens; data-driven color via
      inline style, never dynamic class names) with the halo
      `boxShadow: 0 0 0 3px color-mix(in srgb, <color> 16%, transparent)` and a
      `Tooltip` carrying `gate.detail`.
- [ ] **Step 2: Cells** — title cell: title (click → the existing ReviewView
      target: reuse `buildReviewQueue`'s target semantics — `{kind:'run',runId}`
      for run-pr rows, `{kind:'pr',number}` for pure PRs — and call the same
      `onSelect` path ReviewQueue uses; read `ReviewQueue.tsx:29` and `App.tsx`
      to find the navigation callback to pass down); mono sub-line
      `#N · author · headRef → baseRef · relativeTime`. Author text and the gate
      chip are `<button>`s toggling `filters.author`/`filters.gate` (dismissible
      chips row above the table). Checks cell: `PrChecksPill` wrapped in a
      `Popover` listing `checks.runs` — each row name + conclusion dot +
      external link; distinguish `total === 0` as muted text `'no CI'` (spec:
      must not render as nothing). Worktree cell: no worktree ⇒ `Check out`
      `Button` (size sm, variant outline) → `POST /api/prs/:n/worktree` (add
      `client.createPrWorktree(n)` / `client.removePrWorktree(n)` bindings
      beside `getLanding`); exists ⇒ sync-state `Badge` (`synced`/`behind`/
      `dirty · hold`) + `DropdownMenu`: Open in editor (`code <path>` via the
      existing shell-open Tauri command — grep `src-tauri` for the open/reveal
      command other views use), Copy path, Reveal, Remove (calls DELETE; on 409
      show the dirty reason via the existing toast/sonner).
- [ ] **Step 3: Landed section** — `Collapsible` below the table: landed rows as
      compact mono lines `title · via PR #N|local · sha · relativeTime`.
- [ ] **Step 4: Wire nav + data** — sidebar "Landing" item with
      `landingNavBadge` count; `landing.changed` WS invalidation; filters
      persisted to `localStorage['dispatch:landing:filters']` via Task 8's
      read/serialize; filter-aware empty states ('Nothing in flight' vs 'No rows
      match' + Clear filters button). Stale degradation per spec: when the
      landing query errors, keep rendering the last data (react-query default)
      and show a muted `stale · <relativeTime(generatedAt)>` Badge next to the
      view title instead of blanking the table.
- [ ] **Step 5: Absorb the old inline landing** — in `ReviewView.tsx`'s empty
      state, remove the inlined `<LandingView />` (keep `<ReviewQueue />`) and
      add a link/button "Open Landing" that navigates to the new view. Leave
      `views/LandingView.tsx` itself untouched this task (deleted in Task 10 if
      nothing else imports it).
- [ ] **Step 6: Verify** — `bun run tsc` + full `bun test` in `apps/desktop`;
      `bun run format && bun run lint` at root. Launch check is manual (Wyat).
- [ ] **Step 7: Commit** `feat(desktop): Landing view with unified PR table`

### Task 10: Copy fixes, dead-code sweep, full baseline

**Files:**

- Modify: `apps/desktop/src/components/runs/RunReviewView.tsx:58,282` (stale
  "Pull requests tab" copy → "review it from the Landing view"; fix the
  `onOpenPr` prop doc), `views/LandingView.tsx` (delete if
  `grep -rn "LandingView" apps/desktop/src` shows no remaining importer after
  Task 9; otherwise leave and note why in the commit body)
- Test: existing suites

- [ ] **Step 1:** Fix the copy + prop doc; run the dead-code grep and act on it.
- [ ] **Step 2:** Full baseline from root:
      `bun run build && bun run format && bun run lint && bun run tsc && bun run test`
      (use `bun run test`, not bare `bun test` — root scripts glob apps/ too).
      Re-run any failing server file in isolation before investigating (known
      flakiness under load).
- [ ] **Step 3:** Commit
      `chore(desktop): retire inline landing and stale PR copy`, then hand the
      visual click-path checklist to Wyat: sidebar badge, group headers, gate
      chips, checks popover click-through, worktree create/open/remove,
      dirty-hold badge, landed section.

---

## Explicitly out of scope (per spec)

- ETA timestamps; auto price/perf merge scheduling.
- Persistent PR database.
- Auto-install/build inside PR worktrees.
- Worktrees for local queue entries.
- URL-param filter persistence (localStorage only).
