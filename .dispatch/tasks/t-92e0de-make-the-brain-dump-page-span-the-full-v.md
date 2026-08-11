---
id: t-92e0de
title: Make the Brain Dump page span the full view width
status: todo
kind: task
parent: null
milestone: null
blocked-by:
  - t-f7caf7
labels: []
priority: medium
assignee: none
created: 2026-08-11T02:00:39.508Z
updated: 2026-08-11T02:00:39.510Z
external: null
writes:
  - apps/desktop/src/views/BrainDumpView.tsx
---

## Description

BrainDumpView currently splits into a flex-1 main column and a fixed w-64 right aside (cluster-suggestion card + "What is this?" explainer), permanently reserving ~280px even when the aside holds only the explainer trigger. Collapse to a single full-width column — drop the <aside>, move the cluster "these look like one thing" suggestion into a slim inline banner above the inbox list (styled like the existing multi-select action bar), and move the ExplainerPopover trigger into the page header next to the "Brain dump" title.

Acceptance criteria:

- BrainDumpView renders as a single column filling the full width of the main content area — no fixed-width side rail.
- The cluster-suggestion card's content and "Select them" action remain reachable, relocated inline above/alongside the inbox section.
- The "What is this?" explainer remains reachable (e.g. an icon button beside the page title) and keeps its existing hover/focus/click-to-open behavior.
- No functional regression to capture, clustering, multi-select, convert/dismiss, or the manual-edit flow from the other task.
- bun run format, bun run lint, package tsc, and existing BrainDumpView tests pass; any layout-dependent test/screenshot fixtures are updated.

## Acceptance Criteria

## Activity
