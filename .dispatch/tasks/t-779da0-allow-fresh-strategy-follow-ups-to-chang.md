---
id: t-779da0
title: Allow fresh-strategy follow-ups to change model
status: todo
kind: task
parent: e-5a8ee7
milestone: null
blocked-by: []
labels: []
priority: low
assignee: none
created: 2026-08-10T22:47:54.433Z
updated: 2026-08-10T22:47:54.433Z
external: null
writes: []
---

## Description

Mid-conversation model switching is explicitly refused today: "A follow-up must answer on the same model the conversation started" (orchestrator.ts:~3006). That constraint is correct for resume (the session belongs to one model) but over-broad: a fresh-strategy follow-up rebuilds the prompt from task+ledger+survey and has no session to preserve.

The fix loop already proves this works — rounds 4-5 hand the task to a fresh agent at tier 'high' (fixLoop.ts modelTier escalation, canResume guard). Expose the same capability to humans: requestChanges / follow-up with strategy 'fresh' accepts a model override; the UI's follow-up composer offers the model picker when (and only when) fresh is selected. Resume keeps the existing refusal, with the error message pointing at the fresh option.

## Acceptance Criteria

## Activity
