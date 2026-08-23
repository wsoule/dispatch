---
id: t-ed735b
title: "Zero-turn resumed run finishes green: silent no-op reads as success"
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - orchestrator
  - resilience
priority: high
assignee: none
created: 2026-08-23T00:20:15.382Z
updated: 2026-08-23T00:20:15.382Z
external: null
writes:
  - packages/server/src/**
  - packages/server/test/**
---

## Description

Incident 2026-08-22: run r-297e7b (a message --resume follow-up on t-48a2e5 carrying required review fixes) reached state=finished with turns=0, costUsd=0, no commits, and a transcript ending at the injected user message — the agent never executed a single turn, yet the run reads as a successful finish everywhere (runs list, fix loop, review surfaces). The requested fixes were silently not applied; only a manual diff caught it.

Likely area: the resume path in the executor/session handling — a resumed SDK session that terminates immediately (expired/terminal session id, or an SDK error mapped to a clean exit) is recorded as finished instead of failed. Fix: a run that finishes with zero turns (or no assistant output at all) after a resume must be state=failed with an explanatory error, not finished; consider the same guard for fresh runs. Test: resume with a stubbed executor that exits without turns, assert failed + error message. Related resilience cluster: t-050819 (restart auto-resume), t-350f21 (fix-loop false green) — all three are "dead thing reads as success" bugs.

## Acceptance Criteria

## Activity
