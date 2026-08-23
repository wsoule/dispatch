# Architecture

What Dispatch is today. This describes the system as it exists in the tree, not
as any plan or spec intended it. When this document and a file in
`docs/archive/` disagree, this document is the one that was checked against the
code.

Last verified against the tree on 2026-08-23.

## What it is

Dispatch runs coding agents against a git repo under human supervision. A task
is a markdown file in the repo; dispatching it starts an agent in an isolated
git worktree, scoped to paths the task declared in advance; the run is reviewed,
verified, and merged through the app. Everything executes on the operator's
machine against their checkout with their own API key.

Three things make that more than a wrapper around an agent CLI: **tasks are
files in the repo** (so git is the sync layer and the history), **runs are
constrained before they start** (declared writes, budget caps, turn caps,
human-gated scope escalation), and **what a run produced is recorded** —
findings, evidence, decisions, transcripts — instead of scrolling past.

## Processes

At rest Dispatch is one long-lived process plus whatever agents are running.

```text
┌──────────────────────────┐
│ Dispatch.app (Tauri 2)   │   apps/desktop
│  React UI  ·  Rust shell │   src-tauri spawns + health-checks the daemon
└────────────┬─────────────┘
             │ HTTP + WebSocket, localhost only
┌────────────▼─────────────┐
│ dispatchd                │   packages/server
│  ~91 REST routes         │   one daemon per project root
│  WebSocket event bus     │
│  Orchestrator            │
└────────────┬─────────────┘
             │ spawns
┌────────────▼─────────────┐
│ agent run                │   git worktree per run
│  Claude Agent SDK        │   @anthropic-ai/claude-agent-sdk
└──────────────────────────┘

  dispatch (CLI)  ─┐
  dispatch mcp    ─┼─► same daemon over the same local HTTP API
  MCP clients     ─┘   (five task_* tools skip it and touch files directly)
```

