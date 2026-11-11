# Dispatch core and Dispatch server — design

2026-11-11. Status: **draft for discussion.** No code is to be written from this
until Wyat agrees it; agents build it afterwards, phase by phase. It replaces
the same day's central-hub draft, whose content is folded in here.

Sections marked _unverified_ rest on a reading of headers, docs and line counts,
not on a full read of the code.

## Why

Three facts about Dispatch today, each checked against the tree:

- **Nobody holds the whole picture.** One `dispatchd` per checkout knows that
  checkout. The machine hub (`packages/mcp/src/hub`) knows one user's sessions
  and mail. The hosted hub (`apps/web/src/hub.ts`) routes mail and asks a
  machine live for tasks, so it knows nothing while that machine sleeps.
  Federation logs carry the board, and every daemon re-merges its own copy.
- **The app is required to run the daemon.** `@dispatch/server` is private and
  ships only as a binary inside the desktop app. The CLI's own error says so:
  "install the Dispatch app (it ships dispatchd)". Only the MCP's small hub
  installs alone.
- **The daemon cannot restart under load.** Runs execute inside it, so it
  refuses to restart while any run, merge, plan or terminal is live.

herdr-core (`herdrdev/herdr-core`, Apache-2.0) solves the single-person version
of this well: one headless core per machine, one API, every UI a client, other
machines reached over a pipe. It has no people, tasks or shared order. This
design takes its shape and adds the part a team needs.

## Decisions so far (Wyat, 2026-11-11)

1. **Every team has a server.** Git-only teams go away.
2. **The server may read everything**: tasks, sessions, run logs, messages, docs
   and memory. Sealed mail and `content-e2e` do not survive.
3. **Offline writes queue** and reconcile on reconnect.
4. **A clean break.** Nobody but Wyat syncs a team, so nothing is migrated.
5. **Three layers**: a core on your machine, your own machines joined to each
   other, and a server for the team. The server is a big core.
6. **The core runs without the app.** No app download is needed to install or
   run it.
7. **A rewrite is acceptable**, and the core, server and app may end up in
   separate repositories.

## The shape

```text
 clients: desktop app · web dashboard · phone · CLI · MCP · your own program
    │  one API (every client uses the same methods and events)
    ▼
┌──────────────────────────┐   pipe (ssh or any command)   ┌─────────────────┐
│ Dispatch core            │◄─────────────────────────────►│ Dispatch core   │
│ one per machine          │                               │ another machine │
│ runs agents · owns its   │                               │ of yours        │
│ sessions · works offline │                               └─────────────────┘
└────────────┬─────────────┘
             │ link (outbound, signed in)
             ▼
┌──────────────────────────┐
│ Dispatch server          │  one per team, always on
│ orders what people share │  never runs an agent
│ mirrors every machine    │
└──────────────────────────┘
```

Three products, each usable without the next:

| Product | What it is                                              | Needs                 |
| ------- | ------------------------------------------------------- | --------------------- |
| Core    | The runtime on your machine. Draws nothing.             | Nothing else          |
| Server  | The team's always-on core, with accounts and no runner. | Cores that link to it |
| App     | Desktop, phone and web. Clients of a core or a server.  | A core or a server    |

### The one rule: every project has one home

A project's **home** is the one place that orders changes to it. Everyone else
**links** to the home, keeps a local copy and queues writes while offline.

| Situation           | Home              | How others reach it        |
| ------------------- | ----------------- | -------------------------- |
| Solo, one machine   | Your core         | Nothing to reach           |
| Solo, many machines | One of your cores | A pipe: SSH or any command |
| A team              | The team's server | A signed-in outbound link  |

This is what makes the server "a big core". Ordering is not a server feature;
every core orders the projects it is home to. The server is a home that is
always on and knows who people are.

It also removes a problem the earlier draft had. There, the local store was a
cache of a remote authority, which fought the synchronous task store. Here the
local store is always real: it is either the home, or a full copy of the home
with an outbox.

