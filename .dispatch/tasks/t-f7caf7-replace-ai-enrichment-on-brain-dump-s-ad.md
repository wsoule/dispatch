---
id: t-f7caf7
title: Replace AI enrichment on Brain Dump's "Add detail" with a manual edit window
status: in-progress
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-11T02:00:39.505Z
updated: 2026-08-11T17:06:22.436Z
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
- 2026-08-11T16:46:12.534Z dispatched (claude, branch dispatch/t-f7caf7-replace-ai-enrichment-on-brain-dump-s-ad-b9ae36) — human:wsoule679
- 2026-08-11T17:06:22.435Z Replaced the AI enrich on Brain Dump's "Add detail" with an inline Textarea editor (Save/Cancel, ⌘⏎ saves, Escape cancels), persisting through the existing handleUpdateInboxItem → PATCH /api/inbox/:id. Removed handleEnrichInboxItem/inboxEnrichItemId/inboxEnrichPlanRecord/handleDismissInboxEnrich/handleApplyInboxEnrich, POST /api/inbox/:id/enrich + enrichInbox + buildInboxEnrichPrompt, and the client SDK's enrichInbox.

Two deviations from the task text, both forced by knip being gated at zero:
1. lib/enrichReview.ts is NOT shared with tasks — TaskDetailPanel uses lib/taskEnrich.ts, and EnrichReview.tsx declares its own inline props type. BrainDumpView was its only production consumer. Removed the inbox-only formatEnrichedInboxText (and its tests) and un-exported EnrichDraft; enrichViewState/EnrichViewState are left in place. Heads up: the module now has no production caller at all and is a deletion candidate, which I left alone as out of scope.
2. apps/desktop/e2e/views.spec.ts needed no change — it only takes a braindump screenshot and never exercised the enrich flow, and the row's default rendering is unchanged ("Add detail" label kept). Playwright can't run in this shell anyway (posix_spawn git), so I did not touch the PNG baselines. — none
