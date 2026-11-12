# Plans for the Dispatch rewrite

One plan per phase of `docs/specs/2026-11-11-core-and-server-design.md`. Each
says what the phase builds, the check that says it is done, the small decisions
it makes, its steps with the test that proves each, what in today's code to read
first, and what was not verified when the plan was written.

All of them are drafts for Wyat's review. They live here until their
repositories exist, then move there.

| #   | Phase                         | Plan                                                                                     | Repository        | Needs     |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------- | ----------------- | --------- |
| 1   | Kernel                        | [core-phase-1-kernel](2026-11-11-core-phase-1-kernel.md)                                 | `dispatch-core`   | —         |
| 2   | Home and tasks                | [core-phase-2-home-and-tasks](2026-11-12-core-phase-2-home-and-tasks.md)                 | `dispatch-core`   | 1         |
| 3   | Sessions, terminals, messages | [core-phase-3-sessions-and-terminals](2026-11-12-core-phase-3-sessions-and-terminals.md) | `dispatch-core`   | 1         |
| 4   | Runner                        | [core-phase-4-runner](2026-11-12-core-phase-4-runner.md)                                 | `dispatch-core`   | 2, 3      |
| 5   | Link                          | [core-phase-5-link](2026-11-12-core-phase-5-link.md)                                     | `dispatch-core`   | 2         |
| 6   | Keys                          | [core-phase-6-keys](2026-11-12-core-phase-6-keys.md)                                     | `dispatch-core`   | 5         |
| 7   | Server                        | [server-phase-7-server](2026-11-12-server-phase-7-server.md)                             | `dispatch-server` | 6         |
| 8   | App spike                     | [app-phase-8-spike](2026-11-12-app-phase-8-spike.md)                                     | `dispatch-app`    | 1         |
| 9   | App core and mods             | [app-phase-9-app-core-and-mods](2026-11-12-app-phase-9-app-core-and-mods.md)             | `dispatch-app`    | 2–4, 8    |
| 10  | Docs, memory, sync            | [core-phase-10-docs-memory-sync](2026-11-12-core-phase-10-docs-memory-sync.md)           | `dispatch-core`   | 2         |
| 11  | Teardown and release          | [phase-11-teardown-and-release](2026-11-12-phase-11-teardown-and-release.md)             | all               | 7, 9, 10  |
| 12  | Overseer agent                | [core-phase-12-overseer](2026-11-12-core-phase-12-overseer.md)                           | `dispatch-core`   | 4, then 7 |

## What can run at the same time

```text
1 Kernel ─┬─ 2 Home and tasks ─┬─ 4 Runner ──────────────┬─ 12 Overseer (one machine)
          │                    ├─ 5 Link ── 6 Keys ── 7 Server ── 12 Overseer (team)
          │                    └─ 10 Docs, memory, sync
          ├─ 3 Sessions, terminals, messages ─ 4 Runner
          └─ 8 App spike ── 9 App core and mods ───────────── 11 Teardown and release
```

After phase 1 there are three tracks that do not block each other: the core (2,
3, then 4, 5, 10), the team path (5, 6, 7) and the app (8, then 9).

## Three short checks that come first

Each can change the plan that follows it, so each is the first step of its phase
and takes days, not weeks.

| Check                                                                     | In phase | If the answer is no                                            |
| ------------------------------------------------------------------------- | -------- | -------------------------------------------------------------- |
| Can the `claude` CLI be driven without the SDK, with approvals and resume | 4        | The runner needs a different way to reach Claude Code          |
| Which terminal library can read a screen and draw what real agents draw   | 3        | Build on the one herdr vendors, with its extra build tool      |
| How mods run on GPUI                                                      | 8        | Write a thin layer of our own instead of using herdr's library |

## Decisions the plans make that the spec did not

- The core's binary is `dispatch-core` until phase 11, when it becomes
  `dispatch`.
- The app gets its own fresh repository, `dispatch-app`.
- Project settings stay in the repo's `.dispatch/config.yml`.
- Sync with Linear and GitHub polls, because the only always-on address a team
  has is the server, which must not see task content.
- One core does a team's syncing, named in the line like the lead Overseer.
- The Overseer agent is an ordinary agent session the core starts, not a special
  process.
- An outside security review is part of phase 6.
