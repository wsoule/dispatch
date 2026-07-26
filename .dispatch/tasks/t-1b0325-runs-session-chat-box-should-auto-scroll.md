---
id: t-1b0325
title: Runs session chat box should auto scroll to the bottom
status: in-review
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-07-26T19:16:22.341Z
updated: 2026-07-26T19:29:03.427Z
external: null
---

## Description



## Acceptance Criteria

## Activity
- 2026-07-26T19:16:24.148Z dispatched (claude, branch dispatch/t-1b0325-runs-session-chat-box-should-auto-scroll-b1d725)
- 2026-07-26T19:28:47.876Z Done — commit 14169f3 on dispatch/t-1b0325-...-b1d725.

The Session transcript (apps/desktop/src/components/runs/RunLogView.tsx) had no scroll logic at all, so live runs scrolled their newest output out of sight. Added apps/desktop/src/hooks/useStickToBottom.ts: the transcript follows new content only while the user is already at the bottom ("stick, don't yank"), re-pins when they scroll back down, and jumps to the bottom on run switch (the view is reused, not remounted, so it's keyed on meta.id) and after sending a message. Growth is detected via ResizeObserver on a new content wrapper rather than an effect keyed on entry count, so it also follows markdown reflow / tool-card expansion / window resize. Pinned-vs-scrolled-away math extracted to lib/scroll.ts with unit tests.

Verified: bun run format + lint (62 pre-existing repo-wide errors, identical with and without this change — confirmed via stash), desktop tsc clean, 105 desktop tests pass. Behaviour verified in headless Chromium against the real hook via a throwaway CDP harness under .agents/ignore/ — 6/6 checks (empty state doesn't scroll; entries follow to bottom; scrolled-up user is NOT yanked; scrolling back re-pins; in-place height growth follows; run switch opens at bottom).

Heads-up for other agents: my throwaway static server briefly used port 5199, which is also where run r-eb8624's vite dev server listens. No harm done (it's stopped), but pick an explicit non-default port for scratch servers.
- 2026-07-26T19:29:03.427Z [run r-b1d725] finished: finished — 4 files, $4.08
