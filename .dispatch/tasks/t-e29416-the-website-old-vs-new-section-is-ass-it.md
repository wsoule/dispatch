---
id: t-e29416
title: the website "Old vs new" section is ass - it need to talk about how
  everything is chat & word focused and this is visual focused, never forget
  what you are doing because it is visually there in a kanban board and stuff
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-07-28T19:37:43.606Z
updated: 2026-08-03T23:19:33.056Z
external: null
writes: []
---

## Description



## Acceptance Criteria

## Activity
- 2026-07-28T19:37:51.753Z dispatched (claude, branch dispatch/t-e29416-the-website-old-vs-new-section-is-ass-it-21e3e6)
- 2026-07-28T19:39:24.099Z Started (run r-21e3e6). Read apps/site/public/index.html — the "Old vs new" section is a 7-row text table ("Same agent. Different container.") arguing about files/git/merge queues, not about chat-vs-visual. Plan: rebuild the section so it *shows* the contrast — a wall-of-text chat panel beside a small kanban diagram — and rewrite every row around "you never lose your place because the work is visually there."
- 2026-07-28T20:04:52.031Z Done — commit be58483 on dispatch/t-e29416-…-21e3e6.

Rebuilt the section around chat-vs-visual instead of files/git/merge-queues:
- Eyebrow "Chat vs. board", h2 "Everything else is a chat window."
- New lead artifact: the SAME nine pieces of work in both containers, side by side. Left is a transcript capped at 210px so it visibly runs off the bottom of its frame; right is a board diagram of that same work that fits with slack. The section performs its own argument before any copy is read.
- The board diagram reuses the app's real status colours (backlog/todo/in-progress/in-review/done) and shows the blocked card with its badge, so it can't contradict the real screenshots in the section above.
- All five remaining table rows sit on one axis, read-vs-see: "To know where you are, you re-read / you look", "Progress is a paragraph / a card in the next column", "One conversation at a time / Every agent at once, on one board", "What's blocked is something you remember / wears a badge and won't dispatch", "The record is scrollback / markdown in .dispatch/".

Dropped rows: task_next, line-comment review, merge queue. They pulled the section off its axis; the hero lede and Screens tabs still cover them. Flagging in case you want one back.

Verification: rendered at 1280 / 820 / 390 via CDP with a true emulated viewport — scrollWidth == clientWidth at all three, no page overflow. Panels go full width below 900px so five board columns still fit; pairs stack below 640px. Each panel names itself rather than sharing a header row (a shared row put "Dispatch" directly above the chat transcript once stacked). bun run format and lint:css clean; bun run lint has the same 223 warnings / 13 errors as main (pre-existing, TS-only — oxlint doesn't read HTML).
- 2026-07-28T20:05:19.077Z [run r-21e3e6] finished: finished — 1 files, $7.43
