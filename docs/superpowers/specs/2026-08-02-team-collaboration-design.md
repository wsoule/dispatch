# Spec: Team collaboration — actors, board sync, presence, and claims

**Date:** 2026-08-02 **Status:** approved; implementation deferred

Implementation is held until the in-flight branches land. Several agents are
making major changes concurrently — `feat/orchestration-capabilities` among them
— and this spec touches `packages/core/src/types.ts`, the orchestrator, and the
desktop task components, all of which are moving. Re-read §4's file references
against the tree before planning; they were accurate at `main` @`40ee234` and at
`feat/orchestration-capabilities` @`7777b45`.

Sequencing note: §4.11's audit export depends on the `risk` / `writes` / `model`
/ `findings` / `ledger` model added in `6ec45d9`, which lives on
`feat/orchestration-capabilities`, not `main`. The implementation branch either
stacks on that branch or waits for it to merge.

Reference point: [Mesh](https://entire.vc/mesh/) — "task management for human +
AI teams," MCP-native, event-driven, Go + Postgres + NATS, self-hosted. Mesh
answers the team problem with a shared server. This spec answers it with git,
and says why.

## 1. Problem

Dispatch is a single-operator tool. Put three developers on one repo and seven
distinct things break:

| #   | Failure                                   | Where                                                      |
| --- | ----------------------------------------- | ---------------------------------------------------------- |
| 1   | Task edits never reach teammates          | `autoCommit` is declared and validated but read by nothing |
| 2   | A task cannot name _which_ human or agent | `packages/core/src/types.ts:10`                            |
| 3   | Every review comment is authored by "You" | `packages/server/src/reviewComments.ts:150`                |
| 4   | Two people dispatch agents on one task    | no claim signal exists                                     |
| 5   | Activity-log appends conflict on merge    | no `.gitattributes`, no merge driver                       |
| 6   | Inbox writes conflict destructively       | `packages/server/src/inbox.ts:221` (whole-file rewrite)    |
| 7   | Alice's agent cannot see Bob's            | `run_list`/`agent_message` are loopback-scoped             |

Failure 1 deserves emphasis: `autoCommit` is defaulted in
`packages/core/src/config.ts:53`, validated at `config.ts:307`, and editable
from the Settings screen via `packages/server/src/api.ts:518` — and no code path
reads it. (`autoCommitIfDirty` in the orchestrator is unrelated; that is
run-scoped worktree cleanup.) A task edit today writes a markdown file and
stops. The durable half of team sync is not stale; it never leaves the machine.

Failures 1-3 and 5-6 are durable-state problems, independent of any coordination
protocol. Only 4 and 7 need one.

### 1.1 The structural tension

Task files must live in the working tree — that is the founding thesis
(`docs/superpowers/specs/2026-07-13-agent-orchestration-platform-design.md` §2:
agents grep and edit them with plain file tools). But the working tree is
branch-scoped. So the board forks every time anyone cuts a branch, and every
orchestrator run branch carries its own snapshot of the entire task set.

This has already drawn blood. Commit `53190d6` fixed a case where "checking out
a branch holding an older revision of a task file made every one of those tasks
outstanding and sent the older content straight to `updateIssue`" — a bulk
overwrite of a linked Linear backlog with older content. The fix was monotonic
per-task accounting: a task is outstanding only when its `updated` is strictly
past the version last accounted for.

That fix is really _a rule about which timeline is authoritative_, discovered
under pressure and applied to exactly one consumer. With three people pushing
branches it stops being an edge case, so this spec promotes it to a system-wide
invariant (§3.2).

## 2. Scope

**In scope.** Named human and agent actors; attribution on every mutation;
automatic board sync anchored to trunk; merge hygiene for multi-writer task
files; presence, claims, and duplicate-dispatch prevention over git refs;
cross-machine `run_list` and `agent_message`; a Team surface in the desktop app,
CLI, and MCP; exportable audit.

**Out of scope** — see §9 for the full list, but notably: a relay server, RBAC,
SSO, real-time (sub-second) sync, and cross-repo fleet views. §4.8 and §4.11
keep the seams for those clean without building them.

**Team shape targeted:** 2-8 humans on one repo, each running their own Dispatch
and their own agents.

## 3. Design decisions

### 3.1 Actors: humans and agents are both first-class

Rejected: humans-only with agents attributed to their operator (smallest change,
but agent addresses are what make cross-machine messaging and
assign-to-a-specific-agent expressible); and one seat per install (simplest
protocol, but loses per-agent addressing).

Git flattens this anyway — every commit an agent makes is authored by its
operator — so agent identity is a Dispatch-level concept that git attribution
does not carry. That is acceptable: the durable record of _which_ agent acted
lives in the task Activity log, `findings.jsonl`, and the run record, all of
which are committed.

### 3.2 The board is trunk (the timeline invariant)

> **Invariant.** The board is the state of `.dispatch/` on trunk. A task
> revision reached by any other route — feature branch, worktree, run branch —
> is a _snapshot_: readable, never authoritative, never a sync input.

Rejected: committing task edits on whatever branch you are standing on (the
`53190d6` failure becomes routine rather than exceptional, and every teammate's
view depends on their checkout); and a canonical board in `refs/dispatch/state`
outside the working tree (cleanest separation, but the biggest departure from
"the files just _are_ the tracker," and the board stops being visible in PRs,
forks, CI, and the host's web UI).

### 3.3 Coordination rides git refs, not a server

Presence and claims live in `refs/dispatch/*` — outside `refs/heads`, one ref
per writer.

The founding spec (§2) rejected git refs for _task storage_ on three grounds:
forks, hosting, and CI do not carry them; they are opaque; they need an API to
read. None of those reach presence data. Presence does not need to survive a
fork, does not need to reach CI, and agents never grep it — they call
`run_list`. The original reasoning argues _for_ this narrow use, and this spec
records that so it does not read as a reversal.

Rejected: a relay server (real-time and genuinely more capable, but every team
must run, secure, and upgrade something — and that is the point where Dispatch
competes with Mesh on Mesh's own architecture); and riding GitHub/Linear alone
(cheapest, and a pushed branch is a high-quality claim signal, but it only
arrives minutes into a run, missing the first-seconds window where the duplicate
dispatch race actually happens, and it does nothing for agent-to-agent).

Branch-based signals are still used, as corroboration (§4.9), not as the
primary.

### 3.4 Sync is fully automatic, and safe because of where it runs

Board edits commit and push without ceremony. The safety property is not
restraint; it is isolation: the syncer operates in a private worktree pinned to
trunk, never in the user's working tree (§4.5). It structurally cannot sweep up
uncommitted work, because it is not operating in the tree that holds it.

## 4. Components

### 4.1 Actor model — `packages/core/src/actor.ts` (new)

Pure data shapes with no `node:*` imports, exported through
`packages/core/src/browser.ts` so the desktop webview can import them — the same
constraint `ledger.ts` and `findings.ts` already carry.

```ts
export type ActorKind = 'human' | 'agent';

export interface ActorRef {
  kind: ActorKind;
  /** Stable handle within the project. `null` means "any actor of this kind". */
  handle: string | null;
  /** For agents: the handle of the human who owns the agent. `null` otherwise. */
  operator: string | null;
}

/** `null` encodes the unassigned case (serialized `none`). */
export function parseActorRef(raw: string): ActorRef | null;
export function formatActorRef(ref: ActorRef | null): string;
```

Wire format in task frontmatter, chosen so existing files need no migration:

| Serialized          | Meaning                                         |
| ------------------- | ----------------------------------------------- |
| `none`              | unassigned                                      |
| `human`             | a human, unspecified — **legacy, still valid**  |
| `agent`             | an agent, unspecified — **legacy, still valid** |
| `human:wyat`        | a specific person                               |
| `agent:wyat/claude` | a specific agent, owned by `wyat`               |

`packages/core/src/types.ts` widens `Assignee` from the closed union to
`string`, validated through `parseActorRef`. `ASSIGNEES` stays exported as the
legacy triple so existing pickers keep working while the UI migrates.

`store.ts`'s `CreateInput`/`UpdatePatch` take the serialized string; parsing
happens at the edges (API, CLI, MCP) so the store stays a file-shaped module.

### 4.2 Roster — `.dispatch/team.yml`, `packages/core/src/team.ts` (new)

Committed, so the roster syncs through the same channel as everything else.

```yaml
members:
  - handle: wyat
    email: wsoule679@gmail.com
    displayName: Wyat Soule
    emails: [] # prior addresses, so a changed git email keeps its handle
```

**Self-registering, not administered.** On daemon start Dispatch reads
`git config user.email` and `user.name`, derives a handle from the email
local-part (deduped with a numeric suffix on collision), and appends itself if
absent. There is no invite flow, no account, and no admin step — a teammate's
first commit of a task change carries their roster entry with it.

Email anchors identity because it is what git commits already carry, so Dispatch
attribution and `git blame` agree. Handles are the stable key; emails may change
and are recorded in `emails[]` when they do.

Agent actors are **not** rostered in v1. An agent's handle is derived as
`agent:<operator>/<executor-id>`, which is stable without registration. Named,
longer-lived agents (`agent:reviewer`) are a `team.yml` extension deferred until
something needs them (§9).

### 4.3 Attribution

Every mutation records the acting actor:

- **Task Activity** lines gain a trailing ` — <actor>`. Appended through
  `taskfile.ts`'s existing `appendActivity`, so the format stays one line per
  entry and the merge driver (§4.6) can union them.
- **`findings.jsonl`** — `Finding` gains `raisedBy: string`
  (`packages/core/src/findings.ts`).
- **`ledger.jsonl`** — `LedgerEntry` gains `authoredBy: string`
  (`packages/core/src/ledger.ts`).
- **Review comments** — `packages/server/src/reviewComments.ts` replaces the
  `author = 'You'` defaults at lines 150 and 167 with the resolved local actor.
- **Runs** — the run record gains `dispatchedBy` (the human who pressed go) and
  `ranAs` (the agent actor), set in
  `packages/server/src/orchestrator/orchestrator.ts` at dispatch.

Both JSONL files are read with a default for the new field, so records written
before this change stay parseable and render as an unknown actor.

### 4.4 Monotonic accounting, extracted — `packages/core/src/timeline.ts` (new)

`53190d6`'s per-task rule currently lives inside the Linear sync module. Extract
it:

```ts
/** True when `candidate.updated` is strictly past the last accounted version,
 *  so content that moved backwards (a branch snapshot) is a no-op. */
export function isOutstanding(
  candidate: TaskMeta,
  lastAccountedUpdated: string | undefined
): boolean;
```

Both `packages/server/src/linear/sync.ts` and the new git syncer (§4.5) consume
it. This is the invariant of §3.2 made executable, and it is the reason a
teammate checking out a feature branch cannot push a stale board.

### 4.5 Board syncer — `packages/server/src/sync/` (new)

**The sync worktree.** A private worktree pinned to trunk, created under
`~/.dispatch/worktrees/<hash of rootDir>/board` — outside the user's repo, keyed
the same way daemon and Linear state files already are
(`packages/server/src/linear/state.ts:44`).

The loop, driven by the existing `.dispatch/` watcher
(`packages/server/src/watcher.ts`):

1. A `.dispatch/` path changes in the user's working tree.
2. The syncer mirrors that file into the sync worktree, gated by `isOutstanding`
   (§4.4) so a branch checkout that reverts task content is ignored rather than
   propagated.
3. Commit in the sync worktree, staging **only** paths under `.dispatch/` — the
   same narrow-staging discipline `orchestrator.ts:1029` already applies.
4. `pull --rebase`, then push.
5. Incoming teammate changes are materialized from the sync worktree back into
   the user's working tree. `.dispatch/` is already excluded from the
   orchestrator's dirty gate (`orchestrator.ts:950`), so this does not
   destabilize a run.

The user's index and `HEAD` are never touched. You can be on any branch,
mid-rebase, with a dirty tree, and the syncer is unaffected — and, critically,
cannot include your unrelated uncommitted work in a commit.

Commit messages are generated through the existing
`packages/server/src/git/commitMessage.ts` and marked so they are trivially
filterable: `chore(board): <summary>`.

`autoCommit` finally acquires a consumer: it gates this loop, defaulting to
`true` for new projects and remaining `false` for existing ones so nothing
starts pushing without an explicit opt-in.

**Guardrails.** Push failure degrades to local-only commits plus a UI badge, not
a retry storm (§6). Every syncer action emits an event on the existing bus
(`packages/server/src/events.ts`) so the shell can render a live feed. A kill
switch in Settings sets `autoCommit: false`.

### 4.6 Task-file merge driver — `packages/core/src/mergeTask.ts` (new)

Registered by `dispatch init` and repaired by `dispatch doctor`:

```
# .gitattributes
.dispatch/tasks/*.md merge=dispatch-task
```

```
# .git/config
[merge "dispatch-task"]
  name = Dispatch task file merge
  driver = dispatch merge-task %O %A %B %L %P
```

Behavior: union-merge the `## Activity` section (append-only by construction,
deduped by line); three-way merge frontmatter field by field; conflict only when
both sides changed the same field to different values. `## Description` and
`## Acceptance Criteria` fall back to standard three-way text merge.

Absent the driver you get ordinary git conflicts — degraded, not broken, which
matches the founding spec's "per-task file conflicts only; rare,
human-resolvable" claim. `doctor` reports when the driver is missing.

**`ledger.jsonl` and `findings.jsonl` need no driver.** They are already
`appendFileSync` (`server/src/ledger.ts:47`, `server/src/findings.ts:57`) —
append-only and union-mergeable. The spec states this explicitly so the property
is understood as load-bearing rather than incidental.

### 4.7 Per-actor inbox — `packages/server/src/inbox.ts`

`.dispatch/inbox.md` becomes `.dispatch/inbox/<handle>.md`. Brain-dump capture
is personal by nature, so partitioning by actor removes the whole-file-rewrite
conflict class (`inbox.ts:221`) outright rather than merging around it.
`InboxStore` gains an actor parameter for writes and reads across all files for
clustering (`inboxClusterer.ts`) and display.

Migration: an existing `.dispatch/inbox.md` moves to the local actor's file on
first start, mirroring the `notes.json` → `inbox.md` migration already at
`packages/server/src/index.ts:303`.

### 4.8 Presence — the `PresenceSource` boundary

**This interface is a genuine boundary, not decoration.** It is the seam a
hosted or self-hosted relay implements later without touching a caller, and it
is deliberately expressed in terms of _what the app needs to know_ rather than
_how git refs work_ — no ref names, no fetch semantics, no git types cross it.

```ts
// packages/core/src/presence.ts — pure shapes, browser-safe
export interface PresenceRecord {
  actor: string; // serialized ActorRef
  machine: string;
  heartbeatAt: string;
  claims: Claim[];
  runs: RemoteRun[];
}

export interface Claim {
  taskId: string;
  claimedAt: string; // earliest-wins resolution key (§4.9)
  runId: string | null; // null for a manual human claim
}

export interface PresenceSource {
  /** Everyone the source currently knows about, including self. */
  list(): Promise<PresenceRecord[]>;
  /** Replace this actor's own record. */
  publish(record: PresenceRecord): Promise<void>;
  claim(taskId: string, runId: string | null): Promise<ClaimResult>;
  release(taskId: string): Promise<void>;
  send(to: string, text: string): Promise<void>;
  receive(since: string): Promise<AgentMessage[]>;
  /** Degradation state for the UI: healthy, refs-rejected, offline, disabled. */
  health(): PresenceHealth;
}
```

**Git implementation** — `packages/server/src/presence/gitRefs.ts`:

`refs/dispatch/presence/<handle>` holds the record as a JSON blob. Exactly one
writer per ref, so force-push is unconditionally safe and there is no merge to
get wrong. Heartbeat every 20s while the app is open; fetch
`+refs/dispatch/presence/*:refs/dispatch/presence/*` on the same tick, which
transfers almost nothing. A record older than 90s marks the actor offline and
its claims released.

Presence refs live outside `refs/heads`, so a jj-backed clone does not track
them as bookmarks.

Pruning: an actor's ref is deleted on clean shutdown, and `doctor` removes refs
whose heartbeat is older than 30 days.

### 4.9 Claims

Acquired automatically on dispatch, released on run finish or discard. Humans
can claim manually for hand-work.

**Earliest timestamp wins, not last write.** The fetch → push gap leaves a
couple of seconds where two actors can both claim. After publishing, the claimer
re-fetches; if another live actor holds an earlier `claimedAt`, it yields.
Deterministic tiebreak on handle. This converges without a lock server and costs
one extra fetch.

**Soft block with override at dispatch time.** Not a hard block — presence is
lossy (offline, stale, crashed app) and a hard block would strand people. Not a
passive warning either — those get scrolled past. The dispatch path returns a
conflict the UI renders as a decision: _"Bob's agent has been on this for 4m —
dispatch anyway?"_

**Branch corroboration.** `orchestrator.ts:1063` already enumerates every
`dispatch/*` branch ref in git. A remote branch for a task is a durable claim
even when presence is stale, so the claim check consults both: presence is fast
and advisory, branches are slow and durable. When presence is unavailable
entirely (§6), branch corroboration is the sole signal and the UI says so.

### 4.10 Cross-machine agents

**Messaging uses outboxes, not inboxes.** A shared mailbox ref would be
multi-writer and would conflict. Instead each sender writes
`refs/dispatch/outbox/<sender>` containing messages addressed to anyone;
recipients scan all outboxes on the fetch tick. Single-writer is preserved,
delivery lands within a heartbeat (~20s), and messages carry an id so recipients
can track what they have consumed. Senders expire messages after 30 minutes.

`run_list` (`packages/mcp/src/tools.ts`) merges local runs with remote runs
drawn from presence, each tagged with its actor and whether it is local.
`agent_message` accepts an actor ref or a run id: local targets keep the
existing mid-run injection path, remote targets go through the outbox. A message
to an actor with no live run bounces with a pointer to the task's Activity,
matching the behavior already specified for finished local runs.

### 4.11 Audit export — `packages/server/src/audit.ts` (new)

The attribution added in §4.3 is designed as a **retained, exportable record**,
not as UI state. Deliberate, and cheap now: retrofitting an audit trail after
the fact means reconstructing history that was never written down.

`GET /api/audit/export?since=&until=` streams NDJSON over the union of task
Activity, `findings.jsonl`, `ledger.jsonl`, and run records, normalized to one
shape:

```ts
export interface AuditEvent {
  at: string;
  actor: string; // serialized ActorRef
  kind: 'task' | 'run' | 'finding' | 'ledger' | 'merge' | 'sync';
  taskId: string | null;
  runId: string | null;
  summary: string;
  /** Governance-relevant fields carried through verbatim where present. */
  risk: TaskRisk | null;
  writes: string[];
  model: string | null;
  costUsd: number | null;
}
```

`risk`, `writes`, `model`, and cost are carried through because together with
`findings.jsonl` they already describe _what an agent was permitted to touch,
what it actually touched, what it cost, and what was found_ — the material a
governance surface is built from. Exposing them through one normalized stream
now costs a mapping function; deriving them later costs a migration.

`dispatch audit export` mirrors the endpoint for scripting.

### 4.12 Surfaces

**Desktop** (`apps/desktop/src/components/`):

- **New `team/` directory and a Team page** in the shell nav: roster with online
  state, each actor's live runs and claims, recent activity.
- `tasks/AssigneeAvatar.tsx` widens from its two-way
  `assignee === 'agent' ? Bot : User` branch (line 41) into initials, a
  deterministic color from the handle hash, a bot badge overlay for agents, and
  a presence dot.
- `tasks/PropertyControls.tsx` assignee picker lists roster actors grouped by
  kind, retaining the legacy unspecified options.
- A sync chip in `shell/`: last synced, pending outgoing, incoming, errors, kill
  switch.
- `runs/` gains teammates' runs, read-only, actor-tagged.
- The dispatch dialog renders the claim conflict from §4.9.

**CLI** (`packages/cli/src`): `dispatch whoami`, `dispatch team`,
`dispatch claim|release <id>`, `dispatch runs --all`, `dispatch sync --status`,
`dispatch audit export`, and `dispatch merge-task` (the merge driver entry point
from §4.6).

**MCP** (`packages/mcp/src/tools.ts`): `run_list` widened to team-wide and
actor-tagged; `agent_message` accepts actor refs; `team_list` is new;
`task_save` accepts actor-ref assignees. `workflow://onboarding`
(`packages/mcp/src/onboarding.ts`) gains the claim protocol so a connecting
agent learns to check before touching a task.

## 5. Data flow

```
user edits task in desktop
  → daemon writes .dispatch/tasks/t-xxx.md      (working tree, any branch)
  → watcher fires
  → syncer: isOutstanding? → mirror into sync worktree (trunk)
  → commit (.dispatch/ paths only) → pull --rebase → push
  → teammate's syncer fetches → materializes into their working tree
  → their watcher fires → cache rebuild → WS event → their UI updates

user dispatches an agent
  → presence.claim(taskId, runId) → fetch → check → publish → re-fetch → confirm
  → conflict? → UI decision (proceed / cancel)
  → orchestrator dispatch, run records dispatchedBy + ranAs
  → heartbeat publishes the live run every 20s
  → teammate's run_list shows it
```

## 6. Failure modes

| Failure                                        | Behavior                                                                                                                                 |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Push rejected (protected trunk, no permission) | Local-only mode: keep committing to the sync worktree, badge in the shell, `doctor` explains                                             |
| Host rejects `refs/dispatch/*`                 | `PresenceSource.health()` reports `refs-rejected`; claims fall back to branch corroboration only, and the UI says the signal is degraded |
| Offline                                        | Presence goes stale; the dispatch guard reports _its own age_ rather than implying the task is free                                      |
| Rebase conflict in the sync worktree           | Stop, surface, never force. The board keeps serving from the last good state                                                             |
| Task-file merge conflict without the driver    | Ordinary git conflict, human-resolvable; `doctor` reports the missing driver                                                             |
| Clock skew between machines                    | Staleness measured in local elapsed time; claim comparison carries a tolerance window                                                    |
| Teammate changes git email                     | Handle is stable; the old address moves into `team.yml`'s `emails[]`                                                                     |
| Two actors derive the same handle              | Numeric suffix on registration; `team.yml` is the arbiter and syncs like any board change                                                |
| Sync worktree missing or corrupt               | Recreated from trunk on next start; it holds no state that is not in git                                                                 |

## 7. Testing

**The two-clone harness is the important part.** A bare remote plus two clones
in a temp dir, each with its own actor identity and daemon, makes nearly all of
this testable in `bun test` with no mocks:

- board sync converges after concurrent edits on both clones
- a branch checkout holding older task content does not push backwards (the
  `53190d6` regression, now covered at the syncer level)
- claim race: both clones claim within the fetch window; earliest `claimedAt`
  wins on both sides
- presence goes stale after the threshold and releases claims
- outbox message delivered from clone A to clone B
- push rejection degrades to local-only without losing commits

**Unit tests:** merge driver against crafted three-way inputs (Activity union,
per-field frontmatter merge, genuine conflict); `parseActorRef`/`formatActorRef`
round-trip including every legacy value; `isOutstanding` monotonicity; heartbeat
and staleness with an injected clock.

**Coverage caveat to record:** root `bun run test` excludes `apps/desktop`, so
the Team page and the widened `AssigneeAvatar` ship without automated coverage
under the default script unless that changes.

## 8. Build order

Each step is independently useful and independently shippable:

1. Actor model + roster + attribution (§4.1-4.3) — a board that names people
2. Merge hygiene + per-actor inbox (§4.6-4.7) — multi-writer safety, before
   anything starts writing concurrently
3. Timeline extraction + board syncer (§4.4-4.5) — the board actually syncs
4. Presence + claims (§4.8-4.9) — duplicate dispatch stops
5. Cross-machine `run_list` / `agent_message` (§4.10)
6. Audit export (§4.11) and surfaces (§4.12)

Order matters between 2 and 3: turning on automatic sync before merge hygiene
exists would generate exactly the conflicts the driver is there to prevent.

## 9. Out of scope

- **Relay server.** `PresenceSource` (§4.8) is the seam; no implementation here.
- **Named standing agents** (`agent:reviewer`) — derived operator-scoped handles
  cover v1 addressing.
- **RBAC, SSO, directory-backed identity.** Identity is git identity.
- **Real-time (sub-second) sync.** ~20s is the design target.
- **Cross-repo or cross-project fleet views.** One repo, one board.
- **Conflict resolution UI.** Conflicts surface; git resolves them.
- **Web UI (`packages/web`) parity.** Frozen as a browser fallback per the
  roadmap's standing decisions; team surfaces land in `apps/desktop`.
