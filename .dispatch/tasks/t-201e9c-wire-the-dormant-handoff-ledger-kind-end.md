---
id: t-201e9c
title: Wire the dormant 'handoff' ledger kind end to end
status: todo
kind: task
parent: e-ff5a2c
milestone: null
blocked-by: []
labels:
  - team
priority: high
assignee: none
created: 2026-08-10T22:47:13.264Z
updated: 2026-08-10T22:47:13.264Z
external: null
writes: []
---

## Description

core/src/ledger.ts:4 declares 'handoff' as a valid LedgerKind but no code path ever writes one — the record_decision MCP tool's schema only accepts decision|hazard, and nothing renders handoff entries distinctly.

Make it real:
- Let agents (and the UI) write handoff entries: either extend record_decision's schema or add a dedicated record_handoff MCP tool in packages/mcp/src/tools.ts. A handoff entry should capture: what was being attempted, current state (done/remaining), gotchas discovered, and pointers (branch, files, run id).
- Render handoff entries prominently in the next run's prompt (renderLedgerSection in orchestrator/prompt.ts currently treats all kinds uniformly) — a handoff is addressed to the next worker, unlike a decision which is background.
- Surface handoff entries in the desktop task detail so a human picking up the task sees them too.
- Prompt guidance: when a run ends interrupted/failed or an agent stops mid-task, nudge it to record a handoff (the standing-instructions block in buildTaskPrompt).

## Acceptance Criteria

## Activity
