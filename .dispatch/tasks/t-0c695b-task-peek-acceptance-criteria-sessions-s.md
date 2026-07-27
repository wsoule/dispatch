---
id: t-0c695b
title: "Task peek: acceptance criteria, sessions, self-review and blockers"
status: todo
kind: task
parent: e-92d17d
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:01:29.323Z
updated: 2026-07-27T01:01:29.323Z
external: null
---

## Description

Extend the task peek panel to the mockup's version (docs/design/dispatch-nocturne.dc.html, the taskOpen block and the td object in renderVals), building on TaskDetailDialog.tsx and PropertyControls.tsx.

A right-hand slide-over, roughly 820px, over a dimmed board. Header: task id, state dot and label, close. Main column: the title, then an action row - Dispatch an agent, a model picker beside it, and Watch the agent when a run is already going - then Description, then Acceptance criteria as individually checkable items, then Sessions listing every run against this task with turns/tokens/duration and outcome, then an Activity composer for leaving a note the agent reads when it picks the task up.

Right rail: Properties (state, priority, epic, label, and a self-review toggle) and Blocked by, which lists blocking task ids or states plainly that nothing is holding this up. That last line matters - an empty blockers section reads as missing data, whereas "Nothing is holding this up" answers the question.

Acceptance criteria are the substantive addition: they are currently part of the task body markdown, so per-criterion checked state needs somewhere to live. Decide whether to parse and write back the markdown checkboxes or store state separately, and prefer whichever keeps the task file hand-editable.

Colors from tokens only.

Acceptance criteria:

- The peek shows title, description, acceptance criteria, sessions, activity and properties
- Acceptance criteria can be checked individually and the state persists, keeping the task file hand-editable
- Dispatch works from the peek, the model picker selects the model used, and Watch the agent appears only when there is a run to watch
- Sessions lists every run against the task with turns, tokens, duration and outcome
- Self-review toggles and persists on the task
- Blocked-by lists blockers, and says plainly when there are none
- Notes left in Activity reach the agent when it picks the task up
- Escape closes the peek without closing anything behind it, consistent with the existing nav reducer's escape handling
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
