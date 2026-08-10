---
id: e-5a8ee7
title: "Model flexibility: beyond the hardcoded Claude list"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels:
  - xirp-gap
priority: medium
assignee: none
created: 2026-08-10T22:46:41.330Z
updated: 2026-08-10T22:46:41.330Z
external: null
writes: []
---

## Description

Xirp: "switch models mid-task and route every job to the best available price performance, including open source models that we host ourselves."

Dispatch today: solid role-based routing (execute/plan/draft/enrich/cluster/summarize in core/src/configTypes.ts), per-task and per-device overrides, risk-based review routing, fix-loop tier escalation — but the model list is a hardcoded array of 5 Claude ids (apps/desktop/src/lib/models.ts), the executor passes model straight to the Claude SDK, and mid-conversation model switching is explicitly refused ("A follow-up must answer on the same model the conversation started", orchestrator.ts:~3006).

Scope: un-hardcode the list, open a provider seam (self-hosted/OSS via e.g. Ollama or OpenRouter-compatible endpoints), and let fresh-strategy follow-ups change model (resume legitimately cannot).

## Acceptance Criteria

## Activity
