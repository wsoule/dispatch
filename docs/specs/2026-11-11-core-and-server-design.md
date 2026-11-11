# Dispatch core and Dispatch server — design

2026-11-11. Status: **agreed (Wyat, 2026-11-11).** Agents build it phase by
phase, each phase from its own plan; no plan is written yet. It replaces the
same day's central-hub draft, whose content is folded in here.

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
2. ~~The server may read everything.~~ Reversed by decision 18.
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
    It returns as a module. Messaging between Dispatch agents is in the first
    build.
14. **Run logs stream to the server live** and are kept for 30 days.
15. **Billing is Stripe, and self-hosting is free at every size.** No license
    key gates a self-hosted server.
16. **The server is Elastic-2.0.**
17. **Every session has a status, and it works with herdr.** Dispatch uses the
    same status words and the same signal herdr reads, in the first build.
18. **Everything a team shares is end-to-end encrypted.** Whoever hosts the
    server, us included, cannot read tasks, sessions, run logs, messages, docs
    or memory. This reverses decision 2.
19. **No sessions live on the web.** The hosted endpoint that lets a claude.ai
    session join a team from our server is removed, not postponed. A session
    always runs on a machine with a core.
20. **The app is modular the way herdr's app is.** A small app core, and every
    panel, menu and dialog a mod kept as a file the person can change.
21. **The app is native, like herdr's**, and is written fresh. Getting it right
    matters more than keeping today's app.
22. **The app is built on GPUI.**
23. **There is no web dashboard.** The server's website is sign-in, team setup,
    invites and billing. Team content is only ever opened by a core.
24. **Every machine runs the Overseer.** There is no central brain. The server
    stays as the always-on line and store, and nothing else.
25. **The server names the lead Overseer.** Every machine can oversee; one at a
    time does it for the team.
26. **Agents run as their own command-line programs, in terminals the core
    holds**, the way herdr runs them and the way Dispatch already integrates
    with each agent's CLI.
27. **Dispatch keeps its own task board** and syncs it with GitHub Issues and
    Linear.
28. **The core starts in a fresh repository**, `dispatch-core`, not inside this
    one.

## The shape

```text
 clients: desktop app · phone · CLI · MCP · your own program
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
│ stores it encrypted      │  cannot read it
└──────────────────────────┘
```

Three products, each usable without the next:

| Product | What it is                                              | Needs                 |
| ------- | ------------------------------------------------------- | --------------------- |
| Core    | The runtime on your machine. Draws nothing.             | Nothing else          |
| Server  | The team's always-on store and orderer. Cannot read it. | Cores that link to it |
| App     | Desktop, phone and web. Clients of a core or a server.  | A core or a server    |

### The one rule: every project has one home

A project's **home** is the one place that orders changes to it. Everyone else
**links** to the home, keeps a local copy and queues writes while offline.

| Situation           | Home              | How others reach it        |
| ------------------- | ----------------- | -------------------------- |
| Solo, one machine   | Your core         | Nothing to reach           |
| Solo, many machines | One of your cores | A pipe: SSH or any command |
| A team              | The team's server | A signed-in outbound link  |

Ordering is not a server feature; every core orders the projects it is home to.
For a team, the server gives each change its place in line without reading it,
and every core applies the same rules to the same line, so all of them reach the
same board (see "Encryption"). The server is the part that is always on and
knows who the members are.

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

| Module      | Does                                                         | In core | In server |
| ----------- | ------------------------------------------------------------ | ------- | --------- |
| `kernel`    | Method table, schema, event log, subscriptions, storage      | yes     | yes       |
| `home`      | The rules: per-field revs, appends, creates, claims          | yes     | no        |
| `sequence`  | Gives each change its place in line and keeps the log        | yes     | yes       |
| `link`      | Connects to a home: snapshot, events, outbox, offline rules  | yes     | accepts   |
| `keys`      | Team keys, device admission, sealing and opening content     | yes     | no        |
| `tasks`     | The task model and its views                                 | yes     | no        |
| `sessions`  | The session registry and reported status                     | yes     | no        |
| `terminals` | Holds programs in terminals; attach, read, send              | yes     | no        |
| `messages`  | Mail, channels, gates                                        | yes     | no        |
| `docs`      | Docs and their revisions                                     | yes     | no        |
| `memory`    | Memory entries and proposals                                 | yes     | no        |
| `runner`    | Starts agent CLIs in worktrees; review, verify, merge queue  | yes     | no        |
| `identity`  | Accounts, devices, teams, seats, billing                     | no      | yes       |
| `integrate` | Syncs the board with Linear and GitHub Issues; pull requests | yes     | no        |

