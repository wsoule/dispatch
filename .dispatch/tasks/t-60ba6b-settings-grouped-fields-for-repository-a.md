---
id: t-60ba6b
title: "Settings: grouped fields for repository, agents, verify and appearance"
status: todo
kind: task
parent: e-c88fb6
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:02:30.099Z
updated: 2026-07-27T01:02:30.099Z
external: null
---

## Description

Reshape apps/desktop/src/views/SettingsView.tsx to the mockup's version (docs/design/dispatch-nocturne.dc.html, the isSettings block), using the app's existing form primitives in apps/desktop/src/ui/ rather than new ones.

Four groups under uppercase tracked labels, in a single readable column. Repository: path and base branch. Agents: how many may run at once, then the permission posture as three radio choices - always ask me first, ask once per session then remember, never ask and let it run. Before anything lands: the verify command, plus a checkbox to hold the merge queue when verify fails. Appearance: light / dark / follow the system.

Two things to carry over deliberately. The permission posture wording is better than the usual jargon - it says what happens rather than naming a mode - so keep it, and make sure it agrees with the approve-for-this-session behavior in the run detail epic. And the page subtitle, "Local to this machine. Nothing leaves it.", is a real claim about where settings live; keep it only if it is true, and fix the wording if it is not.

Every control must persist and take effect. A settings screen where a control looks set but does nothing is worse than not having the control.

Colors from tokens only.

Acceptance criteria:

- Four groups render with the app's existing form primitives, in one readable column
- Repository path and base branch persist and are validated
- Concurrency persists and is respected by dispatch
- The three permission postures persist, take effect, and agree with approve-for-this-session in run detail
- The verify command and hold-the-queue-on-failure setting persist and are honored by the merge queue
- The theme switcher works for all three options including follow-the-system
- The "local to this machine" claim is accurate or the copy is corrected
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
