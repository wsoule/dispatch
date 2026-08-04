---
id: e-c88fb6
title: "Supporting screens: Milestones, Sessions, Settings, and the app shell"
status: done
kind: epic
parent: null
milestone: null
blocked-by: []
labels: []
priority: low
assignee: none
created: 2026-07-27T00:55:17.864Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
---

## Description

Bring the remaining screens in the mockup up to the redesign (docs/design/dispatch-nocturne.dc.html - the isMilestones, isSessions, isSettings blocks, plus the sidebar and titlebar at the top of the template). These are smaller than the other epics: each is a restructure of a view that already exists rather than a new surface.

Milestones (MilestonesView.tsx): one row per milestone with its epics, target date, a progress bar with done/total, and a state. An at-risk milestone tints, its date reads as at-risk, and it carries a line naming the actual reason - the mockup's example is "two tasks in this milestone have been waiting on you for over ten minutes", which means risk is derived from run state rather than typed in by hand.

Sessions (SessionsHubView.tsx): a dense table - session id, task, model, turns, tokens, length, ended - where failed and waiting rows tint and finished/killed rows recede. The point is scanning a repo's whole history, including the runs that were killed.

Settings (SettingsView.tsx): grouped fields with the app's existing form primitives - repository path and base branch, agent concurrency, the permission posture as three radio choices, the verify command with a hold-the-queue toggle, and the theme switcher. The permission posture wording in the mockup is worth keeping.

Shell: the sidebar gains a project switcher, badge counts per nav row, and a jump-anywhere hint tied to the existing command palette; the titlebar carries today's spend. Sidebar.tsx already has the nav rows, so this is mostly the badges and the spend readout.

Colors come only from the foundations epic's tokens.

Acceptance criteria:

- Milestones shows progress, target date and state per milestone, and derives at-risk from real run/task state with the reason named
- Sessions is a dense scannable table covering every run including killed ones, with state-appropriate emphasis
- Settings covers repository, concurrency, permission posture, verify command and theme, using existing form primitives and honest copy
- Every setting persists and takes effect
- Sidebar nav rows carry live badge counts that agree with their destinations
- The jump-anywhere hint reflects the real command palette shortcut
- Today's spend appears in the titlebar and can be turned off

## Acceptance Criteria

## Activity
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
