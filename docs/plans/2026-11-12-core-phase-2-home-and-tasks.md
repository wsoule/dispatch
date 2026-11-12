# Dispatch core, phase 2: home and tasks — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 2 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phase 1.

## Goal

The task board works through the new API. One core serves several projects, and
each project it is home to has an ordered log and rules that decide every
change.

**Done when** (the spec's check): one core per machine serves several projects;
the board works through the new API.

## Not in this phase

Running agents (phase 4), linking to another home (5), sealing (6). A session
can hold a claim here, but sessions themselves arrive in phase 3; until then a
claim's holder is whatever the caller names.

## Decisions this plan makes

1. **Two crates**: `sequence` (gives each command its place in line and keeps
   the log) and `home` (the rules). `tasks` is a module of `home` until
   something else needs it apart.
2. **The rules are pure.** `home` takes the current state and one sequenced
   command and returns the new state and events. It reads no clock and makes no
   random choice; time and ids come from the sequencer. Phase 6 depends on this,
   because every core must reach the same answer.
3. **One database per project**, under the core's state directory.
4. **Task fields are today's** (`TaskMeta` in `packages/core/src/types.ts`):
   title, status, kind, parent, milestone, blockedBy, labels, priority,
   assignee, writes, risk, model and the rest. Field names stay, so the import
   in step 10 is a copy.
5. **Project settings stay in the repo**, in `.dispatch/config.yml` (statuses,
   models, verify steps), because people write and review that file. The core
   reads it; it is not part of the ordered log.
6. **Ids are `t-` or `e-` plus eight hex characters**, minted by whoever creates
   the task. A taken id is renamed by the rules and the answer says so.
7. **The rules carry a version number** from the first commit.

## Steps

| #   | Step             | What it adds                                                                                              | Test that proves it                                                                   |
| --- | ---------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | Project database | A database per project; opened when the project is added, closed when removed                             | Two projects' tasks never appear in each other's lists                                |
| 2   | Sequencer        | A command gets the next number and a time, is stored, and is answered once per command id                 | A command sent twice is applied once and answered the same                            |
| 3   | Task model       | Types and validation for every field; statuses and kinds read from the project's config                   | A status the project does not define is refused with the list of valid ones           |
| 4   | Rules: tasks     | Create, set (per field, against the rev the caller last saw), append, remove with a tombstone             | The 19 cases in `packages/hub/test/hub.test.ts`, ported                               |
| 5   | Determinism      | A check that replays a project's log from nothing                                                         | Replaying any recorded log reproduces the stored state exactly                        |
| 6   | Methods          | `task.create`, `get`, `list` (with filters), `set`, `comment`, `remove`                                   | The CLI can create, edit, list and remove a task in a scratch project                 |
| 7   | Claims           | Claim and release; refusal when held or when declared paths overlap                                       | Path overlap matches `packages/core/src/conflicts.ts`, including `dir/**` and escapes |
| 8   | Events           | `task.created`, `changed`, `appended`, `removed`, `claim.granted`, `claim.released`, with the apply table | A subscriber that only applies events ends with the same board as a fresh snapshot    |
| 9   | Records          | Comments, findings, ledger entries and evidence as appends on a task                                      | Each kind round-trips and keeps its order                                             |
| 10  | What to work on  | `task.next`: ready, unblocked, unclaimed, ordered by priority                                             | Matches `packages/core/src/scoring.ts` and `graph.ts` on a fixture board              |
| 11  | Import           | `project import` reads a project from today's Dispatch (its database or its task files)                   | Wyat's own board imports with the same task count and fields                          |

## Notes for whoever builds it

- **`packages/hub` is the reference** for steps 2, 4 and 7. It is TypeScript and
  does not ship; read it, port its tests, write fresh Rust.
- **Status words changed after `packages/hub` was written.** Sessions use
  `working`, `blocked`, `done`, `idle` and `error`; a claim there says `waiting`
  where the spec now says `blocked`.
- **A claim with no declared paths holds only its task.** Core's `tasksConflict`
  treats an empty list as "could touch anything"; the rules must not, or one
  session blocks a whole project.
- **Step 5 runs in CI on every change to `home`.** A rule that depends on
  anything but the log breaks it, which is the point.

## What I have not verified

- That every field of `TaskMeta` is still used. Some may be dead; the import
  will show which.
- How today's task comments, findings and ledger entries are shaped in the
  SQLite backend versus the files backend. Step 11 has to read both.
