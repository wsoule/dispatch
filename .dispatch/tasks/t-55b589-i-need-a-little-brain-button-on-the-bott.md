---
id: t-55b589
title: i need a little brain button on the bottom right to easily add things to
  brain dump
status: in-progress
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-11T02:17:13.360Z
updated: 2026-08-11T02:20:25.942Z
external: null
writes: []
---

## Description



## Acceptance Criteria

## Activity
- 2026-08-11T02:17:27.629Z dispatched (claude, branch dispatch/t-55b589-i-need-a-little-brain-button-on-the-bott-51f5bd) — human:wsoule679
- 2026-08-11T02:20:25.942Z Plan: new BrainDumpFab component in apps/desktop/src/components/shell — fixed bottom-right brain button opening a small capture panel (textarea, ⌘⏎, "Drop into the inbox"), wired in App.tsx via rawData.handleCaptureInbox; hidden on the Brain dump view itself and while the daemon client is null. Following the InboxPanel hand-rolled-popover pattern (testable under happy-dom, no Radix portal). Install+build running in background. — none
