---
id: t-2dfa1d
title: I need to be able to see ALL agents that are runnning via the "all
  agents" page, this includes planners and task details, etc.
status: in-progress
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-11T01:57:30.111Z
updated: 2026-08-11T16:56:02.047Z
external: null
writes: []
---

## Description



## Acceptance Criteria

## Activity
- 2026-08-11T16:49:22.012Z dispatched (claude, branch dispatch/t-2dfa1d-i-need-to-be-able-to-see-all-agents-that-2e4500) — human:wsoule679
- 2026-08-11T16:56:02.046Z Root cause found: the All agents page only renders RunMeta[] (execute/review/verify task runs). Planner conversations, "add detail"/enrich agents, task drafts, and warden chats are in-memory records (PlanRecord/DraftRecord/WardenRecord) with change events but no listing API — PlanManager can only get(id). Approach: add PlanManager.listPlans() + a normalized GET /api/agents endpoint (plans, enrich plans, drafts, wardens as AgentSessionMeta), mirror in @dispatch/client as fetchAgentSessions(), fetch in useDispatchProject (invalidated on plan.changed/draft.changed/warden.changed), and merge session rows into AllAgentsView alongside runs. — none
