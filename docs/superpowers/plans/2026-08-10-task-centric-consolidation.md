# Task-Centric Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Runs and Review pages; the expanded TaskView becomes the one place work is inspected and reviewed, with a slim Inbox for "waiting on you" and a persistent live-agents rail.

**Architecture:** Desktop-only restructure (`apps/desktop`), no server/API changes. Phases: (1–3) bring the TaskView review path to parity with ReviewView's affordances, (4) add the Inbox view, (5) replace `MiniOverview` with a persistent live rail, (6) delete the two pages and redirect their nav targets. Spec: `docs/superpowers/specs/2026-08-10-task-centric-consolidation-design.md`.

**Tech Stack:** React + TypeScript, Bun test runner with `@testing-library/react` (happy-dom), oxlint/oxfmt, knip.

**Already satisfied, no task:** the spec's "All agents absorbs run history" —
`AllAgentsView` already lists every run this repo has had, terminal ones
included ("a history that hides its failures is not a history"). RunsView adds
nothing over it + TaskView, which is why Task 6 deletes it without a
replacement.

## Global Constraints

- `export AGENT=1` in every shell; run tests from `apps/desktop` with `bun test <file>`; typecheck with `bun run tsc` in `apps/desktop`.
- After each task: `bun run format && bun run lint` from the repo root must report 0 errors.
- No lint-suppression comments — fix findings for real (Wyat's standing rule).
- Pierre diff components don't render under happy-dom — never test through `PierreReviewDiff`; test pure logic and shallow component seams instead.
- Commit per task with a conventional-commit message; never `git add -A` (the daemon churns `.dispatch/` and other sessions' files sit in the tree) — always stage explicit paths.
- Pushing to `origin main` may be rejected by concurrent board-sync commits. If so: `git worktree add <scratch> origin/main --detach && git -C <scratch> cherry-pick <sha> && git -C <scratch> push origin HEAD:main`, then `git fetch && git reset --soft origin/main` in the main checkout.

---

### Task 1: Verdict-bar parity — "Ask an agent to review" + live indicator in the task view

`ReviewVerdictBar` already supports `onStartAiReview` and `reviewAgentLive`
(committed earlier as 09c08006). The TaskView path never passes either:
`TaskDiffTab` → `RunReviewView` → `ReviewCommentsPanel` → `ReviewVerdictBar`.
Thread them through.

**Files:**
- Modify: `apps/desktop/src/components/runs/RunReviewView.tsx` (props + passthrough)
- Modify: `apps/desktop/src/components/runs/ReviewCommentsPanel.tsx` (props + passthrough)
- Modify: `apps/desktop/src/components/tasks/TaskDiffTab.tsx` (supply from `data`)
- Test: `apps/desktop/src/components/runs/ReviewCommentsPanel.test.tsx` (new file if absent)

**Interfaces:**
- Consumes: `liveReviewAgentFor(runs, branch)` from `src/lib/runState.ts`; `data.client.startReview(taskId, {base, head, runId})`; `ReviewVerdictBar`'s existing `onStartAiReview?: () => Promise<void>` and `reviewAgentLive?: boolean`.
- Produces: `RunReviewView` optional props `onStartAiReview?: () => Promise<void>` and `reviewAgentLive?: boolean`; same pair on `ReviewCommentsPanel`.

- [ ] **Step 1: Write the failing test**

In `ReviewCommentsPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ReviewCommentsPanel } from './ReviewCommentsPanel';

const submit = () => Promise.resolve({ published: 0 });

// The panel is the TaskView path's only route to the verdict bar; if it
// drops these props the task view silently loses the AI-review affordance.
test('passes the live-review-agent state through to the verdict bar', () => {
  render(
    <ReviewCommentsPanel
      comments={[]}
      onResolve={() => Promise.resolve()}
      onReply={() => Promise.resolve()}
      onSubmit={submit}
      canPostToGitHub={false}
      onStartAiReview={() => Promise.resolve()}
      reviewAgentLive
    />
  );
  const button = screen.getByRole<HTMLButtonElement>('button', {
    name: /agent reviewing/i,
  });
  expect(button.disabled).toBe(true);
});
```

- [ ] **Step 2: Run it, expect failure**

Run: `cd apps/desktop && bun test src/components/runs/ReviewCommentsPanel.test.tsx`
Expected: FAIL — `reviewAgentLive` is not a known prop / button not found.

- [ ] **Step 3: Thread the props**

`ReviewCommentsPanel.tsx` — add to the props interface next to `onStartAiReview`:

```ts
  /** Mirrors ReviewVerdictBar's prop — see liveReviewAgentFor. */
  reviewAgentLive?: boolean;
```

destructure `reviewAgentLive` and pass it to `<ReviewVerdictBar … reviewAgentLive={reviewAgentLive}>`.

`RunReviewView.tsx` — add the same two optional props to `RunReviewViewProps`
(doc comment: "Omitted by pre-consolidation call sites; the ReviewView page
supplied its own until it was retired"), destructure, and pass both into the
`<ReviewCommentsPanel>` render (the block gated on `onAddComment !== undefined && …`).

`TaskDiffTab.tsx` — supply them where `<RunReviewView>` renders:

```tsx
          onStartAiReview={async () => {
            if (data.client === null) {
              throw new Error('The task daemon is not ready yet.');
            }
            await data.client.startReview(selectedRun.taskId, {
              base: selectedRun.baseBranch,
              head: selectedRun.branch,
              runId: selectedRun.id,
            });
          }}
          reviewAgentLive={
            liveReviewAgentFor(data.runs, selectedRun.branch) !== undefined
          }
```

with `import { isTerminalRunState, liveReviewAgentFor } from '../../lib/runState';`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd apps/desktop && bun test src/components/runs/ && bun run tsc`
Expected: all pass, 0 type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/runs/RunReviewView.tsx apps/desktop/src/components/runs/ReviewCommentsPanel.tsx apps/desktop/src/components/runs/ReviewCommentsPanel.test.tsx apps/desktop/src/components/tasks/TaskDiffTab.tsx
git commit -m "feat(desktop): AI-review affordance and live indicator in the task view"
```

---

### Task 2: Fix-findings selection in ReviewCasePanel

The working tree already carries most of this uncommitted (checkboxes per
judgment finding, a "Fix N selected" button, `onFixFindings?: (findings:
Finding[]) => Promise<void>` prop, selection/busy/error state). Finish it:
tests, plus the ReviewView handler that composes the request-changes text.
(ReviewView still exists until Task 6; wiring it there keeps the feature
usable immediately and exercises the same handler TaskDiffTab reuses in
Task 3.)

**Files:**
- Modify: `apps/desktop/src/components/runs/ReviewCasePanel.tsx` (already edited, uncommitted)
- Modify: `apps/desktop/src/views/ReviewView.tsx` (has the `Finding` import already; add handler + prop)
- Test: `apps/desktop/src/components/runs/ReviewCasePanel.test.tsx`

**Interfaces:**
- Consumes: `data.handleRequestChanges(runId: string, text: string): Promise<void>` from `useDispatchProject`; `Finding` from `@dispatch/client` (`id/title/detail/file/line`).
- Produces: `ReviewCasePanel` prop `onFixFindings?: (findings: Finding[]) => Promise<void>`; ReviewView helper `handleFixFindings(selected: Finding[])` composing: `Fix these review findings, then re-run the checks you'd normally run:\n\n- <title> (<file>:<line>)\n  <detail>` per finding.

- [ ] **Step 1: Write the failing tests**

Append to `ReviewCasePanel.test.tsx` (uses its existing `finding()`/`empty` helpers):

```tsx
test('checked findings go to onFixFindings; the button says how many', async () => {
  const fixed: string[][] = [];
  render(
    <ReviewCasePanel
      {...empty}
      findings={[finding(), finding({ id: 'f-000002', title: 'second' })]}
      onFixFindings={(picked) => {
        fixed.push(picked.map((f) => f.id));
        return Promise.resolve();
      }}
    />
  );
  fireEvent.click(
    screen.getByLabelText('Select finding: widens the PATCH surface')
  );
  const button = screen.getByRole('button', { name: /fix 1 selected/i });
  fireEvent.click(button);
  await waitFor(() => expect(fixed).toEqual([['f-000001']]));
});

test('without onFixFindings there are no checkboxes and no fix button', () => {
  render(<ReviewCasePanel {...empty} findings={[finding()]} />);
  expect(screen.queryByLabelText(/select finding/i)).toBeNull();
  expect(screen.queryByRole('button', { name: /fix.*selected/i })).toBeNull();
});
```

(Add `waitFor` to the `@testing-library/react` import.)

- [ ] **Step 2: Run, expect the first to fail only if the uncommitted work is incomplete**

Run: `cd apps/desktop && bun test src/components/runs/ReviewCasePanel.test.tsx`
If the uncommitted implementation is intact both may already pass — that is
fine; verify by reverting nothing and reading the implementation against the
test. If either fails, fix `ReviewCasePanel.tsx` (selection set, `toggleFinding`,
`fixSelected`, checkbox rendering in `FindingRow`) until green.

- [ ] **Step 3: Wire ReviewView**

In `ReviewView.tsx` after `handleStartAiReview` (the `Finding` type import is already in place):

```tsx
  // Resumes the run's own agent on its branch with the checked findings as
  // the change request — the same request-changes path a human review uses.
  const handleFixFindings = useCallback(
    async (selected: Finding[]) => {
      if (run === undefined) {
        throw new Error('The task daemon is not ready yet.');
      }
      const lines = selected.map((f) => {
        const loc =
          f.file === null
            ? ''
            : ` (${f.file}${f.line === null ? '' : `:${f.line}`})`;
        return `- ${f.title}${loc}\n  ${f.detail}`;
      });
      await data.handleRequestChanges(
        run.id,
        `Fix these review findings, then re-run the checks you'd normally run:\n\n${lines.join('\n')}`
      );
    },
    [data, run]
  );

  const canFixFindings =
    run !== undefined &&
    isTerminalRunState(run.state) &&
    run.reviewedAt === undefined;
