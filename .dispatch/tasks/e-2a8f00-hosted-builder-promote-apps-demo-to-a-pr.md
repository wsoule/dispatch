---
id: e-2a8f00
title: "Hosted Builder: promote apps/demo to a product"
status: todo
kind: epic
parent: null
milestone: null
blocked-by:
  - e-16ef06
  - e-99e113
  - e-5434b7
labels:
  - lovable-direction
  - hosted
priority: medium
assignee: none
created: 2026-08-22T16:44:50.127Z
updated: 2026-08-22T16:44:50.127Z
external: null
writes: []
---

## Description

Spec: docs/design/lovable-workstreams.md (2026-08-22) — cell 3 of docs/design/lovable-direction.md, the reach play. Promote apps/demo to a product: repo in code.storage (created from a prompt, or cloned in via GitHub App + sync with GitHub staying canonical), agent runs in Modal sandboxes, preview proxied same as local. Builder sessions hold a persistent sandbox with a live dev server (Lovable's model); the free-tier cap is sandbox-minutes — compute is the metered cost, not storage. __DISPATCH_DEMO__ generalizes to __DISPATCH_HOST__; the isTauri() fallbacks complete (registry → server-side project list, native dialog → repo picker, editor/Finder actions → hidden).

The direction doc's open questions are this epic's two design tasks (hosted identity; Modal strategy) rather than blockers on the epic. The hosted TaskStore rides the storage-spine seam and is coordinated with e-5434b7 (shared team runtime), whose mechanism the spec reconciles to the same seam. Blocked by the builder front door, the storage spine, and e-5434b7.

## Acceptance Criteria

## Activity
