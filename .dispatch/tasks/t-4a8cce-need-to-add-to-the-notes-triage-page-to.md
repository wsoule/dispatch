---
id: t-4a8cce
title: need to add to the notes / triage page to auto generate the task with AI
  to give more context
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-07-26T19:13:24.371Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description



## Acceptance Criteria

## Activity
- 2026-07-26T19:13:29.271Z dispatched (claude, branch dispatch/t-4a8cce-need-to-add-to-the-notes-triage-page-to-673cb0)
- 2026-07-26T19:16:47.138Z Design settled (run r-673cb0). Notes/triage gets a "Draft with AI" action per un-promoted note. Rather than a second AI backend, it reuses the existing plan pipeline: POST /api/notes/:id/enrich builds a note-derived planner prompt, starts a PlanManager plan tagged with the note id, and returns { planId }; the existing POST /api/plan/:id/confirm writes the task and now links the note (linkedTaskId + done). UI shows an inline editable draft (title/description/acceptance criteria/priority) before anything is written — confirm-before-write is preserved. Heads-up for r-020122 (t-d6c287, natural-language single-task endpoint) and r-6c8639 (t-c8954b, multi-turn planner): I touch packages/server/src/api.ts (new notes route + confirmPlan), orchestrator/plan.ts (PlanRecord.sourceNoteId, startPlan 3rd arg), packages/client/src/api.ts, and the desktop Notes view — expect textual conflicts there, no behaviour changes to existing plan/promote semantics.
- 2026-07-26T19:33:45.109Z Done, committed on dispatch/t-4a8cce-…-673cb0 (c5388b1 server, 6fd7b99 desktop).

Flow: Notes & triage → each un-promoted note now has "Draft with AI" beside "Make task". It POSTs /api/notes/:id/enrich, which builds a note-derived planner prompt (read the repo, name real paths, propose exactly ONE task, no epic, don't invent scope) and starts it on the existing PlanManager. The proposal comes back through GET /api/plan/:id and renders inline under the note — title, description, acceptance criteria, priority — editable, and only POST /api/plan/:id/confirm writes anything. Confirm also links the note (linkedTaskId + done), so the hub stops offering to promote it. PlanRecord.sourceNoteId is what carries that association; PlanManager itself stays note-agnostic.

Verified: bun run format / lint (43 warnings, all pre-existing) / tsc across all 7 workspaces clean. New packages/server/test/notes-api.test.ts (9 tests, real HTTP against startServer with a recording planner) covers enrich → ready → confirm → task written + note linked, the note-deleted-mid-draft case, an ordinary Plans-view plan being unaffected, 404/409, and the previously untested promote path. New apps/desktop/src/lib/noteDraft.test.ts (11 tests) covers the draft state machine — writing it caught a real bug: the seed effect had no sourceNoteId check, so drafting note B while note A's plan was still the polled record would have shown A's drafted task under B.

Full server suite 238 pass. Three failures in the repo-wide run (packages/mcp tool-list + the two stdio e2e tests) are pre-existing — they fail identically on a stashed clean tree, untouched by this change.

Not verified: the desktop UI was not driven end-to-end (Tauri app, no component-test harness in the repo — UI logic is unit-tested per the repo's lib/*.ts convention, and rendering is typechecked only). Worth a human clicking through once.
- 2026-07-26T19:33:45.716Z [run r-673cb0] finished: finished — 8 files, $8.65
- 2026-07-26T20:27:38.800Z requested changes (run r-098ba2): continue
- 2026-07-26T20:28:00.115Z [run r-098ba2] finished: finished — 8 files, $1.50
- 2026-07-26T22:14:21.641Z run r-098ba2 merged into main
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
