# Dispatch core, phase 10: docs, memory and sync — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 10 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phase 2; can run beside
phases 3 and 5.

## Goal

The core holds docs and memory, and keeps the board in step with Linear and
GitHub Issues.

**Done when** (the spec's check): docs and memory work; a task changed in Linear
or GitHub Issues changes on the board, and the reverse.

## Not in this phase

The A2A bridge to outside agents (later). Anything on the server: sync runs on a
core, because the server cannot read tasks.

## Decisions this plan makes

1. **Three crates**: `docs`, `memory`, `integrate`. They share nothing but the
   kernel and the task model.
2. **Team docs and team memory travel in the ordered line** like tasks, so they
   are sealed for teams with no extra work. Personal docs and personal memory
   stay in the machine database and never leave.
3. **Dispatch's board is the source.** Linear and GitHub Issues are mirrors that
   are mapped to and from it.
4. **One core does a team's syncing.** Two cores syncing one board would write
   every change twice. The team names the machine, and the line records it, as
   with the lead Overseer.
5. **Sync polls.** Linear and GitHub can push changes to a web address, but the
   only always-on address a team has is the server, which must not see task
   content. The syncing core asks for changes on a timer.
6. **GitHub Issues sync is new** and follows the Linear design.

## Steps

### A. Docs

| #   | Step   | What it adds                                                    | Test that proves it                          |
| --- | ------ | --------------------------------------------------------------- | -------------------------------------------- |
| 1   | Store  | Docs, revisions, sections, attachments; team and personal scope | A personal doc never appears in the line     |
| 2   | Links  | A doc linked to a task as its spec or plan                      | A run's prompt lists the docs its task links |
| 3   | Review | Proposing, reviewing and publishing a revision                  | Today's docs fixtures give the same outcomes |
| 4   | Tools  | `doc_save`, `doc_read` and the rest through the MCP             | An agent saves a plan and another reads it   |

### B. Memory

| #   | Step        | What it adds                                                      | Test that proves it                                  |
| --- | ----------- | ----------------------------------------------------------------- | ---------------------------------------------------- |
| 5   | Store       | Entries, proposals, team and personal scope                       | A proposal is not memory until a person approves it  |
| 6   | Ranking     | Which entries a run sees first; decay of unused ones              | Matches today's ranking on a fixture set             |
| 7   | Agent files | Import from and export to the memory files agents keep themselves | A round trip loses nothing                           |
| 8   | Tools       | The memory tools through the MCP                                  | A lesson one run saves reaches the next run's prompt |

### C. Sync

| #   | Step            | What it adds                                                                  | Test that proves it                                               |
| --- | --------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| 9   | Sync role       | Naming the one core that syncs for a team; handing it over                    | Two cores never both sync one board                               |
| 10  | Linear: connect | Sign in to Linear; choose teams; map statuses, labels and people              | A status with no mapping is reported, not guessed                 |
| 11  | Linear: sync    | Changes flow both ways; an echo of our own change is recognized and dropped   | An edit on each side at once ends the same on both                |
| 12  | GitHub Issues   | The same for issues: title, body, open or closed, labels, assignees, comments | A closed issue closes its task, and the reverse                   |
| 13  | Pull requests   | List pull requests, read diffs, comment and review, as today                  | A review task is made for a pull request and retires when it ends |

## Notes for whoever builds it

- **Docs and memory are specified.** `docs/specs/2026-09-25-docs-design.md` and
  `docs/specs/2026-09-25-memory-design.md`, with the code in
  `packages/server/src/docs/` (11,911 lines), `packages/server/src/memory/`
  (6,533) and `packages/memory/` (5,118). Their tests are the acceptance tests.
- **Linear sync is today's hardest-won glue**: `packages/server/src/linear/`
  (10,435 lines) and the `linear*.ts` files in `packages/core`. `reconcile.ts`
  and `sync.ts` hold the cases that only showed up in use: echoes, merge bases
  and conflicting edits. Port the cases as tests before writing the code.
- **Today's limits on docs and memory in teams go away.** `TEAM-SERVER.md` lists
  them (lessons that did not reach teammates, docs tied to a checkout's path).
  Putting both in the line removes them; check each one is gone.
- **Say the privacy limit in the product.** A task synced to Linear or GitHub is
  readable by that service. The setup screen should say so once.

## What I have not verified

- Whether polling is quick enough to feel live, and what request limits Linear
  and GitHub put on it.
- How GitHub issue comments and Dispatch task comments should map when both
  sides allow edits.
- Whether sealing large doc attachments in the line is sensible, or they need to
  be stored beside it.
