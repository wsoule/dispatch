---
id: t-f6ab79
title: "Warden front and center: Runs | Warden tab toggle in the right rail"
status: in-progress
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - ui
priority: high
assignee: none
created: 2026-08-11T21:17:49.629Z
updated: 2026-08-11T21:33:48.434Z
external: null
writes:
  - apps/desktop/src/components/shell/LiveRail.tsx
  - apps/desktop/src/components/shell/LiveRail.test.tsx
  - apps/desktop/src/components/shell/RailWardenTab.tsx
  - apps/desktop/src/components/shell/RailWardenTab.test.tsx
  - apps/desktop/src/App.tsx
---

## Description

Wyat 2026-08-11: "warden needs to be more front and center. it needs to be in the right sidebar. needs a tab toggle at the top to go between the runs and warden."

Give the right rail (LiveRail) a two-tab header: **Runs** (the current live-agents list + attention strip, unchanged) and **Warden** (the warden chat, compact). The warden tab reuses the conversation machinery behind WardenView (useWardenSession, the transcript/composer/pending-action confirm cards) reshaped for a ~15rem column — message list + composer + confirm cards stacked, no side-by-side layout. The full WardenView page stays; the rail tab is the always-available entry point.

Constraints:
- Active tab persisted per device (localStorage, alongside the rail's collapsed state key dispatch:live-rail).
- The attention strip ("N waiting on you →") stays visible on BOTH tabs — it is the rail's one always-on signal.
- The collapsed rail keeps working as today; expanding returns to the last active tab.
- Pending warden action confirms must remain human-gated exactly as in WardenView — same confirm component, no shortcut paths.
- A live warden turn in progress should show on the Runs tab too (the warden is an agent; it belongs in the agent list with kind label 'warden'), clicking it switches to the Warden tab.
- Component tests for tab switching, persistence, and the confirm card rendering in the rail; reuse WardenView's existing test seams (fake backend) rather than new mocks.

## Acceptance Criteria

## Activity
- 2026-08-11T21:18:14.234Z dispatched (claude, branch dispatch/t-f6ab79-warden-front-and-center-runs-warden-tab-136b66) — human:wsoule679
- 2026-08-11T21:33:48.434Z Done in two commits: 95673f2b extracts WardenChat (transcript, composer, confirm card) from WardenView with a `compact` mode for a 15rem column — the confirm/approve path is one shared component, so rail approvals go through exactly WardenView's code path. d405ec7e gives LiveRail the Runs | Warden segmented header: tab persisted in dispatch:live-rail-tab beside the collapse flag (expand returns to the last tab), attention strip lifted above the tab content so it shows on both tabs, and a warden turn in flight renders as a Runs-tab agent row labeled 'warden' whose click opens the Warden tab. Rail tests fake the WardenSession seam with wardenThread.test.ts-style record fixtures — no module mocks. Verified: desktop suite 1309 pass / 0 fail, tsc clean, lint/knip clean; the wardenLive guard mutation-tested (1 test fails when reverted). Note: WardenChat compact carries its own "New" reset since the rail has no page header; full WardenView is unchanged visually. — none
