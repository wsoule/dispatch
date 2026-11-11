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
8. **The core is fully open source**, runner included. Today's daemon is
   source-available (FSL), so this opens code that was not open before.
9. **The core is written in Rust.**
10. **A team hosts its own server or pays about $10 a seat for a hosted one.**
11. **The sealed relay is retired** once this design covers what it does.
12. **The core is Apache-2.0.**
13. **A2A comes later.** The bridge to outside agents is not in the first build.
    It returns as a worker. Messaging between Dispatch agents is in the first
    build.
14. **Run logs stream to the server live** and are kept for 30 days.
15. **Billing is Stripe, and self-hosting is free at every size.** No license
    key gates a self-hosted server.
16. **The server is Elastic-2.0.**

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

`packages/hub` on this branch is a working TypeScript version of `home`: the
ordered log, per-field revs, claims and session leases, with 19 tests. Under
decisions 8 and 9 it does not ship. It stays as the reference the Rust `home` is
written against, and its tests become that module's acceptance tests.

### Rust, and what stays TypeScript

The core binary is Rust: `kernel`, `home`, `link`, `tasks`, `sessions`,
`messages`, `docs` and `memory`. The server is the same crates plus `identity`
and `mirror`.

Two things stay TypeScript at first and run as **workers**: separate processes
that are ordinary clients of the core's API.

- **The runner.** Agents are driven through the Claude Agent SDK, which is
  published for TypeScript and Python. _Unverified:_ I know of no Rust SDK. A
  worker also holds the orchestrator's review, verify and merge logic (36,705
  lines), which is the part most worth porting instead of rewriting.
- **Integrations.** Linear and GitHub sync are API glue with many edge cases.

This makes the language line the module line: state and order are Rust, things
that drive an outside program are workers. It has one cost for decision 6: the
Rust binary alone gives you the board, sessions and messaging, and dispatching
agents also needs the runner worker installed (a second binary the installer
fetches, with no app involved). A worker can be rewritten in Rust later without
touching the core, because it only uses the public API.

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

With the runner as a worker, the holder is the worker process for one run: it
owns the agent and reports to the core over the API, so a core restart only
drops a connection the worker reopens.

_Unverified, and the riskiest piece:_ runs use the Claude Agent SDK inside the
daemon today, and I have not established how much of a run's state lives in that
process. The runner plan needs that answered first.

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

### Hosting

A team either runs the server itself or pays per seat for a hosted one. Both are
the same binary.

Isolation for hosted teams, in the order to build it:

1. **One database file per team.** A request's team comes from its sign-in, and
   every query goes through a handle opened on that team's file, so no query can
   name another team's data. This is cheap and is where hosting starts.
2. **One encryption key per team** for that file at rest, so a leaked disk or
   backup does not expose every team.
3. **A dedicated instance** for a team that asks for it or grows large: its own
   process and volume. Because hosted and self-hosted are the same binary, this
   is self-hosting run by us.

The server never runs an agent or a team's code, so the risk to isolate is one
team reading another's data, not one team's code escaping. Seats are counted by
the server and billed through Stripe for hosted teams. A self-hosted server is
free at every size, so the license-key check in
`packages/federation/src/license.ts` goes away with the rest of that package.

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
| `packages/server/src/a2a`, `packages/a2a`                 | ~23,700 | Left out of the first build; returns later as a worker                 |
| `packages/mcp/src/hub`                                    | 1,634   | Deleted; the core is the machine hub                                   |
| `packages/mcp`, `packages/cli`                            | ~22,000 | Thinned to clients generated from the method table                     |
| `packages/core`                                           | 21,309  | Kept; it is the task model and storage the kernel builds on            |
| `packages/hub`                                            | ~1,050  | Becomes `home`                                                         |
| `apps/web`                                                | 15,122  | Its accounts and pages move to the server; `hub.ts` is replaced        |
| `packages/remote`, `apps/remote-relay`                    | ~2,000  | Kept; the phone link becomes one more binding of the same API          |
| `apps/desktop`, `packages/ui`, `packages/planning`        | —       | Kept; only the data layer changes                                      |

**Rewrite the state in Rust, port the workers.** Everything that holds or orders
state is new Rust code, written against today's behavior and tests: the kernel,
`home`, `link`, tasks, sessions, messages, docs and memory. The orchestrator and
the integrations move into TypeScript workers with their tests, behind the new
API. Rows above that say "ported" mean rewritten in Rust for state modules and
moved for workers.

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
- **Rust turns most of the port into a rewrite.** Roughly 85,000 lines of
  TypeScript state logic (the task model, messaging, docs, memory and the
  daemon's wiring) are rewritten, not moved. I recommended against this for that
  reason; it is decided, and the worker split above is how the design limits the
  cost.
- **Opening the core gives up the FSL protection** on the orchestrator. What is
  left to sell is the server and hosting.

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

None. Two smaller points were settled last:

- **The server is Elastic-2.0** (Wyat left the choice open; this is the pick).
  Anyone may run the server for their own team for free. Nobody may sell it to
  others as a hosted service. With self-hosting free and no license key, this is
  what keeps paid hosting ours.
- **The herdr status signal is not in the first build.** herdr is a separate
  tool some people run their agents inside. Dispatch could print a short signal
  so those agents show as working or blocked in herdr's own list. Nothing in
  Dispatch needs it, so it waits until someone asks.

## Notes on decided points

- **A2A is not how Dispatch agents talk to each other.** That is the `messages`
  module (the `msg_*` tools, inboxes, channels and gates): any session reaches
  any other through its core and, across people, the server. A2A is a separate
  bridge that speaks Google's Agent2Agent protocol, so an agent that does not
  use Dispatch at all can send work in and get results back.
- **A run log** is the live transcript of an agent: what it said and each tool
  it called. The machine running the agent always has it. Streaming it to the
  server lets anyone on the team watch any run live, and keeps it readable when
  the laptop sleeps.

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
