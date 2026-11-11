# Dispatch core, phase 1: the kernel — plan

2026-11-11. Status: **draft for Wyat's review.** Phase 1 of
`docs/specs/2026-11-11-core-and-server-design.md`. It is written here because
the `dispatch-core` repository does not exist yet; it moves there with the first
commit.

## Goal

A `dispatch-core` binary that starts a background core, answers a small API
three ways, keeps an ordered event log, and proves by test that the API cannot
break. No tasks, sessions, agents or teams yet.

**Done when** (the spec's check): one method table yields the socket, stdio and
WebSocket bindings, the schema, the CLI, and the only-grows test.

## Not in this phase

Tasks and `home` (phase 2), terminals and sessions (3), the runner (4), linking
(5), keys (6), the server (7), the app (8, 9). No installer; CI builds release
binaries and that is all.

## Decisions this plan makes

Each is small, and each is open to change in review.

1. **Binary name: `dispatch-core`** during the rewrite. Today's CLI is already
   `dispatch` on the same machines, and the two must run side by side. The new
   one takes the name `dispatch` at teardown (phase 11).
2. **Two crates to start**: `kernel` (everything the server also needs) and
   `dispatch-core` (the binary and its commands). A crate is added only when a
   later phase needs the boundary.
3. **Linux and macOS first.** All OS-specific code sits behind one `platform`
   module from the first commit, so Windows is an added file, not a refactor.
4. **The first real methods are the project registry** (`project.add`,
   `project.list`, `project.remove`). The kernel needs something that stores and
   emits events, and phase 2 needs exactly this.
5. **State lives in `~/.dispatch/core/<session>/`**, beside today's
   `~/.dispatch/` files and never inside them.
6. **SQLite through `rusqlite`**, bundled, so the binary needs no system
   library.

## The repository

```text
dispatch-core/
  Cargo.toml            workspace; Apache-2.0; publish = false
  rust-toolchain.toml   pinned
  justfile              fmt · lint · test · check (what CI runs)
  AGENTS.md             the rules below
  crates/
    kernel/             rpc · methods · schema · events · store · bindings
    dispatch-core/      main · cli · lifecycle · platform · methods/project
  schema/
    dispatch.openrpc.json   generated; a test fails when it is stale
    released.openrpc.json   the API as last released
    README.md               connecting, events, how to apply each event
  docs/                 commands.md (generated from help)
```

`AGENTS.md` carries the rules from the spec that code alone will not tell a new
agent: one API and one method table; the API only grows; deciding code is
separate from IO; a test first for each documented behavior; tests run in an
isolated session and never touch a real core; report what was observed; keep
files small.

## Steps

Each step is one pull request with its tests. Steps 4 to 8 can be taken by
different agents once step 3 has merged.

| #   | Step             | What it adds                                                                                                            | Test that proves it                                                           |
| --- | ---------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | Scaffold         | Workspace, license, pinned toolchain, format and lint config, `just check`, CI on Linux and macOS                       | CI is green on an empty binary that prints its version                        |
| 2   | RPC              | JSON-RPC 2.0 envelopes; errors with a stable `kind` and a `hint`; one exit code per kind                                | Malformed input, unknown method and bad params each give the documented error |
| 3   | Method table     | One declaration per method (name, params, result, doc, handler) that yields dispatch, the schema and the CLI command    | Adding a method in one place makes it callable, documented and a CLI command  |
| 4   | Store            | The machine database; versioned migrations; refuses a file written by a newer build                                     | A database stamped with a higher version is refused, not downgraded           |
| 5   | Event log        | An append-only log with sequence numbers; `events.subscribe` answers a snapshot, then events, a heartbeat, and `missed` | A slow subscriber gets `missed` and recovers with a fresh snapshot            |
| 6   | Socket and stdio | The local socket in a private directory; plain line mode; `dispatch-core connect` over stdin and stdout                 | The same request gives the same answer over the socket and through `connect`  |
| 7   | WebSocket        | The same methods over a WebSocket, as a library the server will use; off in the core by default                         | The same request gives the same answer over a loopback WebSocket              |
| 8   | Lifecycle        | Any command starts the core when none runs; one core per session; `core status`, `stop`, `restart`; logs                | Twenty commands at once start exactly one core                                |
| 9   | Projects         | `project.add`, `list`, `remove`, with events                                                                            | A subscriber sees a project appear and disappear in order                     |
| 10  | Only grows       | `released.openrpc.json` and the test that compares the current schema against it                                        | Removing a field, or adding a required input, fails the test with the reason  |
| 11  | CLI and docs     | People-readable output, `--json`, errors as JSON when piped; README; generated command reference                        | The command reference matches the binary's help                               |

## Notes for whoever builds it

- **Step 3 is the one to get right.** Everything after it leans on the method
  table. herdr-core's `api.rs`, `api/types.rs` and `rpc.rs` show one way to do
  it with a macro and `schemars`; read them for the idea and write fresh code.
- **Handlers receive who is calling.** Phase 1 trusts the socket's file
  permissions, as herdr does. The spec needs operator and per-run tokens later,
  so every handler takes a caller from the first commit and the tiers can be
  added without changing any method.
- **The WebSocket has no sign-in in this phase**, which is why the core does not
  open it. The server adds sign-in and TLS in phase 7.
- **Events carry the sequence number and are applied in order.** The table in
  `schema/README.md` says, for each event, how a client updates its snapshot.
  Later phases add rows to that table; they do not invent a second mechanism.
- **Isolation.** `DISPATCH_SESSION` selects a separate core, socket and state
  directory. Every test sets it and points the state at a scratch directory.

## What I have not verified

- That a macro-built method table stays pleasant at Dispatch's size.
  herdr-core's has 32 methods; today's Dispatch daemon has about 91 routes, so
  ours will be roughly three times larger.
- Windows: named pipes and process lifetime differ enough that step 8 will need
  its own design there.

## To start

Wyat creates the empty `dispatch-core` repository and attaches it to a session.
Step 1 is the first pull request.