## Dispatch core

One process per machine and OS user, not one per checkout. It replaces both the
per-project `dispatchd` and the machine hub.

### What it owns

- The projects registered on this machine, and the full local copy of each.
- Every session on this machine: dispatched runs and hand-driven agents that
  connect through the MCP.
- Agent execution: worktrees, the agent process, review, verify and merge.
- Code, API keys, personal docs and personal memory. These never leave.

### Rules, mostly borrowed from herdr-core

- **Core draws nothing.** Every surface is a client of one API.
- **One API, one method table.** The schema, the CLI and the client library are
  generated from it. A CLI command is one call. Today the same facts are kept by
  hand in three places: about 91 REST routes, the MCP tools and the CLI, with
  three copies of the `ServerEvent` type.
- **The API only grows.** A released schema is kept in the repo and a test fails
  on any change that would break a client of it.
- **Report what was observed, never what was assumed.** A session's status is
  what the session reported, plus what the core saw itself (it went silent).
- **Deciding code is separate from IO**, so it tests without processes.
- **Modules, with one-way dependencies.** A module can be left out of a build.
  The server is built by leaving out the runner and adding the team modules.
- **Small.** herdr-core is about 22,500 lines. Dispatch's daemon is about
  138,000. A budget per module belongs in each module's plan.

### Modules

| Module      | Does                                                                  | In core | In server |
| ----------- | --------------------------------------------------------------------- | ------- | --------- |
| `kernel`    | Method table, schema, event log, subscriptions, storage               | yes     | yes       |
| `home`      | Orders a project: per-field revs, appends, creates, claims            | yes     | yes       |
| `link`      | Connects to a home: snapshot, events, outbox, offline rules           | yes     | accepts   |
| `tasks`     | The task model and its views                                          | yes     | yes       |
| `sessions`  | The session registry and reported status                              | yes     | mirror    |
| `messages`  | Mail, channels, gates                                                 | yes     | yes       |
| `docs`      | Docs and their revisions                                              | yes     | team docs |
| `memory`    | Memory entries and proposals                                          | yes     | team      |
| `runner`    | Runs agents in worktrees through holders; review, verify, merge queue | yes     | no        |
| `identity`  | Accounts, devices, teams, seats                                       | no      | yes       |
| `mirror`    | Keeps each machine's sessions and runs readable while it is away      | no      | yes       |
| `integrate` | Linear and GitHub                                                     | solo    | team      |

`packages/hub` on this branch is a working first version of `home`: the ordered
log, per-field revs, claims and session leases, with 19 tests. It was written as
a server-only Elastic-2.0 package. Under this design every core runs it, so its
place and license change (see "Open decisions").

### The API

- **Methods** are JSON-RPC 2.0. One call per line in plain mode, so any language
  can talk to it.
- **Three bindings of the same method table**: a local socket (Unix socket or
  named pipe) for the CLI, the MCP and other cores; `dispatch connect`, which
  carries the protocol over stdin and stdout so `ssh box dispatch connect` is a
  remote core; and HTTP with a WebSocket on localhost, because the desktop
  webview and a browser cannot open a Unix socket.
- **Events**: `subscribe` answers with a snapshot and a sequence number, then
  sends events in order, a heartbeat when quiet, and a `missed` notice when the
  client fell too far behind and must take a fresh snapshot. The docs carry a
  table of how to apply each event to a snapshot.

Example, a client following every session on this machine:

```text
→ {"jsonrpc":"2.0","id":1,"method":"session.subscribe","params":{}}
← {"jsonrpc":"2.0","id":1,"result":{"seq":4100,"sessions":[…]}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":4101,"type":"session.changed",
     "session":{"id":"claude-code-7f3a2c","state":"waiting","waitingOn":"gate-7"}}}
← {"jsonrpc":"2.0","method":"heartbeat","params":{"seq":4101}}
```

