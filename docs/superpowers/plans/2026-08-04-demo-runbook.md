# Demo Runbook — Storefront

Live-driven walkthrough of `wsoule/storefront`. No fixed order is enforced by
the app; this is the rehearsed path. Terse — this is for reading in the five
minutes before someone walks in, not during.

## Pre-flight (run in order, same day as the demo)

```bash
export AGENT=1
bun install && bun run build                       # from the repo root
bun packages/demo/src/cli.ts reset
cd .agents/ignore/storefront && bun install && bun test && bun run tsc && cd -
bun packages/demo/src/cli.ts preflight
```

- `preflight` must be all-green except carto/Linear if those genuinely aren't
  configured on this machine — a red carto check silently empties the blast
  radius (moot on this build, see Known gaps), a red Linear check means the
  Linear steps in Settings/stop 10 have nothing to show.
- Boot the daemon with **both** `--init` and an **absolute** `DISPATCH_HOME`:

  ```bash
  DISPATCH_HOME="$(pwd)/.agents/ignore/storefront-home" \
    bun packages/server/src/bin.ts --init --root "$(pwd)/.agents/ignore/storefront"
  ```

  `--init` registers the task/team merge drivers in this clone's local git
  config. Without it, `dispatchd` logs "the task merge driver is not resolvable
  on PATH" at boot, and stop 10's conflict falls back to plain line-based
  merging instead of the field-aware driver it's meant to show off. A
  **relative** `DISPATCH_HOME` also works for run/actor-identity loading but
  breaks worktree creation (git resolves a relative worktree path against
  `--root`'s cwd, not the daemon's) and litters an untracked `.agents/`
  directory inside the storefront clone — always pass an absolute path.

- Open the app, confirm every run in Runs shows the state it was seeded with
  (nothing shows `failed` except `r-3d90c1`, the one run seeded failed on
  purpose). If anything else is `failed`, `reconcileOnBoot` rejected it — don't
  debug live, `reset` again and re-check before the audience arrives.
- Do **not** open `r-c05e19`'s diff tab (t-58cc03's fix-loop round 4) — see
  Known gaps.

## The path

### 1. Task board

- **Screen:** Sidebar → **Tasks**.
- **Click:** Open any task card (e.g. `t-3f8a21`), then click into its body text
  to edit it inline.
- **Say:** "Every task, epic, and status here is real state committed to git —
  nothing in this view is mocked."
- **If it breaks:** Board fails to load → `preflight` should have caught a dirty
  clone; run `reset` again, don't try to fix it live.

### 2. Inbox

- **Screen:** Sidebar → **Brain dump**, "Inbox" section.
- **Click:** Open the "These look like one thing" cluster-capture panel; click
  **Select them**, or open **Group into epics** and click **Select** / **Make an
  epic** on a group. Turn one capture into a task with **Make a task** (or **Add
  detail** first to elaborate it via an agent).
- **Say:** "Ideas land here first — clustering and epic-grouping happen before
  anything becomes a task."
- **If it breaks:** Nothing to cluster → the seeded inbox has three per-actor
  files; switch actor (wsoule679/pmirand/dokafor) in the sidebar if one looks
  empty.

### 3. Drafts tray

- **Screen:** Small **Drafts** badge next to the notifications bell (sidebar).
- **Click:** Badge → opens the draft's page, which embeds the planner's question
  form.
- **Say:** "A planner asks clarifying questions before committing to a plan —
  here's one waiting on an answer."
- **If it breaks — this one is not seeded, see Known gaps.** Before reaching
  this stop, kick off a real plan draft live (Sidebar → **Plans** → start a plan
  on any backlog task) so the badge has something to show. If you forget, skip
  this stop rather than opening an empty tray.

### 4. Dispatch `t-3f8a21` live

- **Screen:** Task card for `t-3f8a21` ("Validate discount codes server-side").
- **Click:** **Dispatch** on the card (or open the dispatch dialog, button reads
  **Dispatch {N}**). Watch tool calls stream in Runs → **Session** tab. Click
  **Stop** partway through; once it winds down, click **Continue** to resume the
  same branch/session.
