---
id: t-d4995b
title: Warden chat view in the global nav
status: done
kind: task
parent: e-1d70ca
milestone: null
blocked-by:
  - t-6f0378
labels: []
priority: high
assignee: none
created: 2026-08-04T18:06:37.200Z
updated: 2026-08-11T15:33:58.418Z
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
- 2026-08-11T02:07:48.864Z dispatched (claude, branch dispatch/t-d4995b-warden-chat-view-in-the-global-nav-0faef1) — none
- 2026-08-11T02:12:28.461Z Starting the Warden chat view. Design settled from reading the branch: 'warden' joins GlobalView in appNav.ts; a new lib/wardenThread.ts flattens WardenRecord into transcript rows (mirroring planThread.ts, with confirm cards emitted for still-pending actions and superseded "queued" rows skipped); a new hooks/useWardenSession.ts owns wardenId + the record query (key exported so useDispatchProject's WS handler can invalidate it on warden.changed, same wiring as plan.changed/draft.changed); Sidebar gets a Warden row in the global section; App.tsx mounts the session hook and routes globalView==='warden' to a new views/WardenView.tsx with the OverviewView DaemonUnavailable gate. Files touched: appNav.ts, wardenThread.ts(+test), useWardenSession.ts, useDispatchProject.ts, Sidebar.tsx(+test), App.tsx, WardenView.tsx. — none
- 2026-08-11T02:30:36.562Z Done — committed 62331631 (feat(desktop): warden chat view in the global nav). All acceptance criteria met: 'warden' in GlobalView + sidebar row (Shield icon, between Sessions and Settings) + palette entry; WardenView renders transcript/composer/confirm-cards; useWardenSession owns the record and useDispatchProject invalidates wardenKey on warden.changed; DaemonUnavailable gate identical to OverviewView. Manually verified in the dev app (browser harness + fakes dispatchd on :4477): real ClaudeWarden answer to a status question (it called list_runs/pending_approvals and named the parked run); cancel_run confirm card → Deny left run awaiting-approval, Approve flipped it to cancelled with an Applied audit row; conversation survives tab switches. Evidence + 2 mutation tests recorded (both guards kill a test when reverted). Pre-existing failures untouched: webkitFloor.test.ts (fails on clean tree) and 9 lint warnings in server warden test files. — none
- 2026-08-11T02:31:08.019Z [run r-0faef1] finished: finished — 10 files, $24.39 — agent:wsoule679/claude
- 2026-08-11T15:33:54.736Z run r-0faef1 merged outside dispatch (branch dispatch/t-d4995b-warden-chat-view-in-the-global-nav-0faef1 landed on dispatch/t-6f0378-client-api-bindings-for-warden-3d4e52) — none
- 2026-08-11T15:33:58.418Z merge queue: dependent run r-6a06aa restacked onto dispatch/t-6f0378-client-api-bindings-for-warden-3d4e52 after blocker run r-0faef1 merged (via git rebase --onto) — none
