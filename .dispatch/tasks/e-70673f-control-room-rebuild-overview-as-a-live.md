---
id: e-70673f
title: "Control room: rebuild Overview as a live agent feed"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: high
assignee: none
created: 2026-07-27T00:53:38.106Z
updated: 2026-07-27T00:53:38.106Z
external: null
---

## Description

Replace apps/desktop/src/views/OverviewView.tsx with the mockup's Control room (docs/design/dispatch-nocturne.dc.html, the isControl block; logic in ribbonDef and the feed builder in renderVals). This is the largest departure in the redesign and the reason for it.

Today's Overview is four StatTiles above a two-column grid of SectionCards, one card per bucket. It answers "how many" but not "what is happening", and it caps each bucket silently. The Control room replaces it with three stacked bands: a seven-counter ribbon across the top (waiting on you, failed, working, needs review, landing, ready to start, blocked) where the two urgent counters tint themselves only when non-zero; a filter bar (free-text query over title/id/epic, toggleable status chips, an "N of M shown" readout, collapse-all); and one continuous feed grouped by state with collapsible headers, per-group caps and an explicit "show the other N" row instead of a silent slice.

The feed row is where the density earns its keep: state label, task title, epic, a live activity line for running agents, elapsed time, and inline actions that differ per state (Approve/Deny, Retry/Read the error, Review, Cancel). Waiting and failed rows carry a second line with the actual question or failure reason plus the command in question, so the user can act without opening anything.

Colors come only from the tokens the foundations epic lands. Everything is driven by data useDispatchProject already has - runs, tasks, readyIds, liveRunStateByTaskId - so this is a view-layer epic.

Acceptance criteria:

- The ribbon shows all seven counts, urgent ones read as urgent only when non-zero, and each is click-through to the right destination
- The filter bar filters the feed by query and by status chip, and reports how many of the total are shown
- Feed groups collapse and expand, cap per group, and expose the remainder behind an explicit row
- Running rows show what the agent is doing now and progress; waiting and failed rows show the question or error inline with the relevant command
- Per-row actions act in place without navigating away, and opening a row goes to the right surface for its state
- A live/paused control stops and resumes the polling that drives the feed
- Empty states read as reassuring rather than broken, as the current SectionCards do

## Acceptance Criteria

## Activity
