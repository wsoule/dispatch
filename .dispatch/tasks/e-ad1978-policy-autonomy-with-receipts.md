---
id: e-ad1978
title: "Policy: autonomy with receipts"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - lovable-direction
  - policy
priority: high
assignee: none
created: 2026-08-22T16:43:48.370Z
updated: 2026-08-22T16:43:48.370Z
external: null
writes: []
---

## Description

Spec: docs/design/lovable-workstreams.md (2026-08-22), from docs/design/lovable-direction.md. Policy is what the agent may do without a human gate — per-project, shared, visible in both lenses. Gates demote from BLOCKING to RECORDING: auto-accept scope requests, auto-retry verify, eventually auto-merge on green, with every decision still landing in the ledger, findings, and evidence trail. A small irreversibility floor always stays blocking regardless of policy: force-push, deletes outside declared writes, spend above the budget cap.

The spec proposes a four-stop autonomy ladder (review everything / auto-accept scope / auto-verify / auto-merge on green; builder preset defaults to 3, engineer to 2) — the ladder is settled by this epic's design task before implementation. Builder surfaces the config as a slider, engineer as the full gate table; same underlying config. This is the positioning epic: Lovable is autonomous and opaque, classic review tooling is legible and slow — Dispatch is autonomous with receipts.

## Acceptance Criteria

## Activity
