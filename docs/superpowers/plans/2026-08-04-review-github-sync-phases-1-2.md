# Review page ↔ GitHub sync — Phases 1 & 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every open GitHub PR appears in the Review queue with live status, and
opens into the same file-tree/inline-thread review surface a local run gets.

**Architecture:** A `ReviewTarget` (`run` or `pr`) replaces the run id that the
queue and diff fetching key on today. `listRepoPrs()` widens to carry GitHub
status from one batched `gh pr list --json` call, and a new
`GET /api/prs/:number/diff` builds a `DiffResult` from `gh pr diff` plus
`gh api …/pulls/N/files` — mirroring `worktree.diff()`'s existing two-call
shape, so no patch parsing is introduced. `ReviewView`'s bail-out on `run.prUrl`
is deleted last, once a PR target has both a diff and status to render.

**Tech Stack:** Bun, TypeScript, React 19, TanStack Query, Tailwind, `bun:test`,
`@testing-library/react`, the `gh` CLI behind the injectable `CommandRunner`
seam.

**Spec:** `docs/superpowers/specs/2026-08-04-review-github-sync-design.md`

## Global Constraints

- Set `export AGENT=1` at the start of every terminal session so Bun's test
  runner emits AI-friendly output.
- Use `bun` only. Never `npm`, `pnpm`, or `npx`.
- Every `gh` and `git` invocation must go through the injected `CommandRunner`
  seam (`packages/server/src/orchestrator/pr.ts:36`). No phase may introduce a
  call that bypasses it — it is the only reason these tests need no network.
- Never add dependency versions to package-level `package.json`. Dependencies
  use Bun's root `workspaces.catalog`.
- Preserve trailing newlines at the end of files.
- Per-PR `gh pr view` for queue rendering is forbidden (spec Decision 4). Queue
  status comes from one batched `gh pr list --json`.
- Comments: 1–2 lines, function-level over inline, concrete and
  behavior-focused. No incident narratives.
- Verification baseline after code changes, from the monorepo root:
  `bun run format` then `bun run lint`.
- **Known-red baseline:** `bun run lint` currently reports 15 errors and 163
  warnings that pre-date this work (in `ApprovalCard.tsx`, `doctor.ts`,
  `legacyWebkitPolyfills.js`, and others). Do not attempt to fix them. Confirm
  your change adds no _new_ entries.
- This plan covers Phases 1 and 2 only. Phases 3 (comment mirror) and 4 (agent
  review of a PR) get their own plans.
- **Refresh cadence (supersedes the spec).** The spec says "one query on a 60s
  interval". The existing `repoPrs` query
  (`apps/desktop/src/hooks/useDispatchProject.ts:954`) deliberately uses
  `staleTime: 60_000` + `refetchOnWindowFocus` with no interval, because no
  WebSocket event announces a GitHub PR change. Ruling: **poll only while the
  Review page is mounted.** Add `refetchInterval` scoped to that view — fresh
  rows exactly while triaging, and no `gh pr list` subprocess every 60s for the
  whole time the app is open. Do not add an unconditional interval, and do not
  leave the query with no interval at all.

## File Structure

**Server (`packages/server`)**

| File                           | Responsibility                                          | Change |
| ------------------------------ | ------------------------------------------------------- | ------ |
| `src/orchestrator/pr.ts`       | `RepoPr` shape, `listRepoPrs()`, new `getPrDiffByUrl()` | Modify |
| `src/api.ts`                   | Route `GET /api/prs/:number/diff`                       | Modify |
| `test/orchestrator/pr.test.ts` | `listRepoPrs` + `getPrDiffByUrl` against `StubRunner`   | Modify |
| `test/prs-api.test.ts`         | HTTP route for the diff endpoint                        | Modify |

**Client SDK (`packages/client`)**

| File         | Responsibility                            | Change |
| ------------ | ----------------------------------------- | ------ |
| `src/api.ts` | `RepoPr` mirror, `fetchRepoPrDiff` method | Modify |

**Desktop (`apps/desktop`)**

| File                                       | Responsibility                                            | Change     |
| ------------------------------------------ | --------------------------------------------------------- | ---------- |
| `src/lib/reviewTarget.ts`                  | `ReviewTarget` type + helpers                             | **Create** |
| `src/lib/reviewTarget.test.ts`             | Its unit tests                                            | **Create** |
| `src/components/runs/PrStatusPills.tsx`    | `StatusPill` + tone maps, shared by row and panel         | **Create** |
| `src/components/runs/PrReviewPanel.tsx`    | Imports pills instead of defining them                    | Modify     |
| `src/components/runs/ReviewQueue.tsx`      | `buildReviewQueue` over runs + repo PRs; rows show status | Modify     |
| `src/components/runs/ReviewQueue.test.tsx` | Queue build + dedup + row rendering                       | **Create** |
| `src/hooks/useRepoPrDetail.ts`             | Adds the PR diff query                                    | Modify     |
| `src/views/ReviewView.tsx`                 | Renders a `pr` target in the full frame                   | Modify     |

`PrStatusPills.tsx` is a new file rather than an export from `PrReviewPanel.tsx`
because the queue row must not import the whole panel to get a pill — that would
drag the composer and its state into the queue's module graph.

---

## Task 1: Widen RepoPr with GitHub status

One batched `gh pr list --json` already can return check rollups, review
decision, mergeability and fork provenance. Today `listRepoPrs()` asks for none
of it, so the queue has nothing to render.

**Files:**

- Modify: `packages/server/src/orchestrator/pr.ts:227-235` (the `RepoPr`
  interface), `:395-432` (`listRepoPrs`)
- Modify: `packages/client/src/api.ts:350-361` (the `RepoPr` mirror)
- Test: `packages/server/test/orchestrator/pr.test.ts`

**Interfaces:**

- Consumes: `PrCheckSummary` and `summarizeChecks` (`pr.ts:172`, `pr.ts:256`),
  both already handling the `statusCheckRollup` shape `pr list` returns.
  `authorLogin` (`pr.ts:701`) for `{login}` objects.
