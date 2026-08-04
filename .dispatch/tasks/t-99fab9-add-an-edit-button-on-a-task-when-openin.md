---
id: t-99fab9
title: add an "edit" button on a task (when opening it for detail) and that will
  edit in markdown using pierre diff’s editor
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-03T23:08:17.867Z
updated: 2026-08-04T17:38:31.442Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description



## Acceptance Criteria

## Activity
- 2026-08-03T23:09:48.695Z dispatched (claude, branch dispatch/t-99fab9-add-an-edit-button-on-a-task-when-openin-fd81a8) — human:wsoule679
- 2026-08-03T23:17:59.459Z Scoped via ask_user. Chosen: whole-task-body markdown editing behind an Edit button, using @pierre/diffs' Editor (its `./edit` export, which requires bumping the catalog pin 1.2.12 -> 1.3.1); read mode renders markdown instead of the current always-on plain textareas. Needs a new `body` field on UpdatePatch through core + server (client re-exports core's type, so no change there). Verified all @pierre/diffs symbols the diff views already import still exist in 1.3.1. — none
- 2026-08-04T00:04:08.328Z Core + server done and green: UpdatePatch.body (whole-body replacement, applied as the base before the section patches), taskfile.normalizeBody, and server validation. Two guards mutation-tested (PATCH rejects a non-string body; POST rejects body outright rather than silently dropping it). Desktop UI written: header Edit button, TaskBodyEditor over @pierre/diffs' Editor, Description/Acceptance/Amendments now render as markdown, and a stale-draft guard (decideBodySave) so a save can't erase Activity an agent appended while the editor was open. BLOCKED on install: the human chose to pin @pierre/diffs 1.3.1 + add it to bunfig's minimumReleaseAgeExcludes, but Claude Code's permission classifier refuses to edit bunfig.toml (it reads as weakening a supply-chain guard) and I won't route around it. Handed the human a paste-able patch command; desktop tsc and the editor's runtime behaviour are unverified until that lands. — none
- 2026-08-04T00:14:27.961Z Committed: build(deps) pinning @pierre/diffs 1.3.1, and feat(core,server) adding UpdatePatch.body + normalizeBody + validation with 7 new tests. Verified core 332/332, server api.test.ts 41/41, decideBodySave 4/4, format clean, lint 0 errors; three guards mutation-tested (1 failure each on revert). Two unrelated pre-existing failures on this host: a server executor test resolving an installed /Applications/Dispatch.app sidecar instead of 'bun', and three desktop webkitFloor tests gated on an unbuilt dist/. Desktop commit is written but deliberately uncommitted — its only type errors are the four @pierre/diffs/edit imports in TaskBodyEditor.tsx, which resolve once bunfig.toml's minimumReleaseAgeExcludes gains @pierre/diffs and bun install runs. TaskDetailDialog.tsx and taskBodyEdit.ts already typecheck clean. — none
- 2026-08-04T00:14:49.351Z [run r-fd81a8] finished: finished — 10 files, $20.58 — agent:wsoule679/claude
- 2026-08-04T16:40:15.302Z status → done — human:wsoule679
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
- 2026-08-04T17:38:31.442Z run r-fd81a8 merged into main — human:wsoule679
