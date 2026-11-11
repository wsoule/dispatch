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
    It returns as a worker. Messaging between Dispatch agents is in the first
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

| Module      | Does                                                                  | In core | In server |
| ----------- | --------------------------------------------------------------------- | ------- | --------- |
| `kernel`    | Method table, schema, event log, subscriptions, storage               | yes     | yes       |
| `home`      | The rules: per-field revs, appends, creates, claims                   | yes     | no        |
| `sequence`  | Gives each change its place in line and keeps the log                 | yes     | yes       |
| `link`      | Connects to a home: snapshot, events, outbox, offline rules           | yes     | accepts   |
| `keys`      | Team keys, device admission, sealing and opening content              | yes     | no        |
| `tasks`     | The task model and its views                                          | yes     | no        |
| `sessions`  | The session registry and reported status                              | yes     | no        |
| `messages`  | Mail, channels, gates                                                 | yes     | no        |
| `docs`      | Docs and their revisions                                              | yes     | no        |
| `memory`    | Memory entries and proposals                                          | yes     | no        |
| `runner`    | Runs agents in worktrees through holders; review, verify, merge queue | yes     | no        |
| `identity`  | Accounts, devices, teams, seats, billing                              | no      | yes       |
| `integrate` | Linear and GitHub                                                     | yes     | no        |

The server is small: `kernel`, `sequence` and `identity`. It stores what cores
send and understands none of it.

`packages/hub` on this branch is a working TypeScript version of `home`: the
ordered log, per-field revs, claims and session leases, with 19 tests. Under
decisions 8 and 9 it does not ship. It stays as the reference the Rust `home` is
written against, and its tests become that module's acceptance tests.

### Rust, and what stays TypeScript

The core binary is Rust: `kernel`, `home`, `link`, `tasks`, `sessions`,
`messages`, `docs`, `memory`, `keys` and `sequence`. The server is `kernel` and
`sequence` plus `identity`.

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
- **It works with herdr.** The runner prints the signal for every run, and the
  MCP does for a hand-driven session where the client allows it. A Dispatch
  agent running inside herdr then shows its state in herdr with no extra setup,
  and Dispatch reads the same signal from any program that prints it.
- **Two more states are observed, never reported**: `stalled` (the core stopped
  hearing from the session) and `ended`. These are Dispatch's own and are not
  sent to herdr.

`packages/hub` uses `working`, `waiting` and `idle` today; the Rust `home` takes
the words above, with `waiting` becoming `blocked`.

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
full, readable team state, kept current by the server. The Overseer agent comes
last and runs where the state is readable: on a member's machine, with that
member's key.

**An always-on core of the team's own.** Anything that must read team content
while every laptop is closed (Linear sync, an always-on Overseer) runs on a core
the team owns, for example on a small server of theirs. It is a member device
like any other and holds the key. The Dispatch server never does.

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

**The web dashboard** opens content in the browser. A device of yours approves
the browser and seals the key to it. One honest limit: the page's code comes
from the host, so a host that turned hostile could serve code that takes the
key. The desktop app and the core do not have that limit.

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

_Unverified, and the riskiest piece in the app:_ herdr ships its own patched
copies of both libraries, which says they need upkeep. Whether Dispatch builds
on the same pair is decided by a spike (see "Build order"), not assumed here.

What this means for today's code:

- **The desktop app is replaced**, along with `packages/ui` and
  `packages/planning`. Today's app stays as the reference for what each view
  does until its mod exists.
- **The phone app stays separate.** A native desktop library does not run on a
  phone, so the phone keeps its own small app as a client of the core.
- **The web dashboard cannot share mods** with a native app. It would be a
  separate program written for the browser (see "Open decisions").

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
| `packages/protocol/src/federation`                        | 1,472   | Deleted as code; its key, epoch and sealing design carries into `keys` |
| `packages/server/src/messaging`, `packages/protocol`      | ~12,000 | Ported into `messages`; the delivery engine loses its federation hooks |
| `packages/server/src/docs`, `memory`, `packages/memory`   | ~23,500 | Ported into `docs` and `memory`                                        |
| `packages/server/src/linear`                              | 10,435  | Ported into `integrate`; for a team it runs on one core the team picks |
| `packages/server/src/a2a`, `packages/a2a`                 | ~23,700 | Left out of the first build; returns later as a worker                 |
| `packages/mcp/src/hub`                                    | 1,634   | Deleted; the core is the machine hub                                   |
| `packages/mcp`, `packages/cli`                            | ~22,000 | Thinned to clients generated from the method table                     |
| `packages/core`                                           | 21,309  | Kept; it is the task model and storage the kernel builds on            |
| `packages/hub`                                            | ~1,050  | Becomes `home`                                                         |
| `apps/web`                                                | 15,122  | Accounts and pages move to the server; `hub.ts` and `mcp.ts` are cut   |
| `packages/remote`, `apps/remote-relay`                    | ~2,000  | Kept; the phone link becomes one more binding of the same API          |
| `apps/desktop`, `packages/ui`, `packages/planning`        | —       | Replaced by the native app; kept as the reference until then           |

**Rewrite the state in Rust, port the workers.** Everything that holds or orders
state is new Rust code, written against today's behavior and tests: the kernel,
`home`, `link`, tasks, sessions, messages, docs and memory. The orchestrator and
the integrations move into TypeScript workers with their tests, behind the new
API. Rows above that say "ported" mean rewritten in Rust for state modules and
moved for workers.

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
The old daemon and today's app keep running until phase 9.

| #   | Phase                | Done when                                                                                                      | After    |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------- | -------- |
| 1   | Kernel               | A method table yields the socket, stdio and HTTP bindings, the schema and the only-grows test                  | —        |
| 2   | Home and tasks       | One core per machine serves several projects; the board works through the new API                              | 1        |
| 3   | Sessions and mail    | The MCP is a client of the core; hand-driven sessions register, report status and message                      | 1        |
| 4   | Runner               | A dispatched run survives a core restart; review, verify and merge pass the ported tests                       | 2, 3     |
| 5   | Link                 | Two of your machines share a project over SSH; the offline rules pass with the link cut                        | 2        |
| 6   | Keys                 | Two devices share a team key through an invite link; a removed device cannot open later changes                | 5        |
| 7   | Server               | Two people see each other's sessions and cannot both claim a task; the server's files hold no readable content | 6        |
| 8   | App spike            | A native window lists live sessions from the core, and one JavaScript mod redraws when its file is saved       | 1        |
| 9   | App core and mods    | The board, task page and sessions list run as native mods; a layout file rearranges the window live            | 2–4, 8   |
| 10  | Docs, memory, Linear | Ported modules pass their existing tests behind the new API                                                    | 2        |
| 11  | Teardown and split   | Federation, board sync, the machine hub, the old daemon and the old app are deleted; repositories separate     | 7, 9, 10 |
| 12  | Overseer agent       | An agent answers "who is stuck" and "what collides" across the team                                            | 7        |

Phases 3, 5 and 10 can run in parallel once 2 lands. The app spike (8) can start
as soon as the kernel exists, and it decides the toolkit before phase 9 commits
to it.

## Open decisions

1. **The web dashboard.** With a native app it shares nothing and is a separate
   program. It is also the one place where the host serves the code that handles
   a team's key. Proposed: leave it out of the first build. The server's site is
   then sign-in, team setup, invites and billing only.

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
