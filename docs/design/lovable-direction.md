# Two front doors: the Lovable-shaped Dispatch

Status: agreed direction. Decisions below were settled in discussion on
2026-08-20, against `main` at v0.23.2. Sequencing is direction, not a committed
schedule; each workstream gets its own plan when it starts.

## The question this answers

"Make Dispatch more like Lovable — still task-based — and add a web version."
Those turned out to be four decisions, all now made:

1. Builder and engineer experiences both exist, as **modes**.
2. Web comes in two stages: reach first, team collaboration later, backed by
   **code.storage** (Pierre) for repos and **Modal** for compute. Free for
   personal accounts; teams pay.
3. Compressing the dispatch → review loop is a goal in itself.
4. Long-term positioning: merge the gap between get-something-working-fast
   (Lovable) and team-grade engineering (Dispatch today).

## What Lovable has that we lack

Strip the marketing and Lovable is four properties:

1. **One box, zero setup.** Type a sentence, something real exists in ~30s.
2. **The running thing is the artifact.** You judge the agent by looking at the
   app, not by reading a diff.
3. **Everything has a URL.** Projects are shareable by default.
4. **Ship is one button.**

Dispatch today is the mirror image: install → init → task → dispatch, the
artifact is a diff and a PR, everything is local, merge is the terminal state.
Property 2 is the biggest lever and is compatible with staying task-based.
Property 4 stays out of scope — Dispatch merges into your repo, and your repo
has its own deploy story.

What we do NOT copy: the "describe an app" front door as the _only_ door, and
autonomy without a trail. Dispatch's value is that agent work is scoped,
budgeted, and recorded.

## The decomposition: lens, policy, backend

"Mode" bundles three things that move independently. We build the decomposition
and ship the word "mode" on top of it as a pair of presets.

**Lens** — which surfaces you see. `builder` (prompt box and live preview are
the stage) or `engineer` (board, diffs, findings, merge queue; preview docked
beside the diff). Lens is **per-project, set by which front door created it**: a
project born from a prompt is a builder project; one born from a cloned repo is
an engineer project. A settings escape hatch can switch a project's lens at any
time — both lenses read the same state, so switching migrates nothing.

We are deliberately **not** designing for mixed teams (different members in
different lenses on one project simultaneously). If that returns later, the
spine supports it — lens would become per-user preference — but we are not
paying for it up front.

**Policy** — what the agent may do without a human gate, per-project, shared,
visible in both lenses (builder shows a simple autonomy slider; engineer shows
the full gate config). Both modes default toward high autonomy — engineers are
trending to auto-accept too. The gates therefore demote from _blocking_ to
_recording_: auto-accept scope requests, auto-retry verify, eventually
auto-merge on green, with every decision still landing in the ledger, findings,
and evidence trail. A small **irreversibility floor** always stays blocking
regardless of policy: force-push, deletes outside declared `writes`, spend above
the budget cap.

This is the positioning that falls out: **autonomy with receipts**. Lovable is
autonomous and opaque; classic review tooling is legible and slow. Dispatch
moves at Lovable speed and leaves an auditable trail, using machinery
(`.dispatch/` findings, rulings, evidence, ledger) that already exists.

**Backend** — follows where the project lives, never toggled by the user:

- **Local**: filesystem + git, exactly as today. Free, unlimited, keeps the
  README promise — your machine, your checkout, your key, nothing uploaded.
- **Hosted**: code.storage for repos, Modal for sandboxes. Free personal
  accounts capped by sandbox-minutes (compute is the metered cost, not storage);
  team collaboration is the paid tier.

## Why code.storage fits us better than it fits Lovable

Lovable uses code.storage as a bucket for generated apps that have no repo.
Dispatch's entire thesis is already the thing Pierre sells: tasks are markdown
files, git is the sync layer and the history. The mapping is direct —

| Dispatch concept                             | code.storage primitive           |
| -------------------------------------------- | -------------------------------- |
| worktree per run                             | ephemeral branch                 |
| epic branches, stacked dispatch, merge queue | branches and refs                |
| findings / evidence / rulings / transcripts  | versioned files ("agent memory") |
| task file as source of truth                 | commits                          |
| "your repo stays canonical"                  | GitHub sync                      |

GitHub sync is the row that protects positioning: the user's repo of record
stays on GitHub; code.storage is the fast machine-facing mirror. Warm/cold
pricing (~$1.00/GB warm, ~$0.15 cold) matches our access pattern — active tasks
warm, landed history cold.

