# Team server

Design document for Dispatch's storage pivot and team tier: tasks leave
markdown, dispatchd owns state in a local database, and team projects home that
state on a server. This supersedes the git-native direction in
`docs/archive/specs/2026-08-02-team-collaboration-design.md` and absorbs the
storage direction agreed on 2026-08-22 (epic `e-99e113`, "Storage spine:
daemon-owned DB with git receipts", building on
`docs/archive/design/lovable-direction.md`).

Status: **direction decided, design draft.** The source-of-truth question is
settled (§3); §8 lists what remains open. Nothing below is implemented.

## 1. Why tasks leave markdown

Tasks-as-files was the founding design and it earned its keep solo. At real
usage it fails on its own evidence:

- **This repo's own history.** 187 files in `.dispatch/tasks/`, and 34 of the 40
  most recent commits on main are `chore(board): sync N tasks`. The sync layer
  is the majority author of the project's history.
- **Task state churns in code diffs.** `findings.jsonl`, `ledger.jsonl`, and
  activity appends land in the same diffs as code, and every PR drags tracker
  noise with it.
- **Write cadence outgrew git.** A scheduler recomputing priorities, shared
  agent memory, presence, claims — everything on the roadmap wants real-time
  reads and writes, not debounced commit-push cycles.
- **Multiplayer wants one authority.** The archived team spec spent most of its
  length reconciling concurrent file edits. A store with an owner makes that
  machinery unnecessary.

What markdown was _for_ — inspectability, history, durability beyond the tool —
is preserved by the receipt log (§4), not by keeping the write path in files.

## 2. Shape

The typical SaaS shape, arrived at through the local daemon:

```text
solo                              team
┌───────────────────┐        ┌───────────────────┐   ┌───────────────────┐
│ Dispatch.app      │        │ Alice: dispatchd ─┼─┐ │ Bob: dispatchd ───┼─┐
│  dispatchd        │        │  (agents, work-   │ │ │                   │ │
│   ├─ SQLite       │        │   trees, keys)    │ │ │                   │ │
│   └─ receipts→git │        └───────────────────┘ │ └───────────────────┘ │
└───────────────────┘                              ▼                       ▼
 no account, no server                    ┌─────────────────────────────────┐
                                          │ team server (hosted/self-host)  │
                                          │  authoritative task store       │
                                          │  identity, orgs, projects       │
                                          │  presence · claims · runs       │
                                          │  audit log · web dashboard      │
                                          └─────────────────────────────────┘
```

- **dispatchd stays the agent host everywhere.** Agents, worktrees, code, and
  API keys never leave the operator's machine in either mode. The server stores
  and coordinates; it does not execute.
- **One storage seam, two backends.** `TaskStore` (`packages/core/src/store.ts`)
  is today a concrete file-backed class; its call surface
  (`create/get/list/update/amend/remove`) becomes an interface. Solo mode
  implements it over local SQLite; a team project implements it over the
  server's API. Callers — the daemon's routes, the orchestrator, MCP — don't
  change.
- **Daemons connect outbound** over one WebSocket. No inbound ports.

## 3. Source of truth (decided)

**Solo:** the daemon's SQLite database. **Team:** the server. Markdown task
files are retired as a write path in both.

Consequences, stated plainly:

- `.dispatch/` in the repo shrinks to genuinely-committable config
  (`config.yml`, `team.yml`). `tasks/*.md`, `findings.jsonl`, `ledger.jsonl`,
  `fix-loops.jsonl`, `notes.json`, and `inbox/` all move into the store.
  Board-sync commits disappear entirely.
- A one-time migration imports `.dispatch/tasks/*.md` into the DB and preserves
  the originals in the receipt log.
- **The five file-direct MCP tools change contract.** `task_list`, `task_get`,
  `task_save`, `task_comment`, `task_next` currently touch files and work
  without a daemon; post-spine they call through the daemon like the other nine.
  "Works with no daemon running" is a real regression to accept — mitigated by
  the daemon being auto-spawned by app and CLI already.
- The board syncer, the task-file merge driver, and the per-actor inbox's
  merge-avoidance design retire with the write path. `conflicts.ts`
  (writes-overlap) survives — it checks declared paths, not file merges.
- Offline in team mode becomes **cache + queued writes + reconcile**, not "git
  still works." Weaker than the old story; honest, and standard for the shape.
  Solo mode remains fully offline by construction.

## 4. Git receipts

Git's role changes from sync layer to **receipt log**: an append-only,
git-versioned export of the audit trail — task history snapshots, ledger,
findings, decisions — written by the daemon to a location _outside_ the project
repo (`~/.dispatch/projects/<id>/receipts`). In team mode the server produces
the same export per project.

This is what keeps the trust story after markdown: everything the tracker knows
is still inspectable, diffable, greppable text with history, and if Dispatch
disappears tomorrow the record survives. It is a projection, never a write path.

## 5. Actors and identity

The actor model survives intact — `ActorRef` (`human:wyat`,
`agent:wyat/claude`), attribution, and the timeline invariant are
storage-independent. Server accounts back `human:*` refs in team mode; agents
inherit their operator's authorization. `team.yml` becomes a cached projection
of the org roster.

## 6. Team features on top

With the server authoritative, the earlier mirror/fan-out machinery is
unnecessary — these become ordinary features of a stateful service:

- **Presence** — derived from connected daemons and live runs.
- **Claims** — TTL leases on `(taskId, writes[])`, admission-checked with the
  existing overlap logic, heartbeat for the life of the run. Lease lost →
  warning in the app, operator decides; never a killed run.
- **Run visibility** — daemons stream run lifecycle + `run.log` (the existing
  `ServerEvent` vocabulary is most of the wire protocol); transcripts and diff
  snapshots upload at terminal state so review works from any machine.
- **Web dashboard** — reads the authoritative store directly; the first surface
  for people who never install the app.
- **Audit** — server-native append-only log, exported as receipts (§4).

## 7. Phasing

0. **Storage spine (solo, no server)** — epic `e-99e113`. Extract the
   `TaskStore` interface, SQLite backend, migration from markdown, receipt
   export, MCP tools through the daemon. Ships as a pure local improvement: sync
   commits gone, real-time board. This phase de-risks everything after it and is
   worth doing even if the server slipped a quarter.
1. **Connect** — accounts, orgs, project homing, presence.
2. **Run visibility** — the most demoable team feature.
3. **Claims.**
4. **Web dashboard.**
5. **Audit, roles, SSO** — the enterprise tier.

## 8. Open decisions

1. **Transcript storage.** Server-held (review-anywhere; we hold code excerpts —
   posture changes) vs. daemon-held with brokered fetch. Leaning server-held
   with retention knobs; self-host is the out.
2. **Offline/conflict policy in team mode.** Queued-write reconciliation rules
   when a daemon reconnects — last-write-wins per field, or surface conflicts to
   a human. Needs deciding before phase 1, not before phase 0.
3. **Server repo location.** Private repo consuming published `@dispatch/core`
   remains the likely shape (`docs/BUSINESS.md`).
4. **Protocol.** Plain WebSocket + JSON mirroring `ServerEvent` until it hurts.
5. **What of `.dispatch/` stays in-repo.** `config.yml` clearly; whether
   `team.yml` stays as a projection or moves fully server-side can wait for
   phase 1.
6. **Web dashboard client.** Revive `@dispatch/web` or start clean on
   `@dispatch/ui`. Decide at phase 4.
