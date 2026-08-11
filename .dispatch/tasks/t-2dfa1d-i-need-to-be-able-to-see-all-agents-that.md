---
id: t-2dfa1d
title: I need to be able to see ALL agents that are runnning via the "all
  agents" page, this includes planners and task details, etc.
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-11T01:57:30.111Z
updated: 2026-08-11T18:01:53.067Z
external: null
writes: []
---

## Description



## Acceptance Criteria

## Activity
- 2026-08-11T16:49:22.012Z dispatched (claude, branch dispatch/t-2dfa1d-i-need-to-be-able-to-see-all-agents-that-2e4500) — human:wsoule679
- 2026-08-11T16:56:02.046Z Root cause found: the All agents page only renders RunMeta[] (execute/review/verify task runs). Planner conversations, "add detail"/enrich agents, task drafts, and warden chats are in-memory records (PlanRecord/DraftRecord/WardenRecord) with change events but no listing API — PlanManager can only get(id). Approach: add PlanManager.listPlans() + a normalized GET /api/agents endpoint (plans, enrich plans, drafts, wardens as AgentSessionMeta), mirror in @dispatch/client as fetchAgentSessions(), fetch in useDispatchProject (invalidated on plan.changed/draft.changed/warden.changed), and merge session rows into AllAgentsView alongside runs. — none
- 2026-08-11T17:16:45.017Z Done in two commits: f1f6f549 (server+client: PlanManager.listPlans, GET /api/agents normalizing plans/enrich/drafts/wardens into AgentSessionMeta, enrich plans now carry the task/note/capture title as `subject`, fetchAgentSessions in @dispatch/client) and aa244671 (desktop: AllAgentsView merges session rows with runs — kind labels planner/detail/draft/warden, shared state dots and Live/Needs review/Closed filter, live-updating via plan.changed/draft.changed/warden.changed). Verified: 9 new server tests + 1228 desktop tests pass, neighboring plan/warden/notes/api suites green (106 pass), format/lint/knip/tsc clean. Mutation-tested the title-truncation guard (1 test fails when reverted). Sessions are in-memory server-side, so the non-run half of the list only reaches back to the daemon's last restart — same lifetime as the Plans/drafts/warden surfaces themselves. — none
- 2026-08-11T17:17:00.005Z [run r-2e4500] finished: finished — 12 files, $23.37 — agent:wsoule679/claude
- 2026-08-11T18:01:53.067Z run r-2e4500 merged into main — human:wsoule679
