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

`config.yml` is hand-written and reviewed, so Settings (`PATCH /api/config`,
core's `updateConfig`) edits it in place. Only the keys a save names change:
comments, key order and keys Dispatch does not know stay as they are, a long
line is not wrapped and CRLF line ends are kept. One thing the YAML library
rewrites anywhere in the file: an inline list or map comes back padded (`[a, b]`
as `[ a, b ]`, `{a: 1}` as `{ a: 1 }`), the style this repo's own config.yml
already uses. The loader checks the whole patched file before it is written.

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

Secrets live in `$DISPATCH_HOME/.dispatch/credentials.json` (mode 0600, written
atomically under `credentials.json.lock`, `packages/core/src/credentials.ts`):
each project's Linear API key and other integration keys, agent API keys, and
the person's own Linear sign-ins under `linearAccounts`, one record per Linear
workspace (organization) id, with the access and refresh tokens, the Linear user
they belong to and the OAuth app that issued them
(`packages/core/src/linearAccounts.ts`). A sign-in is machine-wide: every
project on this machine whose Linear connection is in that workspace uses it.
Nothing in a project's `.dispatch/`, the Linear sync state or `config.yml` ever
holds a token.

Keying by a hash of the project root means several projects share one
`DISPATCH_HOME` without colliding (`packages/server/src/orchestrator/paths.ts`).

The consequence: **task state is portable and shared; run state and memory are
not.** A teammate who clones the repo sees every task, finding and receipt, and
none of your runs or memory; replicating team memory is team-server work.

## Packages

| Package                  | Size                    | What it is                                                                                                                                                                                                |
| ------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@dispatch-foo/core`     | ~11.5k                  | Domain model. Task parse/serialize, `TaskStore`, actors, conflicts, timeline, ledger, findings, evidence, config, merge drivers, Carto binding                                                            |
| `@dispatch-foo/protocol` | ~2.0k                   | The message bus, MIT: addresses, the envelope and its validation, `MessageStore` over SQLite, `DeliveryEngine`                                                                                            |
| `@dispatch/memory`       | ~4.6k                   | The memory engine, MIT: entries and scopes, proposals, ranking, the prompt index, the SQLite store, Claude's memory file format                                                                           |
| `@dispatch/server`       | ~56.8k                  | `dispatchd` — HTTP API, event bus, orchestrator, git, Linear, board sync                                                                                                                                  |
| `@dispatch/cli`          | ~6.4k                   | The `dispatch` binary                                                                                                                                                                                     |
| `@dispatch-foo/mcp`      | ~2.8k                   | Stdio MCP server, 21 tools                                                                                                                                                                                |
| `@dispatch/client`       | ~4.1k                   | Typed API client and React hooks over the daemon                                                                                                                                                          |
| `@dispatch/ui`           | ~31.6k TS + 16.7k CSS   | The desktop's only component library (Gr8r Studio design system): shell, grouped task table, timeline, dependency graph, task detail, pickers, controls; source-consumed (the desktop's Vite compiles it) |
| `@dispatch/planning`     | —                       | Pure planning view-model builders from Better-Tracker's core: workspace snapshot, assessment, timeline, dependency graph, allocation                                                                      |
| `@dispatch/tokens`       | —                       | The design token palette (`tokens.css`) of the marketing site (`apps/site`); the desktop app is on `@dispatch/ui`                                                                                         |
| `apps/desktop`           | ~105.5k TS + 11.1k Rust | The Tauri app: the destinations under Clients, Rust shell, sidecar management                                                                                                                             |
| `apps/demo`              | —                       | Hosted sandbox. Embeds `startServer` in-process with `FakeExecutor`/`FakePlanner`                                                                                                                         |
| `apps/site`              | —                       | Static marketing server (Railway)                                                                                                                                                                         |
| `packages/demo`          | —                       | Seeds a demo repo — board, runs, records, teammate                                                                                                                                                        |

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
- **Integrations** — `/api/linear/*`, including "Sign in with Linear":
  `GET /api/linear/account` (what this caller may see of the sign-in, never a
  token), `POST`/`DELETE /api/linear/sign-in` (start, cancel) and
  `POST /api/linear/sign-out` (`{ workspaceId? }`: the app names the sign-in it
  shows, so signing out needs no Linear lookup). The last three need the
  operator tier and then the daemon owner's own app token (403
  `linear_sign_in_owner_only` otherwise). The account view shows a stored
  sign-in whatever the setup says, and lists every sign-in stored on the machine
  when the project's workspace cannot be told, so one can always be ended. While
  a sign-in waits, and only then, the daemon also listens on
  `127.0.0.1:<linear.oauthCallbackPort>` (default 47823) for Linear's redirect
  to `GET /linear/callback`; it checks the `Host` header, turns away any request
  a browser marks as other than a navigation, checks the state (a wrong one
  never ends the flow), takes one code, and closes after the callback, a cancel,
  a new start or 10 minutes (`linear/signIn.ts`)
- **Files** — `/api/files/*`: browse, read, search and preview a checkout or a
  run's worktree, every path held inside it by `api/workspacePaths.ts`. A page
  that authenticates with a bearer header downloads through
  `POST /api/files/download-ticket`, which checks the path and credential as
  `GET /api/files/raw` would and returns `{ ticket, expiresAt }`;
  `GET /api/files/raw?ticket=` then streams that one file once, as an
  attachment, with no header, within 60 seconds and while the credential that
  asked still holds. Tickets live only in the daemon's memory
  (`api/downloadTickets.ts`) and work on no other route. Minting one starts
  nothing and only lets one read through, so it stays open while team sync turns
  on, as reads do.
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

Any other agent that is a command-line program runs on `CliExecutor`
(`executors/cli.ts`): the presets in `executors/cliPresets.ts` whose binary is
on PATH, and every `executors.<name>.command` in config.yml. It has no approval
protocol (a gated `permissionMode` is refused, and the transcript opens by
saying nothing holds a floor command), no cost, turns or resume, and takes no
mid-run message. Its stdout lands as `assistant` entries one read at a time,
each marked `chunk: true` because a read ends wherever the pipe had data, often
mid-line or inside a code block; its stderr lands as `system` entries. The
desktop's run chat (`groupLogEntries` in `apps/desktop/src/lib/runLog.ts`) joins
consecutive chunks into one text in the first one's place before rendering it as
Markdown, so a code block or a list cut between reads renders whole; each chunk
keeps its own entry, and run.log's `index`, in the transcript. A stderr line or
a tool row between two reads starts a new text, and a transcript logged before
the marker existed renders chunk by chunk as before. That text grows with every
read while the run is live, so the live row draws it one Markdown block at a
time (`StreamingText`'s `blocks`, split by `splitSettledMarkdown` in
`packages/ui`): a read re-parses the block still open, and each finished one is
parsed once. The finished run's row is one Markdown again.

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

### Overseer records

Every `/api/overseer` route that answers with a conversation sends it through
`OverseerManager.view`, which adds to the stored record what the daemon knows
beside it and never stores: `live` while a turn runs (see
[Live text](#live-text-narration-and-tool-results)), `contextLimit` and
`revoked`. `contextLimit` is `ROLLOVER_TOKENS` (150,000): once the record's
`contextTokens` reaches it, the next turn starts a fresh session from a recap of
the latest lines, behind a divider, and the old session's grants end. The
desktop's status line shows the share as "62% context". `revoked` says the
daemon's Overseer agent is not approved, the same check that refuses a turn with
409 `overseer_revoked`. Approving or revoking that agent's own row broadcasts
`overseer.changed` for every conversation, so each window refetches the record
it shows and shows the agent off, or back on, without a send of its own refused
first. The session (`useOverseerSession`) takes whichever came last: a record
that landed, a send refused as revoked (which refetches the open record) or a
send that worked. Only an open conversation's record can say the agent is back,
so the desktop locks the composers on `revoked` only while a conversation is
open (`revokedLocksComposer`); with none open, the banner shows after a refused
send and the next send decides.

The session holds the Overseer page's unsent message (its draft and attached
files), and `submit` sends and clears it. Another surface with a composer of its
own, a Threads reply or the "say something" box in Tasks, sends with `reply`,
which opens the conversation when none is open, takes that surface's own files
(uploaded with `upload`), rejects on failure and leaves the page's message
alone.

## Live text, narration and tool results

The Overseer chat and a task run's chat show an agent at work, not only what it
settled on. Three pieces do that: **live text** (the words of a running turn,
streamed and never stored), **narration** (the Overseer's prose between tool
calls, stored as rows) and **tool results** (how each tool call ended: a run's
stored as entries, the Overseer's as a status on its tool row).

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

**Snapshot.** Every Overseer route that answers with a record (see
[Overseer records](#overseer-records)) and `GET /api/runs/:id` add
`live: { seq, turnId, segments }` while a turn runs, so a window that opens or
reconnects mid-turn starts from what was already written. The stored record and
the run transcript never hold it. The buffer is
`packages/server/src/liveText.ts`, in memory only.

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

**View updates.** The client store applies each frame as it lands, so a read
(`get`, the snapshot `useSyncExternalStore` takes) is always current, but it
tells its views at most once per animation frame, or on the next macrotask where
the host paints none. A turn sends a frame every few tokens, each in a websocket
message of its own, and the Overseer's live text is read at the desktop's App
root (`useOverseerSession`), so telling the views of every frame re-rendered the
whole app per delta; a burst now renders once per painted frame. A hidden window
paints no frames, so its views catch up on the first one it paints.
`LiveTextStore` takes its scheduler as a constructor argument, and its `flush()`
tells the views at once, so a test decides when frames happen.

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
opened with the shared agent token.

**Run audience (decided 2026-10-26).** A run's transcript entry for a bus
message (`kind: 'message'` with a `messageId`: a message delivered to the run, a
channel digest, the run's own message to a person) follows that message's
audience. Its `run.log` frame reaches the sockets `messageAudience` accepts
whole and every other socket as
`{ ts, kind: 'message', messageId, redacted: true }` at the same `index`, so
every window counts the same entries. `GET /api/runs/:id` redacts the same way
by caller, under the bus's read rule (`DeliveryEngine.canRead`): a run's own
token reads as that run (the messages delivered to it and its own), the shared
agent token reads none, and a person reads the messages they take part in, or
every one at the `decide` tier. Every other entry (the agent's own work, the
Session composer's turns, a daemon notice from docs or memory, which carries no
`messageId`) and `run.delta`, the agent's own text as it writes it, reach every
socket and every request-tier caller: run detail already returns the agent's
entries to all of them once they are written. So a Dispatch tool call that
writes text kept for fewer readers loses that text before the daemon writes any
executor's entry (`withoutScopedText` in `orchestrator/types.ts`, under Claude's
`mcp__dispatch__<tool>` and Codex's `mcp.dispatch.<tool>` names): the executor
logs the call as it starts, before anything says where the text went, so the
entry has no id to redact it by. `GET /api/runs/:id` applies the same rule again
as it reads, so a transcript an older daemon wrote, with those inputs whole,
serves them as a new one does. `msg_send` / `msg_reply`, the only way a run
reaches anyone, keep where the message went (`to`, `kind`, `messageId`,
`blocking`, `urgent`, `wake`); the text reaches a reader through the message's
own entry, and a message to another agent, which gets none on the sender's
transcript, through the bus thread. `doc_save` keeps `doc`, `slug`, `scope`,
`baseRev`, `links` and each op's kind, not its body, title or op text: a
personal doc is its owner's, a run's edit to an accepted team doc is a proposal
for deciders and the run's operator, the docs routes refuse the shared agent
token, and a `doc-…` ref does not say which applies. `memory_save` keeps
`scope`, `kind`, `refs`, `milestone`, `appliesTo`, `supersedes` and
`projectOnly`, not its title (the lesson itself) or body, for the same reasons,
and `memory_forget` keeps the memory's `id`, not the reason. A Claude run's
`Write`, `Edit`, `MultiEdit` or `NotebookEdit` call on a file inside a Claude
memory export (`claudeMemoryRoot`, where export mode has the run save memories
as usual) keeps only its `file_path` (`notebook_path`): Dispatch keeps a file
written there as the operator's personal memory, and an edit's old text is one
already exported to them. Every other tool's input stays whole: ids and queries,
or text every transcript reader may already read (a task, a task comment, an
inbox item, evidence, a file in the run's worktree) or that leaves Dispatch (a
Linear comment). Redaction of message entries happens on the way out; the stored
transcript keeps them whole, and the daemon's own readers (review summaries,
judgments, memory) read it as stored. The two sides reuse the bus's own two
rules, so a run's chat shows a message where the bus does, and they differ at
the edges as the bus's do: the socket rule also counts a message's `to`
addresses and its recipients on a teammate's machine, and the read rule lets a
run's token read for its whole task (its task's address and other runs). The
desktop, `dispatch run show`, `--watch`, `run watch` and `dispatch share` show
nothing for a redacted entry, and the CLI, which uses the shared agent token,
gets every bus message's entry redacted.

**Switches.** Two `.dispatch/config.yml` blocks, read when a turn or a run
starts, so a change applies from the Overseer's next turn and to runs started
after it. They are rollback switches, so both default to `live`; YAML `true` and
`false` read as `live` and `off`. Settings → Agents → Streaming sets them
through `PATCH /api/config` (`overseer: { stream }`, `runs: { stream }`; `null`
removes the key), at the decide tier every config save needs.

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
`toolUseId`, no `toolName`, `status` `done` or `error`, and no output: tool
entries and their run.log frames reach every request-tier client, and a result
can carry what the call read (the operator's exported memory, a personal doc, an
MCP answer). Showing output means scoping tool entries the way message entries
are. A sub-agent's results are not logged. The Codex executor logs a tool item
when it starts and again when it completes, both under the item id. A completed
command keeps its output, cut at `MAX_TOOL_RESULT_TEXT` characters with
`… (truncated)` as an Overseer tool row is, because the run chat has always
shown a Codex command's output. The desktop folds each result into its call by
`toolUseId` (`lib/runLog.ts`), so a chip ends done or failed. In a log that
reports results, a call shows as running until its result lands; for an older
daemon, a scripted run, or a sub-agent's call, only the live edge does.
`dispatch run show` folds each result into its call's line (✓ or ✗);
`dispatch run --watch` and `run watch` skip result entries, since the call's own
line already printed.

**Overseer tool status.** An Overseer `tool` row carries a `status` (`running`,
`done` or `error`) and, for a built-in call, the backend's id for it as
`toolUseId` (Claude's tool_use id, Codex's item id); never the call's output, by
the same rule as a run's results. A built-in call the backend reports with an id
(`onToolUse`) lands `running`, and `onToolResult` settles that row in place, in
one `overseer.changed`: Claude reports each top-level `tool_result` for a call
it reported (`is_error` is an error), Codex a tool item's `item/completed`
status (`failed` or `declined` is an error). A registry call's row lands `done`
or `error` once the call ran. A row still `running` when its turn ends (a Stop,
a failed turn, a result that never came) is settled `done` in the update that
ends the turn, and at boot for a turn the daemon died in: `done` there says the
call is over, not that it worked, and a result that comes later changes nothing.
One turn runs at a time, so a `running` row is always the running turn's. The
desktop shows a `running` row without its shimmer, as a plain chip, on a record
that is not `running` and while the turn is parked on an approval, which waits
on the human as the card above it says. Rows from before `status` keep the old
reading, failed when the text starts with `error:`.

**Rendering.** Both chats render live text through `StreamingText`
(`packages/ui`) with the app's Markdown: text that grows continues its reveal
from where it was, text that arrives whole shows at once, and a code fence still
open at the end is closed for display. A CLI agent's joined output, which grows
for the whole run, is drawn a block at a time (see `CliExecutor` above).
Overseer narration renders as the agent's prose, quieter than the reply, and
live segments take the place of the "working" row while there is text. Both
chats use one approval card (`ToolApprovalCard`), whose Deny takes an optional
reason that reaches the model.

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
  Only a human at the decide tier can answer one. An Overseer gate waits on
  state the daemon holds in memory (a parked tool call, a queued action), so the
  boot sweep closes it, and the Overseer's records drop what it asked about: a
  parked call leaves `pendingApprovals` when its turn loads as restarted, and a
  queued action leaves `pendingActions` with a denied row, the model told on its
  next turn, so no card asks about something nothing can decide.
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

**Desktop** (`apps/desktop`, ~105.5k lines of TypeScript) is the primary
surface. Its sidebar lists the destinations
(`apps/desktop/src/lib/shellRoutes.ts`): Overseer, Issues (list and board),
Needs you, Timeline, Graph, Threads, Docs, Runs (Settings' runs page) and
Settings, which opens as a page in the main column. Live opens from the Runs
page and sits under it: the sidebar marks Runs current there, and Escape or the
"Runs" chip goes back to it. The Projects register (also the sidebar Projects
section's "All"), Files, Terminals and Live also open from the command menu
(`apps/desktop/src/lib/paletteEntries.ts`), and the quick-open chord (⌘P on
macOS, Ctrl+P elsewhere) opens quick open over the project's files. Every view
is built from `@dispatch/ui`; the rules it follows are under
[Desktop design system](#desktop-design-system).

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

## Desktop design system

The desktop has one UI layer, `@dispatch/ui` (`packages/ui`): Gr8r Studio's
layout and look with a purple accent, ported from Better-Tracker, whose
`docs/architecture.md` §8.2 was its spec. This section holds the rules Dispatch
follows. `packages/ui/README.md` is the API reference (every component, prop and
behaviour), and `.agents/skills/desktop-ui/SKILL.md` tells a contributor what to
reach for. Checked against the tree on 2026-11-03.

Two tests hold most of it. `packages/ui/test/styles-contrast.test.ts` checks
every text token at 4.5:1 and every mark and control edge at 3:1 on every
surface in both themes, the tone hook's mapping, the dark floor and that no
library file reads a retired token. `apps/desktop/src/styles/gr8r-rules.test.ts`
scans every file under `apps/desktop/src` for hex values, retired tokens,
unresolved `var()` reads, utility classes, removed focus outlines and uppercase
text.

**Layout.** A sidebar shell (`AppShell`) with a command palette; tasks in
grouped lists (`TaskGroupTable`) with a Kanban board as the Issues list's other
mode; a Gantt Timeline; a dependency Graph; a Projects register; a slide-over
drawer and a full page for a task; Flight Plan inside container pages (projects
and milestones); Live under Runs. Live's and Flight Plan's headers use the
compact `StatsStrip` (one 26px row of inline cells that scrolls sideways inside
itself on a narrow column: edge fades, a tab stop only while it overflows or
holds focus, a vertical wheel turned sideways), with the header's controls in
its `end`, so the bands and the canvas keep their height. Their keys and notes
stay short, so the cells and the controls share the row at common widths, but
each still says what it counts; a cell's `title` adds detail and never holds the
only copy of a fact. While a fan-out runs, Flight Plan puts Running, the ETA and
the critical path first, since its controls leave the strip little room and the
fade hides the end. Its fan-out's slots picker (in the Running cell, after the
slots in use), spend and waves are cells, so its `end` holds only the verbs
(Pause and Stop, or the paused pill, Resume, Raise ceiling… and Stop); a spend
near its ceiling comes straight after Running, and a paused session's spend
leads the strip, so neither is ever behind the fade. While a fan-out runs or is
paused (owner decision 2026-11-04), Pause and Stop there are icon-only (named
Pause and Stop, each with a Tooltip saying what it does; Stop then confirms in a
`ConfirmDialog`, since only its glyph sets it apart from Pause) and the cells'
notes move into their hints (`StatsStrip` `notes="hint"`: a Tooltip on hover and
keyboard focus; the note stays in the cell's text for a screen reader). Live's
spend note does the same, its key saying which amount the value is ("Today" for
today's spend, else "Spend" for the live fan-outs' settled spend), so Live's
cells fit beside Pause all at 1024px. A touch screen opens no Tooltip, so there
both strips keep their notes on the row and Pause and Stop keep their words
(`useTouchScreen`). That still left Plan at 1440px (a Plan column of about 654px
beside the Properties panel) 178px too wide while a fan-out ran and 304px while
paused, so (owner decision 2026-11-04, the owner's "just figure it out") Plan's
header, while a fan-out runs or is paused, has no Queued or Landed cell: their
counts are the Running cell's note ("3 queued · 5 of 12 landed", in words since
the note is what a screen reader hears; a part with nothing to say dropped: no
queued part with nothing queued, no landed part with nothing in the plan), so
every count stays in its hint, in its text for a screen reader and on the row on
a touch screen, where the note takes Running's blue as any toned cell's note
does. That cell keeps one React key in every mode, so keyboard focus on it
survives the fan-out's end. It draws its slots in use as text ("2/4", read as "2
of 4 agent slots in use") with no meter track, so all slots taken no longer
turns it amber ("4/4" says so); a Slots cell split off by runs past the slots
keeps the warning tone. The slots picker after the text has a library Tooltip,
and the cell's hint keeps away from the picker and its menu (`StatsStrip`). The
paused verbs Resume and Raise ceiling… are icon-only like Pause and Stop (named,
each with a Tooltip, words kept on a touch screen); Resume's tip follows why the
session paused, since after a run or spend ceiling it pauses again at once and
only Raise ceiling… goes on. Every cell is then on screen at 1440px, running,
near the spend ceiling and paused, with a spend under $1,000 and a short pause
reason (65px, 47px and 81px to spare, measured on 2026-11-04); a four-digit
spend near its ceiling, or beside the "auto-dispatch failed" pill, is 1–2px over
and its last cell goes behind the fade. With no fan-out Plan keeps its Ready and
Landed cells; the milestone bands, the Milestones page and Live keep their
worded verbs, and Live its slots meter. A review diff (`PierreReviewDiff` for a
settled run, `RunDiffView` for a live one, both through `useFittedDiffLayout`)
draws a split setting unified while its column is under 980px.

### Tokens only

- Every colour, size, radius, shadow and motion value is a token from
  `packages/ui/src/styles/tokens.css`. No hex anywhere else; the one exemption
  is `apps/desktop/src/lib/terminalPalette.ts` (the 16 ANSI colours). A tint the
  tokens do not cover is added to `tokens.css` first, then used.
- The pre-Gr8r names (`--paper`, `--ink`, `--background`, `--foreground`,
  `--muted`, `--grey*`, `--tint`, `--hatch`, the `-ink` steps and the rest of
  `RETIRED` in `packages/ui/test/contrast-helpers.ts`) are removed and never
  come back.
- **Surfaces**, back to front: `--bg` (behind everything), `--bg-side` (the
  sidebar), `--surface` (main column, panels, drawer, menus), `--surface-2`
  (hover), `--surface-3` (pressed, tracks), `--sunken` (recessed wells),
  `--overlay` (the scrim). Light is
  `#fbfaf8 / #f4f3f0 / #ffffff / #f6f5f2 / #eeede9 / #f7f6f3`. Dark is a soft
  warm charcoal, redefined rather than inverted, and nothing is darker than
  `#1a1a19` (the sidebar):
  `#1c1c1b / #1a1a19 / #20201f / #272726 / #2e2e2c / #1c1c1b`.
- **Lines**: `--divider` < `--border` < `--border-strong` are decoration. The
  edge of anything a person types in or toggles is `--control-border` (`#8c8880`
  light, `#7c7974` dark), 3:1 on every surface.
- **Text**: `--text`, `--text-2` and `--text-3` hold 4.5:1 on every surface in
  both themes; `--text-4` is for idle icons only, never words; `--text-inv` is
  text on an inverted fill (a toast, a tooltip, the bulk bar).
- **Accent** `#9747ff` in both themes, in Gr8r's accent role only: the primary
  button (one per view), focus rings, selection, progress fills, the timeline's
  today, unread dots and counts, query highlights and links. It never means a
  status. Purple text is `--accent-ink` (`#7c33ea` light, `#b385ff` dark).
- **Elevation** only on things that float or can be picked up: popovers, menus,
  pickers, dialogs, the palette, toasts and the bulk bar (`--shadow-pop`), the
  drawer (`--shadow-drawer`), a dragged card or row (`--shadow-drag`). Panels,
  rows, banners, chips and inputs have none.
- **Shape**: radius from `--r-xs` (4px) to `--r-xl` (12px); row heights,
  paddings and text sizes come from the primitives, so neighbouring surfaces
  line up. A missing variant is added to `packages/ui` with a test and a README
  line, never restyled locally.

### Status colours

The hue table (owner decision Q6, the same as Better-Tracker's): **red** is
overdue and failed; **amber** is at risk, blocked, a missing input and waiting
on you; **green** is on track and succeeded, which includes review (the agent's
work succeeded and waits on a person); **blue** is in progress and live
(working, landing, an active session); **grey** is paused and inactive. Done,
landed and merged are the filled neutral mark, never green beside a red. The
purple accent is never a status.

A status is coloured only through a `UiTone` (`default`, `muted`, `accent`,
`danger`, `warning`, `success`, `info`). A component renders its tone as
`data-tone`, and the hook in `tokens.css` gives that element `--tone` (the hue:
fills, dots, outlines), `--tone-ink` (its text, 4.5:1), `--tone-soft` (the
tint), `--tone-line` (a tinted border) and `--on-tone` (text on a solid fill). A
status word in a host's own markup is `<span class="toneText" data-tone="…">`;
never `color: var(--red)`. Dispatch's states map through these helpers (paths
under `apps/desktop/src/`; the skill lists the rest):

| States                                                                 | `danger` | `warning`                             | `success`    | `info`                                    | `muted`                                                | neutral mark                      |
| ---------------------------------------------------------------------- | -------- | ------------------------------------- | ------------ | ----------------------------------------- | ------------------------------------------------------ | --------------------------------- |
| task status (`statusTone`, `lib/statusTone.ts`)                        | —        | held by a dependency (`BLOCKED_TONE`) | review       | working, landing, a started custom status | draft, ready, dropped, triage, backlog, todo, canceled | landed, a completed custom status |
| feed state (`feedStateTone`, `lib/feedState.ts`)                       | broken   | your move, blocked                    | review       | the machine's move                        | resting                                                | —                                 |
| milestone child (`phaseTone`, `lib/milestoneSession.ts`)               | failed   | capped, held, waiting, blocked        | needs review | working, reviewing, fixing, landing       | —                                                      | the rest                          |
| session (`sessionStatusTone`, `components/sessions/sessionDisplay.ts`) | —        | —                                     | —            | active                                    | ended                                                  | —                                 |

- **Four looks, loud to quiet**: the tinted badge (`Chip filled`, `Notice`,
  `AlertStrip`, a count) for the stronger claim or a call to action; the dot
  pill (an unfilled status `Chip`: neutral, a 6px dot in the hue) for a
  lifecycle status that is not a problem; toned text (`.toneText`) for a bare
  word, number or date; plain quiet text for muted. No solid status slab, and no
  row rule: a row that needs action says so with a tinted chip or a toned cell.
- **Colour is never the only cue.** Every status keeps its shape and its words
  (a visible label, an `aria-label` or a tooltip). Milestone statuses are
  diamonds and task states circles (`StateGlyph`), so the two never look alike;
  done is the neutral fill with a knocked-out tick, because a green fill is as
  light as the red one.

### Contrast, forced colours and motion

- Text holds 4.5:1; marks, control edges and the focus ring hold 3:1, in both
  themes. A pressed toggle (`Button` or `ChipButton` with `aria-pressed`) is the
  accent tint in a full `--accent` edge, which holds 3:1 on `--bg`, `--bg-side`,
  `--surface`, `--surface-2` and `--sunken` (not on `--surface-3`, so toggles
  stay off that ground).
- Code fences in Markdown are highlighted by Shiki with GitHub's high-contrast
  themes (`github-light-high-contrast`, `github-dark-high-contrast`): every
  token colour holds 4.5:1 on the fence's `--sunken`, `--surface` and
  `--surface-2` in its theme
  (`apps/desktop/src/components/runs/markdown/highlight.test.ts`).
- Focus is a 2px `--focus-ring` outline, never `outline: none`.
- Forced colours keep every shape: anything drawn with backgrounds alone takes
  `forced-color-adjust: none` and system colours, and edges are borders.
- Reduced motion is a designed state: transitions off, no scale, lift or
  shimmer. Hover styles apply only under `(hover: hover)` at 901px and wider. A
  theme change never animates.

### Type

Geist (`--font-sans`) for every word, in sentence case, at weights 400, 450, 500
and 600 on the `--fs-2xs` to `--fs-2xl` scale. The one uppercase voice is the
library's `.eyebrow` (sidebar, menu and palette section headings). Geist Mono
(`--font-mono`, `.mono`) is only for machine-read strings: task ids, keys,
paths, commands and code. Counts and dates are Geist with tabular figures
(`.num`). Icons are Lucide. The fonts come from `@fontsource-variable/geist` and
`@fontsource/geist-mono`.

### Theme

Light, dark or System. `html[data-theme]` is `light`, `dark` or `system` (which
follows the OS live through `prefers-color-scheme`). A choice of Light or Dark
is stored in `localStorage` under `dispatch:theme`; nothing stored means System.
The inline `themeScript` (injected by `apps/desktop/vite.config.ts`) applies it
before first paint. The sidebar footer's toggle flips between light and dark,
Settings → General → Appearance offers all three, and the palette's "Follow the
system theme" goes back to System. Storage is per origin: one for the Tauri app,
one per daemon port in a browser. In the Tauri app, `followThemeInNativeWindow`
(`apps/desktop/src/lib/nativeTheme.ts`) sets the window's native appearance (its
background where the page has not painted, the area a resize exposes, native
menus) from `html[data-theme]` at startup and on every change, through
`getCurrentWindow().setTheme` (`null` for System) and the
`core:window:allow-set-theme` capability. The choice is also remembered natively
(`remember_window_theme`, a `window-theme` file in the app config dir), and
setup builds the window (`create: false` in tauri.conf.json) with that theme, so
a launch opens in the chosen appearance from its first frame.

### Overlays: one layer stack

Every overlay renders in place on the layer stack
(`packages/ui/src/shell/layer.ts`), never in a portal. The floating layers
(`Popover`, `PickerPopover`, `Menu`, `Tooltip`, `Dialog`, `ConfirmDialog`) use
the browser's top layer; a modal panel over a scrim (a modal `SlideOver`, a host
panel on `useModalSurface`) stays out of it. Escape closes the topmost layer
only, one per press: its handler calls `preventDefault()` and
`stopPropagation()`, document listeners check `defaultPrevented`, and focus
returns to each opener in turn. A modal surface sets `aria-modal="true"`, so
`useGlobalKeyboard` stays quiet while it is open.

### Slide-over or full page

A task opens two ways, with the same sections in the same order (Gr8r's task
drawer):

- **Slide-over** (`TaskSlideOver`, 620px from the right): a row click or Space.
  On a desktop it has no scrim, so the list beside it stays usable; on a phone
  it covers the page over the scrim. Escape closes the nearest thing first (an
  open picker, a field being edited), then the drawer.
- **Full page** (`TaskDetail` with `layout="page"`): Enter or `o` on a focused
  row, or Open page in the slide-over. Escape or Back returns to the list with
  focus on the row it came from.

A form over a page (the task composer) is a modal `SlideOver`, a short focused
form a `Dialog`, a destructive confirm a `ConfirmDialog`.

### Keyboard map

Resolved in `apps/desktop/src/lib/keyboard.ts` (pure) and wired by
`hooks/useGlobalKeyboard.ts`; `?` shows the shortcuts sheet. "Mod" is ⌘ on macOS
and Ctrl elsewhere.

- **Command palette**: Mod+K anywhere, or `/` outside a text field.
- **Quick open** (go to file): ⌘P on macOS, Ctrl+P on other platforms. It works
  while typing. On macOS, Ctrl+P is never claimed: it keeps Cocoa's "previous
  line" in every text field. Over a modal the chord is claimed and does nothing,
  so the browser's print dialog never opens in its place.
- **Modifier chords** (work while typing): Mod+, Settings; Mod+[ and Mod+] back
  and forward; Mod+1 Overseer, Mod+2 Issues, Mod+3 to Mod+9 the Issues presets
  in chip order; Mod+= / Mod+- / Mod+0 zoom. Mod+D (Drop a thought) and Mod+B
  (sidebar) stay dead while typing or under a modal.
- **Bare keys** (never while typing or under a modal): `c` new task, `[`
  sidebar, `?` shortcuts, and the `g` chords: `g a` or `g o` Overseer, `g t`
  Issues, `g i` Needs you, `g l` Timeline, `g g` Graph, `g m` Threads, `g s`
  Settings, `g f` and `g r` the in-flight and review presets.
- **On a focused list** (`resolveListKeyCommand`; each view takes the subset it
  handles, the Issues list all of them): `j`/`k` or the arrows move, Enter or
  `o` opens the page, Space the slide-over, `x` selects, `s` `p` `a` `l` `m` set
  status, priority, assignee, labels and milestone, `d` dispatches, `f` filters,
  ⇧V opens display options, Escape clears the selection.

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
- **Linear** — two-way sync, team/state mapping, import (`linear/`). The project
  connection is an API key (per project in `credentials.json`, or
  `LINEAR_API_KEY`); background sync, imports, webhooks, labels, projects,
  milestones, every read, and anything an agent, a run, the CLI's agent token, a
  teammate or board sync changes go through it.
  - **Sign in with Linear.** The person running Dispatch can also sign in with
    their own Linear account (OAuth 2 with PKCE S256, no client secret, scopes
    `read,write`; `linear/oauth.ts`). The desktop opens Linear's consent page in
    the system browser; Linear redirects to the daemon's loopback listener,
    which exchanges the code, checks that the token's workspace is the
    connection's (a token for another workspace is revoked at once and nothing
    is stored), and stores the pair in `credentials.json`. The client ID comes
    from `DISPATCH_LINEAR_CLIENT_ID`, then `linear.oauthClientId` in
    `config.yml`, then Dispatch's own public OAuth app
    (`BUILT_IN_LINEAR_CLIENT_ID` in `linear/signIn.ts`, always on port 47823). A
    project's own app's callback URL must be exactly
    `http://127.0.0.1:<linear.oauthCallbackPort>/linear/callback`.
  - **Which credential each write uses.** Issue updates and creates (with their
    relations, links and archive follow-ups), comments and "Share to Linear" go
    out with the person's token, as `Authorization: Bearer`, when they are
    signed in for the project's workspace with `write` granted and the value is
    theirs; everything else uses the connection exactly as before. "Theirs" is
    decided by an in-memory ledger (`linear/personEdits.ts`): the task routes
    record, only for requests on the owner's app token, which task parts the
    owner set and a digest of each value, and every other write the daemon sees
    (each `task.changed`, and each local write a sync pass makes) drops the
    entries it moved, so a value someone else sets back later is theirs. A push
    splits by writer: the fields the owner owns go with their token, the rest
    with the connection, so neither is credited for the other's values. A new
    issue is created by whoever wrote its title, and the other side's fields
    follow on the next push. A comment goes with the person's token only for a
    body or a delete the owner sent through this daemon's API (the ledger keeps
    a digest), and an edit or delete only when Linear also says the signed-in
    user wrote it (the comment link's fourth element); a comment file that
    arrived by git or board sync, even one authored as the owner, goes through
    the connection. Edits made with the `dispatch` CLI use the shared agent
    token, so they are not credited.
  - **Tokens.** Refresh starts 5 minutes before expiry and runs one at a time
    across processes (`credentials.json.linear-refresh.lock`, re-read, then a
    compare-and-set on the old refresh token). A refresh that cannot finish (no
    answer, a throttle, a 5xx) keeps the record and, while it has not expired,
    the current token. Any other refusal from the token endpoint
    (`invalid_grant`, `invalid_client`, another 4xx) deletes the record, revokes
    it unless the grant is already dead, and the account view names the reason;
    the next pass uses the connection. A refreshed `scope` Linear leaves out
    keeps the stored one. Only a token Linear did not accept (401, or
    `AUTHENTICATION_ERROR`) refreshes once and retries once; a refusal of the
    write itself (403, a permission) does neither. A write Linear refuses with
    the person's token is recorded like any failed push, stays theirs, and is
    retried with their token, never with the project key. Sign-out deletes the
    record first, then revokes the grant at Linear. Token requests and the
    person's GraphQL requests never follow a redirect.
  - **The client secret.** `DISPATCH_LINEAR_CLIENT_SECRET`, the escape hatch for
    an app that turns out to want one, is read once at boot and removed from the
    daemon's environment, and `childEnv` drops every `DISPATCH_*SECRET*` as it
    does `DISPATCH_*TOKEN*`, so no agent run or terminal inherits it.
  - **Guests** sign in like anyone: Linear lets them act as members in their own
    teams, and what it refuses is recorded with its reason. Dispatch adds no
    block of its own.
  - **Board sync.** Edits that arrive from another machine are never in this
    daemon's ledger, so they never use this machine's token; with Linear sync on
    several machines, an edit may reach Linear first through another machine's
    connection.
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
