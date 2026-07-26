---
id: t-0abf9d
title: Add a conversational thread to the Plans view
status: todo
kind: task
parent: e-359627
milestone: null
blocked-by:
  - t-332ffe
labels: []
priority: medium
assignee: none
created: 2026-07-26T19:06:42.665Z
updated: 2026-07-26T19:06:42.668Z
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
