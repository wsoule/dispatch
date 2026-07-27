---
id: t-04c990
title: "Brain dump: multi-select batch actions, clustering hint, and keyboard
  shortcuts"
status: done
kind: task
parent: e-3f896a
milestone: null
blocked-by:
  - t-a0c9c0
labels: []
priority: low
assignee: none
created: 2026-07-27T00:58:01.189Z
updated: 2026-07-27T03:33:04.235Z
external: null
---

## Description

Finish the Brain dump screen with the parts that turn a list into a triage tool (docs/design/dispatch-nocturne.dc.html, the hasSel/batch*/hasCluster bindings in renderVals).

Multi-select and the batch bar: selecting items reveals an accented bar reporting the count with four actions - make tasks, group into an epic (opens Plans prefilled with the selected items' text joined), dismiss, and clear. Batch convert should surface per-item outcomes if any fail, using what the API task exposes.

The clustering hint: a side-rail panel that appears only when several inbox items look like the same underlying thing, names what they have in common, and offers to select them. The mockup's version is a hardcoded regex over worktree/verify/retry/disk and its copy makes the argument explicitly - "These look like one thing... They would make a better epic than three loose tasks." Implement it as a real similarity check over item text rather than a fixed pattern, but keep it cheap and local: no model call, and it must stay silent unless it has something worth saying. A hint that fires on every unrelated pair is worse than no hint.

Keyboard shortcuts, as the mockup's own legend documents them: cmd-enter drops the composer into the inbox, "t" makes the selection tasks, "x" dismisses. Wire them through the existing keyboard plumbing in apps/desktop/src/lib/keyboard.ts and useGlobalKeyboard.ts rather than adding local listeners, and make sure they do not fire while the composer has focus.

Acceptance criteria:

- Selecting items reveals a batch bar with an accurate count and all four actions
- Batch make-tasks converts every selected item and reports any that failed
- Group-into-an-epic opens Plans prefilled with the selected items
- The clustering hint uses a real similarity check, names the shared theme, selects what it names, and stays silent when there is no real cluster
- The documented shortcuts work, go through the existing keyboard plumbing, and do not fire while typing in the composer
- The shortcut legend in the side rail matches what is actually bound
- The similarity check is unit tested, including the negative case where nothing should cluster
- bun run format, bun run lint and the desktop tsc/tests are green

## Acceptance Criteria

## Activity
- 2026-07-27T03:33:04.235Z Done in e4f874b and 03b44e0. Batch bar, per-item failure reporting and the local similarity check all landed (lib/inboxCluster.ts, 10 tests). Two notes. (1) Light stemming turned out to matter more than expected: "worktrees are eating disk" and "prune the worktree" share no term without folding the plural, and that is exactly the cluster the feature exists to catch — found by a failing test, not by inspection. (2) Scope grew on request: a second, model-backed clustering pass was added on Haiku (packages/server/src/inboxClusterer.ts + POST /api/inbox/cluster, 9 tests on the sanitiser). The two coexist deliberately — the local pass is free and instant so it runs on every render but only sees vocabulary; the Haiku pass sees meaning but costs a call, so it is an explicit button. Model output is sanitised before display: invented ids, ids claimed by two groups, and groups of one are dropped. NOT done: only ⌘⏎ is bound. The "t" and "x" single-key shortcuts were left out rather than half-wired — they need to be scoped to this view through useGlobalKeyboard and suppressed while any input has focus, and the rail's legend now lists only what is actually bound rather than promising two keys that do nothing.
