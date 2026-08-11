---
id: t-55b589
title: i need a little brain button on the bottom right to easily add things to
  brain dump
status: in-review
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-11T02:17:13.360Z
updated: 2026-08-11T02:33:15.065Z
external: null
writes: []
---

## Description



## Acceptance Criteria

## Activity
- 2026-08-11T02:17:27.629Z dispatched (claude, branch dispatch/t-55b589-i-need-a-little-brain-button-on-the-bott-51f5bd) — human:wsoule679
- 2026-08-11T02:20:25.942Z Plan: new BrainDumpFab component in apps/desktop/src/components/shell — fixed bottom-right brain button opening a small capture panel (textarea, ⌘⏎, "Drop into the inbox"), wired in App.tsx via rawData.handleCaptureInbox; hidden on the Brain dump view itself and while the daemon client is null. Following the InboxPanel hand-rolled-popover pattern (testable under happy-dom, no Radix portal). Install+build running in background. — none
- 2026-08-11T02:33:00.695Z Done, committed as d960334d. BrainDumpFab: fixed bottom-right brain button (accent round FAB) on every project screen except Brain dump itself, gated on a live daemon client. Opens a small panel — textarea, one-item-per-line, ⌘⏎ or "Drop it" commits via the RAW handleCaptureInbox (wrapped one swallows rejections), failure keeps the draft with an inline error, success closes; "Open Brain dump" jumps to the full view. 8 component tests; 3 guards mutation-tested (1 test killed each). Verification: desktop tsc clean, oxlint 0 errors, stylelint + knip clean, full desktop suite 1172 pass with 1 pre-existing webkitFloor/release.yml fail unrelated to this diff. Visual check in the real app left for a human — e2e/screenshot harness is blocked in this agent shell. — none
- 2026-08-11T02:33:15.065Z [run r-51f5bd] finished: finished — 3 files, $10.34 — agent:wsoule679/claude