- Produces: the widened `RepoPr`, consumed by Tasks 3, 4 and 7.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/orchestrator/pr.test.ts`, inside the existing
`describe('PrManager.listRepoPrs', …)` block:

```ts
it('carries GitHub status through so the queue never needs a per-PR view call', async () => {
  const harness = makeHarness();
  const stub = new StubRunner();
  stub.listResult = {
    ok: true,
    stdout: JSON.stringify([
      {
        number: 9,
        title: 'Repo PR from someone else',
        url: 'https://github.com/example/repo/pull/9',
        headRefName: 'feature/someone-else',
        headRefOid: 'abc123',
        author: { login: 'teammate' },
        isDraft: true,
        updatedAt: '2026-07-22T00:00:00Z',
        isCrossRepository: true,
        headRepositoryOwner: { login: 'contributor' },
        reviewDecision: 'CHANGES_REQUESTED',
        mergeable: 'CONFLICTING',
        statusCheckRollup: [
          { conclusion: 'SUCCESS' },
          { conclusion: 'FAILURE' },
          { status: 'IN_PROGRESS' },
        ],
        additions: 12,
        deletions: 3,
        changedFiles: 2,
      },
    ]),
    stderr: '',
  };
  const pr = new PrManager(harness, true, stub.run);

  const prs = await pr.listRepoPrs();

  expect(prs[0]?.checks).toEqual({
    passed: 1,
    failed: 1,
    pending: 1,
    total: 3,
  });
  expect(prs[0]?.reviewDecision).toBe('CHANGES_REQUESTED');
  expect(prs[0]?.mergeable).toBe('CONFLICTING');
  expect(prs[0]?.isCrossRepository).toBe(true);
  expect(prs[0]?.headRepositoryOwner).toBe('contributor');
  expect(prs[0]?.headRefOid).toBe('abc123');
});

