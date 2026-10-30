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

| Path              | Contents                                                    |
| ----------------- | ----------------------------------------------------------- |
| `tasks/*.md`      | One markdown file per task: frontmatter + body              |
| `config.yml`      | Statuses, models, verify steps, orchestrator caps           |
| `team.yml`        | Roster — handles, emails, display names                     |
| `ledger.jsonl`    | Audit receipts: policy approvals, floor holds, scope grants |
| `findings.jsonl`  | Review findings and their verdicts                          |
| `fix-loops.jsonl` | Fix-loop state per task                                     |
| `notes.json`      | Triage notes and follow-ups                                 |
| `inbox/`          | Per-actor inbox (per-actor files, so merges don't collide)  |

**Outside the repo, machine-local, never committed** —
`$DISPATCH_HOME/.dispatch/runs/<sha256(rootDir)[:12]>/`:

- `<runId>.jsonl` — the run transcript
- `messages.db` — the message bus: messages, per-recipient deliveries, channels,
  the agent roster, and which gate answers have taken effect
- diff snapshots, taken before a worktree is removed
- review comments, review packages and outputs
- verify outputs and results
- merge-queue state, milestone PR records
- `worktrees/` — one working tree per run
- `memory.db` — project and team memory, and memory proposals
- `claude-memory/<lineage>/` — a run's Claude memory export

Personal memory lives outside every project, in
`$DISPATCH_HOME/.dispatch/memory/`: `identities.db` (who each handle is) and one
`<identity>.db` per human.

Keying by a hash of the project root means several projects share one
`DISPATCH_HOME` without colliding (`packages/server/src/orchestrator/paths.ts`).

The consequence: **task state is portable and shared; run state and memory are
not.** A teammate who clones the repo sees every task, finding and receipt, and
none of your runs or memory; replicating team memory is team-server work.

## Packages

| Package                  | Size                  | What it is                                                                                                                                     |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dispatch-foo/core`     | ~11.5k                | Domain model. Task parse/serialize, `TaskStore`, actors, conflicts, timeline, ledger, findings, evidence, config, merge drivers, Carto binding |
| `@dispatch-foo/protocol` | ~2.0k                 | The message bus, MIT: addresses, the envelope and its validation, `MessageStore` over SQLite, `DeliveryEngine`                                 |
| `@dispatch/memory`       | ~4.6k                 | The memory engine, MIT: entries and scopes, proposals, ranking, the prompt index, the SQLite store, Claude's memory file format                |
| `@dispatch/server`       | ~56.8k                | `dispatchd` — HTTP API, event bus, orchestrator, git, Linear, board sync                                                                       |
| `@dispatch/cli`          | ~6.4k                 | The `dispatch` binary                                                                                                                          |
| `@dispatch-foo/mcp`      | ~2.8k                 | Stdio MCP server, 21 tools                                                                                                                     |
| `@dispatch/client`       | ~4.1k                 | Typed API client and React hooks over the daemon                                                                                               |
| `@dispatch/ui`           | ~8.8k                 | Component library (shadcn-style) plus `ai/`, `chrome/`, `hooks/`, `lib/`                                                                       |
| `@dispatch/tokens`       | —                     | The design token palette (`tokens.css`) the desktop app and the site share                                                                     |
| `apps/desktop`           | ~67.4k TS + 8.6k Rust | The Tauri app: ~25 views, Rust shell, sidecar management                                                                                       |
| `apps/demo`              | —                     | Hosted sandbox. Embeds `startServer` in-process with `FakeExecutor`/`FakePlanner`                                                              |
| `apps/site`              | —                     | Static marketing server (Railway)                                                                                                              |
| `packages/demo`          | —                     | Seeds a demo repo — board, runs, records, teammate                                                                                             |

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

`packages/server/src/api.ts` serves the daemon's REST routes. Grouped by what
they're for:

- **Tasks and planning** — `/api/tasks/*`, `/api/plan/*`, `/api/tasks/draft*`
- **Runs** — dispatch, resume, stop, archive, edits, comments, send-back,
  review, evidence
- **Messaging** — `/api/messages/*`, `/api/threads/*`, `/api/mailbox`,
  `/api/deliveries/:id/read`, `/api/channels/*`, `/api/decisions/open`,
  `/api/agents/roster|register|:addr/*`: the message bus, where questions, scope
  requests and tool approvals are gates
- **Review** — `/api/prs/*` (comments, diff, findings, review agent, submit),
  `/api/runs/:id/review*`
- **Merge** — `/api/merge-queue/*`, `/api/milestones/:id/land`, `/api/branches`
- **Repo** — `/api/impact`, `/api/landing`
- **Capture** — `/api/inbox/*`, `/api/notes/*`, `/api/conversations`
- **Overseer** — `/api/overseer`, `/api/overseer/:id/message`; its action
  confirmations and built-in tool-call approvals are gates on the message bus
- **Integrations** — `/api/linear/*`
- **Meta** — `/api/health`, `/api/sync`, `/api/config`, `/api/agents`

Push updates go over a **WebSocket event bus** (`events.ts`), not SSE. The
`ServerEvent` union has ~30 members and follows a consistent rule: most events
are bare "go refetch" signals carrying at most an id (`task.changed`,
`run.changed`, `plan.changed`, `finding.changed`, `landing.changed`,
`delivery.changed`), while events whose payload a client would immediately fetch
anyway carry it inline (`run.log`, `queue.drained`, `board.sync`, `run.survey`,
`fixloop.capped`, `linear.changed`, `message.new`). Two carry text that is never
stored at all: `run.delta` and `overseer.delta`, the words of a running turn as
the model writes them (see
[Live text, narration and tool results](#live-text-narration-and-tool-results)).
Read the comments in `events.ts` before adding one — each existing choice is
argued there.

## The orchestrator

`packages/server/src/orchestrator/` is ~25.3k lines across 46 files, the largest
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

**Executors** are pluggable (`registerExecutor`). Production registers
`ClaudeExecutor` over `@anthropic-ai/claude-agent-sdk`, plus `CodexExecutor`
over the Codex App Server (`codex app-server --stdio`) when a `codex` binary is
on PATH. `FakeExecutor` and `FakePlanner` exist behind the
`DISPATCH_ENABLE_FAKES` gate and are what `apps/demo` and much of the test suite
run against — the demo sandbox is a real daemon with a scripted agent, not a
mock UI.

Each executor carries an `ExecutorProfile` (`orchestrator/types.ts`): whether
its finishes report cost and turns, whether it enforces `maxTurns`/
`maxBudgetUsd` itself, and which `permissionMode`s it can honour — the
orchestrator refuses a dispatch its executor cannot run before provisioning a
worktree. `GET /api/executors` publishes the registry with those flags and the
configured default, so no client hard-codes executor names. Model choice goes
through `executorModels()` in core: `models.execute`/`plan` stay the Claude
aliases, `executors.<name>.models` overlays them per executor, and
`orchestrator.executor` names the default. Reasoning effort is separate:
`effort.execute`/`overseer`/`plan` (`low` to `max`) apply when the dispatch or
composer picker is left on Default; an unset role sends none, so the model's own
default holds, and a run records its effort in `RunMeta` so a resume keeps it.
Only the Claude executor, overseer and planner act on it. Fix and verify runs
follow the executor that wrote the work; review runs use the project default.
Both executors share the Dispatch and carto MCP wiring in
`orchestrator/dispatchMcp.ts`.

Codex caveats: it reports token usage but no dollar cost unless
`executors.codex.pricing` (USD per million input/cached-input/output tokens) is
configured, so the finish line otherwise says `cost n/a`; it cannot enforce the
run caps (a system entry notes any that were set); and Codex protects `.git` —
including a worktree's gitdir — under `workspace-write`, so each commit asks for
approval. To hold the irreversibility floor (`floor.ts`), Codex runs under its
`untrusted` policy, which asks before every command that is not read-only:
`default` and `acceptEdits` send those asks to Dispatch's approval flow
(`acceptEdits` accepts edits inside the worktree itself), `bypassPermissions`
accepts all but floor commands itself, and `plan` stays read-only. `auto` and
`dontAsk` are refused, since Codex would answer or skip approvals without
Dispatch. Two paths still skip the ask: a `~/.codex/rules` rule allowing the
command, and input typed into a shell the run already started. Dispatch cannot
hold either, but it sees both afterwards: a floor command that completes with no
ask behind it, or a typed line that trips the floor, fails the run with a system
entry naming the command, so it waits in the decision feed. The MCP servers a
person configured for their own interactive Codex in `~/.codex/config.toml` are
switched off for every dispatched run (a system entry names them); the run gets
only Dispatch's own server and carto.

Notable modules:

| Module                                         | Lines | Role                                                                   |
| ---------------------------------------------- | ----- | ---------------------------------------------------------------------- |
| `mergeQueue.ts`                                | 1928  | Serialized merge with verification and stacking                        |
| `review.ts`                                    | 1068  | Diff review, undeclared-write detection, shared-surface checks         |
| `worktree.ts`                                  | 955   | Per-run worktree lifecycle                                             |
| `fixLoop.ts`                                   | 807   | Automatic fix rounds with a cap and escalation steps                   |
| `overseer.ts` + backend/tools                  | ~800+ | Full agent session in the checkout: project tools with human-confirmed |
|                                                |       | actions, built-in tools behind the run permission policy               |
| `verify.ts`                                    | 360   | Runs `verifySteps` from config, records structured results             |
| `planner.ts`                                   | 243   | Proposes a task set; indices resolve to real ids at confirm            |
| `../policyEngine.ts`                           | —     | Autonomy ladder: gates consult per-project policy, auto-decide, record |
| `../messaging/`                                | —     | Message bus host: questions, scope, approval and wake gates            |
| `milestone.ts`/`milestoneBranch.ts`            | —     | Milestone sessions, progress, and their branches                       |
| `repoDigest.ts`/`orientation.ts`/`hotspots.ts` | —     | Repo context handed to agents                                          |

## Live text, narration and tool results

The Overseer chat and a task run's chat show an agent at work, not only what it
settled on. Three pieces do that: **live text** (the words of a running turn,
streamed and never stored), **narration** (the Overseer's prose between tool
calls, stored as rows) and **tool results** (how each of a run's tool calls
ended, stored as entries).

**Segments.** Live text is cut into segments: one Claude text block, or one
Codex `agentMessage` item. A Claude segment is `<apiMessageId>:<blockIndex>`,
read off the Agent SDK's partial messages, which a turn asks for only while it
streams (`includePartialMessages`; `orchestrator/claudeTextSegments.ts` names
them for both the Overseer and runs). A Codex segment is the item id, fed by
`item/agentMessage/delta`; Codex is not version-pinned, so everything works the
same when no delta ever arrives. A sub-agent's messages (`parent_tool_use_id`
set) never stream, and the Overseer does not count a sub-agent's tool calls or
usage as its own either. The Overseer prefixes each segment with its turn id, so
an id is unique within the conversation.

**Frames.** Each piece of text is one websocket event,
`{ type, conversationId | runId, turnId, seq, segmentId, text }`, where `text`
extends segment `segmentId`. `seq` counts one key's frames (a conversation, or a
run) for the daemon's life and never resets between turns; a run has one turn
for its whole life, and the daemon forgets a run's live text when it ends. When
a segment's text lands on the record, the row carries the segment as `streamId`
and the segment leaves the live text in the same step: an Overseer `narration`
or `assistant` row, a run's `assistant` entry (dropped before its `run.log` is
sent). A client hides every live segment whose id a row already carries. A
Claude text block that its API message stopped without finishing (the stream
broke off, and the CLI sends the text again under a new message) is abandoned,
in a run and in an Overseer turn alike: it leaves the live text, so a stopped
Overseer turn never keeps it as narration, and a frame with `abandoned: true`
and empty `text` tells clients to drop it rather than show it for the rest of
the turn.

**Snapshot.** `GET /api/overseer/:id`, `GET /api/overseer/current` and
`GET /api/runs/:id` add `live: { seq, turnId, segments }` while a turn runs, so
a window that opens or reconnects mid-turn starts from what was already written.
Mutation responses may omit it; the stored record and the run transcript never
hold it. The buffer is `packages/server/src/liveText.ts`, in memory only.

**Gap repair.** The client folds frames in `packages/client/src/liveText.ts`, a
pure reducer behind one store per window, keyed by port and
`overseer:<conversationId>` or `run:<runId>`. A frame whose `seq` follows the
last one appends (a new `turnId` starts that turn's segments empty); an old or
repeated one is ignored; anything else is a gap: the key goes stale, holds the
frame, and refetches its record once per stale episode. The record's `live`
replaces the local text unless the local text is newer, held frames replay while
they follow on, and a gap left over refetches once more. The desktop resets a
daemon's live text on the websocket's `hello`, before it refetches every
Overseer record and run detail: a restarted daemon counts `seq` from zero.
`useLiveText` keeps a segment on screen until the row that replaces it reaches
the view, so text does not blink out between the two; an abandoned segment goes
at once. Every window hears every run's frames, so the desktop keeps text only
for a run a surface shows (its detail query has an observer): a frame for a run
no surface shows drops the text held for it and marks its cached detail stale,
so a run opened later starts from its detail's snapshot. A run's segment leaves
the store when the `run.log` entry naming it arrives, and the run's key goes
once a fetched detail shows the run ended.

**Run log order.** A `run.log` frame carries `index`, its entry's place among
the run's transcript entries, the same position `GET /api/runs/:id` lists it at.
The desktop appends a frame that continues its cached detail, ignores one it
already holds, and refetches once (never cancelling a fetch already out) after
one that skips ahead. Frames that land while a detail fetch is out are added to
its response by index before it lands, so steady output never restarts a fetch.
A frame from an older daemon has no index and is appended as before; one that
lands while a detail fetch is out has the detail fetched once more after that
fetch lands, since its response may predate the entry. A daemon that could not
write an entry to the transcript still sends its frame, with no index, and then
`run.changed`, so every window refetches the run instead of staying one entry
ahead of the transcript.

**Audience (owner decision, 2026-10-23).** `overseer.delta` goes only to the
conversation's live audience (`overseerLiveAudience` in
`orchestrator/overseer.ts`): any deciding human (a `human:` credential at the
`decide` tier or above, the reach the bus mirror of the conversation's lines
already has through `messageAudience` in `messaging/service.ts`), the
conversation's owner at any tier, and operator-tier sockets. Never a socket
opened with the shared agent token. `run.delta` goes to exactly the sockets
`run.log` reaches, which today is every socket; that is parity on purpose, and
scoping both is separate work.

**Switches.** Two `.dispatch/config.yml` blocks, read when a turn or a run
starts. They are rollback switches, so both default to `live`; YAML `true` and
`false` read as `live` and `off`. Neither is in Settings yet.

```yaml
overseer:
  stream: live # live | narration | off
runs:
  stream: live # live | off
```

For the Overseer, `live` streams and keeps narration, `narration` keeps the rows
but streams nothing (Claude is not asked for partial messages), and `off` is one
reply per turn with nothing in between. For runs, `off` shows each block of text
once the model finished it.

**Narration.** `OverseerMessage.role` gains `narration`: prose the Overseer
wrote mid-turn, before a tool call, kept as a row in the order it was written.
Each turn still has exactly one `assistant` reply row, so everything that reads
"the turn's reply" (the rollover recap, the bus reply, the last line on Tasks,
`GET /api/agents`, the memory export) is unchanged. The Claude backend holds
each finished text block as pending, commits the pending blocks as narration
just before the next top-level tool call, and treats what is pending at the
`result` as the reply; a pending block whose text the result does not contain is
kept as narration too, so no text is lost. The Codex backend holds finished
`agentMessage` items by id: the next item commits the earlier ones as narration,
except one Codex marked `final_answer`, and at the turn's end every item but the
reply is narration. Codex's reply is its last message even when a step followed
it, by which time that message went out as narration: the manager then moves it,
so the reply row takes the narration row's place rather than repeating it. A
turn that is stopped or fails keeps the text it had streamed as narration rows,
ahead of the stop notice or the failure. A desktop that predates the role drops
those rows, so a newer daemon is safe with it.

**Run tool results.** A run's transcript is append-only, so a tool call's
outcome is an entry of its own. The Claude executor logs each top-level
`tool_result` for a call the agent itself made as a `tool` entry with the call's
`toolUseId`, no `toolName`, `status` `done` or `error`, and no output: the
transcript and its run.log frames reach every request-tier client, and a result
can carry what the call read (the operator's exported memory, a personal doc, an
MCP answer). Showing output means scoping run.log first. A sub-agent's results
are not logged. The Codex executor logs a tool item when it starts and again
when it completes, both under the item id. The desktop folds each result into
its call by `toolUseId` (`lib/runLog.ts`), so a chip ends done or failed. In a
log that reports results, a call shows as running until its result lands; for an
older daemon, a scripted run, or a sub-agent's call, only the live edge does.
`dispatch run show` folds each result into its call's line (✓ or ✗);
`dispatch run --watch` and `run watch` skip result entries, since the call's own
line already printed.

**Rendering.** Both chats render live text through `StreamingText`
(`packages/ui`) with the app's Markdown: text that grows continues its reveal
from where it was, text that arrives whole shows at once, and a code fence still
open at the end is closed for display. Overseer narration renders as the agent's
prose, quieter than the reply, and live segments take the place of the "working"
row while there is text. Both chats use one approval card (`ToolApprovalCard`),
whose Deny takes an optional reason that reaches the model.

## Messaging

Agents, runs and people talk over one persistent bus
(`docs/specs/2026-09-23-messaging-core-design.md`).

- **`@dispatch-foo/protocol`** (MIT) holds the address grammar, the envelope and
  its validation, the `MessageStore` interface with its SQLite store, and the
  `DeliveryEngine`: it resolves recipients, chooses push, notify or hold, runs
  the wake policy and the guardrails, and replays unfinished work at boot. It
  reaches the outside world only through a `MessagingHost`.
- **The daemon is one host** (`packages/server/src/messaging/`). `host.ts`
  pushes into a live run's session through the orchestrator and wakes tasks;
  `principal.ts` resolves each caller to a human, a run or an approved agent and
  fails closed; `routes.ts` serves the routes; `gates.ts` runs a gate's effect
  once, before its answer is published.
- **Gates** are blocking questions to a human carrying typed `data`
  (`tool-approval`, `scope`, `wake`, `agent-registration`, `overseer-action`).
  Only a human at the decide tier can answer one.
- **Tables** (`messages.db`, machine-local): `messages`, `recipients`,
  `deliveries` (one per resolved recipient, each with its own state),
  `channels`, `members`, `agents`, `gate_effects`.
- **Clients**: the MCP's `msg_*`, `inbox_read`, `thread_read`, `channel_*` and
  `agent_list` tools; the CLI's `dispatch approvals`, `dispatch approve`,
  `dispatch message`, `dispatch scope` and `dispatch team agents`; the desktop's
  Threads view, each task's Thread tab, messages inline in the run chat, the
  gate cards, and Settings → Connected agents, all fed by
  `apps/desktop/src/hooks/useThreads.ts` and the one open-gates query.

## Clients

**Desktop** (`apps/desktop`, ~67.4k lines) is the primary surface: ~25 views
covering board, tasks, task detail, PR review, diffs, branches, milestones,
plans, sessions, agents, impact, inbox/brain-dump, threads, settings, gallery.

**CLI** (`packages/cli`) — commands include `init`, `mcp`, `task`, `plan`,
`milestone`, `serve`, `ui`, `doctor`, `run`, `runs`, `approve`, `message`,
`cancel`, `diff`, `review`, `scope`, `approvals`, `fanout`, `worktree`, `share`,
`team`, `sync`, `receipts`, `migrate`, `merge-task`, `merge-team`;
`dispatch --help` lists them all. Every read command takes `--json`.

**MCP** (`packages/mcp`) — stdio server registered into the project's
`.mcp.json` by `dispatch init`. 21 tools. Five (`task_list`, `task_get`,
`task_save`, `task_comment`, `task_next`) operate on `.dispatch/tasks/*.md`
directly and need no daemon; the other sixteen require a running `dispatchd` and
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
continue to exist. The server design is `docs/TEAM-SERVER.md`, and its scope is
wider than team features: the decided direction retires markdown as the task
write path entirely (daemon-owned SQLite solo, server-authoritative for teams),
which will eventually rewrite the "Where state lives" section above.

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

pnpm + moon monorepo. Tool versions (bun, pnpm, node, moon, gh) are pinned in
`.prototools` and installed via [proto](https://moonrepo.dev/docs/proto).
Dependencies are pinned in the `catalog` in `pnpm-workspace.yaml`; package
`package.json` files reference `catalog:` rather than versions. moon is the task
runner; each package also keeps a matching `package.json` script, deliberately
identical to its moon task, because knip's entry-point discovery and Tauri's
`beforeBuildCommand` both read scripts and cannot read moon tasks.

From anywhere in the repo: `moon run root:format` (oxfmt), `moon run root:lint`
(oxlint, type-aware), plus `root:lint-md`, `root:lint-spelling`,
`root:lint-css`, `root:lint-deadcode` (knip), `root:lint-dup` (jscpd),
`root:lint-arch` (dependency-cruiser), `root:lint-types`, `root:check-licenses`.
`moon ci` runs the affected-aware set of these in CI (see
`.github/workflows/ci.yml`).

Treat a failure as pre-existing until you have checked whether your own change
caused it. moon caches task results by input hash, so if a lane's verdict looks
suspicious, re-run it with `--force` (which bypasses the cache and the affected
check) rather than trusting a cache hit: `moon run root:lint --force`. Note that
`root:clean` deletes build output, not moon's cache — it is not the lever for
this.

## Known soft spots

Things that are true about the tree and worth knowing before you trust
something:

- Versioning: the app version lives in `apps/desktop/src-tauri/tauri.conf.json`
  and the release tag (v0.24.0 at the time of writing); the npm packages are
  unpublished and their `package.json` versions now track the app version.
  `src-tauri/Cargo.toml` still says `0.1.0` — harmless, since `tauri.conf.json`
  wins, but it is the one version string left unaligned.
- `docs/archive/design/` holds the earlier direction docs. The lovable pair fed
  the agreed storage/hosted direction (live milestones still reference their old
  `docs/design/` paths). `LICENSING.md` and `docs/TEAM-SERVER.md` are the
  current statements.
- The repo-local lint baseline is red, so CI signal on those checks is weak.
