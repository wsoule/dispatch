---
id: t-807365
title: "Sessions: a dense table of every run, including the killed ones"
status: todo
kind: task
parent: e-c88fb6
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:02:16.272Z
updated: 2026-07-27T01:02:16.272Z
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
