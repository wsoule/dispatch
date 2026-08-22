---
id: t-fb96ec
title: "Lens field and presets: per-project lens set by front door"
status: todo
kind: task
parent: e-3a6884
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:44:09.125Z
updated: 2026-08-22T16:44:09.125Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/server/src/**
  - packages/server/test/**
---

## Description

Project-level lens value (builder | engineer) in core types and project state, defaulted by the front door that created the project (prompt → builder, cloned repo → engineer; all existing projects → engineer). Exposed through the daemon API so the app can read and switch it (the settings escape hatch). No UI beyond wiring — the shell task renders it.

## Acceptance Criteria

## Activity
