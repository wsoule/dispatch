# The central hub: one authority per team — design

2026-11-11. Status: **draft for Wyat's review.** Direction decided in
conversation the same day; nothing here is built. Sections marked _unverified_
rest on a reading of headers and comments, not on a full read of the code.

## Why

Dispatch has a hub, but the hub is a router. No single place can answer "what is
every session doing and what state is every task in". Four places each hold a
slice:

| Place                                     | Knows                                                | Blind to                                                   |
| ----------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------- |
| `dispatchd`, one per checkout             | That checkout's tasks, runs, docs, memory            | Other repos, other machines                                |
| Machine hub (`packages/mcp/src/hub`)      | One OS user's sessions and agent mail                | Tasks                                                      |
| Hosted team hub (`apps/web/src/hub.ts`)   | Mirrored agent rosters, mail routing                 | Tasks: it asks a machine live (`call('projects'/'http')`)  |
| Federation logs (git branch or the relay) | Board and run presence, as signed per-machine chains | Nobody materializes them centrally; every daemon re-merges |

The consequences are the ones a team feels: two machines can both start the same
task, a closed laptop leaves a task "in progress" forever, and the web can show
a project only while its machine is awake.

`docs/TEAM-SERVER.md` §3 already decided "Team: the server" on 2026-08-23. The
2026-09-23 update moved to peer federation so teams could ship before a server
existed. A server now exists (`apps/web`). This spec returns to the first
decision and removes the detour.

## Decisions (Wyat, 2026-11-11)

1. **Every team has a hub.** Git-only teams go away. A teardown and rewrite of
   the team tier is acceptable.
2. **The hub may read everything**: tasks, sessions, run logs, messages, docs
   and memory. Sealed mail and `content-e2e` do not survive for hub teams.
3. **Offline edges queue writes** and reconcile on reconnect. They do not go
   read-only.

## Shape

```text
 Alice's machine                 HUB (one per team)                Bob's machine
┌────────────────────┐      ┌──────────────────────────┐      ┌────────────────────┐
│ sessions · runs    │ cmd  │ validate → order → store │ evt  │ sessions · runs    │
│ dispatchd          ├─────►│                          ├─────►│ dispatchd          │
│  SQLite = cache    │◄─────┤ tasks · sessions · runs  │◄─────┤  SQLite = cache    │
│  outbox (queue)    │ evt  │ claims · mail · docs     │ cmd  │  outbox (queue)    │
│ code, keys, trees  │      │ memory · people · audit  │      │ code, keys, trees  │
└────────────────────┘      └──────────────────────────┘      └────────────────────┘
                                  ▲            ▲
                             web dashboard   Overseer agent
```

Three rules carry the whole design:

- **The hub owns state and order.** Every change is a command. The hub checks
  it, gives it the next sequence number, stores it and sends the resulting event
  to everyone. One total order replaces hybrid clocks, hash chains and merge
  rules.
- **Edges execute and cache.** Agents, worktrees, code and API keys stay on the
  operator's machine, as today. The hub never runs an agent. The local SQLite
  database stays, as a cache the daemon reads synchronously.
- **Machines dial out.** One WebSocket per machine, no inbound ports, as the
  machine hub does today.

### Solo stays as it is

A project with no team keeps its local SQLite store and has no hub. The team
path is that same store with a sync layer attached, so there is one store and
one optional component, not two backends.

This revises what I said in conversation ("run the same hub on localhost").
`TaskStorePort` (`packages/core/src/store.ts`) is synchronous: `get(id)` returns
a `TaskDoc`, not a promise. Putting a network authority behind it means
rewriting every caller. Keeping SQLite as the read path and syncing it avoids
that and leaves solo untouched.

Team projects must be on the `sqlite` backend. A `files` project migrates
(`packages/core/src/migrate.ts`) when it joins a team.

## What the hub holds

One SQLite database per team, beside today's `team.db`. A team has one writer by
construction, so SQLite is enough until a team outgrows one process.

