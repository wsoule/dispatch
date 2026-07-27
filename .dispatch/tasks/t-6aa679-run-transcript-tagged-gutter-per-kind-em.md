---
id: t-6aa679
title: "Run transcript: tagged gutter, per-kind emphasis, and a live streaming tail"
status: todo
kind: task
parent: e-805f3e
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: medium
assignee: none
created: 2026-07-27T01:00:11.492Z
updated: 2026-07-27T01:00:11.492Z
external: null
---

## Description

Reshape the run transcript to the mockup's two-column form (docs/design/dispatch-nocturne.dc.html, the transcript binding and the isDetail transcript block). Today this is RunLogView.tsx with ToolCard.tsx; the change is from stacked cards to a dense tagged list.

Every entry becomes a narrow left gutter holding a short uppercase tag - read, think, edit, run, you - against wrapped monospace text on the right. The tag column is fixed width so the whole transcript reads as a single scannable spine: you can see the shape of what the agent did (five reads, a think, two edits, a test run) without reading any of the text.

Emphasis differs per kind and carries meaning. Thinking is dimmed, because it is context rather than action. A command that passed reads as passed. The user's own interjections are accented, so your own steering stands out from the agent's stream. Tool reads and edits are plain.

The tail streams: the in-progress entry renders its partial text with a caret rather than appearing only once complete. Respect prefers-reduced-motion for the caret.

Also handle the boring-but-important part: the transcript stays pinned to the bottom while streaming, and releases when the user scrolls up so reading history is not fought by incoming output. There is an existing task about the chat box auto-scrolling; check whether this supersedes it.

Colors from tokens only.

Acceptance criteria:

- Entries render as a fixed-width tag gutter against wrapped monospace text
- Tags cover read, think, edit, run and user turns, and per-kind emphasis is meaningful and token-driven
- The in-progress entry streams its partial text with a caret, and the caret respects prefers-reduced-motion
- The view stays pinned to the bottom while streaming and releases when the user scrolls up
- A jump-to-latest affordance appears when the user has scrolled away
- Long output and very long single lines are handled without breaking the layout
- Overlap with the existing auto-scroll task is resolved
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
