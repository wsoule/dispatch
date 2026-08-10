---
id: t-ce0ae7
title: Un-hardcode the model list and open a provider seam
status: todo
kind: task
parent: e-5a8ee7
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-10T22:47:49.199Z
updated: 2026-08-10T22:47:49.199Z
external: null
writes: []
---

## Description

The model list is a hardcoded array of 5 Claude ids in apps/desktop/src/lib/models.ts, and executors/claude.ts passes model straight to the Claude SDK's query({options:{model}}).

Scope:
- Model catalog becomes data: config-driven (.dispatch/config.yml models section already exists for roles — extend with an available-models list or provider blocks), with the current 5 Claude ids as the default so zero-config behavior is unchanged.
- Provider seam in the execution path: the Claude SDK supports custom base URLs / gateways (ANTHROPIC_BASE_URL), which covers Anthropic-compatible self-hosted endpoints cheaply; a genuinely different provider API arrives with the second-executor work in the vendor-neutral epic — don't duplicate it here, but make the model catalog provider-aware (model id + provider + pricing entry).
- Desktop Settings → Agents and the per-task model override should read the catalog, not the constant.
- Cost: ingestion-side pricing.json already has a _default fallback; orchestrator-side costUsd comes from the SDK and will be absent for non-SDK providers — record that gap rather than showing $0.

Xirp quality matched: "route every job to the best available price performance, including open source models that we host ourselves" — this task is the routing substrate; actual price-performance auto-routing is a later decision.

## Acceptance Criteria

## Activity