### Who may call it

herdr-core trusts anything that reaches its socket. Dispatch cannot: a
dispatched run must not act as its operator. The core keeps today's tiers: the
operator's clients hold the operator token, and a run's MCP presents that run's
own token, which limits what it can read and change. Closing the known gap (a
run that reads the operator token from disk) still needs sandboxing and is out
of scope here.

### Holders

A holder is a small process that owns one running agent and outlives the core.
The core restarts or updates, then reattaches. This removes "cannot restart
while a run is live".

_Unverified, and the riskiest piece in the core:_ runs use the Claude Agent SDK
inside the daemon today, and I have not established how much of a run's state
lives in that process. The holder plan needs that answered first.

### Install and state

- One binary, `dispatch`, installed by a script, a package manager or `npx`. Any
  command starts the core in the background when none runs.
- The app finds a running core or starts the one it finds installed. It may
  bundle a core for convenience, but nothing requires the app.
- State under `~/.dispatch/core/<session>/`: one machine database (projects,
  sessions, messages) and one database per project. A `DISPATCH_SESSION`
  variable selects a separate core and state directory, which tests use so they
  never touch the real one.

## Your own machines

`dispatch machine add user@host --name box` saves a pipe to another core of
yours. The command runs `dispatch connect` on the other side; trust and
encryption are SSH's.

- Your core merges that machine's sessions and runs into one list, addressed
  `box/<id>`. The other machine still owns them.
- A project that lives on both machines has one home (you choose which). The
  other links to it over the same pipe and queues writes while it is away.
- No account and no server are involved.

This is one person's trust domain. It is not a way to share with a teammate.

## Dispatch server

A core built without the runner and with `identity` and `mirror`. One per team,
hosted at app.dispatch.foo or self-hosted.

- **It is the home of the team's projects.** It orders tasks, claims, team docs,
  team memory and messages.
- **It mirrors every machine.** Each linked core sends its sessions, run
  lifecycle and run logs, so the team view and the web dashboard work while a
  laptop sleeps. The machine remains the owner; the mirror is a copy.
- **It never runs an agent** and never holds code beyond the diff a finished run
  uploads for review.
- **It knows who people are.** Accounts, teams, invites and device sign-in
  already exist in `apps/web` and carry over. Signed rosters, per-machine keys
  and fingerprints go away with federation.
- **The Overseer agent comes last.** First the state exists; then an agent with
  read tools over the whole team connects as one more session, running on a
  member's machine with that member's key.

### Who owns what

| Record                       | Owner                  | Copies                                |
| ---------------------------- | ---------------------- | ------------------------------------- |
| Tasks, comments, findings    | The project's home     | Every linked core                     |
| Claims                       | The project's home     | Every linked core                     |
| Sessions and their status    | The machine running it | The server's mirror, your other cores |
| Run logs and transcripts     | The machine running it | The server's mirror                   |
| Team docs, team memory, mail | The server             | Linked cores                          |
| Personal docs and memory     | Your core              | None                                  |
| Code, worktrees, API keys    | Your core              | None                                  |

### Claims

A claim is a lease on a task and the paths it declares, held by a session. The
home admits it when nobody else holds the task and no other live claim declares
overlapping paths. A claim with no declared paths holds only its task. A claim
lives while its session reports in; a session silent for two minutes is stalled,
and its claims are released 15 minutes later. A lost claim never kills a run:
the operator is warned and decides.

```text
bob → home   claim {task:"t-12", session:"b1", writes:[…]}
home → bob   refused: held by agent:alice/claude-code-7f3a2c since 17:04

bob → home   claim {task:"t-15", session:"b1", writes:["src/team/routes.ts"]}
home → bob   refused: overlaps t-12 on src/team/routes.ts
```

### Offline

A linked core applies its own write locally, queues the command and marks the
task "not yet synced". On reconnect it sends the queue in order.