```

and on the `<ReviewCasePanel>` render add
`onFixFindings={canFixFindings ? handleFixFindings : undefined}`.

- [ ] **Step 4: Full check**

Run: `cd apps/desktop && bun test src/components/runs/ src/lib/runState.test.ts && bun run tsc`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/components/runs/ReviewCasePanel.tsx apps/desktop/src/components/runs/ReviewCasePanel.test.tsx apps/desktop/src/views/ReviewView.tsx
git commit -m "feat(desktop): select review findings and hand them to the agent to fix"
```

---

### Task 3: Rehome the case panel into the task view's review surface

`ReviewCasePanel` (evidence, mutations, findings + the new fix action,
escalated decisions) renders only on ReviewView today. Give it a home that
survives: an optional section in `RunReviewView`'s right column, above the
comments panel, fed by `TaskDiffTab`.

**Files:**
- Modify: `apps/desktop/src/components/runs/RunReviewView.tsx`
- Modify: `apps/desktop/src/components/tasks/TaskDiffTab.tsx`
- Test: extend `apps/desktop/src/components/runs/RunReviewView.test.tsx`

**Interfaces:**
- Consumes: `useTaskFindings(client, taskId)` from `src/hooks/useOrchestration.ts` (returns `{ findings, error }`); `data.runDetail.evidence` / `data.runDetail.mutations`; `ReviewCasePanel` props from Tasks 1–2.
- Produces: `RunReviewView` optional prop `casePanel?: { evidence: CommandEvidence[]; mutations: MutationEvidence[]; findings: Finding[]; decisions: LedgerEntry[]; onFixFindings?: (findings: Finding[]) => Promise<void> }` — one object, absent means the section is hidden (older call sites keep compiling).