| Record     | Key fields                                                                                  | Notes                                            |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `events`   | `seq`, `at`, `actor`, `machine`, `type`, `body`, `cmd`                                      | Append-only. The audit log and the sync stream.  |
| `projects` | `id`, `name`, `repo` (remote URL), `config`                                                 | A repo the team works in.                        |
| `tasks`    | `TaskDoc` fields, plus a `rev` per field                                                    | `rev` is the `seq` that last set the field.      |
| `sessions` | `id`, `kind`, `actor`, `machine`, `project`, `branch`, `task`, `state`, `waitingOn`, `beat` | See "Sessions".                                  |
| `claims`   | `task`, `writes[]`, `session`, `expires`                                                    | See "Claims".                                    |
| `runs`     | `id`, `task`, `session`, `status`, `cost`, `verdict`                                        | Lifecycle. Logs live in `run_log`.               |
| `run_log`  | `run`, `n`, `entry`                                                                         | The `run.log` entries, streamed. Retention knob. |
| `messages` | Today's `messages`, `recipients`, `deliveries`, `channels`                                  | In the clear.                                    |
| `docs`     | Today's `docs.db` team scope                                                                | Personal scope stays on the machine.             |
| `memory`   | Today's `memory.db` team scope                                                              | Personal scope stays on the machine.             |
| `people`   | Today's `users`, `members`, `devices`, `invites`                                            | Already in `team.db`.                            |

What does not go to the hub: source code, worktrees, API keys, personal docs and
personal memory. A run's diff uploads when the run ends, so review works from
any machine. That means the hub holds code excerpts; decision 2 accepts it.

## Sessions

One record type for everything that does work, replacing the agent roster
mirror, `presence` ops and the run table as three views of the same fact.

```json
{
  "id": "claude-code-7f3a2c",
  "kind": "session",
  "actor": "agent:alice/claude-code-7f3a2c",
  "machine": "alice-mbp",
  "project": "dispatch",
  "branch": "feat/claims",
  "task": "t-12",
  "state": "working",
  "waitingOn": null,
  "label": "claims admission",
  "beat": "2026-11-11T17:04:10Z"
}
```

- `kind`: `session` (a hand-driven agent with the MCP), `run` (a dispatched
  run), `hosted` (claude.ai through `/mcp`), `overseer`.
- `state`: `working`, `waiting` (on a gate; `waitingOn` names it), `idle`,
  `stalled`, `ended`.
- **A session is a lease.** The machine sends a beat every 30 seconds listing
  its live sessions. A session with no beat for two minutes (today's
  `ONLINE_MS`) becomes `stalled`, and its claim starts to expire. The hub marks
  it; nobody has to notice.
- Addresses do not change: `agent:<operator>/<name>` and `run:<id>`.

## Claims

A claim is a lease on `(task, writes[])`, held by a session.

- A dispatch, or a session calling `task_claim`, sends `claim`. The hub admits
  it when no live claim holds the task and no live claim's `writes` overlap
  (`packages/core/src/conflicts.ts`, the existing logic). Otherwise it refuses
  and names the holder.
- The claim lives while its session beats. A stalled session's claim is held for
  a grace period (proposed: 15 minutes), then released.
- **A lost claim never kills a run.** The operator gets a warning and decides,
  as `TEAM-SERVER.md` §6 already says.

This is the feature peer federation cannot give: with no orderer, both machines
can believe they won.

## The wire

Plain WebSocket and JSON, extending the frames `apps/web/src/hub.ts` already
uses (`{id, kind, body}` and `{re, ok, result}`).