| Kind of change                              | Rule                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Appends: comments, activity, findings, mail | Always accepted, ordered by arrival.                                         |
| Field sets: status, title, assignee, body   | Accepted if nobody set that field since you last saw it. Otherwise refused.  |
| Creates                                     | Accepted. A taken id is renamed and the answer says so.                      |
| Claims                                      | Never queued. An offline run starts unconfirmed and asks when it reconnects. |

A refused edit is visible: the task gets a line such as "Your offline change of
status to review was not applied: Bob set it to done at 16:52."

## The app

Desktop, phone and web become clients and nothing else. They use the generated
client library and hold no logic the API does not expose. The desktop app can
point at the local core, at one of your other machines, or at the team's server
with the same code.

The desktop app is the largest part of the tree by far. It is not rewritten: its
data layer (`packages/client`) is replaced and the views stay.

## Repositories

Proposed end state:

| Repository        | Holds                                                               | Depends on              |
| ----------------- | ------------------------------------------------------------------- | ----------------------- |
| `dispatch-core`   | The kernel and core modules, the CLI, the MCP, the schema, the spec | Nothing of Dispatch's   |
| `dispatch-server` | `identity`, `mirror`, the hosted site, the deployment               | Published core packages |
| `dispatch` (app)  | Desktop, phone, web dashboard, the UI library, the marketing site   | The published client    |
| `dispatch-plugin` | As today                                                            | The published MCP       |

The contract between repositories is the published schema and client package,
not source imports.

**Recommendation: split last.** "No app download to run the core" is a packaging
requirement, and a single binary meets it from inside the monorepo. Splitting
while the API still changes daily turns every change into a publish and three
pull requests. Build in this repo with the boundaries enforced (a lint that
forbids imports across the three), and move directories out once the schema has
gone a few releases without a break. The move is then mechanical.

## What happens to today's code

Source lines, tests excluded.

| Today                                                     | Lines   | Fate                                                                   |
| --------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `packages/server` routes, events, wiring                  | ~29,000 | Rewritten as the kernel and the method table                           |
| `packages/server/src/orchestrator`                        | 36,705  | Ported into `runner`, behavior and tests kept, behind the new API      |
| `packages/server/src/team`, `sync`, `packages/federation` | ~24,000 | Deleted                                                                |
| `packages/protocol/src/federation`                        | 1,472   | Deleted; a breaking version of the published protocol                  |
| `packages/server/src/messaging`, `packages/protocol`      | ~12,000 | Ported into `messages`; the delivery engine loses its federation hooks |
| `packages/server/src/docs`, `memory`, `packages/memory`   | ~23,500 | Ported into `docs` and `memory`                                        |
| `packages/server/src/linear`                              | 10,435  | Ported into `integrate`; the server becomes a team's one Linear writer |
| `packages/server/src/a2a`, `packages/a2a`                 | ~23,700 | Undecided (see "Open decisions")                                       |
| `packages/mcp/src/hub`                                    | 1,634   | Deleted; the core is the machine hub                                   |
| `packages/mcp`, `packages/cli`                            | ~22,000 | Thinned to clients generated from the method table                     |
| `packages/core`                                           | 21,309  | Kept; it is the task model and storage the kernel builds on            |
| `packages/hub`                                            | ~1,050  | Becomes `home`                                                         |
| `apps/web`                                                | 15,122  | Its accounts and pages move to the server; `hub.ts` is replaced        |
| `packages/remote`, `apps/remote-relay`                    | ~2,000  | Kept; the phone link becomes one more binding of the same API          |
| `apps/desktop`, `packages/ui`, `packages/planning`        | —       | Kept; only the data layer changes                                      |

**Rewrite the spine, port the behavior.** The kernel, `home`, `link` and the
server are new code. The orchestrator, docs, memory and Linear hold years of
edge cases and their tests; those are moved behind the new API, not rewritten
from nothing. herdr-core's "fresh code only" rule suits a 22,000-line runtime,
not a product this size.

