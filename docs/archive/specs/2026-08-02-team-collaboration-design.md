# Spec: Team collaboration — actors, board sync, presence, claims, and real-time

**Date:** 2026-08-02 · **Rewritten:** 2026-08-04 · **Status:** §§1-4.12
approved, §§4.1-4.7 shipped; §§3.5-3.6, 4.13-4.15 new and unapproved

## Revision note (2026-08-04)

The original spec put real-time sync out of scope and rejected moving the board
out of the working tree, on the grounds that doing so would be "the biggest
departure from _the files just are the tracker_." Both positions are revised
here, and the reason is a design that was not considered at the time: **Relay
for Obsidian**, which keeps a vault as ordinary markdown on disk while a CRDT
underneath handles concurrent edits. Markdown-on-disk and real-time co-editing
are not opposed. That collapses the tradeoff the original rejection rested on.

What changed:

- **§3.2** is no longer absolute. The invariant generalizes to "the board has
  exactly one authority," and _which_ authority depends on the sync mode.
- **§3.5-3.6** are new: two sync modes over one identical file layout.
- **§4.13-4.15** are new: the `BoardSync` boundary, the relay mode's three-layer
  CRDT, and external-write reconciliation — which is the real engineering risk.
- **§9** loses "real-time sync"; it is now mode B rather than a non-goal.

What did not change: the actor model, roster, attribution, timeline invariant,
board syncer, merge driver, per-actor inbox, presence, claims, cross-machine
agents, and audit export all stand as approved. Sections that have since shipped
are compressed to what they are, where they live, and their status — the code is
the detail now. Sections not yet built keep their full treatment.

Implementation status at the time of this rewrite (v0.15.0):

| Section    | Component                      | Status    |
| ---------- | ------------------------------ | --------- |
| §4.1-4.3   | Actors, roster, attribution    | shipped   |
| §4.4       | `timeline.ts`                  | shipped   |
| §4.5       | Board syncer                   | shipped   |
| §4.6       | Task merge driver              | shipped   |
| §4.7       | Per-actor inbox                | shipped   |
| §4.9.1     | `conflicts.ts`                 | shipped   |
| §4.8       | Presence                       | not built |
| §4.10-4.12 | Cross-machine, audit, surfaces | not built |
| §4.13-4.15 | BoardSync, relay mode          | not built |

