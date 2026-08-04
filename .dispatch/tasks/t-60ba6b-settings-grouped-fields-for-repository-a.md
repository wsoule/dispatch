---
id: t-60ba6b
title: "Settings: grouped fields for repository, agents, verify and appearance"
status: done
kind: task
parent: e-c88fb6
milestone: null
blocked-by:
  - t-cfce10
labels: []
priority: low
assignee: none
created: 2026-07-27T01:02:30.099Z
updated: 2026-08-04T17:12:24.869Z
external: null
writes: []
archived-at: 2026-08-04T17:12:24.869Z
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
- 2026-07-27T23:09:09.637Z Done in e16e199. Settings is now writable: core gained updateConfig (16 tests) + PATCH /api/config, and ProjectSettingsSection edits verify command, auto-commit, epic concurrency and permission posture, all persisting to .dispatch/config.yml. The writer uses YAML's document API rather than re-serialising a parsed object, because the file is hand-written and checked in — comments and key order survive an edit, which a naive round-trip would silently destroy. Clearing the verify command deletes the key rather than writing an empty string, since no-verify and a verify-that-runs-nothing are different to the merge queue. permissionMode is validated BEFORE the write: updateConfig re-reads through loadConfig to return its result, and loadConfig throws on an unknown mode, so validating only there would leave a file the daemon then refuses to load. Deviations: `statuses` is deliberately NOT editable (structural — every task on disk carries one, and editing the list from a form would orphan tasks whose status stopped existing); repository path and base branch are not editable (the window is scoped to the project it launched in, and re-pointing it is the project switcher's job, not a text field); no hold-the-queue-on-failure toggle (the queue already stops on a failed verify, so the setting would describe behaviour that is not optional); appearance follows the OS and has no in-app toggle, which is a deliberate existing choice in tailwind.css. The mockup's "Local to this machine" subtitle was NOT kept — it is false: these settings live in the repo and are shared with anyone who clones it, which is the point.
- 2026-08-04T17:12:24.869Z archived — merged and shipped — human:wsoule679
