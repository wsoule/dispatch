# The autonomy ladder: stops, gate assignments, presets, floor

Status: decision record, 2026-09-03. Settles the design task `t-df1163` under
epic `e-ad1978` (Policy: autonomy with receipts). This document **amends**
`docs/archive/design/lovable-workstreams.md` §"Policy: autonomy with receipts" —
the archive is read-only by `docs/archive/README.md`'s own rule, so the
amendment lives here and this file is now the source of truth for the ladder.
Where this doc and the archived spec disagree, this doc wins.

Method: every human-gated decision point in the codebase was enumerated
(file:line cited throughout) and assigned a rung. The assignments below are
meant to be mechanical — an implementation task should be able to read its row
and know exactly which switch it is building.

## The ladder: four stops, confirmed

The spec's four stops survive contact with the code. Each rung is defined by
exactly which gates demote from _blocking_ to _recording_; everything not named
at a rung keeps its previous behavior. Rungs are cumulative.

1. **`review-all`** — every decision-feed item blocks. This is the
   `DecisionFeed` default today (`packages/server/src/decisionFeed.ts:169`,
   `blockingPolicy`). Note this is _not_ "approve every tool call": the default
   `permissionMode: 'auto'` (`packages/core/src/config.ts:67`) already lets the
   SDK's classifier approve routine tool calls at every rung — only its
   escalations reach the feed. Rung 1 does not turn that off; it is the
   strictest _policy_ stop, not a change to the executor's permission mode.

2. **`auto-scope`** — scope requests
   (`packages/server/src/orchestrator/scopeRequests.ts`) auto-grant and record,
   subject to the constraint below. Everything else still blocks.

3. **`auto-verify`** — the review → fix loop ignites on its own when an
   implementer finishes and retries through the round cap; non-floor tool
   approval escalations also auto-allow. Merge still blocks.

4. **`auto-merge`** — a run whose fix loop completes green auto-enqueues to the
   merge queue, which rebases, verifies, and lands it. Humans review receipts
   after the fact.

The config key is `policy.rung: 1 | 2 | 3 | 4` in `.dispatch/config.yml`
(committed, per-project, shared — same file as `fixLoop`, `verifySteps`,
`orchestrator`). The builder slider and the engineer gate table both write this
one key.

### Rung 2 details — auto-scope

- Mechanism: at rung ≥ 2 the daemon answers a new scope request itself via the
  existing `ScopeRequestRegistry.decide()` with `granted: true`. Add `'policy'`
  to the `ScopeDecider` union
  (`packages/server/src/orchestrator/scopeRequests.ts:10`) so an auto-grant can
  never read as a human's ruling — the same reason `decidedBy` exists at all.
- Constraint: auto-grant only paths inside the project root that do not match a
  floor pattern (below). A request touching `.git/`, paths outside the repo, or
  a floor surface blocks at every rung.
- Backstop: the review's `undeclaredWrites` scan
  (`packages/server/src/orchestrator/review.ts:190-240`) still reports
  everything the run touched, so an auto-granted extension is re-examined by the
  reviewer, not waved through end to end.

### Rung 3 details — auto-verify

- Mechanism: rung ≥ 3 behaves as `fixLoop.auto: true`
  (`packages/core/src/configTypes.ts:167-192`) — the machinery already exists
  and defaults off precisely because "each finished implementer spends without
  anyone asking for it." The rung is that ask, made once. The two settings OR
  together; a per-task `fix-loop: false` opt-out is still honored.
- The loop's own bounds are unchanged: `cap` (default 5, hard max 50), the
  escalation ladder, and `requiresRuling`
  (`packages/server/src/orchestrator/fixLoop.ts:80-84`) — a critical or `blocks`
  finding still demands a written human ruling at this rung and every other (see
  the floor).
- Tool-approval escalations (the SDK classifier's `safetyCheck` referrals,
  `packages/server/src/orchestrator/executors/claude.ts:203-229`) auto-allow at
  rung ≥ 3 unless they match a floor pattern. They are grouped here rather than
  at rung 2 because rung 2 is deliberately narrow — the one known-noisy gate —
  while rung 3 is "don't interrupt the loop."

### Rung 4 details — auto-merge

- Mechanism: when a fix loop reaches `complete` (clean review, no standing
  rulings), the daemon calls the same enqueue path `POST /api/runs/:id/review`
  `approve` uses (`packages/server/src/api.ts:1713`, `:1798`). The merge queue
  is already autonomous once fed — rebase, `verifySteps`, merge, with its
  environmental and GitHub holds
  (`packages/server/src/orchestrator/mergeQueue.ts:87-97`) — so rung 4 is only
  the feeding.
- "Green" means: fix loop `complete`. A loop that stopped `capped`
  (`rounds-exhausted`, `standing-block`, `error`, `stopped`) never
  auto-enqueues.
