---
id: t-2814f8
title: Remove Notes &amp; triage, migrating its data and the agent note channel
  into the inbox
status: todo
kind: task
parent: e-3f896a
milestone: null
blocked-by:
  - t-a0c9c0
labels: []
priority: medium
assignee: none
created: 2026-07-27T01:06:11.216Z
updated: 2026-07-27T01:06:11.216Z
external: null
---

## Description

Notes and triage is being removed. Brain dump replaces it as the single inbox, so this task retires the old surface and makes sure nothing it carried is lost. Ordered after the Brain dump view exists so there is never a window with no capture surface at all.

The page itself is the easy part: delete apps/desktop/src/views/NotesView.tsx, drop 'notes' from ProjectView in apps/desktop/src/lib/appNav.ts and its cases in navReducer, remove the sidebar row in Sidebar.tsx, remove the render branch in App.tsx, and update appNav.test.ts. Also remove the "The triage list from before" link the mockup shows in Brain dump's side rail - there will be no old list to link to.

Three things need rehoming rather than deleting.

The agent channel. packages/server/src/notes.ts backs the MCP dispatch_note tool, which agents call mid-run to flag things they noticed - the store keeps createdByRunId so the UI can say an agent flagged this. If the page goes and nothing else renders those items, dispatch_note becomes a write-only hole. Route dispatch_note into the inbox instead, and make agent-flagged items visibly distinguishable from ones the user typed.

The note-to-task AI draft. useDispatchProject.ts carries a second plan slot - notePlanId, notePlanRecord, handleConfirmNotePlan - deliberately kept apart from the Plans view's own plan slot so starting a note draft cannot clobber an open plan. That is exactly what Brain dump's "Plan it" button does. Repoint it rather than rebuilding it, and keep the two-slot separation for the same reason it exists today.

The existing data. .dispatch/notes.json holds real notes with kinds (note / triage / followup / todo), done state and linkedTaskId. Migrate it into .dispatch/inbox.md, reconciling those four kinds with the inbox's own (bug / idea / task / note) and preserving done state and task links. Migration must be idempotent and must not lose items it cannot classify - fall back to a kind rather than dropping the row.

Then remove what is genuinely dead: the notes routes in packages/server/src/api.ts, the client methods in packages/client/src/api.ts, the note.changed event wiring, notes.ts itself, and noteDraft.ts/noteDraft.test.ts if the inbox does not reuse them. Check packages/cli/src/watch.ts and orchestrator/plan.ts before deleting - they reference notes and may or may not be the same thing.

Acceptance criteria:

- The Notes and triage view, its nav row, its ProjectView member and its reducer cases are gone, and appNav tests are updated
- dispatch_note writes into the inbox and agents can still flag items mid-run
- Agent-flagged inbox items are visibly distinguishable from user-entered ones, preserving which run flagged them
- The note-to-task AI draft flow is repointed to Brain dump's Plan it, keeping its plan slot separate from the Plans view's
- .dispatch/notes.json is migrated into .dispatch/inbox.md preserving kind, done state and linked task ids, idempotently and without dropping unclassifiable items
- Dead notes routes, client methods, event wiring and storage are removed, and remaining "notes" references elsewhere are confirmed unrelated before deletion
- No dangling references to the removed view remain, including in the command palette and any keyboard shortcuts
- Migration is unit tested including the already-migrated and unclassifiable cases
- bun run format, bun run lint and the desktop/server/client tsc/tests are green

## Acceptance Criteria

## Activity
