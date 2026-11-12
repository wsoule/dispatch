# Dispatch core, phase 4: the runner — plan

2026-11-12. Status: **draft for Wyat's review.** Phase 4 of
`docs/specs/2026-11-11-core-and-server-design.md`. Needs phases 2 and 3.

## Goal

Dispatching a task starts that agent's own command-line program in a worktree,
inside a held terminal, and carries the work through approval, review, verify
and merge.

**Done when** (the spec's check): a Claude Code run and a Codex run each start
from a task, ask for approval, and pass review, verify and merge.

## Not in this phase

The Overseer agent (phase 12). GitHub pull request review and Linear (10). Other
machines (5).

## Decisions this plan makes

1. **One crate, `runner`, in three parts** that land in order: run an agent to a
   diff (A), judge and land the diff (B), plan work (C). A is usable alone.
2. **No agent SDK.** Each agent is its own CLI. Claude Code and Codex are driven
   through their machine-readable modes; everything else runs one-shot from a
   preset.
3. **A run is a session** (phase 3) with a task, a worktree and a claim.
4. **Every approval is a gate** (phase 3), so the app, the CLI and the phone
   answer it the same way.
5. **The spike in step 1 can change this plan.** If the `claude` CLI cannot do
   what Dispatch needs without the SDK, that is found in a week, not at the end.

## Steps

### A. Run an agent to a diff

| #   | Step            | What it adds                                                                                                     | Test that proves it                                                          |
| --- | --------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | Spike           | A throwaway program that drives `claude` and `codex` without any SDK, and a written list of what each mode gives | The list covers approval at a tool call, cost, turn count, resume, and hooks |
| 2   | Worktrees       | A git worktree and branch per run; cleanup; the disk-size guard                                                  | Two runs in one repo never see each other's changes                          |
| 3   | Prompt          | The run's opening prompt from the task, its docs, memory index and project rules                                 | Matches today's `orchestrator/prompt.ts` output on a fixture task            |
| 4   | Claude adapter  | Start `claude` in its protocol mode in a held terminal; stream entries; resume a session                         | A fake `claude` that speaks the protocol completes a run end to end          |
| 5   | Codex adapter   | The same for `codex app-server`                                                                                  | A fake `codex` completes a run end to end                                    |
| 6   | One-shot agents | Presets for other agents; honest limits (no approval gate, no cost, no resume)                                   | A mode that needs a human gate is refused at dispatch for a one-shot agent   |
| 7   | Approvals       | A tool call that needs a person parks as a gate; the answer resumes or denies it                                 | A parked call survives a core restart and is still answerable                |
| 8   | Scope           | Declared files are enforced before a write; asking for more is a gate                                            | A write outside the task's declared files is held, not made                  |
| 9   | Caps            | Spend and turn caps per run; the spend gate                                                                      | A run that reaches its cap stops and says why                                |
| 10  | Run log         | The run's entries as an ordered stream others can follow                                                         | A late subscriber gets the log from the start, then live                     |

### B. Judge and land the diff

| #   | Step        | What it adds                                                                                         | Test that proves it                                                 |
| --- | ----------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| 11  | Review      | A separate review of the diff; findings with verdicts; undeclared-write and destructive-write checks | Today's review fixtures give the same findings                      |
| 12  | Verify      | The project's verify steps run against the worktree                                                  | A failing step blocks the merge and is attached as evidence         |
| 13  | Fix loop    | Findings go back to the agent, a bounded number of times                                             | The loop stops at its limit and hands the task to a person          |
| 14  | Merge queue | Runs land one at a time; a conflict sends the run back                                               | Two finished runs touching one file land in order, not both at once |
| 15  | Landing     | The merge reaches the origin branch; the task is closed and archived                                 | A landed task is marked and its worktree is gone                    |

### C. Plan work

| #   | Step       | What it adds                               | Test that proves it                               |
| --- | ---------- | ------------------------------------------ | ------------------------------------------------- |
| 16  | Planner    | Turn a goal into tasks with declared files | Today's planner fixtures give tasks that validate |
| 17  | Milestones | Milestone branches and phases              | Matches `docs/design/milestone-branches.md`       |

## Notes for whoever builds it

- **Today's orchestrator is the reference**, file by file
  (`packages/server/src/orchestrator/`, 36,705 lines): `worktree.ts`,
  `prompt.ts`, `executors/claude.ts`, `executors/codex.ts`, `codexAppServer.ts`,
  `executors/cli.ts` and `cliPresets.ts`, `floorHook.ts`, `review.ts`,
  `verify.ts`, `fixLoop.ts`, `mergeQueue.ts`, `originLanding.ts`, `planner.ts`,
  `milestone*.ts`. Its tests are the acceptance tests.
- **Tests never call a real model.** Each adapter is tested against a fake CLI
  that speaks the same protocol, as today's `executors/fake.ts` does for the
  SDK. A real-agent smoke test costs money and is run by hand.
- **`docs/design/autonomy-ladder.md`** defines the permission modes that steps 6
  to 8 enforce.
- **Account failover and usage** (`accountFailover.ts`, `usage.ts`) are part of
  step 9, not a separate feature.

## What I have not verified

- **The one that matters: step 1.** I believe the Agent SDK is a wrapper over
  the `claude` CLI's machine-readable mode. I have not confirmed that mode gives
  approvals at a tool call, hooks, cost and resume on its own.
- That `codex app-server` is stable enough to build on directly; today's code
  already does, which is encouraging.
- How much of the 36,705 lines is still live. Some of it will be dead paths that
  should not be carried over.
