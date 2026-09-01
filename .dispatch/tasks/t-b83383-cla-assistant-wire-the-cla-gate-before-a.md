---
id: t-b83383
title: "CLA Assistant: wire the CLA gate before any outside PR can land"
status: todo
kind: task
parent: e-c25f9c
milestone: null
blocked-by: []
labels:
  - open-core
  - licensing
priority: high
assignee: none
created: 2026-08-23T14:30:13.373Z
updated: 2026-08-23T14:30:13.373Z
external: null
writes:
  - .github/workflows/cla.yml
  - .github/CLA.md
---

## Description

Set up contributor-license-agreement enforcement so it is live before the repo is public: the cla-assistant GitHub Action (contributor-assistant/github-action) with a CLA text committed at .github/CLA.md, blocking PR merge until signed, signatures stored in the repo (or a dedicated signatures branch). The CLA must grant relicensing rights (code may move across the MIT/FSL boundary and into the commercial server) — DCO is explicitly not sufficient (docs/BUSINESS.md). Note the repo's CI convention: actions are SHA-pinned (see .agents/skills/github-actions-ci). Manual half: none beyond merging — the action needs no external service. CONTRIBUTING.md already tells contributors to expect the prompt.

## Acceptance Criteria

## Activity
