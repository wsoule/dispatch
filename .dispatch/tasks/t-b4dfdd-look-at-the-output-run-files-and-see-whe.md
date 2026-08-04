---
id: t-b4dfdd
title: look at the output run files and see where the agent is repeating a lot
  of actions, this needs to be consolidated into something somehow- like the
  agents shouldn’t aways be doing the same thing if they dont have to
status: in-review
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-07-28T20:01:00.686Z
updated: 2026-08-04T00:29:39.263Z
external: null
writes: []
---

## Description



## Acceptance Criteria

## Activity
- 2026-08-03T23:19:48.573Z dispatched (claude, branch dispatch/t-b4dfdd-look-at-the-output-run-files-and-see-whe-9d3751) — human:wsoule679
- 2026-08-03T23:22:45.652Z Analysed 23 dispatch run transcripts (~1.66k tool calls) from ~/.claude/projects/*dispatch-worktrees*. Repetition is concentrated in a fixed orientation ritual every run redoes: ToolSearch for dispatch MCP schemas (19/23 runs), run_list (16/23), `ls .agents/skills/` + `head .agents/skills/*/SKILL.md` (near-universal, mandated by AGENTS.md), `ls apps packages`/repo-tree discovery, then re-reading the same core files (packages/server/src/api.ts in 6 separate runs, orchestrator/plan.ts + planners/claude.ts in 4 each, useDispatchProject.ts in 5). Median 16 tool calls before the first edit; the substantial runs burn 26-59. Scratch analysis script at .agents/ignore/run-analysis/analyze.ts. — none
- 2026-08-04T00:29:20.505Z Shipped in 4 commits (b93e2bf, 0296bdd, 1e9b715, 82112a7). Consolidated the repeated orientation ritual into a single `## Repo orientation` section rendered into every run prompt, fed by three collectors: deterministic facts (workspace map, skills index from SKILL.md frontmatter, root scripts, live concurrent runs + claims), a commit-keyed LLM repo map cached under runsDir and refreshed in the background, and cross-run file hotspots mined from this project's own transcripts. Where the section covers ground an instruction used to, that instruction now points at it instead of repeating the errand, so the fetching stops rather than doubling. Verified end-to-end against the real repo: the section renders the full 8-package workspace map and 8-skill index, and the miner independently rediscovers packages/server/src/api.ts — the file planners/claude.ts already hardcodes as this repo's canonical shared ground. Also filed t-9e0f00 for the merge-queue DISPATCH_HOME leak (12,763 dirs vs 25 transcripts). — none
- 2026-08-04T00:29:39.263Z [run r-9d3751] finished: finished — 14 files, $15.69 — agent:wsoule679/claude
