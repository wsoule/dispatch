---
id: e-805f3e
title: "Run detail: watch and steer a live agent"
status: todo
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: medium
assignee: none
created: 2026-07-27T00:54:42.607Z
updated: 2026-07-27T00:54:42.607Z
external: null
---

## Description

Reshape the run detail surface to the mockup's version (docs/design/dispatch-nocturne.dc.html, the isDetail block; logic in transcript, the d object and pending/streamText in renderVals). Today this is RunsView.tsx over RunLogView and ToolCard; the mockup keeps the same job and tightens how it reads.

Three changes of substance. The transcript becomes a two-column layout with a narrow tagged gutter (read / think / edit / run / you) against wrapped monospace text, so the shape of what the agent is doing is scannable without reading every line - thinking is dimmed, passing commands read as passing, and the user's own interjections are accented. The tail of the stream renders live with a caret rather than appearing only once a message completes. Second, when the run is waiting on approval, the question becomes an inline attention block in the transcript at the point it was asked - the actual question, the actual command in a code block, and three choices (approve once, approve for the session, deny and say why) - rather than a card detached from the conversation. ApprovalCard.tsx is the starting point. Third, a persistent steer composer at the bottom whose copy states the contract: what you type is read on the agent's next turn, not immediately.

The right sidebar carries files touched with per-file +/- counts, the task the run belongs to with its epic and labels, and progress with token spend. Header carries the branch, elapsed, turn count, files touched, diff totals and pause/stop.

Colors come only from the foundations epic's tokens.

Acceptance criteria:

- The transcript renders with a tagged gutter, per-kind emphasis, and a live-streaming tail
- Approval requests appear inline in the transcript where they were asked, showing the real question and command
- Approve once, approve for the session and deny-with-a-reason all work and are visibly distinct in effect
- The steer composer sends mid-run, appears in the transcript as the user's turn, and its copy is honest about when the agent reads it
- The sidebar shows files touched with diff counts, the owning task, and progress with token spend
- The header shows branch, elapsed, turns, files and diff totals, and pause/stop act on the real run
- Long transcripts stay pinned to the bottom while streaming but release when the user scrolls up

## Acceptance Criteria

## Activity
