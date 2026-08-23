# Team server

Design document for moving Dispatch's team collaboration from git-ref
coordination to a server. This supersedes the git-native direction in
`docs/archive/specs/2026-08-02-team-collaboration-design.md`; the parts of that
spec that shipped are inputs here, not casualties.

Status: **draft for decision**. §7 lists the calls that are still open; nothing
below is implemented.

## 1. Why a server

The git-native design got real mileage — five of its seven team failures are
fixed and shipped (see §2) — but the two that remain, plus everything the
business needs, are the ones git refs handle worst:

- **Claims and presence are liveness problems.** "Is anyone dispatching this
  task right now" and "is Alice's agent still alive" need heartbeats and TTLs,
  not commits. A ref-based claim can't expire when a laptop lid closes.
- **Run state never crosses machines.** Transcripts, live logs, diff snapshots,
  and verify results live under `DISPATCH_HOME`, keyed to one machine
  (`docs/ARCHITECTURE.md`, "Where state lives"). A teammate can see every task
  and none of the work happening on it. Multiplayer is mostly _this_.
- **Sync latency is push-cadence.** The board syncer is debounced off local
  edits and rides git push/pull; a board that updates when someone happens to
  push is not a live board.
- **The paid tier needs an account boundary.** Licensing, seats, and audit all
  want a place identity actually lives (`docs/BUSINESS.md`).

An existence proof already in the tree: `apps/demo` boots per-session
`dispatchd` instances server-side, isolated by `DISPATCH_HOME` — the daemon is
hostable today.

## 2. What we keep

Shipped and staying, regardless of anything below:

| Piece                                        | Why it survives                               |
| -------------------------------------------- | --------------------------------------------- |
| Actors (`ActorRef`, `team.yml`, attribution) | Identity model is transport-independent       |
| Task-file merge driver                       | Files still merge whenever git is in the loop |
| Per-actor inbox                              | Same                                          |
| `conflicts.ts` writes-overlap detection      | Becomes the server's claim-admission check    |
| Board syncer                                 | Remains the offline/no-server fallback path   |

The solo product keeps its promise unchanged: **no account, no server, nothing
uploaded.** Everything in this document is additive and opt-in; a daemon that
never connects behaves exactly as today.

## 3. Architecture

```text
   Alice's machine                     Bob's machine
┌───────────────────┐             ┌───────────────────┐
│ Dispatch.app      │             │ Dispatch.app      │
│   dispatchd ──────┼──┐       ┌──┼───── dispatchd    │
│   (runs agents,   │  │       │  │                   │
│    owns worktrees)│  │       │  │                   │
└───────────────────┘  │       │  └───────────────────┘
                       ▼       ▼
              ┌─────────────────────┐
              │ team server         │   one per org; hosted or self-hosted
              │  identity & orgs    │
              │  project registry   │
              │  presence           │
              │  claims (leases)    │
              │  run registry+relay │
              │  task mirror        │
              │  audit log          │
              └──────────┬──────────┘
                         │
                  web dashboard (later)
```

Load-bearing properties:

- **`dispatchd` stays the agent host.** Agents, worktrees, API keys, and code
  never leave the operator's machine. The server coordinates; it does not
  execute.
- **Daemons connect outbound** over a single WebSocket. No inbound ports, no NAT
  traversal, nothing to open on a corporate laptop.
- **Degraded = today.** Server unreachable → daemon runs exactly the current
  solo behavior and reconciles when it reconnects. The server is an availability
  enhancement, never a dependency for dispatching.

## 4. What crosses the boundary

The state split in `ARCHITECTURE.md` is the map. Per class of state:

| State                                  | Today         | With server                                                                        |
| -------------------------------------- | ------------- | ---------------------------------------------------------------------------------- |
| Tasks, ledger, findings (`.dispatch/`) | repo, via git | unchanged as source of truth; server keeps a **mirror** for fan-out and web (§7.1) |
| Presence                               | — (not built) | server-derived from connected daemons + active runs                                |
| Claims                                 | — (not built) | server-issued leases, heartbeat TTL, admission-checked with `conflicts.ts`         |
| Run metadata + live log                | machine-local | streamed up (`run.log` events already exist verbatim)                              |
| Transcripts, diff snapshots            | machine-local | uploaded at run end, retention-bound                                               |
| Worktrees                              | machine-local | **never cross**                                                                    |
| API keys, credentials                  | machine-local | **never cross**                                                                    |
| Audit                                  | — (not built) | server-native append-only log                                                      |

The event vocabulary already exists: the daemon's `ServerEvent` union
(`events.ts`) is very close to the wire protocol daemon→server, and the mirror's
fan-out to other daemons reuses the same "go refetch" contract clients already
speak. This is the main reason the lift is smaller than it looks.

## 5. Sketches

**Claims.** A dispatch first asks the server for a lease on
`(taskId, writes[])`. The server admission-checks overlap against live leases
using the same `entriesOverlap` logic that gates local scheduling today, then
grants a TTL'd lease the daemon heartbeats for the life of the run. Lease lost
(laptop sleeps, network drops) → surfaced in the app as a warning, not a killed
run — the operator decides. Offline → no lease, current local-only conflict
checks apply, flagged as unclaimed on reconnect.

**Run visibility.** Daemons forward run lifecycle + `run.log` to the server; the
server fans out to subscribed teammates. A teammate's app renders a read-only
live view of the run — same components, remote feed. Transcript and diff
snapshot upload at terminal state makes review-after-the-fact possible from any
machine.

**Task mirror.** Daemon reports task-file state (post-merge-driver, so the
server never resolves conflicts); server holds latest-known state per project
for instant fan-out and the web dashboard. Divergence between mirror and repo
resolves in the repo's favor, always.

**Identity.** Server accounts map onto the existing `ActorRef` space —
`human:wyat` gains a verified account behind it; agents keep `agent:wyat/claude`
and inherit their operator's authorization. `team.yml` becomes a cached
projection of the org roster rather than the roster itself.

## 6. Phasing

Each phase ships value alone and none requires the next:

1. **Connect + presence** — accounts, orgs, project link, who's online, which
   tasks have live runs. Small, and immediately visible.
2. **Run visibility** — stream lifecycle + logs; teammates watch runs read-only.
   The single most demoable team feature.
3. **Claims** — leases with TTL; kills the "two people dispatched the same task"
   failure for good.
4. **Task mirror + web dashboard** — live board in the browser; first surface
   for people who never install the app (managers).
5. **Audit + admin** — append-only audit export, roles, SSO. The enterprise
   tier.

## 7. Open decisions

Ordered by how much the answer changes.

1. **Task source of truth.** Recommended: files stay authoritative, server
   mirrors (§4, §5). Alternative: server-authoritative tasks with git export —
   maximal "real server product," but it abandons the load-bearing product claim
   that tasks are files in your repo, breaks offline-first, and invalidates the
   MCP file tools. Decide explicitly; everything in §5 assumes the
   recommendation.
2. **Transcript storage.** Server-held (easy review-anywhere, but we now hold
   customer code excerpts — security posture changes) vs. daemon-held with
   server-brokered fetch (better story, worse availability). Leaning server-held
   with retention knobs and self-host as the out.
3. **Repo location for the server.** Same monorepo vs. private repo from day
   one. `docs/BUSINESS.md` argues private; the counterargument is shared core
   types (`ServerEvent`, `TaskMeta`) want one tree. A private repo consuming
   published `@dispatch/core` is the likely shape.
4. **Protocol stack.** Plain WebSocket + JSON mirroring `ServerEvent` (fastest,
   matches existing code) vs. anything fancier. Recommend the former until it
   hurts.
5. **Web dashboard client.** Revive `@dispatch/web` (currently dependent-less)
   or start clean against `@dispatch/ui`. Decide when phase 4 starts, not now.
