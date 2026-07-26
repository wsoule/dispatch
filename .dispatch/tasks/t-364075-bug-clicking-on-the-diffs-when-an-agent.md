---
id: t-364075
title: 'bug: clicking on the "diffs" when an agent is running makes the page go blank'
status: cancelled
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-07-26T19:12:51.788Z
updated: 2026-07-26T20:30:27.002Z
external: null
---

## Description



## Acceptance Criteria

## Activity
- 2026-07-26T19:13:39.217Z dispatched (claude, branch dispatch/t-364075-bug-clicking-on-the-diffs-when-an-agent-eb8624)
- 2026-07-26T19:23:11.664Z Root cause found and reproduced. The Runs "Diff" tab renders `<PatchDiff patch={diff.patch} />` (apps/desktop/src/components/runs/RunDiffView.tsx), but @pierre/diffs' `PatchDiff` is a SINGLE-file component: it calls `getSingularPatch()`, which throws `FileDiff: Provided patch must contain exactly 1 file diff` for any patch touching ≠1 file. A run's diff is a whole multi-file patch, so the render throws — and since the desktop app has no error boundary anywhere, React unmounts the entire tree and the window goes blank. Reproduced headlessly against the live daemon via the app's `?root=&port=` browser harness (pageerror captured). Fix: parse the patch with `parsePatchFiles()` and render one `<FileDiff>` per file, plus an error boundary so a third-party widget throw can never blank the app again.
- 2026-07-26T19:31:02.935Z [run r-eb8624] finished: failed — 0 files, $8.02
- 2026-07-26T20:29:18.880Z run r-eb8624 discarded