- **Say:** "This is a real agent, not a recording — discount validation really
  is client-trusted right now, and it's about to move server-side."
- **If it breaks:** Live run errors, stalls, or costs run out → stop narrating
  it as live and open `t-3f8a21`'s run history instead; `r-1e6a4f` is a
  pre-recorded transcript of the same task, including a granted scope request,
  seeded specifically as this fallback.

### 5. Review surface

- **Screen:** Task `t-2e91aa` ("Move cart state to the session store", status
  **in-review**) → its run history → open the review run. **Not** the top-level
  **Review** nav item's queue — review/verify-kind runs never appear there (the
  queue only lists not-yet-reviewed execute runs), so t-2e91aa's own review has
  to be reached from the task page.
- **Click:** Open the run; the case panel, thread index, and verdict footer
  ("Finish the review": Comment / Request changes / Approve) load together.
  Click a finding to see it anchored to its diff line as a comment.
- **Say:** "Every finding here is anchored to the exact line it's about — not a
  free-floating comment."
- **If it breaks:** Diff pane shows "Couldn't load this run's diff" → this is
  seeded to work (a real `git diff` snapshot on
  `r-2e91aa`/`r-7f4a2b`/`r-4b91de`); if it still fails, findings are still
  listed and file:line-referenced in the run's own transcript and in the task's
  Ledger section — narrate from there.

### 6. Rule on findings

- **Screen:** Task `t-2e91aa` (or `t-58cc03`) detail dialog, findings list.
- **Click:** On an **open** finding (`f-a1b2c3` critical on `t-2e91aa`, or
  `f-e5f6a7`/`f-a7b8c9` on `t-58cc03`), click **Park** and give a one-line
  ruling; on another open finding, click **Block**. Then Sidebar → **Settings**
  → **Agents** tab → **Escalation ladder** to show the fix loop's round cap and
  the escalation rule a blocked finding feeds into.
- **Say:** "Parking says 'not now, here's why'; blocking stops the branch from
  merging until it's addressed — the fix loop picks blocked findings up
  automatically."
- **If it breaks:** Ruling won't save → the finding may already be
  parked/blocked from a prior run-through; use `reset` before the demo, not
  mid-demo.

### 7. Verify evidence → ledger → scope request

- **Screen:** Same case panel as stop 5, on the verify run (`r-4b91de`).
- **Click:** Scroll to **What the agent verified** (command evidence) and
  **Guards it mutation-tested** (mutation evidence). Then open the task/epic
  detail dialog's **Ledger** section (constraint / hazard / decision / handoff —
  one of each is seeded). If the live run from stop 4 is still going and the
  agent files a scope request, point out the inline **Grant** / **Deny** card in
  its Session log.
- **Say:** "The mutation test reverted a guard and confirmed it wasn't dead code
  — three tests failed, so it's load-bearing. The ledger is what the next agent
  inherits instead of re-discovering the same constraint."