it('asks gh for the status fields in the same single list call', async () => {
  const harness = makeHarness();
  const stub = new StubRunner();
  const pr = new PrManager(harness, true, stub.run);

  await pr.listRepoPrs();

  const listCall = stub.calls.find((c) => c.cmd[2] === 'list');
  const fields = listCall?.cmd[listCall.cmd.indexOf('--json') + 1] ?? '';
  expect(fields).toContain('statusCheckRollup');
  expect(fields).toContain('isCrossRepository');
  expect(fields).toContain('headRefOid');
  // One call total — a per-PR `gh pr view` for status is what this avoids.
  expect(stub.calls.filter((c) => c.cmd[2] === 'view')).toHaveLength(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
export AGENT=1
cd packages/server && bun test test/orchestrator/pr.test.ts
```

Expected: FAIL — `prs[0].checks` is `undefined`, and the `--json` field list has
no `statusCheckRollup`.

- [ ] **Step 3: Widen the interface**

Replace `RepoPr` in `packages/server/src/orchestrator/pr.ts`:

```ts
// One open PR in the repo, from `gh pr list --json …` — the body of
// `GET /api/prs`. Carries the same status the review UI shows, so the queue
// renders every row from one batched call instead of a `gh pr view` per PR.
export interface RepoPr {
  number: number;
  title: string;
  url: string;
  headRefName: string;
  author: string;
  isDraft: boolean;
  updatedAt: string;
  /** Head commit SHA — the `commit_id` GitHub wants when posting a review comment. */
  headRefOid: string;
  /** True when the head branch lives in a fork; gates Phase 4's confirm. */
  isCrossRepository: boolean;
  /** Login owning the head repository, named in that confirm. */
  headRepositoryOwner: string;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  checks: PrCheckSummary;
  additions: number;
  deletions: number;
  changedFiles: number;
}
```

- [ ] **Step 4: Widen the gh call and the parsing**

In `listRepoPrs()`, replace the `--json` argument and the `raw.map(…)` body:

```ts
const result = await this.run(this.ctx.rootDir, [
  'gh',
  'pr',
  'list',
  '--json',
  'number,title,url,headRefName,headRefOid,author,isDraft,updatedAt,' +
    'isCrossRepository,headRepositoryOwner,reviewDecision,mergeable,' +
    'statusCheckRollup,additions,deletions,changedFiles',
  '--state',
  'open',
  '--limit',
  '50',
]);
```

```ts
return raw.map((item) => ({
  number: Number(item.number ?? 0),
  title: String(item.title ?? ''),
  url: String(item.url ?? ''),
  headRefName: String(item.headRefName ?? ''),
  author: authorLogin(item.author),
  isDraft: item.isDraft === true,
  updatedAt: String(item.updatedAt ?? ''),
  headRefOid: String(item.headRefOid ?? ''),
  isCrossRepository: item.isCrossRepository === true,
  headRepositoryOwner: authorLogin(item.headRepositoryOwner),
  reviewDecision: (item.reviewDecision as RepoPr['reviewDecision']) ?? null,
  mergeable: (item.mergeable as RepoPr['mergeable']) ?? null,
  checks: summarizeChecks(item.statusCheckRollup),
  additions: Number(item.additions ?? 0),
  deletions: Number(item.deletions ?? 0),
  changedFiles: Number(item.changedFiles ?? 0),
}));
```

`headRepositoryOwner` arrives as a `{login}` object, which is exactly what
`authorLogin` unwraps — reusing it keeps one place handling gh's author-object
shape.

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/server && bun test test/orchestrator/pr.test.ts
```

Expected: PASS, including the pre-existing `listRepoPrs` test — it asserts on
fields that all still exist.

- [ ] **Step 6: Mirror the shape into the client SDK**

Replace `RepoPr` in `packages/client/src/api.ts` with the identical field list,
keeping the existing "Mirrors RepoPr in packages/server/…" comment above it.
`PrCheckSummary` is already exported from this module; reuse it rather than
re-declaring the shape.

- [ ] **Step 7: Typecheck both packages**

```bash
cd packages/server && bun run tsc
cd ../client && bun run tsc
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/server/src/orchestrator/pr.ts packages/client/src/api.ts \
        packages/server/test/orchestrator/pr.test.ts
git commit -F - <<'COMMIT'
feat(server): carry GitHub PR status through listRepoPrs

The review queue had nothing to triage on: RepoPr carried a title, an
author and a timestamp, so telling a PR with failing checks from an
approved one meant opening each row.

gh pr list already returns the check rollup, review decision,
mergeability and fork provenance in the same call, so widening the
field list costs one flag rather than a gh pr view per row.
COMMIT
```

---

## Task 2: Extract the PR status pills into a shared module

The queue row and the review panel must render the same pill for the same state.
Today `StatusPill` and its tone maps are private to `PrReviewPanel.tsx`.

**Files:**

- Create: `apps/desktop/src/components/runs/PrStatusPills.tsx`
- Modify: `apps/desktop/src/components/runs/PrReviewPanel.tsx:27-62`, `:144-152`

**Interfaces:**

- Consumes: `PrStatus`, `PrConversationItem` from `@dispatch/client`.
- Produces: `StatusPill`, `STATE_TONE`, `REVIEW_VERDICT`, and `PrChecksPill` —
  consumed by Task 4's queue row and by `PrReviewPanel`.

- [ ] **Step 1: Create the shared module**

```tsx
import type {
  PrCheckSummary,
  PrConversationItem,
  PrStatus,
} from '@dispatch/client';
import { Check, Clock, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type PillTone = 'green' | 'amber' | 'red' | 'purple' | 'muted';

// One PR status fact (state, review decision, mergeability, checks) as a pill.
// Shared so the review queue row and the PR panel cannot drift apart.
export function StatusPill({
  icon,
  children,
  tone = 'muted',
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: PillTone;
}) {
  const toneClass = {
    green: 'border-state-review-edge bg-state-review-surface text-state-review',
    amber:
      'border-state-waiting-edge bg-state-waiting-surface text-state-waiting',
    red: 'border-destructive/30 bg-destructive/10 text-destructive',
    purple: 'border-primary/30 bg-primary/10 text-primary',
    muted: 'border-border bg-muted/60 text-muted-foreground',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        toneClass
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export const STATE_TONE: Record<PrStatus['state'], 'green' | 'purple' | 'red'> =
  {
    OPEN: 'green',
    MERGED: 'purple',
    CLOSED: 'red',
  };

export const REVIEW_VERDICT: Record<
  NonNullable<PrConversationItem['state']>,
  { label: string; tone: PillTone }
> = {
  APPROVED: { label: 'approved', tone: 'green' },
  CHANGES_REQUESTED: { label: 'requested changes', tone: 'amber' },
  COMMENTED: { label: 'commented', tone: 'muted' },
  DISMISSED: { label: 'dismissed', tone: 'muted' },
};

// A check rollup as one pill: red when anything failed, amber while any is
// still running, green only when every check has passed. Renders nothing for
// a PR with no checks at all, so a repo without CI shows no empty pill.
export function PrChecksPill({ checks }: { checks: PrCheckSummary }) {
  if (checks.total === 0) return null;
  const tone =
    checks.failed > 0 ? 'red' : checks.pending > 0 ? 'amber' : 'green';
  const icon =
    checks.failed > 0 ? (
      <X className="size-3" />
    ) : checks.pending > 0 ? (
      <Clock className="size-3" />
    ) : (
      <Check className="size-3" />
    );
  return (
    <StatusPill tone={tone} icon={icon}>
      {checks.passed}/{checks.total} checks
    </StatusPill>
  );
}
```

- [ ] **Step 2: Point PrReviewPanel at the shared module**

In `PrReviewPanel.tsx`: delete the local `StatusPill`, `STATE_TONE` and
`REVIEW_VERDICT` definitions, import them from `./PrStatusPills`, and replace
the inline checks-pill block in `PrStatusHeader` with
`<PrChecksPill checks={checks} />`. Drop any lucide imports that become unused.

- [ ] **Step 3: Verify the panel still renders**

```bash
cd apps/desktop && bun test src/components/runs/
```

Expected: PASS. This is a pure extraction — no behavior changes, so the existing
panel tests are the regression net.

- [ ] **Step 4: Typecheck**

```bash
cd apps/desktop && bun run tsc
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/runs/PrStatusPills.tsx \
        apps/desktop/src/components/runs/PrReviewPanel.tsx
git commit -F - <<'COMMIT'
refactor(desktop): share the PR status pills

The review queue is about to render the same state pills the PR panel
shows. Keeping the tone maps private to the panel would mean a second
copy, and two copies drift.

Extracted rather than exported from PrReviewPanel so a queue row does not
pull the review composer and its state into its module graph.
COMMIT
```

---

## Task 3: ReviewTarget and a queue built from runs and repo PRs

The queue maps over `RunMeta[]`, so a PR Dispatch never opened cannot appear at
all.

**Files:**

- Create: `apps/desktop/src/lib/reviewTarget.ts`,
  `apps/desktop/src/lib/reviewTarget.test.ts`
- Modify: `apps/desktop/src/components/runs/ReviewQueue.tsx:7-11`
  (`ReviewQueueItem`), `:136-146` (`buildReviewQueue`)
- Create: `apps/desktop/src/components/runs/ReviewQueue.test.tsx`

**Interfaces:**

- Consumes: `RunMeta`, `RepoPr` from `@dispatch/client`.
- Produces:
  - `type ReviewTarget = { kind: 'run'; runId: string } | { kind: 'pr'; number: number }`
  - `reviewTargetKey(target: ReviewTarget): string`
  - `ReviewQueueItem` gaining `target: ReviewTarget`, `title: string`,
    `pr?: RepoPr`
  - `buildReviewQueue(runs: RunMeta[], repoPrs: RepoPr[]): ReviewQueueItem[]`

  Task 4 renders these; Task 7 switches on `target.kind`.

- [ ] **Step 1: Write the failing test for the target helper**

Create `apps/desktop/src/lib/reviewTarget.test.ts`:

```ts
import { expect, test } from 'bun:test';

import { reviewTargetKey } from './reviewTarget';

test('a run target and a pr target never collide on the same key', () => {
  expect(reviewTargetKey({ kind: 'run', runId: '7' })).toBe('run:7');
  expect(reviewTargetKey({ kind: 'pr', number: 7 })).toBe('pr:7');
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
export AGENT=1
cd apps/desktop && bun test src/lib/reviewTarget.test.ts
```

Expected: FAIL — cannot resolve `./reviewTarget`.

- [ ] **Step 3: Create the target module**

```ts
/**
 * What a review is looking at: a local run's diff, or a GitHub pull request.
 *
 * The review stack keyed everything on a run id, so a PR dispatch never opened
 * had no diff, no comment store and no queue row. This is the key those three
 * share instead.
 */
export type ReviewTarget =
  | { kind: 'run'; runId: string }
  | { kind: 'pr'; number: number };

/** A stable string key for React lists and query keys. */
export function reviewTargetKey(target: ReviewTarget): string {
  return target.kind === 'run' ? `run:${target.runId}` : `pr:${target.number}`;
}
```

- [ ] **Step 4: Run it to verify it passes**

```bash
cd apps/desktop && bun test src/lib/reviewTarget.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing test for the widened queue**

Create `apps/desktop/src/components/runs/ReviewQueue.test.tsx`:

```tsx
import type { RepoPr, RunMeta } from '@dispatch/client';
import { expect, test } from 'bun:test';

import { buildReviewQueue } from './ReviewQueue';

function run(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Local work',
    executor: 'fake',
    state: 'finished',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    ...overrides,
  } as RunMeta;
}

function repoPr(overrides: Partial<RepoPr> = {}): RepoPr {
  return {
    number: 9,
    title: 'Someone else PR',
    url: 'https://github.com/example/repo/pull/9',
    headRefName: 'feature/x',
    author: 'teammate',
    isDraft: false,
    updatedAt: '2026-08-02T00:00:00Z',
    headRefOid: 'abc123',
    isCrossRepository: false,
    headRepositoryOwner: 'example',
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: { passed: 0, failed: 0, pending: 0, total: 0 },
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    ...overrides,
  };
}

test('a repo PR dispatch never opened still gets a queue row', () => {
  const queue = buildReviewQueue([], [repoPr()]);
  expect(queue).toHaveLength(1);
  expect(queue[0]?.target).toEqual({ kind: 'pr', number: 9 });
  expect(queue[0]?.title).toBe('Someone else PR');
});

test('a dispatch-opened PR appears once, as its run', () => {
  const url = 'https://github.com/example/repo/pull/9';
  const queue = buildReviewQueue(
    [run({ prUrl: url, taskTitle: 'Our work' })],
    [repoPr({ url })]
  );
  expect(queue).toHaveLength(1);
  // The run-backed item wins: it is the one that can reach the agent send-back.
  expect(queue[0]?.target).toEqual({ kind: 'run', runId: 'r-1' });
  expect(queue[0]?.title).toBe('Our work');
});

test('local runs awaiting review still appear alongside PRs', () => {
  const queue = buildReviewQueue([run()], [repoPr()]);
  expect(queue).toHaveLength(2);
  expect(queue.filter((i) => i.isPr)).toHaveLength(1);
});

test('newest first, so the queue reads like an inbox', () => {
  const queue = buildReviewQueue(
    [run({ updatedAt: '2026-08-01T00:00:00Z' })],
    [repoPr({ updatedAt: '2026-08-03T00:00:00Z' })]
  );
  expect(queue[0]?.isPr).toBe(true);
});
```

- [ ] **Step 6: Run it to verify it fails**

```bash
cd apps/desktop && bun test src/components/runs/ReviewQueue.test.tsx
```

Expected: FAIL — `buildReviewQueue` takes one argument and items have no
`target`.

- [ ] **Step 7: Widen the item and the builder**

In `ReviewQueue.tsx`, replace `ReviewQueueItem` and `buildReviewQueue`:

```ts
export interface ReviewQueueItem {
  /** What this row opens — a local run's diff, or a GitHub PR. */
  target: ReviewTarget;
  /** What the row shows: the task title for a run, the PR title otherwise. */
  title: string;
  /** True when this one is waiting on GitHub rather than on a local diff. */
  isPr: boolean;
  /** Sort key, newest first. */
  updatedAt: string;
  /** Present for a run-backed row — turns/cost meta and the send-back path. */
  run?: RunMeta;
  /** Present for any row with GitHub status to render. */
  pr?: RepoPr;
}

/**
 * Everything a human still has to look at: finished-but-unreviewed runs, plus
 * every open PR in the repo.
 *
 * A PR dispatch opened itself arrives twice — once via its run's `prUrl` and
 * once from `gh pr list`. The run-backed row wins, because it is the only one
 * that can reach the agent send-back. Sorted newest first so the queue reads
 * like an inbox rather than an archaeology dig.
 */
export function buildReviewQueue(
  runs: RunMeta[],
  repoPrs: RepoPr[] = []
): ReviewQueueItem[] {
  const prByUrl = new Map(repoPrs.map((pr) => [pr.url, pr]));
  const items: ReviewQueueItem[] = [];
  const claimedUrls = new Set<string>();

  for (const run of runs) {
    if (run.archivedAt !== undefined) continue;
    const isPr = run.prUrl !== undefined;
    if (!isPr && !(run.state === 'finished' && run.reviewedAt === undefined)) {
      continue;
    }
    if (run.prUrl !== undefined) claimedUrls.add(run.prUrl);
    items.push({
      target: { kind: 'run', runId: run.id },
      title: run.taskTitle,
      isPr,
      updatedAt: run.updatedAt,
      run,
      ...(run.prUrl !== undefined && prByUrl.has(run.prUrl)
        ? { pr: prByUrl.get(run.prUrl) }
        : {}),
    });
  }

  for (const pr of repoPrs) {
    if (claimedUrls.has(pr.url)) continue;
    items.push({
      target: { kind: 'pr', number: pr.number },
      title: pr.title,
      isPr: true,
      updatedAt: pr.updatedAt,
      pr,
    });
  }

  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
```

Add `import type { ReviewTarget } from '../../lib/reviewTarget';` and widen the
`RepoPr` import from `@dispatch/client`.

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd apps/desktop && bun test src/components/runs/ReviewQueue.test.tsx src/lib/reviewTarget.test.ts
```

Expected: PASS, all six tests.

- [ ] **Step 9: Commit**

```bash
git add apps/desktop/src/lib/reviewTarget.ts \
        apps/desktop/src/lib/reviewTarget.test.ts \
        apps/desktop/src/components/runs/ReviewQueue.tsx \
        apps/desktop/src/components/runs/ReviewQueue.test.tsx
git commit -F - <<'COMMIT'
feat(desktop): build the review queue from runs and repo PRs

The queue mapped over RunMeta, so a pull request dispatch never opened
could not appear in the one screen named after reviewing.

Introduces ReviewTarget as the key the queue, the diff fetch and the
comment store will all share, and dedupes a dispatch-opened PR to its
run-backed row, which is the only one that can reach the send-back.
COMMIT
```

---

## Task 4: Render status on the queue rows

**Files:**

- Modify: `apps/desktop/src/components/runs/ReviewQueue.tsx` (the `Row`
  component and both call sites of `item.run.id`)
- Modify: `apps/desktop/src/components/runs/ReviewQueue.test.tsx`

**Interfaces:**

- Consumes: `ReviewQueueItem` (Task 3), `StatusPill` / `PrChecksPill` (Task 2).
- Produces: `ReviewQueueProps` now taking `selected: ReviewTarget | null` and
  `onSelect: (target: ReviewTarget) => void`.

- [ ] **Step 1: Write the failing test**

Append to `ReviewQueue.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';

test('a PR row shows its check rollup and review decision', () => {
  render(
    <ReviewQueue
      items={buildReviewQueue(
        [],
        [
          repoPr({
            checks: { passed: 2, failed: 1, pending: 0, total: 3 },
            reviewDecision: 'CHANGES_REQUESTED',
          }),
        ]
      )}
      selected={null}
      onSelect={() => {}}
    />
  );
  expect(screen.getByText('2/3 checks')).toBeDefined();
  expect(screen.getByText('requested changes')).toBeDefined();
});

test('a row with no checks renders no empty checks pill', () => {
  render(
    <ReviewQueue
      items={buildReviewQueue([], [repoPr()])}
      selected={null}
      onSelect={() => {}}
    />
  );
  expect(screen.queryByText(/checks/)).toBeNull();
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd apps/desktop && bun test src/components/runs/ReviewQueue.test.tsx
```

Expected: FAIL — the props are named `selectedRunId`/`onSelect(runId)`, and rows
render no pills.

- [ ] **Step 3: Rewrite the props and the Row**

```tsx
interface ReviewQueueProps {
  items: ReviewQueueItem[];
  selected: ReviewTarget | null;
  onSelect: (target: ReviewTarget) => void;
  /** Compact mode renders as a narrow rail beside an open review. */
  compact?: boolean;
}
```

In both `.map(…)` bodies, key and select on the target:

```tsx
{
  local.map((item) => (
    <Row
      key={reviewTargetKey(item.target)}
      item={item}
      selected={
        selected !== null &&
        reviewTargetKey(selected) === reviewTargetKey(item.target)
      }
      onSelect={onSelect}
      compact={compact}
    />
  ));
}
```

And the `Row` body:

```tsx
function Row({
  item,
  selected,
  onSelect,
  compact,
}: {
  item: ReviewQueueItem;
  selected: boolean;
  onSelect: (target: ReviewTarget) => void;
  compact: boolean;
}) {
  const { run, pr, isPr } = item;
  const Icon = isPr ? GitPullRequest : GitPullRequestArrow;
  const verdict =
    pr?.reviewDecision === 'APPROVED'
      ? REVIEW_VERDICT.APPROVED
      : pr?.reviewDecision === 'CHANGES_REQUESTED'
        ? REVIEW_VERDICT.CHANGES_REQUESTED
        : undefined;
  return (
    <button
      type="button"
      onClick={() => onSelect(item.target)}
      className={cn(
        'flex w-full items-center gap-2 rounded-md border border-transparent px-2 py-1.5 text-left transition-colors duration-150',
        selected ? 'border-border bg-accent' : 'hover:bg-muted/60'
      )}
    >
      <Icon
        className={cn(
          'size-3.5 shrink-0',
          isPr ? 'text-state-landing' : 'text-state-review'
        )}
      />
      <span className="min-w-0 flex-1 truncate text-[13px]">{item.title}</span>
      {!compact && pr !== undefined && <PrChecksPill checks={pr.checks} />}
      {!compact && verdict !== undefined && (
        <StatusPill tone={verdict.tone}>{verdict.label}</StatusPill>
      )}
      {!compact && pr?.mergeable === 'CONFLICTING' && (
        <StatusPill tone="red">Conflicts</StatusPill>
      )}
      {!compact && run?.turns !== undefined && (
        <span className="dense-meta shrink-0">{run.turns} turns</span>
      )}
      {!compact && run?.costUsd !== undefined && (
        <span className="dense-meta shrink-0">${run.costUsd.toFixed(2)}</span>
      )}
    </button>
  );
}
```

Pills are suppressed in `compact` mode — the rail beside an open review is 190px
wide and has no room for them.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd apps/desktop && bun test src/components/runs/ReviewQueue.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Fix the call sites**

`ReviewQueue` is rendered in `apps/desktop/src/views/ReviewView.tsx` (twice) and
possibly `PullRequestsView.tsx`. Find them and update to the new props:

```bash
cd apps/desktop && grep -rn "<ReviewQueue" src/
```

At each, pass
`selected={selectedRunId === null ? null : { kind: 'run', runId: selectedRunId }}`
and
`onSelect={(target) => { if (target.kind === 'run') onSelectRun(target.runId); }}`.
Task 7 replaces this shim with real target-based navigation; leaving it narrow
here keeps this task's diff reviewable.

- [ ] **Step 6: Typecheck and run the desktop suite**

```bash
cd apps/desktop && bun run tsc && bun test src/
```

Expected: no type errors; tests pass.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src/components/runs/ReviewQueue.tsx \
        apps/desktop/src/components/runs/ReviewQueue.test.tsx \
        apps/desktop/src/views/ReviewView.tsx
git commit -F - <<'COMMIT'
feat(desktop): show PR status on the review queue rows

A queue row showed a title, turns and cost, so deciding which PR needed
attention meant opening every one of them.

Rows now carry the check rollup, review decision and conflict state from
the batched list call. Compact mode suppresses them: the rail beside an
open review is 190px and has no room.
COMMIT
```

---

## Task 5: Serve a PR's diff

**Files:**

- Modify: `packages/server/src/orchestrator/pr.ts` (add `getPrDiffByUrl`,
  `getPrDiff`)
- Modify: `packages/server/src/api.ts:2985` (the `prs` route block)
- Test: `packages/server/test/orchestrator/pr.test.ts`,
  `packages/server/test/prs-api.test.ts`

**Interfaces:**

- Consumes: `parsePrUrl` (`pr.ts:242`), `commandErrorText` (`pr.ts:46`),
  `DiffResult` from `./worktree.js`.
- Produces: `getPrDiffByUrl(url: string): Promise<DiffResult>` and the route
  `GET /api/prs/:number/diff`, consumed by Tasks 6 and 7.

- [ ] **Step 1: Write the failing test**

Add to `packages/server/test/orchestrator/pr.test.ts`:

```ts
describe('PrManager.getPrDiffByUrl', () => {
  const url = 'https://github.com/example/repo/pull/9';

  it('builds a DiffResult from the patch and the files list', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.diffResult = {
      ok: true,
      stdout: 'diff --git a/src/a.ts b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n',
      stderr: '',
    };
    stub.filesResult = {
      ok: true,
      stdout: JSON.stringify([
        { filename: 'src/a.ts', status: 'modified' },
        { filename: 'src/b.ts', status: 'added' },
        { filename: 'src/c.ts', status: 'removed' },
        { filename: 'src/d.ts', status: 'renamed' },
      ]),
      stderr: '',
    };
    const pr = new PrManager(harness, true, stub.run);

    const diff = await pr.getPrDiffByUrl(url);

    expect(diff.patch).toContain('+new');
    expect(diff.files).toEqual([
      { path: 'src/a.ts', status: 'M' },
      { path: 'src/b.ts', status: 'A' },
      { path: 'src/c.ts', status: 'D' },
      { path: 'src/d.ts', status: 'R' },
    ]);
  });

  it('conflicts when gh pr diff fails rather than returning an empty diff', async () => {
    const harness = makeHarness();
    const stub = new StubRunner();
    stub.diffResult = { ok: false, stdout: '', stderr: 'no such PR' };
    const pr = new PrManager(harness, true, stub.run);

    await expect(pr.getPrDiffByUrl(url)).rejects.toBeInstanceOf(
      OrchestratorConflictError
    );
  });
});
```

Add the two stub fields and their routes to `StubRunner`:

```ts
diffResult: CommandResult = { ok: true, stdout: '', stderr: '' };
filesResult: CommandResult = { ok: true, stdout: '[]', stderr: '' };
```

```ts
if (cmd[0] === 'gh' && cmd[1] === 'pr' && cmd[2] === 'diff') {
  return this.diffResult;
}
if (cmd[0] === 'gh' && cmd[1] === 'api' && cmd[2].endsWith('/files')) {
  return this.filesResult;
}
```

Place the `/files` branch **before** the existing generic `gh api` branch that
returns `apiResult`, or the line-comment stub will swallow it.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd packages/server && bun test test/orchestrator/pr.test.ts
```

Expected: FAIL — `getPrDiffByUrl` is not a function.

- [ ] **Step 3: Implement the diff fetch**

Add near `getPrDetailByUrl` in `pr.ts`:

```ts
// GitHub's per-file status strings, mapped to the single letters the diff UI
// already renders (matching `git diff --name-status` output).
const FILE_STATUS_LETTER: Record<string, string> = {
  added: 'A',
  modified: 'M',
  changed: 'M',
  unchanged: 'M',
  removed: 'D',
  renamed: 'R',
  copied: 'C',
};
```

```ts
  // GET /api/prs/:number/diff. A PR's diff in the same shape a run's worktree
  // diff produces, so the review UI renders both through one component.
  //
  // Two calls, mirroring worktree.diff(): `gh pr diff` for the raw patch, and
  // the REST files list for per-file status, which `pr diff` does not report.
  // Nothing here parses the patch — `DiffResult.patch` is stdout verbatim.
  async getPrDiffByUrl(url: string): Promise<DiffResult> {
    const location = parsePrUrl(url);
    if (location === null) {
      throw new OrchestratorConflictError(`unrecognizable PR url: ${url}`);
    }
    const patch = await this.run(this.ctx.rootDir, ['gh', 'pr', 'diff', url]);
    if (!patch.ok) {
      throw new OrchestratorConflictError(
        `gh pr diff failed: ${commandErrorText(patch)}`
      );
    }
    const listed = await this.run(this.ctx.rootDir, [
      'gh',
      'api',
      '--paginate',
      `repos/${location.owner}/${location.repo}/pulls/${location.number}/files`,
    ]);
    if (!listed.ok) {
      throw new OrchestratorConflictError(
        `gh api pulls/files failed: ${commandErrorText(listed)}`
      );
    }
    let raw: Array<Record<string, unknown>>;
    try {
      raw = JSON.parse(listed.stdout) as Array<Record<string, unknown>>;
    } catch {
      throw new OrchestratorConflictError(
        'gh api pulls/files returned invalid JSON'
      );
    }
    const files = raw.map((item) => ({
      path: String(item.filename ?? ''),
      status: FILE_STATUS_LETTER[String(item.status ?? '')] ?? 'M',
    }));
    return { patch: patch.stdout, files };
  }
```

Add `import type { DiffResult } from './worktree.js';` to `pr.ts`.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd packages/server && bun test test/orchestrator/pr.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add the route**

In `api.ts`, inside the `segments[0] === 'prs'` block, alongside the existing
`detail` branch:

```ts
// GET /api/prs/:number/diff — the PR's diff in DiffResult shape, so the
// review surface renders a PR through the same component a run uses.
if (segments.length === 3 && segments[2] === 'diff' && method === 'GET') {
  const pr = await resolveRepoPrByNumber(ctx, segments[1]);
  if (pr === null) return errorResponse(404, 'pull request not found');
  return jsonResponse(await ctx.prManager.getPrDiffByUrl(pr.url));
}
```

Resolving the number through `resolveRepoPrByNumber` (rather than accepting a
URL) is what keeps dispatchd from becoming an open proxy for diffing an
arbitrary PR URL — the same reasoning the `detail`/`review`/`comment` routes
already document.

- [ ] **Step 6: Write and run the route test**

Add to `packages/server/test/prs-api.test.ts`, following the file's existing
harness:

```ts
it('GET /api/prs/:number/diff returns the PR diff', async () => {
  // Follow this file's existing server + stub-runner setup.
  const res = await fetch(`${baseUrl}/api/prs/9/diff`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { patch: string; files: unknown[] };
  expect(body.patch).toContain('diff --git');
});

it('GET /api/prs/:number/diff 404s for a PR that is not open', async () => {
  const res = await fetch(`${baseUrl}/api/prs/404/diff`);
  expect(res.status).toBe(404);
});
```

```bash
cd packages/server && bun test test/prs-api.test.ts
```

Expected: PASS.

- [ ] **Step 7: Typecheck and commit**

```bash
cd packages/server && bun run tsc
git add packages/server/src/orchestrator/pr.ts packages/server/src/api.ts \
        packages/server/test/orchestrator/pr.test.ts \
        packages/server/test/prs-api.test.ts
git commit -F - <<'COMMIT'
feat(server): serve a pull request's diff as a DiffResult

Reviewing a PR in-app meant leaving for github.com, because the review
surface can only render a DiffResult and only a run's worktree produced
one.

Mirrors worktree.diff()'s two-call shape rather than parsing: gh pr diff
for the patch verbatim, and the REST files list for the per-file status
that pr diff does not report. The number resolves through the open-PR
list, so this is not a proxy for diffing an arbitrary URL.
COMMIT
```

---

## Task 6: Fetch a PR's diff from the client

**Files:**

- Modify: `packages/client/src/api.ts` (`ApiClient` interface + implementation)
- Modify: `apps/desktop/src/hooks/useRepoPrDetail.ts`

**Interfaces:**

- Consumes: `getPrDiffByUrl`'s route (Task 5), `DiffResult` (already exported
  from `@dispatch/client`).
- Produces: `fetchRepoPrDiff(number: number): Promise<DiffResult>` and, on
  `RepoPrDetailData`, `prDiff: DiffResult | undefined` +
  `prDiffLoading: boolean`. Task 7 consumes both.

- [ ] **Step 1: Add the client method**

In the `ApiClient` interface, beside `fetchRepoPrDetail`:

```ts
  /** The PR's diff in the same shape `fetchRunDiff` returns. */
  fetchRepoPrDiff(number: number): Promise<DiffResult>;
```

And in the implementation object, beside `fetchRepoPrDetail`:

```ts
    fetchRepoPrDiff: (number) => request(target, `/api/prs/${number}/diff`),
```

- [ ] **Step 2: Typecheck the client**

```bash
cd packages/client && bun run tsc
```

Expected: no errors.

- [ ] **Step 3: Build the client so the desktop app resolves it**

```bash
cd "$(git rev-parse --show-toplevel)" && bun run build
```

`@dispatch/*` resolve via `dist/`, so the desktop app will not see the new
method until the client is rebuilt.

- [ ] **Step 4: Add the diff query to the hook**

In `useRepoPrDetail.ts`, add alongside the existing detail query:

```ts
const { data: prDiff, isLoading: prDiffLoading } = useQuery({
  queryKey: ['dispatch-repo-pr-diff', client?.baseUrl, number],
  queryFn: () => {
    if (client === null || number === null) {
      throw new Error('no repo PR selected');
    }
    return client.fetchRepoPrDiff(number);
  },
  enabled: client !== null && number !== null,
  retry: false,
});
```

Add `prDiff` and `prDiffLoading` to `RepoPrDetailData` and to the returned
object. Its own query key (rather than folding into the detail query) keeps a
slow `gh pr diff` from delaying the status header, which is the faster of the
two calls.

- [ ] **Step 5: Typecheck the desktop app**

```bash
cd apps/desktop && bun run tsc
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/api.ts apps/desktop/src/hooks/useRepoPrDetail.ts
git commit -F - <<'COMMIT'
feat(client): fetch a pull request's diff

Gives the review surface the DiffResult it needs for a PR target.

The diff gets its own query key rather than folding into the detail
query, so a slow gh pr diff does not hold up the status header.
COMMIT
```

---

## Task 7: Render a PR in the full review surface

The payoff: delete the bail-out and let a PR target render the file tree, viewed
ticks and per-file diff.

**Files:**

- Modify: `apps/desktop/src/views/ReviewView.tsx:129-131` (the bail-out) and its
  render body

**Interfaces:**

- Consumes: `buildReviewQueue` (Task 3), `ReviewQueue`'s target props (Task 4),
  `useRepoPrDetail`'s `prDiff` (Task 6), `PierreReviewDiff` and `ReviewFileTree`
  unchanged.
- Produces: nothing downstream — this is the top of the stack for Phases 1–2.

- [ ] **Step 1: Note the verification approach — no new unit test here**

This task adds **no new unit test**, deliberately. Rendering `ReviewView`
requires a full `DispatchProjectData` fixture (client, queries, health, runs,
diff, merge queue), and a test built on that much mocking asserts the fixture
rather than the behavior. The logic this task depends on is already tested where
it lives: `buildReviewQueue` in Task 3 and the row rendering in Task 4.

Task 7's verification is therefore: the existing desktop suite must stay green
(Step 6), `tsc` must pass (Step 6), and the change must be confirmed in the
running app against a real PR (Step 7).

Two invariants this task must not break:

- `countAwaitingReview` stays exported from `ReviewView.tsx` — the nav badge
  imports it.
- The local-run review path (no `prUrl`) keeps rendering exactly as it does
  today. Only the PR branch is new.

If Step 6 or Step 7 fails, that is the signal — do not add a mock-heavy test to
manufacture green.

- [ ] **Step 2: Thread repo PRs into the queue**

`data.repoPrs` **already exists** on `DispatchProjectData`
(`apps/desktop/src/hooks/useDispatchProject.ts:195`, typed `RepoPr[] | null`,
populated by a query gated on `health?.pr === true`). Do not add a new query.

In `ReviewView`, widen the existing `queue` memo to pass it through:

```tsx
const queue = useMemo(
  () => buildReviewQueue(data.runs, data.repoPrs ?? []),
  [data.runs, data.repoPrs]
);
```

Leave that query's refresh config alone — see the Refresh Cadence note in Global
Constraints.

- [ ] **Step 3: Replace the bail-out with a PR branch**

Delete:

```tsx
if (run.prUrl !== undefined) {
  return <>{renderPr(run.id)}</>;
}
```

Select the diff and comments by target instead. Above the return:

```tsx
// A PR's diff comes from GitHub, a run's from its worktree — the frame below
// is identical either way, which is the whole point of the unified surface.
const isPrTarget = selectedTarget?.kind === 'pr';
const diff = isPrTarget ? repoPr.prDiff : data.diff;
const diffLoading = isPrTarget ? repoPr.prDiffLoading : false;
```

where
`repoPr = useRepoPrDetail(data.client, isPrTarget ? selectedTarget.number : null)`.

Then use `diff` in place of `data.diff` in the `paths` memo, the
`ReviewFileTree` `files` prop, and the `PierreReviewDiff` `patch` prop.

- [ ] **Step 4: Show PR status in the header**

For a PR target, render `<PrStatusHeader status={…} />`-equivalent pills from
the queue item's `pr` field beneath the title, using `PrChecksPill` and
`StatusPill` from Task 2. Keep the existing branch/turns/cost meta for run
targets.

- [ ] **Step 5: Keep the comment composer honest**

Phase 3 has not landed, so line comments on a PR target cannot sync to GitHub
yet. Pass `onAdd={undefined}` for PR targets, and render the right rail's
`PrReviewPanel` conversation instead of `ReviewCommentsPanel`. A composer that
silently wrote comments only to local disk would be a lie about where they went.

- [ ] **Step 6: Run the full desktop suite**

```bash
cd apps/desktop && bun test src/ && bun run tsc
```

Expected: PASS, no type errors.

- [ ] **Step 7: Verify in the real app**

```bash
cd "$(git rev-parse --show-toplevel)" && bun run build
```

Launch the desktop app against a repo with at least one open PR. Confirm: the PR
appears in the Review queue with check/decision pills; clicking it opens the
file tree with viewed ticks; selecting a file renders that file's diff; the
header shows the PR's status.

If no repo with an open PR is available, say so in the handoff rather than
claiming this step passed.

- [ ] **Step 8: Full baseline and commit**

```bash
cd "$(git rev-parse --show-toplevel)" && bun run format && bun run lint
```

Confirm lint reports no _new_ errors beyond the 15 known-red pre-existing ones.

```bash
git add apps/desktop/src/views/ReviewView.tsx \
        apps/desktop/src/views/ReviewView.test.tsx \
        apps/desktop/src/hooks/useDispatchProject.ts
git commit -F - <<'COMMIT'
feat(desktop): review a pull request on the review page

ReviewView bailed out to the PR panel the moment a run had a prUrl, so a
PR lost the file tree, the viewed ticks and the per-file diff — the whole
reason the full-page review exists.

A PR target now renders the same frame, taking its diff from GitHub
instead of a worktree. The line-comment composer stays off for PR targets
until the comment mirror lands: writing them to local disk only would
misrepresent where they went.
COMMIT
```

---

## Self-Review

Checked against
`docs/superpowers/specs/2026-08-04-review-github-sync-design.md`:

**Spec coverage (Phases 1–2).** Phase 1's widened `RepoPr` → Task 1; shared
pills → Task 2; unified `buildReviewQueue` with URL dedup → Task 3; row status →
Task 4; the 60s refresh → Task 7 Step 2. Phase 2's `GET /api/prs/:number/diff`
with the two-call shape and status-letter mapping → Task 5; the client fetch →
Task 6; deleting the bail-out → Task 7.

**Deliberately deferred, with reasons stated in-plan.** `ReviewTarget` lives in
`apps/desktop/src/lib/` rather than also re-keying `ReviewCommentStore`; the
storage split is Phase 3's, and Phase 1–2 has no consumer for it. The
line-comment composer is disabled for PR targets in Task 7 Step 5 rather than
writing to local disk.

**Type consistency.** `ReviewTarget` / `reviewTargetKey` (Task 3) are used
unchanged in Tasks 4 and 7. `PrChecksPill` / `StatusPill` (Task 2) are consumed
in Tasks 4 and 7. `getPrDiffByUrl` (Task 5) backs `fetchRepoPrDiff` (Task 6),
consumed in Task 7. `RepoPr`'s widened fields (Task 1) are what Tasks 3, 4 and 7
read.

**One risk carried forward.** Task 5's `FILE_STATUS_LETTER` mapping and the
`pulls/N/files` payload were not verified against a live GitHub response — the
repo had no open PRs when the spec was written. Task 5's tests use documented
field names. If the real payload differs, Task 5 Step 6 is where it surfaces.
