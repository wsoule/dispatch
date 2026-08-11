---
id: t-bef1cb
title: "Second real agent executor: Codex CLI (or Gemini CLI) behind the
  Executor seam"
status: todo
kind: task
parent: e-98857a
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-08-10T22:47:36.803Z
updated: 2026-08-10T22:47:36.803Z
external: null
writes: []
---

## Description

The Xirp quality Dispatch lacks: dispatching work to a non-Anthropic harness. The registry already exists (registerExecutor, orchestrator.ts; DEFAULT_EXECUTOR_NAME='claude') so this does not strictly depend on Phase A — it's a second implementation of the existing Executor contract (orchestrator/types.ts:132) alongside executors/claude.ts.

Scope:
- Pick the first target by ecosystem maturity at build time (Codex CLI and Gemini CLI both have headless/exec modes; evaluate which maps cleanest onto the contract: streamed NormalizedEntry events, interrupt/requestStop, send for follow-ups, approval flow, session id for resume, cost reporting).
- Map every ExecutorEvents callback; where the harness has no equivalent (e.g. no tool-approval hook), document the degradation explicitly rather than faking it.
- Per-executor MCP wiring: the dispatch MCP server must reach the agent (executors/claude.ts injects it via the SDK; other CLIs use their own MCP config format).
- CLI/binary resolution mirroring claudeCli.ts (env override → PATH), with a clear install hint.
- Executor selection surfaced at dispatch time (API body already carries executor; expose in the desktop dispatch dialog behind the registry's registeredExecutorNames).
- Follow the fake.ts/claude.ts test split: contract tests run against the fake; a gated integration test against the real CLI.

## Acceptance Criteria

## Activity
