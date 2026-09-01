---
id: t-7ced61
title: Search across shared runs and transcripts
status: dropped
kind: task
parent: e-5434b7
milestone: null
blocked-by:
  - t-1429fa
labels:
  - team
priority: medium
assignee: none
created: 2026-08-10T22:48:44.031Z
updated: 2026-08-23T14:29:36.545Z
external: null
writes: []
---

## Description

There is no transcript or run search anywhere in Dispatch today — not even over local `~/.dispatch/runs/`. Once runs publish to the shared store, "an agent in one session rediscovering what another session already resolved" (the exact entropy Xirp calls out) becomes solvable with search.

Scope:
- Index the published run corpus: task title/id, run summary, evidence lines, ledger entries, findings, and transcript text per the design task's redaction decision.
- Human surface: search from the desktop (Sessions hub is the natural home) returning runs with matched context, local and remote.
- Agent surface: an MCP tool (e.g. run_search) so a dispatched agent can ask "has anyone touched X / solved Y" before re-deriving it — this is the compounding-knowledge loop, and it should be mentioned in the onboarding resource and possibly the standing prompt instructions.
- Start with plain text/keyword search over the store; embeddings/semantic search is a later decision, not this task.

## Acceptance Criteria

## Activity
