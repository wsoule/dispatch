# Dispatch core, phase 5: link — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 5 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phase 2.

## Goal

One person's machines work as one. A core reaches another core of yours over a
pipe, shows its sessions in the same list, and shares a project whose home is on
either machine, with edits queued while the pipe is down.

**Done when** (the spec's check): two of your machines share a project over SSH;
the offline rules pass with the link cut.

## Not in this phase

Teammates. Everything here is one person's trust: SSH decides who gets in, and
the home core reads the project in the clear. Sealing is phase 6 and the server
is phase 7; both reuse this phase's link.

## Decisions this plan makes

1. **One crate, `link`**, used by a core to reach any home. The server later
   accepts the same link.
2. **A machine is a saved pipe.** `machine add user@host` runs
   `dispatch-core connect` on the other side. Any command that carries stdin and
   stdout unchanged works in place of SSH.
3. **A project has one home**, chosen by the person. The other machine holds a
   full copy and an outbox.
4. **What you see locally is the home's state plus your own queued changes**,
   re-applied on top each time the home's state moves. A queued change that the
   home refuses is dropped from that view and reported.
5. **Claims are never queued.** An offline run starts unconfirmed and asks when
   the link returns.

## Steps

| #   | Step               | What it adds                                                                                         | Test that proves it                                                         |
| --- | ------------------ | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | Machines           | `machine add`, `ls`, `rm`, `login`; a custom connection command; reconnect with backoff              | A dropped pipe reconnects by itself and says so in `machine ls`             |
| 2   | Remote lists       | The other machine's sessions and terminals in this machine's lists, addressed `box/<id>`             | A terminal started on `box` appears here and can be read and attached       |
| 3   | Remote commands    | `--on <machine>` for running a program there; reading and editing a file there                       | A run started with `--on box` executes on `box`, not here                   |
| 4   | Hello and snapshot | A linking core says where it got to; the home answers with events, or a snapshot when too far behind | A core that was away for a long time catches up from a snapshot             |
| 5   | Commands           | A linked core's change is sent to the home, sequenced there, and comes back as an event              | Two cores editing one board end with the same board                         |
| 6   | Outbox             | Changes made while the pipe is down are stored and sent in order when it returns                     | Pull the link, make five edits, restore it: all five arrive in order        |
| 7   | Local view         | The home's state with queued changes on top; a "not yet synced" mark                                 | An edit made offline shows at once and loses its mark after it is sequenced |
| 8   | Refusals           | A stale edit is dropped from the local view, with a note on the task naming what won                 | The offline-edit example in the spec, exactly                               |
| 9   | Offline claims     | A run that starts offline holds an unconfirmed claim and asks on reconnect                           | A refused claim warns the operator and never kills the run                  |
| 10  | Choosing a home    | `project home` shows and sets which machine is home; moving a home                                   | After a move, both machines agree where the home is and nothing is lost     |
| 11  | Installing         | `machine add --install` copies this binary to a machine that lacks it                                | A machine with no core becomes usable after one confirmed command           |

## Notes for whoever builds it

- **herdr-core's `docs/machines.md`, `machines.rs`, `remote.rs` and
  `stitch.rs`** are the reference for steps 1 to 3 and 11: the target forms, the
  custom connection command, what happens when the remote login prints text, and
  how remote records are merged into one list.
- **The whole phase is testable on one machine.** Two cores in separate sessions
  joined by a pipe are two machines as far as `link` can tell. The "cut the
  link" tests close that pipe.
- **Step 7 is where bugs will hide.** The local view must be rebuilt from the
  home's state and the outbox every time, never patched in place.
- **Moving a home (step 10) is a command in the line**, so every copy learns of
  it in order.

## What I have not verified

- How large a snapshot gets for a busy project, and whether step 4 needs to send
  it in pieces.
- Windows: SSH and pipes behave differently enough there that steps 1 and 11
  need their own check.