`dispatchd` is local HTTP only. Nothing in the current system talks to a
Dispatch server, because there isn't one — see
[Team collaboration](#team-collaboration).

The desktop app does not need Bun or the CLI on `PATH`. A dev build runs the
TypeScript daemon through `bun` from the checkout; a packaged release runs
`bun build --compile`d binaries bundled in the app's Resource dir
(`apps/desktop/src-tauri/src/sidecar.rs`).

## Where state lives

This split is the single most important fact about the system, and the one the
team-server work has to cross.

**In the repo, committed, synced by git** — `.dispatch/`:

| Path              | Contents                                                   |
| ----------------- | ---------------------------------------------------------- |
| `tasks/*.md`      | One markdown file per task: frontmatter + body             |
| `config.yml`      | Statuses, models, verify steps, orchestrator caps          |
| `team.yml`        | Roster — handles, emails, display names                    |
| `ledger.jsonl`    | Decisions, hazards, constraints, handoffs                  |
| `findings.jsonl`  | Review findings and their verdicts                         |
| `fix-loops.jsonl` | Fix-loop state per task                                    |
| `notes.json`      | Triage notes and follow-ups                                |
| `inbox/`          | Per-actor inbox (per-actor files, so merges don't collide) |

**Outside the repo, machine-local, never committed** —
`$DISPATCH_HOME/.dispatch/runs/<sha256(rootDir)[:12]>/`:

- `<runId>.jsonl` — the run transcript
- diff snapshots, taken before a worktree is removed
- review comments, review packages and outputs
- verify outputs and results
- merge-queue state, epic PR records
- `worktrees/` — one working tree per run

Keying by a hash of the project root means several projects share one
`DISPATCH_HOME` without colliding (`packages/server/src/orchestrator/paths.ts`).

The consequence: **task state is portable and shared; run state is not.** A
teammate who clones the repo sees every task, decision and finding, and none of
your runs.

## Packages

| Package            | Size                  | What it is                                                                                                                                     |
| ------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dispatch/core`   | ~4.3k                 | Domain model. Task parse/serialize, `TaskStore`, actors, conflicts, timeline, ledger, findings, evidence, config, merge drivers, Carto binding |
| `@dispatch/server` | ~33.7k                | `dispatchd` — HTTP API, event bus, orchestrator, git, Linear, board sync                                                                       |
| `@dispatch/cli`    | ~2.8k                 | The `dispatch` binary                                                                                                                          |
| `@dispatch/mcp`    | ~1.7k                 | Stdio MCP server, 14 tools                                                                                                                     |
| `@dispatch/client` | ~2.9k                 | Typed API client and React hooks over the daemon                                                                                               |
| `@dispatch/ui`     | ~6.7k                 | Component library (shadcn-style) plus `ai/`, `chrome/`, `hooks/`, `lib/`                                                                       |
| `@dispatch/web`    | ~0.9k                 | Browser board UI — **no dependents, see below**                                                                                                |
| `apps/desktop`     | ~40.8k TS + 3.5k Rust | The Tauri app: ~25 views, Rust shell, sidecar management                                                                                       |
| `apps/demo`        | —                     | Hosted sandbox. Embeds `startServer` in-process with `FakeExecutor`/`FakePlanner`                                                              |
| `apps/site`        | —                     | Static marketing server (Railway)                                                                                                              |
| `packages/demo`    | —                     | Seeds a demo repo — board, runs, records, teammate                                                                                             |

`@dispatch/web` is the Phase-2 browser UI (Board, ListView, TaskDetail, TopBar).
Nothing depends on it. `dispatchd` can still serve its `dist/` if built
(`webDistDir` in `startServer`), but the desktop app is the real client now.
**Treat it as unmaintained until someone decides otherwise** — it is either the
seed of a future browser client or dead weight, and nothing in the tree says
which.

## The task model

`TaskMeta` (`packages/core/src/types.ts`) is the center of the system. Beyond
the obvious fields (`status`, `priority`, `assignee`, `blockedBy`, `labels`,
`milestone`, `parent`):

- **`writes`** — paths or globs the task may modify. Declared before the run
  starts. This is the primary guardrail, and it is read three incompatible ways
  in three places (as globs, as literal paths, as regex subjects); the type's
  own comment is the reference. Anything new that reads `writes` has to pick a
  reading deliberately.
- **`risk`** (`routine` / `elevated` / `critical`) — drives review depth and
  model tier.
- **`selfReview`** — the agent re-reads its own diff against acceptance criteria
  before finishing. Defaults on; tasks opt out.
- **`exercised`** — set only once a verify run actually exercised the work and
  every check passed. Distinct from review findings, which only read the diff.
- **`derivedFrom`** — set on tasks Dispatch synthesized to anchor a review of
  someone else's artifact (e.g. `github-pr:41`). Never dispatchable, never
  synced outward, retires itself.
- **`assignee`** is a serialized `ActorRef` — `human:wyat`, `agent:wyat/claude`,
  or `none`. Humans and agents are the same kind of thing here.

`status` is a string, not the `TaskStatus` union: the built-ins are defaults and
`.dispatch/config.yml`'s `statuses` is the source of truth per repo.

## The daemon

`packages/server/src/api.ts` (~4.8k lines) serves roughly 91 REST routes.
Grouped by what they're for:

- **Tasks and planning** — `/api/tasks/*`, `/api/plan/*`, `/api/tasks/draft*`
- **Runs** — dispatch, message, resume, stop, archive, questions, edits,
  comments, send-back, review, evidence
- **Review** — `/api/prs/*` (comments, diff, findings, review agent, submit),
  `/api/runs/:id/review*`
- **Merge** — `/api/merge-queue/*`, `/api/epics/:id/land`, `/api/branches/*`
- **Repo** — `/api/git/*`, `/api/impact`, `/api/landing`
- **Capture** — `/api/inbox/*`, `/api/notes/*`, `/api/conversations`
- **Warden** — `/api/warden`, `/api/warden/:id/message`, action confirmation
- **Integrations** — `/api/linear/*`
- **Meta** — `/api/health`, `/api/sync`, `/api/config`, `/api/agents`

Push updates go over a **WebSocket event bus** (`events.ts`), not SSE. The
`ServerEvent` union has ~30 members and follows a consistent rule: most events
are bare "go refetch" signals carrying at most an id (`task.changed`,
`run.changed`, `plan.changed`, `finding.changed`, `landing.changed`), while
events whose payload a client would immediately fetch anyway carry it inline
(`run.log`, `queue.drained`, `board.sync`, `run.survey`, `fixloop.capped`,
`linear.changed`). Read the comments in `events.ts` before adding one — each
existing choice is argued there.

## The orchestrator

`packages/server/src/orchestrator/` is ~19.1k lines across 37 files, the largest
subsystem by a wide margin.

**Run lifecycle:**

```text
provisioning ─► running ◄─► awaiting-approval
                  │
                  ├─► finished
                  ├─► failed
                  ├─► cancelled
                  └─► interrupted-dirty   (failed, left uncommitted work)
```

`interrupted-dirty` triggers a **`RunSurvey`** — staged/unstaged/untracked
files, last commit, and commits an orphaned agent process landed after the
daemon lost track of it. Recovery information instead of a hand inspection.

**Run kinds:** `execute` writes code, `review` judges a diff and emits findings,
`verify` runs checks against finished work.

**Executors** are pluggable (`registerExecutor`). Production registers exactly
one, `ClaudeExecutor`, over `@anthropic-ai/claude-agent-sdk`. `FakeExecutor` and
`FakePlanner` exist behind the `DISPATCH_ENABLE_FAKES` gate and are what
`apps/demo` and much of the test suite run against — the demo sandbox is a real
daemon with a scripted agent, not a mock UI.

Notable modules:

| Module                                         | Lines | Role                                                                  |
| ---------------------------------------------- | ----- | --------------------------------------------------------------------- |
| `mergeQueue.ts`                                | 1928  | Serialized merge with verification and stacking                       |
| `review.ts`                                    | 1068  | Diff review, undeclared-write detection, shared-surface checks        |
| `worktree.ts`                                  | 955   | Per-run worktree lifecycle                                            |
| `fixLoop.ts`                                   | 807   | Automatic fix rounds with a cap and escalation steps                  |
| `warden.ts` + backend/tools                    | ~545+ | Conversational agent with a tool registry and human-confirmed actions |
| `verify.ts`                                    | 360   | Runs `verifySteps` from config, records structured results            |
| `planner.ts`                                   | 243   | Proposes a task set; indices resolve to real ids at confirm           |
| `scopeRequests.ts`                             | —     | Runtime scope escalation, decided by app or API                       |
| `questions.ts`                                 | —     | Agent-to-human questions, blocking until answered                     |
| `epic.ts`/`epicBranch.ts`                      | —     | Epic sessions, progress, and their branches                           |
| `repoDigest.ts`/`orientation.ts`/`hotspots.ts` | —     | Repo context handed to agents                                         |
| `jj.ts`                                        | —     | Jujutsu support, including colocation with git                        |

## Clients

**Desktop** (`apps/desktop`, ~40.8k lines) is the primary surface: ~25 views
covering board, tasks, task detail, PR review, diffs, branches, milestones,
plans, sessions, agents, impact, inbox/brain-dump, settings, gallery.

**CLI** (`packages/cli`) — commands: `init`, `mcp`, `task`, `plan`, `daemon`,
`doctor`, `orchestrate`, `scope`, `merge-task`, `merge-team`. Every read command
takes `--json`.

**MCP** (`packages/mcp`) — stdio server registered into the project's
`.mcp.json` by `dispatch init`. 14 tools. Five (`task_list`, `task_get`,
`task_save`, `task_comment`, `task_next`) operate on `.dispatch/tasks/*.md`
directly and need no daemon; the other nine require a running `dispatchd` and
return a clear error without one. A `workflow://onboarding` resource briefs a
connecting agent on the conventions.

## Team collaboration

Shipped today, all of it git-based, no server:

- **Actors** — humans and agents as first-class `ActorRef`s, with a roster in
  `team.yml` and attribution on comments and timeline entries
- **Board syncer** (`sync/boardSyncer.ts`) — pushes and materializes task files
  through a dedicated sync worktree, debounced off local edits
- **Task-file merge driver** — activity-log appends merge instead of conflicting
- **Per-actor inbox** — separate files, so two people's writes can't clobber
- **`conflicts.ts`** — detects when two tasks' declared `writes` overlap

Not built: presence, run claims, cross-machine agents, audit export.

**This is the area under active change.** Team collaboration is moving to a
server; the git-native design in
`docs/archive/specs/2026-08-02-team-collaboration-design.md` is superseded, and
the parts of it that shipped are listed above as what exists, not as what will
continue to exist. There is no server design document yet.

The hard part is already visible in [Where state lives](#where-state-lives): the
repo half of the state is shared and the run half is machine-local, and
multiplayer needs the run half to cross machines.

## Integrations

- **GitHub** — PR listing, diffs, comments, review submission, and a poll that
  caches the repo's PR set. Dispatch can synthesize a task to anchor a review of
  someone else's PR (`derivedFrom`).
- **Linear** — two-way sync, team/state mapping, import (`linear/`).
- **Carto** — optional dependency-graph backend that narrows review scope to a
  change's real blast radius. Without it there's a built-in TypeScript-only
  scanner; on a Go, Python or Rust repo that finds nothing and review scope
  silently shrinks to the changed files. `dispatch doctor` reports which backend
  is in use.

## Build and verification

Bun monorepo. Dependencies are pinned in the root `workspaces.catalog`; package
`package.json` files reference `catalog:` rather than versions.

From the root: `bun run format` (oxfmt), `bun run lint` (oxlint, type-aware),
plus `lint:md`, `lint:spelling`, `lint:css`, `lint:deadcode` (knip), `lint:dup`
(jscpd), `lint:arch` (dependency-cruiser), `lint:types`.

**These do not currently pass on a clean checkout.** As of this writing
`bun run lint` reports 57 errors and 474 warnings, `lint:md` and `lint:spelling`
each fail on pre-existing files, and `bun run format` wants to reflow the
Carto-generated block in `AGENTS.md`. Treat a failure as pre-existing until you
have checked whether your own change caused it.

## Known soft spots

Things that are true about the tree and worth knowing before you trust
something:

- `@dispatch/web` has no dependents and no stated future.
- `README.md` describes a Homebrew cask and notarized v0.1.1 builds; every
  `package.json` in the tree says `0.0.1`, and the archived team spec references
  v0.15.0. The versioning story does not agree with itself.
- `docs/design/lovable-direction.md` and `lovable-workstreams.md` predate the
  server pivot and have not been re-checked.
- `docs/design/open-source-monetization.md` was written against a git-native
  multiplayer assumption that no longer holds.
- The repo-local lint baseline is red, so CI signal on those checks is weak.
