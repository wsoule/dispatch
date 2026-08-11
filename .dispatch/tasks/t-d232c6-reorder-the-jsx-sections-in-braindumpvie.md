---
id: t-d232c6
title: Reorder the JSX sections in BrainDumpView to render the 'Group into
  epics' suggestion panel before the 'Inbox' item list. Currently the grouping
  suggestions appear after the inbox items (lines 430-519 after lines 299-362);
  they should appear before. This improves UX by showing epic-grouping hints
  before the raw item list, helping users think about structure earlier.
status: done
kind: task
parent: null
milestone: null
blocked-by: []
labels: []
priority: none
assignee: none
created: 2026-08-04T18:06:50.010Z
updated: 2026-08-10T23:58:52.399Z
external: null
writes: []
archived-at: 2026-08-10T23:58:52.399Z
---

## Description



## Acceptance Criteria

## Activity
- 2026-08-04T18:07:17.402Z dispatched (claude, branch dispatch/t-d232c6-reorder-the-jsx-sections-in-braindumpvie-d5ee92) — human:wsoule679
- 2026-08-04T18:22:32.651Z Moved the "Group into epics" panel out of the right-rail <aside> into the main content column, directly above the Inbox <section>. Asked the human first: the two blocks named in the task live in different JSX parents, so "before the Inbox list" could not be a sibling swap — they chose moving it into the main column (option A) over reordering within the rail.

Three adaptations beyond the raw move: wrapper <div> → <section> to match the sibling bands in that column; added `rule` to its SectionLabel so the heading spans the pane and pins the refresh control right, matching the Inbox heading directly below it; and updated the "The free hint above is instant" comment, which encoded the sibling relationship it no longer has.

Verified: format/lint clean, desktop tsc + vite build pass, inbox clustering unit suites 15/15. Visually confirmed via the Playwright harness (a11y snapshot shows "Group into epics" preceding "Inbox" in DOM order; rendered screenshot shows the two headings aligned in the main column).

NOTE FOR REVIEW — the committed Playwright baselines e2e/views.spec.ts-snapshots/braindump-{light,dark}-darwin.png are now stale and must be regenerated (`bun run e2e:update --grep braindump`) on a machine with a clean storefront fixture. I deliberately did NOT regenerate them: unmodified HEAD already fails on this machine by 458px, all of it the env-specific sidebar warning ("Board sync is off" / "dispatch command isn't resolvable" / "Task merge driver not set up", which varied between runs). Updating here would have baked that local noise into the shared baselines. — none
- 2026-08-04T18:24:09.282Z [run r-d5ee92] finished: finished — 1 files, $5.57 — agent:wsoule679/claude
- 2026-08-10T23:57:41.975Z run r-d5ee92 merged outside dispatch (branch dispatch/t-d232c6-reorder-the-jsx-sections-in-braindumpvie-d5ee92 landed on main) — none