The server is small: `kernel`, `sequence` and `identity`. It stores what cores
send and understands none of it.

`packages/hub` on this branch is a working TypeScript version of `home`: the
ordered log, per-field revs, claims and session leases, with 19 tests. Under
decisions 8 and 9 it does not ship. It stays as the reference the Rust `home` is
written against, and its tests become that module's acceptance tests.

### How agents run

Up to the server, the core is meant to feel like herdr-core with a task board:
it runs programs in terminals, keeps them alive, and lets a person attach and
take over.

**Every agent is its own CLI, started by the core in a held terminal.** There is
no agent SDK inside Dispatch. An agent can be started three ways, and all three
are that agent's own program:

| Way                  | What the core starts                                    | What Dispatch gets                          |
| -------------------- | ------------------------------------------------------- | ------------------------------------------- |
| Interactive          | The agent's normal screen, in a terminal you can attach | A live terminal; status the program reports |
| The agent's protocol | The same CLI in its machine-readable mode               | Approvals, cost, turns, a session to resume |
| One-shot             | The CLI's "run this prompt and exit" form               | Output and a diff to review                 |

This is what Dispatch does today, kept and made uniform:

- **Claude Code and Codex speak a protocol.** Today Dispatch reaches Claude
  through the Agent SDK, which itself starts the `claude` CLI, and reaches Codex
  through `codex app-server`. The core starts those same programs and speaks to
  them directly.
- **Every other agent runs one-shot** from a preset (`gemini`, `opencode`,
  `aider`, `goose` and others, in `executors/cliPresets.ts`), with the limits
  today's code states: no approval gate, no cost reporting, no resumable
  session.
- **Hand-driven sessions** still join through the MCP, whether or not the core
  started their terminal.

_Unverified, and to settle by a spike before the runner is planned:_ that the
`claude` CLI's machine-readable mode gives everything Dispatch uses the SDK for
today (approvals at a tool call, hooks, cost, resuming a session). I believe the
SDK is a wrapper over it and have not confirmed the coverage.

**One binary.** With no SDK there is no reason for a TypeScript part. The whole
core is Rust: `kernel`, `home`, `link`, `tasks`, `sessions`, `terminals`,
`runner`, `messages`, `docs`, `memory`, `keys`, `sequence` and `integrate`. The
server is `kernel` and `sequence` plus `identity`. Installing the core is one
binary, as decision 6 asks.

### The API

- **Methods** are JSON-RPC 2.0. One call per line in plain mode, so any language
  can talk to it.
- **Three bindings of the same method table**: a local socket (Unix socket or
  named pipe) for the app, the CLI, and the MCP; `dispatch connect`, which
  carries the protocol over stdin and stdout so `ssh box dispatch connect` is a
  remote core; and a WebSocket over TLS, which is how a core links to the server
  and how the phone reaches a core through its relay. With a native app and no
  web dashboard, nothing needs a plain HTTP API.
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

### Status

Every session reports a status, and Dispatch uses herdr's open status signal
(OSC 7501, the Program Status Protocol) for it instead of inventing its own.

| Reported state | Meaning                                                |
| -------------- | ------------------------------------------------------ |
| `working`      | The agent is running.                                  |
| `blocked`      | It needs a person: `permission`, `question` or `auth`. |
| `done`         | It finished and nobody has looked yet.                 |
| `idle`         | It is waiting for input.                               |
| `error`        | It stopped on a failure.                               |

A report can also carry a progress number and a short message.

- **One status, everywhere.** The core's session records, the app and the events
  all use these words. A blocked session names the gate it waits on.
- **It works with herdr.** The core reads the signal from any program in its
  terminals. For an agent that does not print it, the protocol or the MCP
  reports the same states, and the core prints the signal on the agent's behalf.
  A Dispatch agent running inside herdr then shows its state there with no extra
  setup.
- **Two more states are observed, never reported**: `stalled` (the core stopped
  hearing from the session) and `ended`. These are Dispatch's own and are not
  sent to herdr.