Reference point: [Mesh](https://entire.vc/mesh/) answers the team problem with a
shared server. [Relay](https://relay.md) answers real-time markdown editing with
a CRDT and a hosted relay. This spec answers the team problem with git by
default, and adopts Relay's architecture for the real-time tier.

## 1. Problem

Dispatch is a single-operator tool. Put three developers on one repo and seven
distinct things break:

| #   | Failure                                   | Status                         |
| --- | ----------------------------------------- | ------------------------------ |
| 1   | Task edits never reach teammates          | fixed — board syncer (§4.5)    |
| 2   | A task cannot name _which_ human or agent | fixed — actor model (§4.1)     |
| 3   | Every review comment is authored by "You" | fixed — attribution (§4.3)     |
| 4   | Two people dispatch agents on one task    | open — needs claims (§4.9)     |
| 5   | Activity-log appends conflict on merge    | fixed — merge driver (§4.6)    |
| 6   | Inbox writes conflict destructively       | fixed — per-actor inbox (§4.7) |
| 7   | Alice's agent cannot see Bob's            | open — needs presence (§4.8)   |

Failures 1-3 and 5-6 were durable-state problems, independent of any
coordination protocol; they are done. Only 4 and 7 need coordination, and they
are what remains of the original scope.

### 1.1 The structural tension

Task files must live in the working tree — that is the founding thesis
(`docs/superpowers/specs/2026-07-13-agent-orchestration-platform-design.md` §2:
agents grep and edit them with plain file tools). But the working tree is
branch-scoped. So the board forks every time anyone cuts a branch, and every
orchestrator run branch carries its own snapshot of the entire task set.

This has already drawn blood. Commit `53190d6` fixed a case where checking out a
branch holding an older revision of a task file made every one of those tasks
outstanding and sent the older content straight to `updateIssue` — a bulk
overwrite of a linked Linear backlog with older content. The fix was monotonic
per-task accounting, promoted here to a system-wide invariant (§3.2).

**The tension has two resolutions, not one.** The original spec found the first:
keep the files in the tree and make trunk authoritative, reconciling with a
merge driver. The second is to keep the files in the tree and make a CRDT
authoritative, reconciling by construction. Both preserve the founding thesis.
They differ in what reconciles, what durability rests on, and whether a server
is required. §3.5 makes that a choice rather than a fork in the road.

### 1.2 The cost of living in the code repo

Trunk-authoritative sync solves correctness but leaves four costs, all inherent
to board data riding a code repo:

1. **History pollution.** Task churn appears in `git log`, diffs, blame, and
   PRs.
2. **Branch scoping.** What the board shows depends on the checked-out branch;
   the syncer exists to work around this.
3. **Publication.** Cloning the code clones the backlog — a real constraint for
   open-core packaging and for client work.
4. **Conflicts.** A custom merge driver is needed only because the data rides
   branches.

The original spec accepted all four in exchange for the board being visible in
PRs, forks, CI, and the host's web UI. That is a real benefit and the trade is
defensible — but it is a trade, and §3.5 stops forcing every project to take the
same side of it.

## 2. Scope

**In scope.** Named human and agent actors; attribution on every mutation;
automatic board sync; merge hygiene for multi-writer task files; presence,
claims, and duplicate-dispatch prevention over git refs; cross-machine
`run_list` and `agent_message`; a Team surface in the desktop app, CLI, and MCP;
exportable audit; **and a second sync mode providing sub-second collaborative
editing over a relay, with markdown files preserved on disk.**

**Out of scope** — see §9, but notably: RBAC, SSO, cross-repo fleet views, and
distributed scheduling.

**Team shape targeted:** 2-8 humans on one repo, each running their own Dispatch
and their own agents.

## 3. Design decisions

### 3.1 Actors: humans and agents are both first-class

Unchanged and shipped. See §4.1.

### 3.2 The board has exactly one authority (the timeline invariant)

> **Invariant.** The board has exactly one authoritative source at a time. A
> task revision reached by any other route is a _snapshot_: readable, never
> authoritative, never a sync input.
>
> In **git mode** the authority is `.dispatch/` on trunk. In **relay mode** it
> is the CRDT document.

The original wording named trunk directly. Generalizing it costs nothing —
`isOutstanding` (§4.4) is already expressed as "strictly past the last accounted
version," which is a statement about timelines, not about git.

Rejected, and still rejected: committing task edits on whatever branch you are
standing on (the `53190d6` failure becomes routine, and every teammate's view
depends on their checkout).

Rejected in the original, **revised here**: a canonical board outside the
working tree. The stated objection was that it is "the biggest departure from
_the files just are the tracker_." Relay mode makes that objection moot — the
files stay in the working tree, readable and greppable and writable by agents
with plain file tools. What leaves the code repo is not the files; it is the
_commits_.

### 3.3 Coordination rides git refs, not a server (git mode)

Unchanged for git mode. Presence and claims live in `refs/dispatch/*`, one ref
per writer, behind the `PresenceSource` boundary (§4.8). In relay mode the relay
implements that same boundary — which is what §4.8 was designed for.

### 3.4 Sync is automatic, and safe because of where it runs

Unchanged and shipped. The syncer operates in a private worktree pinned to
trunk, never in the user's working tree, so it structurally cannot sweep up
uncommitted work.

### 3.5 Two sync modes, one file layout

**A project picks one mode. Teams do not mix modes.**

|                 | **Mode A — git** (default, no server) | **Mode B — relay** (hosted or self-hosted) |
| --------------- | ------------------------------------- | ------------------------------------------ |
| Authority       | `.dispatch/` on trunk                 | CRDT document                              |
| Reconciliation  | `mergeTask.ts` + board syncer         | CRDT merge, conflict-free                  |
| Latency         | sync tick (seconds to minutes)        | sub-second                                 |
| Repo presence   | `.dispatch/tasks/` tracked on trunk   | `.dispatch/tasks/` **gitignored**          |
| Git's role      | the durable record                    | export and audit (§4.11)                   |
| Board in PRs/CI | yes                                   | no                                         |
| Server required | no                                    | yes                                        |
| Costs of §1.2   | all four accepted                     | 2 and 4 removed; 1 and 3 largely           |

**Exactly what mode B gitignores: `.dispatch/tasks/` and nothing else.**
`config.yml` and `team.yml` stay committed in both modes — they are project
configuration and the roster, they barely churn, and the roster must be readable
from a fresh clone to bootstrap identity before any sync exists. `inbox/` stays
committed too: it is per-actor by §4.7, so it cannot conflict, and gitignoring
it would strand a user's own notes on one machine.

So §1.2's costs 2 (branch scoping) and 4 (conflicts) are removed outright, and 1
(pollution) and 3 (publication) are removed for the backlog itself — which is
the part that churns and the part that reveals plans — while low-frequency
per-actor inbox notes remain in the repo. Stating this precisely rather than
claiming all four, because the difference is what a reader would otherwise
discover as a surprise.

What is identical in both modes: the on-disk layout, `TaskStore`, the MCP tools,
the CLI, and every agent. **Nothing above the `BoardSync` boundary (§4.13)
learns which mode it is in.** Switching modes is a configuration change plus a
`.gitignore` edit, not a data migration.

**Mixing modes within one project is prohibited**, and this is load-bearing
rather than conservative: two authorities for one board is the `53190d6` failure
class at steady state instead of as an edge case. `doctor` reports a project
whose configured mode disagrees with its `.gitignore` or with the roster's
recorded mode.

**On coupling storage to packaging.** Mode B requires a relay, and a relay is a
service. That makes mode B the natural paid tier and mode A the free,
self-sufficient one. This spec records the coupling as deliberate: mode A must
remain fully capable on its own — a team that never pays gets correctness,
attribution, sync, and claims, and loses only latency and repo cleanliness.
Degrading mode A to sell mode B would invalidate this design.

### 3.6 Markdown stays authoritative-shaped

In relay mode the CRDT is the authority, but the file on disk is not a cache to
be regenerated at will. It is continuously reconciled, and it must remain
readable and editable by any tool that does not know the CRDT exists — which is
every agent Dispatch dispatches.

Concretely: an agent that opens `t-abc123.md`, edits the description with
`Edit`, and writes it back must have that edit converge into the CRDT the same
way a teammate's keystroke does. This is the requirement that makes §4.15 the
hardest part of mode B, and it is non-negotiable — the founding thesis is
exactly this property.

## 4. Components

### 4.1-4.3 Actors, roster, attribution — **shipped**

`packages/core/src/actor.ts` (`ActorRef`, `parseActorRef`, `formatActorRef`),
`packages/core/src/team.ts` with `.dispatch/team.yml`, and attribution on task
Activity lines, `findings.jsonl`, `ledger.jsonl`, review comments, and run
records. Identity is anchored to git email; handles are the stable key; the
roster self-registers with no invite flow. Wire format is backward compatible —
`none`, `human`, and `agent` remain valid.

### 4.4 Monotonic accounting — **shipped**

`packages/core/src/timeline.ts` exports
`isOutstanding(candidate, lastAccountedUpdated)`, consumed by the Linear sync
and the board syncer. This is §3.2's invariant made executable, and it
generalizes unchanged to mode B: the CRDT's version vector replaces `updated` as
the accounting key, and callers do not change.

### 4.5 Board syncer — **shipped** (mode A only)

`packages/server/src/sync/`. A private worktree at
`~/.dispatch/worktrees/<hash>/board` pinned to trunk; mirror on watcher events
gated by `isOutstanding`; commit staging only `.dispatch/` paths;
`pull --rebase`; push; materialize incoming changes back into the working tree.
Periodic pull alongside the edit-triggered path. Gated by `autoCommit`.

In mode B this component is inert — the relay is the sync. It remains in the
tree because a project can move from B back to A.

### 4.6 Task-file merge driver — **shipped** (mode A only)

`packages/core/src/mergeTask.ts`, registered by `dispatch init`, repaired by
`dispatch doctor`. Union-merges `## Activity`, three-way merges frontmatter per
field, falls back to text merge for prose sections.

In mode B it is dead code for task files, because task files are gitignored and
git never merges them. It stays registered — `mergeTeam.ts` still needs the same
machinery for `team.yml`, which is committed in both modes.

### 4.7 Per-actor inbox — **shipped**

`.dispatch/inbox/<handle>.md`, one file per actor. Partitioning by actor removed
the whole-file-rewrite conflict class outright.

### 4.8 Presence — the `PresenceSource` boundary — **not built**

Unchanged from the original spec, and its importance increases: this is the seam
mode B's relay implements. The interface stays expressed in terms of what the
app needs to know — no ref names, no fetch semantics, no git types, and now no
CRDT types either.

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
  /** The task's declared `writes`, carried so remote actors can run
   *  `tasksConflict` without fetching the task file. Empty = undeclared. */
  writes: string[];
}

export interface PresenceSource {
  list(): Promise<PresenceRecord[]>;
  publish(record: PresenceRecord): Promise<void>;
  claim(
    taskId: string,
    runId: string | null,
    writes: string[]
  ): Promise<ClaimResult>;
  release(taskId: string): Promise<void>;
  send(to: string, text: string): Promise<void>;
  receive(since: string): Promise<AgentMessage[]>;
  health(): PresenceHealth;
}
```

**Git implementation** (mode A) — `refs/dispatch/presence/<handle>` holds the
record as a JSON blob, one writer per ref so force-push is unconditionally safe.
Heartbeat every 20s; a record older than 90s marks the actor offline and
releases its claims. Refs live outside `refs/heads`, so a jj-backed clone does
not track them as bookmarks.

**Relay implementation** (mode B) — the relay pushes presence on the same
connection that carries document updates. Heartbeat and staleness thresholds
drop to seconds. `health()` reports relay connectivity instead of ref
acceptance.

### 4.9 Claims — **not built**

Unchanged. Acquired automatically on dispatch, released on run finish or
discard; earliest `claimedAt` wins; soft-block with an override the UI renders
as a decision; branch corroboration as a durable secondary signal.

#### 4.9.1 Write-set overlap across machines — **primitives shipped**

`packages/core/src/conflicts.ts` provides `tasksConflict`,
`claimConflictsWithWrites`, and `schedulableBatch`. The team layer changes the
input set, not the rule: the local scheduler feeds `liveClaims()` from one
registry, the team check feeds it from one registry plus every live remote
presence record.

The asymmetry is easy to get backwards: an undeclared _candidate_ against a
non-empty remote claim **does** conflict, because the remote side has concrete
evidence of a file being touched. Only an empty _claim_ is silent.

Liveness mitigations, all required: stale presence claims are ignored; the soft
override always applies; the conflict names which actor, run, and path collided.

### 4.10 Cross-machine agents — **not built**

Unchanged. Outboxes, not inboxes: each sender writes
`refs/dispatch/outbox/<sender>`; recipients scan all outboxes on the fetch tick.
Single-writer preserved. In mode B the relay carries messages directly and the
outbox refs are unused.

### 4.11 Audit export — **not built**

Unchanged, and its role grows in mode B: when the board is gitignored, this
export _is_ the durable record that leaves the machine.
`GET /api/audit/export?since=&until=` streams NDJSON over task Activity,
`findings.jsonl`, `ledger.jsonl`, and run records, normalized to `AuditEvent`
carrying `risk`, `writes`, `model`, and `costUsd`.

Mode B adds a scheduled variant: a periodic export committed to a configured git
destination, so a relay-mode project still has an offline, greppable,
tamper-evident history. The destination is deliberately _not_ the code repo —
that would reintroduce §1.2's costs through the back door.

### 4.12 Surfaces — **not built**

Unchanged: a Team page, a widened `AssigneeAvatar`, roster-aware assignee
pickers, a sync chip, teammates' runs in `runs/`, and the claim-conflict dialog.
CLI gains `whoami`, `team`, `claim|release`, `runs --all`, `sync --status`,
`audit export`, `merge-task`. MCP widens `run_list`, extends `agent_message`,
adds `team_list`.

Mode B adds to the sync chip: connection state, and per-actor editing indicators
on a task open in the detail view.

### 4.13 The `BoardSync` boundary — **new**

The durable-state twin of `PresenceSource`, and the seam the two modes sit
behind. Same discipline: no git types, no CRDT types cross it.

```ts
// packages/core/src/boardSync.ts — pure shapes, browser-safe
export interface BoardSync {
  /** Begin syncing; resolves once the local board is consistent with the
   *  authority, or reports degraded and serves what is on disk. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** The local writer touched these paths. Implementations decide whether
   *  that means "commit and push" or "fold into the CRDT". */
  localChanged(paths: string[]): void;
  /** Fired when the authority changes the working tree, so the cache can
   *  rebuild and the UI can update — the same event both modes already need. */
  onRemoteChange(cb: (paths: string[]) => void): () => void;
  health(): BoardSyncHealth;
}
```

`GitBoardSync` wraps the shipped syncer; its `localChanged` is the watcher path
that exists today. `RelayBoardSync` (§4.14) implements the same three methods
over a document connection.

The daemon constructs one at boot from project config and hands it to nothing —
it is a background component, and every existing caller keeps reading and
writing through `TaskStore` exactly as now. That is the property that makes mode
B a configuration change rather than a rewrite.

### 4.14 Relay mode — the three-layer CRDT — **new**

A task file is not one document. It decomposes into three regions with different
merge semantics, and treating them uniformly is the mistake to avoid:

| Region                                     | Shape             | CRDT               | Why                                                            |
| ------------------------------------------ | ----------------- | ------------------ | -------------------------------------------------------------- |
| Frontmatter (`status`, `priority`, …)      | map of scalars    | LWW per field      | Character-level merge on YAML produces invalid YAML            |
| `## Description`, `## Acceptance Criteria` | prose             | text CRDT          | The Obsidian case; concurrent prose editing                    |
| `## Activity`                              | append-only lines | grow-only sequence | Already append-only by construction; the easiest CRDT there is |

The Activity layer is worth calling out: it retires original failure #5
outright, because a grow-only sequence cannot conflict. The merge driver's union
rule (§4.6) is the same semantics expressed in git; the CRDT expresses it
natively.

`writes`, `blockedBy`, and `labels` are arrays in frontmatter and want set
semantics (add-wins), not LWW — otherwise two people adding different labels
lose one. This is the one place where "frontmatter is LWW" is too coarse.

**Document granularity: one CRDT document per task file**, not one per board.
Per-board would make every keystroke a write against a document the size of the
backlog, and would couple unrelated tasks' histories. Per-task keeps documents
small, makes deletion trivial, and lets the relay shard naturally. The cost is
that board-level operations (reordering, bulk status change) span documents and
are not atomic — acceptable, because they are not atomic today either.

### 4.15 External-write reconciliation — **new, and the real risk**

This is the section that decides whether mode B is buildable.

Relay's writers are humans typing at human speed into one editor. Dispatch's
writers are:

1. **Humans in the desktop app** — the easy case, and the one Relay solves.
2. **Agents**, rewriting whole files programmatically with `Edit`/`Write`,
   frequently, with no knowledge of the CRDT.
3. **git**, swapping files wholesale on checkout.

Writer 3 is eliminated by construction: **in mode B `.dispatch/tasks/` is
gitignored, so git never writes task files.** This is the main reason the mode
split is coherent rather than arbitrary — the `53190d6` hazard, which would be
far worse with a second replica arguing about it, simply cannot occur.

Writer 2 is the actual work. The rule:

> Every external write to a task file is diffed against the CRDT's current
> materialization and applied as operations on the appropriate layer — never as
> a whole-document replacement.

Mechanically: the watcher sees a changed file, the syncer reads it, parses it
into the three regions, and diffs each against what the CRDT currently holds.
Frontmatter differences become field sets. Activity differences become appends
(and an agent that _removed_ Activity lines is rejected, not replicated —
Activity is append-only by contract). Prose differences become text operations
computed by a standard diff.

**The failure mode to design against is the echo loop**: the CRDT materializes a
file, the watcher sees the write, and it is diffed back in. The materializer
must mark its own writes and the watcher must ignore them — by content hash
rather than by timestamp, because an agent can legitimately write the same
content the materializer just did.

**A concurrent whole-file rewrite by an agent will lose prose edits made in the
same window.** Diffing a wholesale rewrite against a document a human is
simultaneously typing into produces a large replacement operation, and text
CRDTs resolve that by keeping both — which for a rewritten description is noise,
not a merge. Mitigation, in order of preference: (a) route agent writes through
`TaskStore` so they arrive as structured field updates rather than file rewrites
— most agent writes already go through the MCP `task_save` tool, not raw `Edit`;
(b) soft-lock a task's prose while a human is actively editing it, surfaced
through presence; (c) accept it and make it visible in Activity.

Option (a) is the one to build. It also narrows the problem considerably: raw
file edits by agents become the exception rather than the norm, and the
exception degrades to (c).

## 5. Data flow

**Mode A (git):**

```text
user edits task in desktop
  → daemon writes .dispatch/tasks/t-xxx.md      (working tree, any branch)
  → watcher fires → BoardSync.localChanged()
  → GitBoardSync: isOutstanding? → mirror into sync worktree (trunk)
  → commit (.dispatch/ paths only) → pull --rebase → push
  → teammate's syncer fetches → materializes → their watcher → cache → WS event
```

**Mode B (relay):**

```text
user types in the desktop task detail
  → CRDT op applied locally, rendered immediately
  → relay broadcasts → teammate's replica applies → their UI updates (<1s)
  → materializer writes .dispatch/tasks/t-xxx.md (marked, hash-tracked)

agent edits the same file with plain tools
  → watcher fires → BoardSync.localChanged()
  → RelayBoardSync: parse three regions, diff each against the CRDT
  → apply as operations → relay broadcasts → converges
```

## 6. Failure modes

| Failure                                        | Behavior                                                                                                                                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Push rejected (mode A)                         | Local-only mode: keep committing to the sync worktree, badge, `doctor` explains                                                                                                                                             |
| Host rejects `refs/dispatch/*`                 | `PresenceSource.health()` reports `refs-rejected`; claims fall back to branches                                                                                                                                             |
| Offline (mode A)                               | Presence goes stale; the dispatch guard reports its own age                                                                                                                                                                 |
| **Relay unreachable (mode B)**                 | Edits continue locally against the CRDT and converge on reconnect; the sync chip reads `offline`. This is a CRDT's native behavior and needs no special handling — but the UI must not imply teammates are seeing the edits |
| **Relay permanently lost (mode B)**            | The on-disk markdown is intact and complete. `dispatch sync --mode git` re-tracks `.dispatch/tasks/` and falls back to mode A. **No data is stranded in a service** — this is a requirement, not a consequence              |
| **Echo loop (mode B)**                         | Materializer marks its writes by content hash; watcher ignores matching writes                                                                                                                                              |
| **Agent whole-file rewrite during human edit** | Degrades per §4.15; surfaced in Activity                                                                                                                                                                                    |
| Rebase conflict in the sync worktree           | Stop, surface, never force                                                                                                                                                                                                  |
| Task-file merge conflict without the driver    | Ordinary git conflict; `doctor` reports the missing driver                                                                                                                                                                  |
| Clock skew between machines                    | Staleness measured in local elapsed time; claims carry a tolerance window                                                                                                                                                   |
| Mode disagreement within a team                | `doctor` detects config/`.gitignore`/roster mismatch and refuses to sync                                                                                                                                                    |

## 7. Testing

**The two-clone harness** remains the important part for mode A: a bare remote
plus two clones in a temp dir, each with its own actor and daemon — board
convergence, the `53190d6` regression, claim races, presence staleness,
write-set overlap, outbox delivery, push-rejection degradation.

**Mode B needs a two-replica harness**, structurally similar: two `BoardSync`
instances against an in-process relay, no network.

- concurrent prose edits to one description converge identically on both
  replicas
- concurrent frontmatter edits to _different_ fields both survive; to the _same_
  field, LWW resolves and both replicas agree on the winner
- concurrent `labels` additions both survive (the add-wins case §4.14 calls out)
- Activity appends from both replicas union, in a stable order
- an external whole-file write on replica A converges to replica B
- the echo loop does not occur: a materialized write produces no operations
- an external write that _deletes_ Activity lines is rejected, not replicated
- relay disconnect, divergent edits on both sides, reconnect → convergence
- mode B → mode A fallback yields a complete, valid task set on disk

**Coverage caveat, still true:** root `bun run test` covers `packages/*`, so
desktop-side surfaces need their own run.

## 8. Build order

Mode A first; mode B is strictly additive and must not block it.

1. ~~Actor model + roster + attribution~~ — **shipped**
2. ~~Merge hygiene + per-actor inbox~~ — **shipped**
3. ~~Timeline extraction + board syncer~~ — **shipped**
4. **Presence + claims (§4.8-4.9)** — duplicate dispatch stops. Next.
5. Cross-machine `run_list` / `agent_message` (§4.10)
6. Audit export (§4.11) and surfaces (§4.12)
7. **`BoardSync` extraction (§4.13)** — wrap the shipped syncer behind the
   interface with no behavior change. Independently valuable: it is the seam,
   and extracting it while there is exactly one implementation is far cheaper
   than retrofitting it around two.
8. **Relay mode (§4.14-4.15)** — the three-layer CRDT, the materializer, the
   external-write differ, and the relay itself.

Step 7 is the commitment point worth naming: it is cheap, reversible, and buys
the option on step 8 without taking it.

**Scoping honesty for step 8.** Relay solves one CRDT layer with human-speed
writers. This is three layers with programmatic writers and a reconciliation
requirement no vault editor has. It is a quarter of work, not a sprint, and
§4.15 is where it will be spent.

## 9. Out of scope

- **RBAC, SSO, directory-backed identity.** Identity is git identity.
- **Cross-repo or cross-project fleet views.** One repo, one board.
- **Distributed scheduling.** §4.9.1 surfaces cross-machine write-set overlap as
  advice at dispatch time; it does not schedule across machines.
- **Conflict resolution UI (mode A).** Conflicts surface; git resolves them.
- **Sub-second presence in mode A.** ~20s remains the git-mode target; mode B is
  the answer for teams that need faster.
- **Real-time editing of anything but task files.** Notes, inbox, findings, and
  ledger stay file-and-git in both modes; only `.dispatch/tasks/` gets a CRDT.
- **Named standing agents** (`agent:reviewer`) — derived operator-scoped handles
  cover v1 addressing.
- **Web UI (`packages/web`) parity.** Frozen as a browser fallback; team
  surfaces land in `apps/desktop`.