- [ ] **Step 1: Failing test** — in `RunReviewView.test.tsx`, reusing its existing meta/diff fixtures (call the fixture-built props `baseProps` here):

```tsx
test('a provided case panel renders its findings; absent, no case section', () => {
  const f: Finding = {
    id: 'f-000001', taskId: 't-1', runId: null, severity: 'critical',
    verdict: 'open', title: 'widens the PATCH surface', detail: 'anyone can set status',
    file: 'api.ts', line: 88, ruling: null, round: 0,
    createdAt: '2026-08-10T00:00:00.000Z', updatedAt: '2026-08-10T00:00:00.000Z',
    raisedBy: '',
  };
  render(
    <RunReviewView
      {...baseProps}
      casePanel={{ evidence: [], mutations: [], findings: [f], decisions: [] }}
    />
  );
  expect(screen.getByText('widens the PATCH surface')).toBeDefined();

  render(<RunReviewView {...baseProps} />);
  expect(screen.queryAllByText('widens the PATCH surface')).toHaveLength(1);
});
```
- [ ] **Step 2: Run, expect FAIL** (`casePanel` unknown prop).
- [ ] **Step 3: Implement** — in `RunReviewView`, when `casePanel !== undefined`, render inside the right column (wrap the existing `ReviewCommentsPanel` block's parent so both stack):

```tsx
          {casePanel !== undefined && (
            <ReviewCasePanel
              evidence={casePanel.evidence}
              mutations={casePanel.mutations}
              findings={casePanel.findings}
              decisions={casePanel.decisions}
              onFixFindings={casePanel.onFixFindings}
              onStartAiReview={onStartAiReview}
              reviewAgentLive={reviewAgentLive}
            />
          )}
```

In `TaskDiffTab`, fetch findings and build the object (evidence/mutations from
`data.runDetail`, decisions `[]` for now — the ledger-entry filter ReviewView
uses depends on epic plumbing TaskDiffTab doesn't have; note that in a comment),
`onFixFindings` composed exactly as Task 2's ReviewView handler but calling
`data.handleRequestChanges(selectedRun.id, …)`, gated on
`isTerminalRunState(selectedRun.state) && selectedRun.reviewedAt === undefined`.
- [ ] **Step 4: Run tests + tsc** — `bun test src/components/runs/ && bun run tsc`, all green.
- [ ] **Step 5: Commit** — `git add` the three files, message `feat(desktop): case panel (evidence, findings, fix action) in the task view review`.

---

### Task 4: The Inbox view

A slim, list-only page of what's waiting on a human. Reuses
`buildReviewQueue(runs, repoPrs)` (which already folds repo PRs in) for the
review rows, plus live runs whose feed state is `waiting` (approvals and
questions).

**Files:**
- Create: `apps/desktop/src/lib/inboxQueue.ts` + `apps/desktop/src/lib/inboxQueue.test.ts`
- Create: `apps/desktop/src/views/InboxView.tsx`
- Modify: `apps/desktop/src/lib/appNav.ts` (add `'inbox'` to `ProjectView`)
- Modify: `apps/desktop/src/components/shell/Sidebar.tsx` (nav item, `Inbox` lucide icon, group `Work`)
- Modify: `apps/desktop/src/App.tsx` (route case rendering `InboxView`)

**Interfaces:**
- Consumes: `buildReviewQueue` from `src/components/runs/ReviewQueue.tsx`; `deriveFeedState` from `src/lib/feedState.ts`; nav callbacks `openTaskView(taskId, tab, runId?)` already in `App.tsx`.
- Produces: `buildInbox(runs: RunMeta[], repoPrs: RepoPr[]): { review: ReviewQueueEntry[]; waiting: RunMeta[] }` in `inboxQueue.ts`; `InboxView({ data, onOpenTask, onOpenPr })`.

- [ ] **Step 1: Failing tests for `buildInbox`** — a finished un-reviewed run lands in `review`; a run whose `deriveFeedState` is `waiting` lands in `waiting`; a reviewed run appears in neither; entries preserve `buildReviewQueue`'s order. Copy the `run()` fixture pattern from `src/components/runs/reviewQueue.test.ts`.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `buildInbox`** — thin composition, no re-derivation:

```ts
export function buildInbox(
  runs: RunMeta[],
  repoPrs: RepoPr[]
): { review: ReviewQueueEntry[]; waiting: RunMeta[] } {
  return {
    review: buildReviewQueue(runs, repoPrs),
    waiting: runs.filter((r) => deriveFeedState(r) === 'waiting'),
  };
}
```

(Adjust `deriveFeedState`'s second argument if its signature requires the
queue-phase map — pass `undefined` and add a test pinning that a plain
waiting run still classifies.)
- [ ] **Step 4: `InboxView`** — sections *Needs review* and *Waiting on you*, each a list of rows (task title, state pill via `StateDot`, relative time via `formatRelativeTimeFromIso`); review rows call `onOpenTask(taskId, 'diff', runId)` (PR entries call `onOpenPr(number)`), waiting rows `onOpenTask(taskId, 'chat', runId)`. Empty state: "Nothing waiting on you." Follow `AllAgentsView`'s table/row idiom, including `DaemonUnavailable` gating.
- [ ] **Step 5: Nav** — add `'inbox'` to the `ProjectView` union, Sidebar item `{ id: 'inbox', label: 'Inbox', icon: Inbox, group: 'Work' }`, App.tsx case beside the ReviewView case (ReviewView stays until Task 6). For PR rows, reuse the existing PR-review navigation ReviewView uses (`setSelectedPrNumber` equivalent lives in App-level nav after Task 6; until then route PR rows to the Review page's PR mode).
- [ ] **Step 6: Verify** — `bun test src/lib/inboxQueue.test.ts && bun run tsc`; hand-check: Inbox shows the same runs the Review page queue shows.
- [ ] **Step 7: Commit** — message `feat(desktop): inbox view — everything waiting on a human, in one list`.

---

### Task 5: Persistent live rail

Replace `MiniOverview` (rail that appears only when something needs a person)
with `LiveRail`: attention strip + one row per live agent, always visible.

**Files:**
- Create: `apps/desktop/src/components/shell/LiveRail.tsx` + `LiveRail.test.tsx`
- Create: `apps/desktop/src/lib/liveRail.ts` + `liveRail.test.ts` (pure derivation)
- Modify: `apps/desktop/src/App.tsx` (swap `MiniOverview` render at its single call site)
- Delete: `apps/desktop/src/components/shell/MiniOverview.tsx` (knip will demand it once unreferenced)

**Interfaces:**
- Consumes: `TERMINAL` check via `isTerminalRunState`; run kinds (`run.kind ?? 'execute'`); `buildInbox` from Task 4 for the attention count; nav callbacks `onOpenTask`, `onOpenInbox`.
- Produces: `buildLiveRail(runs: RunMeta[], repoPrs: RepoPr[]): { attentionCount: number; live: Array<{ run: RunMeta; kindLabel: 'agent' | 'review' | 'verify' }> }`.

- [ ] **Step 1: Failing tests for `buildLiveRail`** — a running execute run appears labeled `agent`; a running review run appears labeled `review`; terminal runs are excluded from `live`; `attentionCount` equals `buildInbox().review.length + buildInbox().waiting.length`.
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Implement** `buildLiveRail` on top of `buildInbox`; then `LiveRail`: attention strip only when `attentionCount > 0` (`<button>` "N waiting on you →" → `onOpenInbox()`); body rows `title / StateDot state / elapsed` clicking `onOpenTask(run.taskId, 'chat', run.id)`; idle body `<p>No agents running.</p>`. Component test: renders the idle copy with no runs; renders a row per live run.
- [ ] **Step 4: Swap in App.tsx** — replace the `<MiniOverview …>` element (single call site, `App.tsx` ~line 989) with `<LiveRail …>`; delete `MiniOverview.tsx`.
- [ ] **Step 5: Verify** — `bun test src/lib/liveRail.test.ts src/components/shell/ && bun run tsc`; `bun run build && bun run lint:deadcode` from root (MiniOverview deletion must leave knip clean).
- [ ] **Step 6: Commit** — `feat(desktop): persistent live-agents rail with attention strip`.

---

### Task 6: Delete RunsView and ReviewView; redirect their nav

**Files:**
- Delete: `apps/desktop/src/views/RunsView.tsx`, `apps/desktop/src/views/ReviewView.tsx`
- Modify: `apps/desktop/src/App.tsx` (remove imports + route cases; move ReviewView's PR-review composition target), `apps/desktop/src/lib/appNav.ts` (redirect), `apps/desktop/src/components/shell/Sidebar.tsx` (drop the two items)
- Test: extend `apps/desktop/src/lib/appNav.test.ts` (create if absent)

**Interfaces:**
- Consumes: everything Tasks 1–5 produced.
- Produces: `appNav` treats incoming `'runs'`/`'review'` view actions as `'inbox'` (keep the union members, map them in the reducer — external deep links and stored nav state must not crash).

- [ ] **Step 1: Failing nav test** — in `appNav.test.ts` (match the file's existing reducer-call idiom; the shapes below follow `NavAction`'s `select-view` variant — adjust the action `type` string to whatever the reducer actually names it after reading `appNav.ts`):

```ts
test("the retired 'runs' and 'review' views normalize to 'inbox'", () => {
  for (const view of ['runs', 'review'] as const) {
    const next = navReduce(initialNavState, { type: 'select-view', view });
    expect(next.view).toBe('inbox');
  }
});
```
- [ ] **Step 2: Run, FAIL.**
- [ ] **Step 3: Redirect in the reducer** — in `appNav.ts`, where actions with `view === 'runs' || view === 'review'` are handled (~line 200), normalize to `'inbox'` with a comment naming this plan. Keep the union members with a `/** retired — normalized to 'inbox' */` doc.
- [ ] **Step 4: Delete the pages** — remove both files, their `App.tsx` imports/render cases, and the two Sidebar entries. ReviewView's repo-PR mode: move the `selectedPrNumber` state + PR composition (`PrReviewPanel` etc.) into the surface the Inbox's PR rows open — a full-window `PrReviewView` extracted from ReviewView's PR branch if the diff shows it is self-contained, else keep the composition file but route it only from Inbox. Whichever, `handleAgentPrReview`/`startPrAgentReview` must survive with it.
- [ ] **Step 5: Sweep the corpses** — `grep -rn "RunsView\|ReviewView" apps/desktop/src` must return only `RunReviewView` matches; `bun run build && bun run lint:deadcode` clean (delete now-unreferenced helpers it names, e.g. queue components only ReviewView used — but NOT `buildReviewQueue`, which Inbox consumes).
- [ ] **Step 6: Full verify** — from `apps/desktop`: `bun test && bun run tsc`; from root: `bun run format && bun run lint && bun run lint:deadcode`. Hand-check with Wyat: Board → task → Diff review; Inbox → both row kinds; rail during a live dispatch.
- [ ] **Step 7: Commit** — `feat(desktop)!: retire the Runs and Review pages for the task-centric flow`.