## Costs, stated plainly

- **The product stops gaining features for the length of the rewrite.** The
  build order below keeps the old daemon working until the new core can replace
  it, but attention is finite.
- **A privacy promise is withdrawn.** Clients say today that the relay cannot
  read message contents, and teams can turn on end-to-end encryption. Under
  decision 2 a team has neither. The site, the privacy policy and the disclosure
  text need rewriting before any team exists. Self-hosting the server is the
  answer for a team that will not accept it.
- **A published protocol breaks.** `@dispatch-foo/protocol` and the protocol
  spec's federation appendix need a breaking version.
- **The server is a single point of failure for claims and dispatch.**
  Everything else queues.
- **Holders are new and unproven** for agent runs.

## Build order

Each phase is a unit an agent team can take, with a check that says it is done.
The old daemon keeps running until phase 7.

| #   | Phase                | Done when                                                                                     | After |
| --- | -------------------- | --------------------------------------------------------------------------------------------- | ----- |
| 1   | Kernel               | A method table yields the socket, stdio and HTTP bindings, the schema and the only-grows test | —     |
| 2   | Home and tasks       | One core per machine serves several projects; the board works through the new API             | 1     |
| 3   | Sessions and mail    | The MCP is a client of the core; hand-driven sessions register, report status and message     | 1     |
| 4   | Runner               | A dispatched run survives a core restart; review, verify and merge pass the ported tests      | 2, 3  |
| 5   | Link                 | Two of your machines share a project over SSH; the offline rules pass with the link cut       | 2     |
| 6   | Server               | Two people on one team see each other's sessions and cannot both claim one task               | 5     |
| 7   | App on the new API   | Desktop, web and phone run on the generated client; the old daemon is not started             | 2–4   |
| 8   | Docs, memory, Linear | Ported modules pass their existing tests behind the new API                                   | 2     |
| 9   | Teardown and split   | Federation, board sync, the machine hub and the old daemon are deleted; repositories separate | 6–8   |
| 10  | Overseer agent       | An agent answers "who is stuck" and "what collides" across the team                           | 6     |

Phases 3, 5 and 8 can run in parallel once 2 lands.

## Open decisions

1. **Licenses.** Today the daemon is FSL, the libraries are MIT and the team
   tier is Elastic-2.0. `home` must be in the core, so it cannot stay
   Elastic-2.0. Which license does the core repository carry, and is the server
   the only Elastic-2.0 part?
2. **Language.** Stay on TypeScript and Bun, compiled to one binary
   (recommended: the orchestrator and the Claude Agent SDK are TypeScript, and
   the port depends on keeping them), or move the kernel to Rust as herdr did.
3. **A2A.** About 23,700 lines serve agent-to-agent links with outside agents
   and teammates. Keep as a module, or cut for now.
4. **Run logs on the server.** Stream every entry live (proposed) or upload at
   the end. Needs a retention default (proposed: 30 days).
5. **The free tier.** Layer 2 gives one person many machines with no server.
   What does a small team pay for a hosted one?
6. **The sealed relay** (`wsoule/dispatch-relay`, not visible from this
   session). Retired with federation, or kept for something.
7. **herdr interop.** Emitting herdr's status code (OSC 7501) from Dispatch runs
   is cheap and makes them show correctly inside herdr. Running Dispatch's
   terminals on herdr-core itself is a larger question, not proposed here.

## Taken from herdr-core, and not

Read: its README, agent guide, machines, security and API docs, and its module
layout. Not read: its Rust source in depth. Not run.

Taken: a headless core per machine; one API with a generated schema that only
grows; every UI as a client; the same protocol over any pipe; holders; reported
status; snapshot-then-events with a `missed` notice; isolated sessions for
tests; a size budget.

Not taken: its trust model (anything on the socket is you), and the absence of
any always-on node. A team needs to know who acted, and needs state that stays
readable when a machine is away.