`packages/hub` uses `working`, `waiting` and `idle` today; the Rust `home` takes
the words above, with `waiting` becoming `blocked`.

### Holders and terminals

A holder is a small process that owns one terminal and the program in it, and
outlives the core. The core restarts or updates, then reattaches. This removes
"cannot restart while a run is live".

This is herdr-core's design, taken as it is: a running agent is a program in a
held terminal, whichever of the three ways started it. A person can list
terminals, read one without attaching, attach and take over, and detach without
ending the program. Today's terminal host (`terminalHost.ts`, `terminals.ts`) is
the starting point for what a holder keeps.

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

One per team, hosted at app.dispatch.foo or self-hosted. It is the team's
always-on line and store, and it cannot read what it holds.

- **It orders.** Every change a core sends gets the next sequence number and a
  time, and goes out to every other core.
- **It stores.** The whole encrypted log, encrypted snapshots, and encrypted run
  logs for 30 days, so a core that was away catches up and a new device starts
  from the latest snapshot.
- **It knows who the members are.** Accounts, teams, invites, device sign-in,
  seats and billing. These already exist in `apps/web` and carry over.
- **It reports who is connected.** A machine going silent is something the
  server sees for itself, so it writes that into the line in the clear, and
  cores turn it into `stalled` sessions and released claims.
- **It never runs an agent** and never holds a key.

"Knowing everything" therefore lives in the cores. Every member's core holds the
full, readable team state, kept current by the server, and every core runs the
Overseer over it (see "The Overseer").

**An always-on core of the team's own.** Anything that must read team content
while every laptop is closed (Linear sync, overseeing at night) runs on a core
the team owns, for example on a small server of theirs. It is a member device
like any other, holds the key and runs the Overseer like any other. The Dispatch
server never does.

### The Overseer

Every core oversees. Nothing central decides for the team. The Overseer has two
layers, and both run on every machine.

**The rules, always on.** Every core applies the same `home` rules to the same
line, so each one works out for itself who holds what, what collides, which
sessions are stalled and which claims have lapsed. This needs no model and costs
nothing. It is the "overseer that knows every state", and there is one on every
machine.

**The agent, on each person's machine.** An agent with read tools over the whole
team's state, using its operator's own model key. It is the same on every
machine. What differs is its scope:

| Duty                                                        | Who does it            |
| ----------------------------------------------------------- | ---------------------- |
| Tell its operator what needs them, across the team          | Every Overseer         |
| Look after its own machine's sessions                       | Every Overseer         |
| Team-wide: notice stalled work, collisions, re-queue, split | The lead Overseer only |

**The server names the lead.** Each core tells the server, in the clear, whether
its Overseer agent is on and willing to lead. The server picks one of the
connected, willing machines and writes "the lead is this device" into the line.
It needs to read nothing to do that; it already knows who is connected.

- **Order of preference.** The team sets it: for example the team's always-on
  core first, then people in a chosen order. With none set, the server takes the
  machine that has been connected longest.
- **Handover.** When the lead goes silent for two minutes, the server names the
  next and writes that into the line.
- **Everyone agrees who leads.** The lead is a fact in the line with a sequence
  number, so every core knows who led at each point. A team-wide action from a
  machine that was not the lead at that point is refused by the rules, which
  covers a machine that went offline still believing it led.
- **No extra power.** The lead reads nothing the others cannot and holds no
  special key. Leading only means its agent is the one that thinks about
  team-wide events, so the team pays for that thinking once, not once per
  machine.

```text
alice's laptop and the team's always-on core are connected; the team prefers the core.

server → line   seq 5000  lead = team-core
t-15 stalls     team-core's Overseer re-queues it; alice's Overseer only tells alice
team-core drops server → line   seq 5040  lead = alice-mbp
```

With one person and several machines, the project's home core does the naming.
With one machine there is nothing to name.

**What stays human.** Today's gates carry over: an Overseer action that today
needs a person's approval still asks its own operator first.

**Cost.** Team-wide thinking is spent on the lead's operator's tokens. A team
that wants that shared runs an always-on core with a team key for the model and
puts it first. An operator can turn their agent off or decline to lead; the
rules layer keeps running.

**The server is still needed.** Decentralized here means no machine is in charge
and none can read more than another. The server remains as the one always-on
thing that lines changes up and holds them, because without a single line the
cores would have to merge conflicting histories, which is the problem federation
had.

