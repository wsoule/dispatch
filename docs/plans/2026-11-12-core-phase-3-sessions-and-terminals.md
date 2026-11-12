# Dispatch core, phase 3: sessions, terminals and messages — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 3 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phase 1; can run beside
phase 2.

## Goal

The core runs programs in terminals that outlive it, knows every session on the
machine and its status, and lets sessions message each other. This is the part
of the core that is meant to feel like herdr-core.

**Done when** (the spec's check): a program runs in a held terminal and survives
a core restart; you attach, read and send; sessions message.

## Not in this phase

Starting an agent from a task, worktrees, approvals and review (phase 4). Other
machines (5). The bridge to outside agents, A2A (later).

## Decisions this plan makes

1. **Three crates**: `terminals` (holders and streams), `sessions` (the registry
   and status) and `messages`.
2. **A session is one record type** for anything doing work: a terminal the core
   started, a run (phase 4), or a hand-driven agent that joined through the MCP.
3. **Status words are herdr's**: `working`, `blocked`, `done`, `idle`, `error`,
   read from the open status signal (OSC 7501). `stalled` and `ended` are the
   core's own and are observed, never reported.
4. **The MCP is a client of the core**, shipped in the same binary as
   `dispatch-core mcp`. It holds no state of its own.
5. **Addresses do not change**: `agent:<operator>/<name>`, `run:<id>`,
   `human:<handle>`, `channel:<name>` (`packages/protocol/src/address.ts`).
6. **Caller tiers start here.** The operator's clients hold the operator token;
   a session's MCP presents that session's own token, which limits what it can
   read and change.

## Steps

| #   | Step               | What it adds                                                                                           | Test that proves it                                                                     |
| --- | ------------------ | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 1   | Holder             | A small process that owns one terminal and its program, with its own socket                            | Killing the core leaves the program running; a new core finds it                        |
| 2   | Run and list       | `terminal.run` (wait, or return at once), `list`, `kill`, `keep`                                       | A background program is listed with its folder and what runs in it                      |
| 3   | Read and send      | Read a terminal's screen and history without attaching; send it text                                   | Text sent to a shell appears in what is read back                                       |
| 4   | Attach             | A framed stream: first paint, then raw output; keys, resize and focus back; flow control               | A viewer that stalls gets a fresh repaint, and other viewers are not held up            |
| 5   | Status             | Read the status signal from a terminal's output; keep what was reported                                | A program that prints `blocked` shows as blocked; one that prints nothing has no status |
| 6   | Sessions           | The registry; a lease renewed by activity; `stalled` after two minutes of silence                      | A session whose program is frozen becomes stalled without anyone asking                 |
| 7   | Tokens and tiers   | An operator token and per-session tokens; each method names the tier it needs                          | A session token cannot read another session's mail or act as the operator               |
| 8   | MCP                | `dispatch-core mcp`: `whoami`, `session_label`, `agent_list`, and the task tools from phase 2          | Two MCP processes in one repo see each other in `agent_list`                            |
| 9   | Mail               | Messages, recipients, deliveries each with their own state, inboxes, threads                           | A message to an offline session waits and arrives when it returns                       |
| 10  | Channels and gates | Channels with members; a gate is a blocking question to a person, with typed data                      | A session that asks a gate stays `blocked` until a person at the decide tier answers    |
| 11  | Unread delivery    | The unread footer on tool results; hook output for clients that support hooks                          | A session with unread mail sees the count on its next tool result                       |
| 12  | Parents            | A program started inside a terminal is its child; the parent gets a note when a child needs it or ends | Ending a parent ends its children unless they were started to outlive it                |

## Notes for whoever builds it

- **herdr-core is the reference for steps 1 to 5 and 12.** Read its `holder.rs`,
  `terminals.rs`, `attach.rs`, `status.rs`, `notes.rs` and `schema/README.md`
  for the ideas and the edge cases. Write fresh code.
- **Today's terminal host** (`packages/server/src/terminalHost.ts`,
  `terminals.ts`) shows what Dispatch already keeps per terminal: bounded
  output, how much was trimmed, and a list that survives a restart.
- **Messaging is specified.** `docs/specs/2026-09-23-messaging-core-design.md`
  and `packages/protocol/src/engine.ts` define delivery, wake policy and gates.
  Keep the behavior; drop every federation hook.
- **Session naming is specified.** `docs/specs/2026-10-15-mcp-mesh-design.md`:
  `<client>-<sid>`, the session-key order, and "approve the client once, not
  every session".
- **Gate types that exist today**: `tool-approval`, `scope`, `wake`,
  `agent-registration`, `overseer-action`.

## What I have not verified

- **Which terminal library to build on.** herdr vendors Ghostty's and needs a
  Zig toolchain to build it. The requirement is a screen snapshot for "read" and
  first paint, and correct handling of what real agents draw. A short comparison
  belongs before step 3.
- **A Rust MCP library.** I assume one exists that is good enough; step 8 starts
  by confirming it, or writes the small stdio server by hand.
- **Which clients let an MCP write to the terminal**, which decides whether a
  hand-driven session can print the status signal itself or the core has to
  print it on its behalf.
