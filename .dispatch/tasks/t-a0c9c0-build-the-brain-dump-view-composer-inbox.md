---
id: t-a0c9c0
title: "Build the Brain dump view: composer, inbox list, and per-item actions"
status: todo
kind: task
parent: e-3f896a
milestone: null
blocked-by:
  - t-22429b
  - t-cfce10
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:57:45.076Z
updated: 2026-07-27T01:06:35.708Z
external: null
---

## Description

Build the Brain dump screen (docs/design/dispatch-nocturne.dc.html, the isDump block) as a new view in apps/desktop/src/views/, wired to the inbox SDK methods and added to the sidebar and the nav reducer in apps/desktop/src/lib/appNav.ts.

Top of the page is the composer: a large borderless textarea on a subtle panel, a live hint that counts how many items the current text will become ("6 lines - each becomes one item") and otherwise explains the rule, and two actions - drop into the inbox, or hand the whole blob to the planner with the text prefilled.

Below it, the inbox: one row per item with a select checkbox, a kind badge, the text, its age, and three per-item actions (make a task, plan it, dismiss). Beneath that, the archive of already-converted items, collapsed by default behind a show-N-already-sorted row, each struck through with an arrow to the task it became.

The right rail carries a short "how this works" explanation naming .dispatch/inbox.md, and the keyboard shortcut legend. The tone in the mockup's copy is load-bearing - "Nothing here is a commitment", "Sort it later, or never" - and the point of the whole screen is that capture is cheap. Keep it.

Kind badges take existing palette tokens per docs/design/README.md; nothing from the mockup's palette. Reuse the primitives from the foundations epic.

Acceptance criteria:

- The composer drops a multi-line blob into the inbox in one action, and the hint accurately previews how many items that will be
- Hand-it-to-the-planner opens Plans with the text prefilled
- Inbox rows show kind, text and age, and support make-a-task, plan-it and dismiss
- Converted items appear in the archive with a link to the task they became, collapsed by default
- The view is reachable from the sidebar with a live count badge and is wired through the nav reducer
- The empty inbox state invites capture rather than reading as an error
- The explanatory copy names the real file path
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T01:06:35.708Z Scope change: Notes & triage is being removed and Brain dump is the single inbox, which means this view is the only place agent-flagged items surface. Two adjustments to the description above. (1) Inbox rows must distinguish items an agent flagged mid-run (via the MCP dispatch_note tool) from ones the user typed, and show which run flagged them — otherwise the agent channel is invisible. (2) Do NOT build the "Older — the triage list from before" link the mockup shows in the right rail; the page it points at is being deleted. The "Plan it" action should repoint the existing note-to-task AI draft flow in useDispatchProject.ts (notePlanId / notePlanRecord / handleConfirmNotePlan) rather than building a new one — and keep that plan slot separate from the Plans view's own, which is why it exists. Removal and migration are t-2814f8, which lands after this.