| Frame   | Direction  | Meaning                                                                          |
| ------- | ---------- | -------------------------------------------------------------------------------- |
| `hello` | edge → hub | `{machine, build, cursor}`. The hub answers with events after `cursor`.          |
| `snap`  | hub → edge | A full snapshot, when `cursor` is older than the hub keeps or the edge is new.   |
| `cmd`   | edge → hub | `{cid, type, body, base}`. `cid` is a ULID, so a resend is applied once.         |
| `ack`   | hub → edge | `{cid, seq}`, or `{cid, refused, why, current}`.                                 |
| `evt`   | hub → edge | `{seq, type, body, actor, cmd}`. Edges apply in `seq` order and move the cursor. |
| `beat`  | edge → hub | `{sessions: [...]}` every 30 seconds.                                            |
| `call`  | hub → edge | Brokered request to a daemon (today's `http` frame). Kept for file-level reads.  |

Event types reuse the `ServerEvent` vocabulary (`packages/server/src/events.ts`)
where one exists (`task.changed`, `run.changed`, `run.log`, `message.new`), so
the desktop and the web dashboard read one stream whether it comes from a local
daemon or the hub.

### Example: Bob picks up work while Alice is busy

```text
alice → hub  cmd  {cid:"01J…A", type:"claim", body:{task:"t-12", writes:["packages/server/src/team/**"]}}
hub → alice  ack  {cid:"01J…A", seq:4101}
hub → all    evt  {seq:4101, type:"claim.granted", body:{task:"t-12", session:"claude-code-7f3a2c"}}

bob → hub    cmd  {cid:"01J…B", type:"claim", body:{task:"t-12", writes:[…]}}
hub → bob    ack  {cid:"01J…B", refused:true, why:"held",
                   current:{session:"claude-code-7f3a2c", actor:"agent:alice/…", since:"17:04"}}

bob → hub    cmd  {cid:"01J…C", type:"claim", body:{task:"t-15", writes:["packages/server/src/team/routes.ts"]}}
hub → bob    ack  {cid:"01J…C", refused:true, why:"overlap",
                   current:{task:"t-12", paths:["packages/server/src/team/routes.ts"]}}
```

Bob's agent sees the refusal as the `task_next` tool result and takes the next
task that is free.

## Offline: the queue

An edge applies its own write to the local cache at once, puts the command in an
outbox table and shows the task as "not yet synced". On reconnect it sends the
outbox in order, then reads events from its cursor.

Each command carries `base`: for every field it sets, the `rev` the edge last
saw. The hub decides per field:

| Kind of change                                      | Rule                                                                                                                          |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Appends: comments, activity, findings, messages     | Always accepted. Ordered by arrival.                                                                                          |
| Field sets: status, title, assignee, priority, body | Accepted when the hub's `rev` equals `base`. Otherwise refused for that field, and the edge keeps the hub's value.            |
| Creates                                             | Accepted. Ids stay locally minted; on the rare collision the hub renames the newcomer and says so in the `ack`.               |
| Claims, and the dispatch that needs one             | Never queued. An offline dispatch starts with an unconfirmed claim and asks on reconnect; a refusal is a warning, not a kill. |

A refused field set is not silent. The edge writes an activity line on the task
and notifies the author.

### Example: an offline edit that loses

```text
(offline) alice sets t-9 status → "review"      base {status: 3990}
(meanwhile) bob sets t-9 status → "done"        hub seq 4050

alice → hub  cmd  {cid:"01J…D", type:"task.set", body:{id:"t-9", status:"review"}, base:{status:3990}}
hub → alice  ack  {cid:"01J…D", refused:true, why:"stale",
                   current:{status:"done", rev:4050, actor:"human:bob"}}
```

Alice's board shows `done`, with the line "Your offline change of status to
review was not applied: Bob set it to done at 16:52."

Body text is the weak spot: whole-field compare refuses an edit when anyone else
touched the body. Acceptable for a first version, since task bodies change
rarely after planning; a three-way text merge can come later.

## Identity

Accounts, teams, invites and device sign-in already exist in `apps/web`
(`users`, `members`, `invites`, `device_codes`, `devices`). They become the only
identity system for teams:

- A person signs in with GitHub or Linear. A machine signs in with the device
  code flow (`dispatch-mcp login`) and gets a device token.
- The hub attributes every command to the device's person and the session it
  names. `ActorRef` does not change.
- Seats are counted by the hub. A self-hosted hub still checks a license key
  past three seats.

Signed rosters, per-machine signing keys, invite secrets and fingerprint checks
go away with federation. The trust model becomes "the team trusts its hub",
which is what decision 2 already implies.

## The Overseer

Two separate things, built in this order:

1. **The state.** Everything above. Deterministic, no model involved. This is
   what makes "the hub knows everything" true.
2. **The agent.** Today's `OverseerManager`, given read tools over the whole
   team's state (`sessions`, `claims`, `runs`, `tasks`) and the existing gated
   actions. It can answer "who is stuck", "what collides", "what should Bob's
   idle session take".

The hub does not execute, so the agent runs on a member's machine with that
member's key and connects as a session of kind `overseer`. A hosted Overseer
with a team-supplied key is a later option and an open decision.

## What goes away

Line counts are source lines today, tests excluded.

| Code                                              | Lines  | Fate                                                                                                                |
| ------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/team/federation/`            | 14,517 | Deleted. Signed ops, roster, keys, content encryption, git and relay transports, onboarding.                        |
| `packages/server/src/team/boardSync/`             | 2,821  | Deleted. The per-field clock merge.                                                                                 |
| `packages/server/src/sync/`                       | 1,156  | Deleted. The git transport for board sync. _Unverified_ that nothing solo uses it.                                  |
| `packages/federation/`                            | 2,715  | Deleted, except `license.ts`, which moves to the hub.                                                               |
| `packages/protocol/src/federation/`               | 1,472  | Deleted from the engine's path. It is MIT and published; see "Costs".                                               |
| `packages/server/test/team/`                      | 24,647 | Mostly deleted with the code it tests.                                                                              |
| `packages/mcp/src/hub/`                           | 1,634  | Kept and simplified: it stays the machine's one connection, but stops being a protocol replica with loopback links. |
| `apps/web/src/hub.ts`                             | 654    | Rewritten as the authority.                                                                                         |
| `wsoule/dispatch-log`, the `ops/` and `fed/` logs | —      | Archived. No machine writes it again.                                                                               |
| The sealed relay (`wsoule/dispatch-relay`)        | —      | Retired for team sync. Not visible from this session, so its size is unknown.                                       |

Kept as they are: `packages/core`, the task model, the orchestrator, gates,
`packages/remote` and `apps/remote-relay` (the phone link is a solo feature and
stays end to end encrypted), the hosted planner, and the Linear integration,
which becomes simpler because the hub is the one Linear writer.

`packages/server/src/team/links/` (2,077 lines, teammate links for A2A) is
_unverified_: I have not established whether it serves people who share no team.
If it does, it needs its own decision.

## Costs, stated plainly

- **A privacy promise is withdrawn.** Clients show today that the relay "cannot
  read message contents", and teams can turn on end-to-end content encryption
  (`2026-10-05-sealed-relay-contract.md`). Under decision 2 a hub team has
  neither. Existing teams must be told before they move, and the site, the
  privacy policy and `RELAY_DISCLOSURE` need rewriting. Self-hosting the hub is
  the answer for a team that will not accept it.
- **A published protocol changes.** `@dispatch-foo/protocol` and
  `packages/protocol-spec` (appendix F) describe federation. Removing it is a
  breaking version of both.
- **The hub is a single point of failure for writes that need order.** Claims
  and dispatch need it. Everything else queues.
- **About 23,000 lines of shipped, tested code are deleted**, plus most of
  24,600 lines of tests. The federation work is not reusable here: its hard
  parts solve the absence of an orderer.
- **The free tier changes.** Git-only sync cost nothing to run. Every team now
  needs a hosted or self-hosted hub. Pricing for teams of three or fewer needs a
  decision.

## Phasing

Each phase ships on its own and leaves the tree working.

1. **Hub store and the read-only view.** The event log, tasks, sessions and runs
   on the hub; edges push their state up; the web dashboard reads it with
   machines asleep. Federation still runs. Proves the data model.
2. **Writes through the hub.** `cmd`/`ack`/`evt`, the local cache, the outbox
   and the offline rules. Board state stops traveling by federation.
3. **Sessions and claims.** Leases, stalled detection, admission.
4. **Messages, docs and memory move.** The hub becomes the message store;
   sealing ends.
5. **Teardown.** Delete federation, board sync, the relay transport and their
   tests. Migrate existing teams: one admin machine uploads its board as the
   first snapshot, the others resync, and the old op log is exported to the
   receipt log.
6. **The Overseer agent** over the whole team.

Phase 1 can also be reached faster by having the hub read the existing op log
and materialize it. That only works for teams without `content-e2e`, and it
builds on code phase 5 deletes, so the plan above skips it.

## Open decisions

1. **Existing teams.** How many real teams sync today? If it is only Wyat's own
   machines, phase 5's migration tool can be a script and the privacy notice is
   a formality. If others do, both are real work.
2. **Run logs.** Stream every `run.log` entry to the hub live (proposed, since
   it makes any run watchable from anywhere), or upload at the end. Live costs
   storage and bandwidth; needs a retention default (proposed: 30 days).
3. **Teammate links.** Keep, fold into the hub, or delete (see "What goes
   away").
4. **Where the hub core lives.** A new `packages/hub` (ELv2, added to
   `scripts/check-licenses.ts`) used by `apps/web`, or inside `apps/web`. A
   package makes self-hosting and testing easier.
5. **Hosted Overseer.** Whether the hub may ever run an agent with a
   team-supplied key.
6. **Free tier.** What a team of three or fewer pays for a hosted hub.
