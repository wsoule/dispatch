---
id: t-d4995b
title: Warden chat view in the global nav
status: todo
kind: task
parent: e-1d70ca
milestone: null
blocked-by:
  - t-6f0378
labels: []
priority: high
assignee: none
created: 2026-08-04T18:06:37.200Z
updated: 2026-08-04T18:06:37.202Z
external: null
writes:
  - apps/desktop/src/views/WardenView.tsx
  - apps/desktop/src/components/warden/**
  - apps/desktop/src/hooks/useWardenSession.ts
  - apps/desktop/src/lib/appNav.ts
  - apps/desktop/src/components/shell/Sidebar.tsx
  - apps/desktop/src/App.tsx
---

## Description

New global-nav tab ("Warden") with a chat transcript, a message composer, and pending-action confirm cards (approve/deny buttons with the action's human-readable summary). Add a session hook that owns the active warden record and invalidates on `warden.changed`, mirroring how useDispatchProject wires the drafts query today.

Acceptance criteria:

- 'warden' added to GlobalView in apps/desktop/src/lib/appNav.ts; a sidebar entry appears in the global section alongside All Agents/Sessions/Settings and routes to the new view
- New WardenView renders the transcript (user/assistant turns) and a composer that sends follow-up messages
- A pending mutating action renders as a distinct confirm card (summary + approve/deny); denying never triggers the underlying mutation, approving does and the transcript updates once it resolves
- View reflects daemon-unavailable state the same way OverviewView does when data.client is null
- Manually verified in the running desktop dev app: open the tab, ask a status question, get a real answer; trigger a mutating action, confirm it, and see the corresponding real state change (e.g. a run actually gets cancelled)

## Acceptance Criteria

## Activity
