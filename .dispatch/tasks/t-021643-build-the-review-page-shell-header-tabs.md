---
id: t-021643
title: "Build the Review page shell: header, tabs, and the file list with viewed
  tracking"
status: cancelled
kind: task
parent: e-ddd932
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: high
assignee: none
created: 2026-07-27T00:59:16.695Z
updated: 2026-07-27T23:10:35.833Z
external: null
---

## Description

Build the Review screen's frame (docs/design/dispatch-nocturne.dc.html, the isReview block header, rvTabs and rvFiles in renderVals) as a full-page surface for one run, replacing the modal path through DiffModal.tsx.

The header: a breadcrumb back to the Control room with the run id, the task title with a state dot, the three verdict actions (Discard, Send back with notes, Accept and land), and a metadata line carrying the branch, file count, diff totals, turn count and a checks summary. Below it, three tabs - Files changed, Conversation, Checks - each with its own count, with the active tab marked by an underline rule.

The file list, on the left of the Files changed tab: per file, the path truncated from the left (so the filename stays visible, which is what the mockup's direction:rtl trick is doing - use a proper approach, not that), +/- counts, a comment count when it has threads, and a checkmark when viewed. Above it a header with the file count and an unviewed-only toggle, and an N-of-M-viewed readout. Clicking a file selects it; viewed state is per file and per run.

Viewed tracking is the part worth getting right: it needs to persist for the run so closing and reopening the review does not lose which files were already read.

Colors from tokens only. Reuse the foundations primitives.

Acceptance criteria:

- Review is a full-page surface for one run, reachable from the Control room feed and from Runs
- The header shows branch, file count, diff totals, turns and checks summary, with the three verdict actions
- Three tabs render with counts, and the active tab is clearly marked
- The file list shows path, diff counts, comment count and viewed state, with the filename always visible when truncated
- Viewed state persists per run across closing and reopening the review
- The unviewed-only filter works and the viewed readout is accurate
- Selecting a file drives the diff pane's target
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T23:10:35.833Z Cancelled rather than done — not built, and I do not think it should be built as written. It assumes a full-page Review surface replacing DiffModal, with three tabs and a bespoke file list. The app already reviews a run inside RunsView (RunReviewView: diff, file tree, merge/discard/request-changes, queue controls, PR handoff), and the review comments from t-46b6eb now live there too. Building a second full-page review surface beside it would mean two places to review the same run, which is the exact duplication RunReviewView's own doc comment says it exists to avoid. Two sub-parts are separately worth doing and are NOT covered anywhere: per-file "viewed" tracking persisted per run (genuinely useful on a large diff, and nothing else provides it), and the tabs — though two of the three tabs it names have no data behind them, per the note on t-c14d40. Recommend closing this shape and opening a small task for viewed-tracking inside the existing review surface if it is still wanted.