Vendor risk is real (Pierre is young) but unusually well hedged: it's git, the
exit is `git clone`, and GitHub sync keeps a canonical copy elsewhere at all
times. We also already ship `@pierre/diffs` and `@pierre/trees`.

The storage seam is small: `taskfile.ts` (parse/serialize) is pure; task I/O
goes through the single `TaskStore` class in `packages/core/src/store.ts` (~315
lines); only 7 of 28 core source files touch `node:fs`, and
`packages/core/src/browser.ts` already maintains a pure entry point. Hosted mode
means a second `TaskStore` implementation, not a rewrite.

## What already exists toward the web version

- **The desktop UI is already a browser app.** 6 of 443 source files in
  `apps/desktop/src` import `@tauri-apps/*`, and every IPC call in
  `lib/tauri.ts` has a documented `isTauri()` browser fallback. Tauri covers
  registry, native dialogs, editor/Finder, JSONL observability, updater —
  nothing on the task/run/review path.
- **`apps/demo` is already a multi-tenant host**: per-visitor `dispatchd`,
  HTTP + WS proxy behind `/s/<id>/`, session caps, TTL sweeps, rate limiting,
  token injection via `__DISPATCH_DEMO__`. The hosted product is a
  generalization of this (real repo in, accounts, persistence), not new
  infrastructure.
- **The daemon's two-tier token auth** (`agentToken` request / `appToken`
  decide) is already the right authorization shape for a shared web session.
- **`packages/web` stays frozen** per the roadmap's standing decisions. The web
  version is the desktop bundle, hosted — not a revival of packages/web.

## The four cells, in build order

Local/hosted × builder/engineer. Local+Engineer is the shipped product. The
rest, in order:

### 1. Preview per run (spine — both modes, both backends)

The single biggest Lovable-ness lever, and it is spine, not lens: **every run
that reaches a reviewable state gets a dev server and a preview URL.** Builder
makes it the stage; engineer docks it beside the diff.

Concretely: a per-run dev-server supervisor in dispatchd — preview command from
`.dispatch/config` (default: detect `dev` in the worktree's `package.json`),
allocated port, proxied at `/preview/<runId>/`, iframe in the app; stopped with
the run, swept on daemon shutdown. Known costs: fresh worktrees need installs,
arbitrary child processes need supervision, hung preview commands need timeouts.

This also serves the loop-compression goal directly: hot-reload the preview on
agent edits and the feedback loop becomes visual and near-instant, with no gate
involved at all.

### 2. Builder front door, locally (Local+Builder — the sleeper)

The empty/first-run state becomes a single prompt box — "what do you want to
change?" — over the existing planner (`orchestrator/planner.ts`), showing the
proposed task graph inline, dispatching on confirm. Mostly information
architecture over machinery that exists; no Modal, no code.storage. This is the
free tier's viral surface.

### 3. Hosted Builder (the reach play)

Promote `apps/demo` to a product: repo in code.storage (created from a prompt,
or cloned in via GitHub App + sync), agent runs in Modal sandboxes, preview
proxied same as local. Builder sessions hold a persistent sandbox with a live
dev server (Lovable's model); the free-tier cap is sandbox-minutes.
`__DISPATCH_DEMO__` injection seam generalizes to `__DISPATCH_HOST__`. Extend
the existing `isTauri()` fallbacks: registry → server-side project list, native
dialog → repo picker, editor/Finder actions → hidden.

### 4. Hosted Engineer (when teams arrive)

The full board/review/merge-queue surface over hosted backends, ephemeral
per-run sandboxes instead of persistent ones, roles and centralized billing.
This is the paid tier and the last thing built, because it depends on everything
above plus accounts and persistence.

### Independent, cheap, any time: shareable run URLs

`dispatch share <runId>` → static read-only page of transcript, diff, findings,
rulings. Highest perceived-Lovable per unit of engineering; no hosting
dependency.

## Open questions for the next plan

- Preview supervisor details: install strategy for fresh worktrees, port
  allocation, health/timeout policy, non-web repos (no preview — what shows
  instead).
- The autonomy slider's exact stops, and which default _on_ in each mode's
  preset — the irreversibility floor is fixed, everything between is open.
- Hosted identity: accounts, GitHub App scopes, per-user API keys vs. platform
  keys and billing.
- Modal specifics: image strategy, snapshot/hibernate for builder sessions, cost
  model per free-tier minute.