- Epic children land on `epic/<id>` as usual; **landing the epic branch onto
  main stays a human act at every rung** (`POST /api/epics/:id/land`,
  `packages/server/src/orchestrator/orchestrator.ts:2583`). The epic land is the
  batch review point rung 4 preserves; a standalone task's run, whose base is
  main, does land on main automatically at rung 4.

## Per-preset defaults: confirmed

- **builder = 3 (`auto-verify`)** — confirmed. Not 4: the builder preset is the
  front-door experience for someone who has not yet seen a diff land; auto-merge
  before first trust is the Lovable failure mode this product positions against.
  The slider makes 4 one notch away.
- **engineer = 2 (`auto-scope`)** — confirmed. Closest stop to today's behavior
  plus relief from the one gate that measurably interrupts (scope requests park
  the agent mid-run on a 30s long-poll).
- Both presets surface the same `policy.rung` key; the lens epic (`e-3a6884`)
  sets the default at project creation, the settings escape hatch moves it any
  time.

## Per-task risk modifier

Tasks already carry `risk: routine | elevated | critical`
(`packages/core/src/types.ts:7`), which today selects the review model
(`packages/server/src/orchestrator/review.ts:145-148`) and injects risk-derived
review checks (`review.ts:442-500`). The ladder reuses it as a per-task cap on
the project rung:

| risk       | effective rung         | additionally                        |
| ---------- | ---------------------- | ----------------------------------- |
| `routine`  | project rung           | —                                   |
| `elevated` | `min(project rung, 3)` | a human always merges elevated work |
| `critical` | `min(project rung, 1)` | never auto-dispatched (see floor)   |

`effectiveRung(task) = min(config.policy.rung, riskCap(task.meta.risk))` is the
whole function. This also gives the floor's "npm publish is never reachable by
auto-dispatch" a mechanical home: release/publish tasks are declared `critical`
(the planner already emits risk; `prReviewTask.ts:93` shows the pattern), and
the epic engine holds `critical` children for explicit human dispatch exactly as
it already holds tasks whose declared writes were flagged
(`packages/server/src/orchestrator/plan.ts:674`).

## The irreversibility floor

Always blocking, at every rung, regardless of policy. The spec's three members
are confirmed; three are added. For each: how it is enforced.

1. **Force-push to any ref the run does not own** — confirmed. The product's
   only force-push is `--force-with-lease` on a run's own just-rebased PR branch
   (`packages/server/src/orchestrator/mergeQueue.ts:1312`), which is exempt as
   the product's own mechanism. An agent's `git push --force` to a shared branch
   arrives as a Bash tool call: the approval classifier must treat it as floor
   (always `blocking`), never auto-allowed at rung 3.
2. **Deletes outside declared `writes`** — confirmed. Same enforcement surface
   (tool-approval classification), plus the existing guards never demote: branch
   deletion with unlanded commits requires the explicit `?force=1`
   (`packages/server/src/api.ts:1897-1901`), and epic branches with unreviewed
   children are refused outright.
3. **Spend above the budget cap** — confirmed, with a sharper reading:
   `maxBudgetUsd` (`packages/core/src/configTypes.ts:15`, "the real guard" —
   `config.ts:66`) is a hard stop the SDK enforces per run. The floor property
   is that **no policy rung ever raises or waives it** — a run that hits the cap
   parks as a stalled decision-feed item; more budget is a human config edit,
   never an auto-grant.
4. **Publishing artifacts** — added, from the 2026-09-01 incident on the publish
   epic (epic auto-dispatch launched the npm-publish task the moment its blocker
   flipped, unreviewed). Covers `npm publish` / any registry publish, and
   pushing `v*`/release tags (a tag push _is_ the release trigger in this repo's
   pipeline — same irreversibility, different spelling). Enforced twice:
   publish/release tasks are `critical` risk (no auto-dispatch, rung capped at
   1), and publish-shaped commands are floor patterns in the approval
   classifier.
5. **Repo visibility and remote settings** — added, same incident class:
   `gh repo edit --visibility`, remote repo deletion, default-branch changes.
   Floor patterns in the approval classifier.
6. **Rulings on blocking findings** — added. `requiresRuling` findings (critical
   severity or `blocks` recommendation,
   `packages/server/src/orchestrator/fixLoop.ts:80-84`) and capped fix loops
   always wait for a written human ruling; no rung lets the machine rule
   `parked`/`blocked` on its own. This is what keeps rung 4's "green" honest:
   nothing carrying an unruled blocker can reach the merge queue.

Floor patterns live in one place — the `DecisionPolicy` classifier — not
scattered per gate, so the floor's membership is a single reviewable list.

## Gate inventory → rung table

