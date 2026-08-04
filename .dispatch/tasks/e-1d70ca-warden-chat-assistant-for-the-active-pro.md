---
id: e-1d70ca
title: "Warden: chat assistant for the active project"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-04T18:06:37.190Z
updated: 2026-08-04T18:06:37.190Z
external: null
writes: []
---

## Description

A conversational, LLM-backed assistant surfaced as a new tab in the sidebar's global nav section (next to All Agents/Sessions/Settings). It answers status questions about the currently active project — runs, tasks, epics, merge queue, pending approvals, open questions, ledger — and can take mutating actions (dispatch a task, approve/deny a run, cancel a run, dequeue a merge, message a live agent) via real tool-calling against a Claude Agent SDK session. Every mutating tool call is paused as a pending action; nothing executes until the human explicitly confirms it in the chat UI. Scoped to the active project only (not cross-project) for this iteration; a floating/overlay panel accessible from any view is an explicit non-goal for now (tab only).

## Acceptance Criteria

## Activity
