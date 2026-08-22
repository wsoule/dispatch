---
id: t-95328d
title: "Scoring service: named factors with tunable weights"
status: todo
kind: task
parent: e-ba8bf1
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-08-22T16:37:59.294Z
updated: 2026-08-22T16:37:59.294Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

Pure scoring function in packages/core over named factors: task urgency, project rank within initiative, initiative rank, milestone due-date proximity, dependency-unblocking value (how many tasks this one unblocks), and task age. Each factor has a weight from .dispatch config with sensible defaults. Output is a total score PLUS the per-factor breakdown so the UI can explain every ranking. Daemon service recomputes the ordered queue of ready (unblocked, todo) tasks on task/entity change and exposes it over the existing HTTP/WS channel.

## Acceptance Criteria

## Activity