- **If it breaks:** No live scope request appears (the agent didn't need one) →
  narrate from `r-1e6a4f`'s transcript instead, which already shows one granted.

### 8. Carto blast radius — no dedicated screen exists

- **Screen:** None. There is no blast-radius panel, view, or button anywhere in
  the desktop app (confirmed by source search — `depmap.ts` computes it
  internally to widen review scope, but nothing surfaces it visually).
- **Click:** Nothing to click — do not promise one live.
- **Say:** Narrate conceptually while pointing at the review surface's file list
  from stop 5/7: "a change to `src/db/client.ts` would pull every importer into
  scope — that's carto/blast-radius reasoning happening behind this list, not a
  separate screen."
- **If it breaks:** It can't — there's nothing here to demo. Skip this stop or
  keep it purely verbal. See Known gaps.

### 9. Git panel

- **Screen:** Sidebar → **Git**.
- **Click:** Walk **Status** → **Files** → **Branches** → **Commits** →
  **Stashes** panels; open the commit composer; click a file in the diff pane.
- **Say:** "This is the same git state everything else in the app reads from —
  no separate sync layer."
- **If it breaks:** Empty stashes/commits → expected on a freshly-reset clone
  with no uncommitted work; make a small local edit first if you want the
  composer to have something to commit.

### 10. Teammate claim, then conflict → finish in Linear

- **Screen:** Sync chip in the sidebar footer.
- **Click (terminal, before or during):**

  ```bash
  bun packages/demo/src/cli.ts teammate claim t-1d77e5
  bun packages/demo/src/cli.ts teammate conflict t-6c40de
  ```

  Watch the sync chip change and the board update with no manual merge. Then
  Sidebar → **Settings** → **Integrations** to show the Linear panel.

- **Say:** "A teammate just claimed a task and moved another one — the merge
  driver resolved both without anyone touching git."
- **If it breaks:** `teammate claim`/`conflict` errors on push rejection → the
  teammate clone was stale relative to origin (e.g. you ran it a second time
  without `reset`); re-run `reset`. Linear panel shows disconnected → expected
  if this machine's `~/.dispatch/credentials.json` has no key; narrate the
  `config.yml` fields (`teamId`, `statusMap`, `direction`) instead of a live
  sync.

### 11. Settings tour

- **Screen:** Sidebar → **Settings**: **General**, **Agents**, **Integrations**,
  **Daemon**, **Diffs**.
- **Click:** Walk each tab — Agents (models, fix-loop cap, escalation ladder,
  already shown in stop 6), Integrations (Linear, already shown in stop 10),
  Daemon, Diffs.
- **Say:** "By now every section here maps to something you just watched
  happen."
- **If it breaks:** Nothing to break — this is read-only narration.

## Known gaps

1. **Drafts tray (stop 3) cannot be seeded.** `PlanManager`'s `PlanRecord` is
   explicitly in-memory only (`packages/server/src/orchestrator/plan.ts` — "a
   lost daemon losing in-flight drafts is acceptable"), so no fixture can
   produce a waiting planner after a restart. You must kick off a real plan
   draft live, shortly before this stop.

2. **`r-c05e19` (t-58cc03's fix-loop round 4) has no working diff.** Its seeded
   `branch` (`dispatch/execute-t-58cc03-c05e19`) is never created by `reset` —
   repo.ts only creates real branches for the two `BRANCH_FIXES` entries. This
   is deliberately **not** fixed: opening the run is safe either way (the daemon
   returns a graceful 409, the desktop app shows "Couldn't load the diff"
   inline, nothing crashes), but the row has no real diff to show. Simplest
   handling: don't click it. It sits in the review queue alongside `r-3d90c1`,
   `r-1e6a4f`, and `r-88bf02` — of those four, only `r-1e6a4f` (t-3f8a21's
   fallback, stop 4) is meant to be opened during the walkthrough.

3. **Carto has no UI surface at all (stop 8).** Not carto-specific to this
   machine — there is no blast-radius panel, view, or button in
   `apps/desktop/src` regardless of whether carto is installed. Treat stop 8 as
   narration, not a click, until a UI is built for it.

4. **`dispatch merge-task` must be resolvable on PATH.** Boot with `--init` (see
   pre-flight) or the merge driver silently falls back to line-based merging for
   stop 10 — it happens to still succeed for this specific claim/conflict pair
   (the two edits land on different frontmatter lines), but doesn't exercise the
   feature being demonstrated.

5. **`DISPATCH_HOME` must be an absolute path.** A relative one works for
   loading run/actor state but breaks worktree creation (see pre-flight) and
   leaves a stray `.agents/` directory inside the storefront clone.

6. **Live-run beats (stops 4 and 7's scope request) are inherently unscripted.**
   Budget/time can run out, or the agent may not need a scope grant at all. Both
   have a seeded fallback (`r-1e6a4f`) — know it before you need it, not during.
