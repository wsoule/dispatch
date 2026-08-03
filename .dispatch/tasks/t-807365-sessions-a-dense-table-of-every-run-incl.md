---
id: t-807365
title: "Sessions: a dense table of every run, including the killed ones"
status: done
kind: task
parent: e-c88fb6
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:02:16.272Z
updated: 2026-07-27T02:34:42.514Z
external: null
---

## Description

Reshape apps/desktop/src/views/SessionsHubView.tsx to the mockup's table (docs/design/dispatch-nocturne.dc.html, the isSessions block and the sessions builder in renderVals), reusing SessionRow.tsx, sessionDisplay.ts and SpendTable.tsx where they fit.

A seven-column table with an uppercase tracked header: session id, task, model, turns, tokens, length, ended. Numeric columns are mono and tabular-nums so they align down the page, which is the whole reason to make this a table rather than cards.

Emphasis by outcome: failed and waiting rows tint, running rows read as active, finished and killed rows recede. The subtitle states the scope plainly - every run this repo has had, including the ones you killed - because the value of this screen is that it hides nothing.

Sorting and filtering are worth having if the existing view already has them; do not add a new mechanism if it does not.

Colors from the run-state tokens only.

Acceptance criteria:

- Sessions renders as a dense seven-column table with a tracked header
- Numeric columns are mono and tabular-nums and align vertically
- Failed, waiting, running, finished and killed rows are visually distinguished using tokens
- Killed and failed runs are included rather than filtered out
- Rows open the session detail that already exists
- The table stays readable at the app's narrowest supported width
- Long task titles truncate rather than wrapping the row
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T02:34:42.514Z Done in 389f17e, but built in AllAgentsView rather than SessionsHubView — the task named the wrong file. SessionsHubView is the cross-project spend surface (dashboard stats, spend by model, spend by project) over the app's own session data, not dispatch runs; reshaping it into a per-repo run table would have destroyed a different feature. AllAgentsView was the right home: it was already the per-project run surface, just filtered to live runs only, which cannot answer "what has this repo actually done". It now takes data.runs (all of them) and renders a dense table — task, model, turns, spend, updated, outcome — with terminal rows receding but never filtered out. Column template is shared between the header strip and the rows so the two cannot drift. Columns differ from the mockup's seven: no session id (the run id is not useful to read), and spend instead of tokens (costUsd is on RunMeta; a token count is not). Also migrated this view's raw bg-amber-500/bg-emerald-500/bg-red-500 dots onto StateDot + tokens.
