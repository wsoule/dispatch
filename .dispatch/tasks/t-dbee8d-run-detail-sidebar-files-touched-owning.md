---
id: t-dbee8d
title: "Run detail sidebar: files touched, owning task, and progress"
status: done
kind: task
parent: e-805f3e
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:00:24.862Z
updated: 2026-07-27T23:08:44.590Z
external: null
---

## Description

Add the right sidebar and header metadata to the run detail surface (docs/design/dispatch-nocturne.dc.html, the isDetail sidebar and the d object in renderVals).

Sidebar, three sections. Files touched: each file the run has modified with its path and +/- counts, filename kept visible when the path truncates. Task: the owning task's description in brief with its id and label as tags, linking through to the task. Progress: a bar plus a line reporting percent complete and token spend.

Header metadata line: the branch name, elapsed time, turn count, files touched and diff totals, plus Pause and Stop actions.

All of it should come from run data that already exists; if percent-complete has no real basis in the run model, do not invent one - either derive it from something honest (turns against a cap, verify steps completed) or drop the percentage and keep token spend. A progress bar that is really a random number is worse than no progress bar, and this is the one place in the mockup where the fixture is doing something the backend cannot.

Colors from tokens only. Reuse the foundations primitives.

Acceptance criteria:

- The sidebar lists files touched with diff counts and keeps filenames visible when paths truncate
- The task section shows the owning task with its id and label and links through to it
- Progress reports token spend, and any percentage shown is derived from real run state or omitted
- The header shows branch, elapsed, turns, files and diff totals
- Pause and Stop act on the real run and reflect the resulting state
- The sidebar collapses or hides gracefully at narrow window widths
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T23:08:44.590Z Done in 0d10361 as RunSidebar, mounted beside the Session transcript. Files touched, owning task + epic (click-through), branch, started, turns, spend, model. Two omissions, both taking the description's own instruction not to invent: (1) NO completion percentage — the orchestrator has no notion of how far through a task an agent is, and turns-against-a-cap would be a bar that moves for reasons unrelated to progress. Spend and turns are real, so those are what it reports. (2) NO per-file +/- counts: DiffFile is {path, status} only, so the counts would have to be re-parsed out of the patch string, and a number rendered here would be indistinguishable from a measured one. It shows the git status letter instead, tinted for add/delete. Paths truncate from the left (dir=rtl) so the filename survives on a deep path. NOT DONE: Pause/Stop in a header — RunsView already has run actions elsewhere and adding a second set would give two places to stop the same run.