### Encryption

Every core seals what it sends with the team's key before it leaves the machine,
and opens what it receives.

**What the host can and cannot see**

| Cannot see                                             | Can see                                        |
| ------------------------------------------------------ | ---------------------------------------------- |
| Tasks, comments, findings, claims                      | Who is on the team and their devices           |
| Session records, status, run logs and diffs            | Which device sent a change, when, and its size |
| Messages, channels, docs, memory                       | Which devices are connected                    |
| Project and task names (projects are opaque ids to it) | Seat count and billing                         |

**How order works without reading.** The server only lines changes up. Every
core runs the same `home` rules over the same line, using the server's sequence
numbers and times and never its own clock, so every core decides the same thing:
which edit was stale, who got the claim. A core learns whether its own change
held when it sees where the change landed.

```text
bob's core    seals claim{t-12} ──► server gives it seq 4102 ──► every core
every core    opens it, applies the rules to seq 4101 (alice's claim) then 4102
              → all agree: 4102 is refused, t-12 is held by alice's session
```

**The rules have a version.** Cores only agree if they run the same rules. The
line records the team's rules version; a core older than it reads but does not
write until it updates.

**Keys**

- **A team key per epoch**, held only by member devices. Content is sealed with
  the current epoch's key.
- **Joining.** An invite link carries a one-time secret in the part of the URL
  that is never sent to a server. The team key waits on the server sealed under
  that secret, so the new device opens it with nobody else online. The link is
  the key: it expires, works once, and is sent through a channel the team
  trusts.
- **Adding your own device.** An existing device of yours approves it and seals
  the key to it.
- **The device list is signed.** Each admission is signed by a device already on
  the list, back to the founding device, and every core checks that chain. The
  server cannot add a device of its own to read along.
- **Removing someone** starts a new epoch with a new key the removed devices
  never get, and the server stops serving them. They keep what they already had;
  nothing can take that back.
- **Recovery.** Each person gets a recovery phrase. A person who loses every
  device and the phrase is invited again by a teammate. A team whose every
  member loses everything has lost its data; nobody can recover it, us included.

The design for epochs, sealing and its test vectors already exists in the
federation code (`content.ts`, `teamKeys.ts`, `hpke.ts`, `seal.ts`,
`packages/federation/vectors`). It is rewritten in Rust as `keys`; the hard part
of federation, merging without an orderer, is still gone.

**No code from the host ever handles a key.** There is no web dashboard, so
content is only opened by a core the person installed. The server's website
handles sign-in, team setup, invites and billing, none of which needs the key.

**One mode.** Self-hosted servers are encrypted the same way. Two modes would
double what has to be tested, and a self-hosted team can run its own always-on
core for anything that needs to read.

### Hosting

A team either runs the server itself or pays per seat for a hosted one. Both are
the same binary.

Isolation for hosted teams:

1. **Encryption does most of it.** A team's content is sealed with a key the
   host never has, so one team cannot read another's even if a bug hands it the
   wrong rows.
2. **One database file per team**, so account and timing data stay apart and a
   team can be exported or deleted whole.
3. **A dedicated instance** for a team that asks for it: its own process and
   volume. Because hosted and self-hosted are the same binary, this is
   self-hosting run by us.

Seats are counted by the server and billed through Stripe for hosted teams. A
self-hosted server is free at every size, so the license-key check in
`packages/federation/src/license.ts` goes away with the rest of that package.

### Who owns what

| Record                       | Owner                  | Copies                   |
| ---------------------------- | ---------------------- | ------------------------ |
| Tasks, comments, findings    | The project's home     | Every linked core        |
| Claims                       | The project's home     | Every linked core        |
| Sessions and their status    | The machine running it | Every linked core        |
| Run logs and transcripts     | The machine running it | Linked cores, on request |
| Team docs, team memory, mail | The project's home     | Every linked core        |
| Personal docs and memory     | Your core              | None                     |
| Code, worktrees, API keys    | Your core              | None                     |

For a team, the server holds a sealed copy of every row above the last two.

### Claims

A claim is a lease on a task and the paths it declares, held by a session. It is
admitted when nobody else holds the task and no other live claim declares
overlapping paths. A claim with no declared paths holds only its task. A claim
lives while its session reports in; a session silent for two minutes is stalled,
and its claims are released 15 minutes later. A lost claim never kills a run:
the operator is warned and decides.

