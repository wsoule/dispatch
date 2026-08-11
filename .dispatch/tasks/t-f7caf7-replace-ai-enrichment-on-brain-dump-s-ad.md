---
id: t-f7caf7
title: Replace AI enrichment on Brain Dump's "Add detail" with a manual edit window
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-11T02:00:39.505Z
updated: 2026-08-11T02:00:39.505Z
external: null
writes:
  - apps/desktop/src/views/BrainDumpView.tsx
  - apps/desktop/src/hooks/useDispatchProject.ts
  - packages/server/src/api.ts
  - packages/client/src/api.ts
risk: elevated
---

## Description

On the Brain Dump inbox row, "Add detail" currently calls `handleEnrichInboxItem` which kicks off an AI plan-record draft (repo read → `EnrichReview` diff-review UI). Replace this with a plain inline edit: clicking "Add detail" opens a `Textarea` pre-filled with the item's current `text` in the same slot the AI draft used to occupy, with Save/Cancel controls. Save calls the existing (currently unused) `data.handleUpdateInboxItem(id, { text })`, which already PATCHes `/api/inbox/:id` with no AI involved. Cancel discards. Also remove the now-dead AI-inbox-enrich plumbing this leaves behind — `handleEnrichInboxItem`, `inboxEnrichItemId`, `inboxEnrichPlanRecord`, `handleDismissInboxEnrich`, `handleApplyInboxEnrich` in `useDispatchProject.ts`/`DispatchProjectData`; the `POST /api/inbox/:id/enrich` route, `enrichInbox`, and `buildInboxEnrichPrompt` in `packages/server/src/api.ts`; and the `enrichInbox` method on the client SDK interface in `packages/client/src/api.ts`. `EnrichReview`, `lib/enrichReview.ts`, `lib/taskEnrich.ts`, and the task-detail AI "add detail" flow in `TaskDetailPanel.tsx` are shared with tasks and stay untouched.

Acceptance criteria:

- Clicking "Add detail" on an inbox row opens an inline textarea pre-filled with that item's current text, with Save and Cancel controls, and fires no network/AI call on open.
- Save persists the edited text via handleUpdateInboxItem (PATCH /api/inbox/:id) and closes the editor; Cancel closes without persisting.
- Only one row's editor is open at a time, matching the prior single-slot draft behavior.
- handleEnrichInboxItem, inboxEnrichItemId, inboxEnrichPlanRecord, handleDismissInboxEnrich, handleApplyInboxEnrich are removed from useDispatchProject.ts/DispatchProjectData after confirming no other caller depends on them.
- POST /api/inbox/:id/enrich, enrichInbox, and buildInboxEnrichPrompt are removed from packages/server/src/api.ts, and the enrichInbox method is removed from the client SDK in packages/client/src/api.ts.
- TaskDetailPanel's own AI "add detail" flow (EnrichReview, lib/enrichReview.ts, lib/taskEnrich.ts) is unmodified and still works.
- bun run format, bun run lint, and package-level tsc pass; BrainDumpView unit tests and apps/desktop/e2e/views.spec.ts are updated for the new flow.

## Acceptance Criteria

## Activity