Every gate found in the codebase, and the rung at which it demotes from blocking
to recording. "floor" = never demotes. "n/a" = not a policy gate (informational,
environmental, or the human's own console) — listed so the inventory is
verifiably complete, not because the ladder touches it.

| #   | Gate                                                                            | Where                                                                   | Demotes at                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Routine tool calls (SDK classifier, `permissionMode: 'auto'`)                   | `packages/core/src/config.ts:67`; `executors/claude.ts:203-239`         | already auto at every rung (recorded in transcript)                                                                                                                                                      |
| 2   | Tool-approval escalations (`canUseTool` → `Orchestrator.approve()`)             | `executors/claude.ts:529`; `orchestrator.ts:1042`; feed kind `approval` | **3**, floor patterns never                                                                                                                                                                              |
| 3   | Scope requests (edit outside declared `writes`)                                 | `scopeRequests.ts`; feed kind `scope-request`                           | **2**, floor patterns never                                                                                                                                                                              |
| 4   | `ask_user` questions                                                            | `questions.ts`; feed kind `question`                                    | n/a — informational; an answer cannot be auto-fabricated. Unanswered questions already time out to agent judgment                                                                                        |
| 5   | Fix-loop ignition on implementer finish                                         | `configTypes.ts:167-192` (`fixLoop.auto`, default false)                | **3**                                                                                                                                                                                                    |
| 6   | Fix-loop rulings (`requiresRuling`, capped loops)                               | `fixLoop.ts:80-84`; feed kind `fix-loop-capped`                         | floor (#6)                                                                                                                                                                                               |
| 7   | Review verdict → merge (`review(id,'merge')`, `submitReview` approve → enqueue) | `orchestrator.ts:2126`; `api.ts:1713,1798,4979`                         | **4**                                                                                                                                                                                                    |
| 8   | Merge-queue processing once enqueued (rebase, `verifySteps`, merge)             | `mergeQueue.ts`                                                         | already autonomous; its `blocked-environment` / `waiting-github` holds are invariants and never demote                                                                                                   |
| 9   | Epic child auto-dispatch after `start()`                                        | `epic.ts` (EpicEngine)                                                  | already autonomous once a human starts the epic; `critical`-risk children and flagged undeclared-writes tasks (`plan.ts:674`) never auto-dispatch                                                        |
| 10  | Plan confirm (proposed graph dispatches on confirm)                             | planner/plan confirm path                                               | n/a — **never demotes.** Filing and first-dispatching work always has a human at the top of the chain; the ladder governs gates inside dispatched work. This is the anti-Lovable property the spec names |
| 11  | Epic land onto main                                                             | `orchestrator.ts:2583`                                                  | n/a — stays human at every rung (rung 4 lands children onto the epic branch)                                                                                                                             |
| 12  | Branch deletion with unlanded commits (`?force=1`)                              | `api.ts:1897-1901`                                                      | floor (#2)                                                                                                                                                                                               |
| 13  | Warden mutating-action confirmations                                            | `wardenTools.ts:381-521`; `warden.ts` (QUEUED_NOTE)                     | n/a — the warden is the human's own console; its confirm protects against the chat model acting unilaterally, which no autonomy rung is a mandate for                                                    |
| 14  | `maxBudgetUsd` hard stop                                                        | `configTypes.ts:15`; `executors/claude.ts:574`                          | floor (#3)                                                                                                                                                                                               |
| 15  | Run stalled / interrupted-dirty handling                                        | feed kind `run-stalled`                                                 | n/a — an after-the-fact repair signal, not a permission                                                                                                                                                  |

## Mechanism: one seam, three switches

The decision feed already reserved the seam for exactly this epic:
`DecisionPolicy` and `DecisionDisposition`
(`packages/server/src/decisionFeed.ts:83-87`, and the comment at `:39-41` naming
`e-ad1978`). Implementation is therefore:

1. A `policy.rung` config key and a `DecisionPolicy` implementation that maps
   each `UnclassifiedDecisionItem` to `blocking`/`recorded` from the effective
   rung plus the floor-pattern list.
2. Three behavior switches keyed off the effective rung: the scope auto-decider
   (rung ≥ 2), fix-loop auto-ignition (rung ≥ 3), and auto-enqueue of green runs
   (rung ≥ 4).
3. Receipts for every auto-decision, all three of: a ledger entry, the
   decision-feed item kept with `disposition: 'recorded'` (the feed becomes the
   notification center's filter, per the audit amendment), and an Activity line
   on the task. `decidedBy: 'policy'` wherever an existing record distinguishes
   who decided.

## Explicitly out of scope for the ladder

- `permissionMode` stays an orchestrator config, not a rung: the ladder operates
  above the executor's permission machinery, in the decision feed.
- Mixed per-user policy (different members, different rungs) — same non-goal as
  mixed-lens teams in the direction doc.
- Auto-answering `ask_user`, auto-ruling findings, auto-landing epics: all
  considered and rejected above; recorded here so they are re-litigated
  deliberately or not at all.