```text
bob claims t-12   → refused: held by agent:alice/claude-code-7f3a2c since 17:04
bob claims t-15   → refused: overlaps t-12 on src/team/routes.ts
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

The model is herdr's desktop app (`herdrdev/herdr-app`): the app's own core
stays small, and everything a person sees is a **mod**. Its guide says it
plainly: "Nothing in the default interface is special."

### Two programs

- **`dispatch`**, the core: runs agents, holds tasks and sessions. It keeps
  running when the window closes or updates.
- **`dispatch-app`**, the window: one client of the core. It can point at the
  local core or at another machine of yours.

### The app core stays small

The app core is the model the core's API gives it, layout documents, commands,
keys, and the mod API. Nothing else. Before anything is added to it, three
questions (herdr's rule, taken whole):

1. Does the app itself act on it, not only show it?
2. Can only the app see it, for example a change that happens while no mod is
   watching?
3. Can mods not do it correctly, even with care?

Three "no" answers mean it is a mod, even at the price of some repetition.

### Everything else is a mod

The board, a task's page, threads, the timeline, the graph, the run chat,
review, the sessions list, settings, the command palette, dialogs and
notifications are each a mod: a small program in its own folder that draws one
panel and calls commands.

| File                  | What it decides                             | Applied     |
| --------------------- | ------------------------------------------- | ----------- |
| `layouts/<name>.json` | The window: which mods sit where, the theme | live        |
| `mods/<name>/`        | One panel, menu or dialog                   | live reload |
| `keys.json`           | What every key does                         | live        |
| `settings.json`       | The person: fonts, zoom, sounds             | live        |

These live in one app folder on the person's machine: the interface, as files.

- **Shipped and personal.** Shipped layouts and mods are replaced on update. To
  change one, duplicate it; personal copies are never overwritten.
- **Safe to break.** An invalid file keeps the last good version and writes the
  reason beside it. One key that nothing can rebind returns to the default
  layout.
- **Agents can change the window.** The app writes a guide and the API's type
  file into the app folder on every start, and has commands to list, check and
  screenshot (`dispatch-app status`, `check <mod>`, `shot`). "Give me a sidebar
  of blocked agents" is something a person asks their agent for.
- **Mods are trusted code, not sandboxed.** A mod has the person's access to the
  core, which includes readable team content. Read a mod before installing it,
  as you would a shell script.
- **Mods are personal.** They are files on a machine. The server does not carry
  them.

A sketch of a mod, to show the size intended (the API is not designed yet):

```js
// mods/blocked/main.js: every session waiting on a person
export default function Blocked({ dispatch, ui }) {
  const waiting = dispatch.sessions({ state: 'blocked' });
  return ui.list(waiting, (s) =>
    ui.row({
      title: s.label ?? s.id,
      note: s.waitingOn,
      onClick: () => dispatch.run('session.open', { id: s.id }),
    })
  );
}
```

### What mods are drawn with

The app is native: Rust, drawing on the GPU, with no web view. Mods are small
JavaScript programs that describe native elements; the app draws them. There is
no HTML or CSS in a mod.

herdr's app is built this way on GPUI (the UI library from the Zed editor) and
gpui-kit, which runs the JavaScript mods. Both are Apache-licensed.

GPUI is decided (decision 22). _Unverified, and the riskiest piece in the app:_
the mod runtime. herdr ships its own patched copies of GPUI and gpui-kit, which
says they need upkeep. The spike (see "Build order") settles whether Dispatch
uses gpui-kit for mods or its own thin layer over GPUI.

What this means for today's code:

- **The desktop app is replaced**, along with `packages/ui` and
  `packages/planning`. Today's app stays as the reference for what each view
  does until its mod exists.
- **The phone app stays separate.** A native desktop library does not run on a
  phone, so the phone keeps its own small app as a client of the core.
- **There is no web dashboard** (decision 23).

## Repositories

Proposed end state:

| Repository        | Holds                                                               | Depends on              |
| ----------------- | ------------------------------------------------------------------- | ----------------------- |
| `dispatch-core`   | The kernel and core modules, the CLI, the MCP, the schema, the spec | Nothing of Dispatch's   |
| `dispatch-server` | `identity`, the hosted site, billing, the deployment                | Published core packages |
| `dispatch` (app)  | The native app, its shipped mods, the phone app, the marketing site | The published client    |
| `dispatch-plugin` | As today                                                            | The published MCP       |

The contract between repositories is the published schema and client package,
not source imports.

**Fresh repositories from the start** (decision 28). An earlier draft said to
build inside this repo and split last, because the new code would share code
with the old. It no longer does: the core is a Rust rewrite and nothing carries
over as code. So `dispatch-core` begins as its own repository, Apache-2.0 from
its first commit. This repository keeps running and is the reference for
behavior until the new one replaces it. The server and app repositories are
created when their phases start.

## What happens to today's code

Source lines, tests excluded.

| Today                                                     | Lines   | Fate                                                                   |
| --------------------------------------------------------- | ------- | ---------------------------------------------------------------------- |
| `packages/server` routes, events, wiring                  | ~29,000 | Rewritten as the kernel and the method table                           |
| `packages/server/src/orchestrator`                        | 36,705  | Rewritten in Rust as `runner`, with today's tests as the reference     |
| `packages/server/src/team`, `sync`, `packages/federation` | ~24,000 | Deleted                                                                |
| `packages/protocol/src/federation`                        | 1,472   | Deleted as code; its key, epoch and sealing design carries into `keys` |
| `packages/server/src/messaging`, `packages/protocol`      | ~12,000 | Ported into `messages`; the delivery engine loses its federation hooks |
| `packages/server/src/docs`, `memory`, `packages/memory`   | ~23,500 | Ported into `docs` and `memory`                                        |
| `packages/server/src/linear`                              | 10,435  | Rewritten as `integrate`; a team runs it on one core it picks          |
| `packages/server/src/a2a`, `packages/a2a`                 | ~23,700 | Left out of the first build; returns later as a module                 |
| `packages/mcp/src/hub`                                    | 1,634   | Deleted; the core is the machine hub                                   |
| `packages/mcp`, `packages/cli`                            | ~22,000 | Thinned to clients generated from the method table                     |
| `packages/core`                                           | 21,309  | Kept; it is the task model and storage the kernel builds on            |
| `packages/hub`                                            | ~1,050  | Becomes `home`                                                         |
| `apps/web`                                                | 15,122  | Accounts and pages move to the server; `hub.ts` and `mcp.ts` are cut   |
| `packages/remote`, `apps/remote-relay`                    | ~2,000  | Kept; the phone link becomes one more binding of the same API          |
| `apps/desktop`, `packages/ui`, `packages/planning`        | —       | Replaced by the native app; kept as the reference until then           |

**Everything is rewritten in Rust.** Today's code and its tests are the
reference for behavior, not something that is moved. Rows above that say
"ported" mean rewritten against that reference.

**GitHub Issues sync is new.** Today Dispatch syncs tasks with Linear and works
with GitHub pull requests; it does not sync GitHub issues. `integrate` adds it
on the same model as Linear: Dispatch's board is the source, and each side's
changes are mapped to the other.

## Costs, stated plainly

- **The desktop app is written again from nothing.** It is the largest part of
  the tree (roughly 230,000 lines under `apps/desktop`, plus the component
  library). Every view is rebuilt as a native mod.
- **Native mods are harder to write than web pages.** Fewer people know the
  toolkit, and nothing from the web's libraries carries over.
- **The product stops gaining features for the length of the rewrite.** The
  build order below keeps the old daemon working until the new core can replace
  it, but attention is finite.
- **The host can do nothing that needs reading.** No server-side search, no
  Linear sync on the server, no email that quotes a task. Those run on a
  member's core or on an always-on core the team owns.
- **claude.ai cannot join a team from our server.** Today a claude.ai session
  joins through `app.dispatch.foo/mcp` and lives on the hosted hub
  (`apps/web/src/mcp.ts`). That is removed (decision 19).
- **Lost keys are lost data.** There is no reset we can perform.
- **A person who leaves keeps what they already had.**
- **Every core must run the same rules.** A rules change is a coordinated
  update, and an out-of-date core cannot write.
- **A new device has more to do.** It downloads a sealed snapshot and the line
  after it, and opens all of it locally.
- **A published protocol breaks.** `@dispatch-foo/protocol` and the protocol
  spec's federation appendix need a breaking version.
- **The server is a single point of failure for claims and dispatch.**
  Everything else queues.
- **Holders are new to Dispatch.** herdr proves the design; Dispatch still has
  to build it.
- **Rust makes the whole core a rewrite.** Roughly 130,000 lines of TypeScript
  (the task model, messaging, docs, memory, the orchestrator, Linear sync and
  the daemon's wiring) are rewritten, not moved. I recommended against Rust for
  that reason; it is decided, and one language and one binary is what it buys.
- **Dropping the SDK means owning the agent protocols.** When the `claude` or
  `codex` CLI changes its machine-readable mode, Dispatch adapts, where today
  the SDK absorbs some of that.
- **A synced board is not fully private.** Tasks a team syncs to GitHub Issues
  or Linear are readable by those services. The encryption covers what stays in
  Dispatch.
- **Opening the core gives up the FSL protection** on the orchestrator. What is
  left to sell is the server and hosting.

## Build order

Each phase is a unit an agent team can take, with a check that says it is done.
The old daemon and today's app keep running until phase 9.

| #   | Phase               | Done when                                                                                                      | After    |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Kernel              | A method table yields the socket, stdio and WebSocket bindings, the schema and the only-grows test             | —        |
| 2   | Home and tasks      | One core per machine serves several projects; the board works through the new API                              | 1        |
| 3   | Sessions, terminals | A program runs in a held terminal and survives a core restart; you attach, read and send; sessions message     | 1        |
| 4   | Runner              | A Claude Code run and a Codex run each start from a task, ask for approval, and pass review, verify and merge  | 2, 3     |
| 5   | Link                | Two of your machines share a project over SSH; the offline rules pass with the link cut                        | 2        |
| 6   | Keys                | Two devices share a team key through an invite link; a removed device cannot open later changes                | 5        |
| 7   | Server              | Two people see each other's sessions and cannot both claim a task; the server's files hold no readable content | 6        |
| 8   | App spike           | A native window lists live sessions from the core, and one JavaScript mod redraws when its file is saved       | 1        |
| 9   | App core and mods   | The board, task page and sessions list run as native mods; a layout file rearranges the window live            | 2–4, 8   |
| 10  | Docs, memory, sync  | Docs and memory work; a task changed in Linear or GitHub Issues changes on the board, and the reverse          | 2        |
| 11  | Teardown and split  | Federation, board sync, the machine hub, the old daemon and the old app are deleted; repositories separate     | 7, 9, 10 |
| 12  | Overseer agent      | The lead acts once on a stalled task; when its machine drops, the server names another and it takes over       | 7        |

Phases 3, 5 and 10 can run in parallel once 2 lands. The app spike (8) can start
as soon as the kernel exists, and it decides the toolkit before phase 9 commits
to it.

## Open decisions

None.

Settled last: the server's license (Wyat left the choice open; Elastic-2.0 is
the pick). Anyone may run the server for their own team for free. Nobody may
sell it to others as a hosted service. With self-hosting free and no license
key, this is what keeps paid hosting ours.

## Notes on decided points

- **A2A is not how Dispatch agents talk to each other.** That is the `messages`
  module (the `msg_*` tools, inboxes, channels and gates): any session reaches
  any other through its core and, across people, the server. A2A is a separate
  bridge that speaks Google's Agent2Agent protocol, so an agent that does not
  use Dispatch at all can send work in and get results back.
- **A run log** is the live transcript of an agent: what it said and each tool
  it called. The machine running the agent always has it. Streaming it sealed
  through the server lets anyone on the team watch any run live, and keeps it
  readable to them when the laptop sleeps.

## Taken from herdr, and not

herdr is the reference for this design, not something Dispatch runs on.

Read: herdr-core's README, agent guide, machines, security and API docs, and its
module layout; herdr-app's README, agent guide, mods and security docs, and the
opening of its mod guide. Not read: either's Rust source in depth, or the mod
API in full. Not run.

Taken: a headless core per machine; one API with a generated schema that only
grows; every UI as a client; the same protocol over any pipe; holders; reported
status; snapshot-then-events with a `missed` notice; isolated sessions for
tests; a size budget. From the app: a small app core with a three-question gate,
everything else as mods, the interface as files, shipped and personal copies,
live reload that keeps the last good version, and an app agents can inspect and
change.

Not taken: its trust model (anything on the socket is you), and the absence of
any always-on node. A team needs to know who acted, and needs state that stays
readable when a machine is away.
