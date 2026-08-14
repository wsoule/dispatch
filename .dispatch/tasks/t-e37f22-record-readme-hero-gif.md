---
id: t-e37f22
title: Record README hero GIF
status: todo
kind: task
parent: null
milestone: null
blocked-by: []
labels:
  - docs
priority: medium
assignee: none
created: 2026-08-14T00:36:06.858Z
updated: 2026-08-14T00:36:06.858Z
external: null
writes: []
---

## Description

Capture and place the README hero GIF that Task 2 of the README rewrite
(docs/superpowers/plans/2026-08-11-readme-rewrite.md) could not record in
this shell: Chrome MCP's browser extension was not connected and the
repo's agent-browser CLI is not installed here, so the capture path was
unreachable (not merely flaky).

\## Steps (from the original Task 2 brief)

1. Stage a believable project: use `.agents/ignore/gen-demo.py` (main repo)
   or `dispatch init` + 4-6 tasks with realistic titles and mixed statuses
   under a scratch directory.
2. Record the loop: open the desktop app (or the browser-dev harness —
   `apps/desktop`'s vite dev server plus a `dispatchd` daemon started with
   `DISPATCH_ENABLE_FAKES=1 DISPATCH_FAKE_APPROVAL=1` against the staged
   project, opened at `?root=<path>&port=<dispatchd port>`) and record:
   create task -> dispatch -> agent output streaming -> review/findings
   view. Target 15-25 seconds, extra frames before/after actions, window
   ~1280x800.
3. Optimize and place at docs/assets/dispatch-hero.gif, <= 5 MB
   (gifsicle -O3 --lossy=80, fewer frames, or a smaller window if over).
4. Uncomment the hero image line in README.md (currently replaced with
   `<!-- TODO(asset): docs/assets/dispatch-hero.gif -- task -> dispatch ->
   review loop -->`) and remove this TODO once the asset is in place.

## Acceptance Criteria

## Activity
