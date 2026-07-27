---
id: t-0abf9d
title: Add a conversational thread to the Plans view
status: in-review
kind: task
parent: e-359627
milestone: null
blocked-by:
  - t-332ffe
labels: []
priority: medium
assignee: none
created: 2026-07-26T19:06:42.665Z
updated: 2026-07-26T22:37:05.931Z
external: null
---

## Description

Extend apps/desktop/src/views/PlansView.tsx so that after the initial prompt, the user can keep talking to the planner: render a message thread of user/assistant turns, add a follow-up composer, show the live 'planning…' state per turn, and reflect the refined proposal in the existing editable review list as the conversation updates it. Reuse the existing composer, PlanTaskRow review cards, reduceProposal editing, history sidebar, and DaemonUnavailable handling already in this file.

Acceptance criteria:

- The Plans view shows a scrollable thread of alternating user and assistant messages for the active plan
- A follow-up composer lets the user send additional messages without starting a brand-new plan, using the SDK method from the API task
- Assistant turns that change the proposal update the editable review list (PlanTaskRow cards) in place, preserving the stable per-row taskKeys behavior
- Per-turn pending/failed states are shown (spinner while the agent responds, inline error on failure) reusing the existing state patterns
- Confirming the plan still writes the tasks via handleConfirmPlan and the session plan history continues to work

## Acceptance Criteria

## Activity
- 2026-07-26T22:12:52.879Z dispatched (claude, branch dispatch/t-0abf9d-add-a-conversational-thread-to-the-plans-9954a6)
- 2026-07-26T22:16:15.452Z Started r-9954a6. Backend deps (t-c8954b planner conversation, t-332ffe SDK/hook exposure) are already on main: PlanRecord.messages + client.sendPlanMessage + data.handleSendPlanMessage all exist, so this is view-only. Plan: extract thread-building + draft/taskKeys reconciliation into apps/desktop/src/lib/planThread.ts (unit-testable, matching the repo's lib-test convention), then wire the thread + follow-up composer into PlansView.
- 2026-07-26T22:31:29.237Z [run r-9954a6] finished: failed — 0 files, $9.45
- 2026-07-26T22:31:47.536Z requested changes (run r-4b0606): continue
- 2026-07-26T22:36:51.068Z Done in 811446d. PlansView now renders the plan transcript as a thread (user/planner bubbles, per-turn pending spinner, inline failure row) with a follow-up composer on data.handleSendPlanMessage; the review list updates in place as later turns refine the proposal. Draft/taskKeys reconciliation extracted to apps/desktop/src/lib/planThread.ts (13 unit tests): unchanged server proposal -> same draft by identity so the 2s poll can't clobber edits; changed proposal -> adopted with a fresh key revision. Two bugs found by driving a scripted dispatchd end-to-end: (1) after a failed follow-up the record keeps the prior proposal but confirm 409s unless state==='ready', so Confirm is now gated on the record (same check covers already-confirmed plans reopened from history); (2) the opening turn showed "Planning…" twice (thread row + skeleton) — skeleton is shape-only now. Also: PlanTaskRow emits ProposalAction instead of a Partial<PlannedTask> patch, and handleSendPlanMessage seeds the 202 record into the plan query so the user's turn shows on send. format/lint/tsc/tests green (173 desktop tests).
- 2026-07-26T22:37:05.931Z [run r-4b0606] finished: finished — 4 files, $4.83
