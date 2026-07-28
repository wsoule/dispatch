---
id: t-b6ddf8
title: The "add details" using ai button on a task does not work.
status: in-review
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-07-28T18:45:21.707Z
updated: 2026-07-28T19:17:05.063Z
external: null
---

## Description



## Acceptance Criteria

## Activity
- 2026-07-28T18:45:29.605Z dispatched (claude, branch dispatch/t-b6ddf8-the-add-details-using-ai-button-on-a-tas-42e6d6)
- 2026-07-28T18:49:06.276Z Root cause found (r-42e6d6). "Add detail" is wired to an orphaned plan slot. `handleEnrichTask` POSTs /api/tasks/:id/enrich, stores the returned planId in `notePlanId`, and `notePlanRecord` polls it — but the only UI that ever rendered that slot was the old NotesView, deleted in e4f874b when Brain dump replaced Notes & triage. 03b44e0 then built "Add detail" on top of the orphan. So the button flips to "Reading the repo…" for the length of one 202 round-trip and back, and the draft is never shown. Second defect underneath: confirmPlan -> PlanManager.confirm *creates a new task*, so even wired up it would duplicate the task instead of deepening it, and enrichTask passes the task id as `sourceNoteId` (a note-only field). Fixing all three.
- 2026-07-28T19:16:43.272Z Fixed and committed (ebc8563). The draft now has its own app-level slot tagged with its task, and the task detail dialog reviews it — proposed Description + Acceptance Criteria, then Apply or Discard. Apply PATCHes the two sections onto the existing task instead of confirming the plan (confirm only creates tasks, so it would have duplicated this one). Empty sections are omitted from the patch rather than sent as '', since sections replace wholesale. Two server-side defects the tests turned up: the prompt was fed task.body verbatim, so the create template's empty headings meant the "no description at all" branch could never fire and a dispatched task's whole Activity log went in as if it were the spec (now Description + Acceptance Criteria only, via a new core getSection); and the plan carried the task id as sourceNoteId. New tests: packages/server/test/tasks-enrich-api.test.ts (7), apps/desktop/src/lib/taskEnrich.test.ts (15), core getSection (5). format + lint clean (0 errors), core/server/desktop tsc + tests pass. One pre-existing unrelated failure in claude-executor.test.ts (expects `bun`, gets the installed Dispatch.app resource path) — fails identically on a clean tree. Note: "Add detail" on a Brain dump item is still broken through the same orphaned notePlanRecord slot; that one needs a confirm flow rather than a patch, so I left it for its own task.
- 2026-07-28T19:17:05.063Z [run r-42e6d6] finished: finished — 10 files, $13.47
