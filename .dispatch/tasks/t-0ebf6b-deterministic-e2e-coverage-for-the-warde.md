---
id: t-0ebf6b
title: Deterministic e2e coverage for the warden chat flow
status: todo
kind: task
parent: e-1d70ca
milestone: null
blocked-by:
  - t-d4995b
labels: []
priority: medium
assignee: none
created: 2026-08-04T18:06:37.201Z
updated: 2026-08-11T15:39:11.271Z
external: null
writes:
  - apps/desktop/e2e/warden.spec.ts
  - packages/server/src/orchestrator/warden.ts
  - packages/server/src/orchestrator/wardens/fake.ts
---

## Description

Add a fake tool-calling backend (mirrors planners/fake.ts) so the warden flow is testable without a live LLM call, and an e2e spec exercising: open the Warden tab, ask a status question and see the fake's answer, trigger a mutating action, confirm it, and verify the underlying state actually changed (e.g. a fake-dispatched run appears).

Acceptance criteria:

- A fake warden backend produces deterministic turns/pending actions for test mode, without calling the real Claude Agent SDK
- e2e spec covers: opening the tab from the sidebar, a status question/answer round trip, a mutating action's confirm card appearing, and both the approve and deny paths
- Denying a pending action in the e2e test leaves the underlying state unchanged; approving it is reflected elsewhere in the app (e.g. the affected run's state)

## Acceptance Criteria

## Activity
- 2026-08-11T02:31:19.657Z dispatched (claude, branch dispatch/t-0ebf6b-deterministic-e2e-coverage-for-the-warde-6a06aa) — none
- 2026-08-11T02:38:22.959Z Oriented. FakeWarden (wardens/fake.ts) already exists for unit tests; the gap is e2e wiring. Plan: (1) extend FakeWarden so a scripted call's input can derive from earlier results in the same turn (dispatch "first ready task" generically), (2) bin.ts registers a 'fake' warden backend under DISPATCH_ENABLE_FAKES=1 with a default script (status turn answers from list_runs; mutating turns queue dispatch_task of the first ready task with the fake executor), (3) desktop devtool localStorage key dispatch.devFakeWarden makes useWardenSession start conversations with backend:'fake' (mirrors dispatch.devFakeExecutor), (4) playwright daemon gets DISPATCH_ENABLE_FAKES=1 and a new e2e/warden.spec.ts covers tab open → status Q/A → confirm card → deny (runs unchanged, checked via API) → re-ask → approve (run for the seeded task appears in Runs view), then archives the dispatched run so the screenshot fixture stays clean. Note: e2e cannot execute in this agent shell (playwright webserver can't posix_spawn git — see prior runs), so the spec follows the repo's existing convention (edit-diff.spec.ts) of a carefully derived, clearly annotated first-run spec; unit tests + tsc/lint verify everything else. — none
- 2026-08-11T03:14:01.214Z Done, 3 commits (0a9707c5 server fake backend, 3fba31a6 desktop devtool + race fix, 5244bb57 executed e2e spec). Highlights: (1) FakeWarden already existed for unit tests; the new pieces are bin.ts registering it under 'fake' on DISPATCH_ENABLE_FAKES=1 with a default script (status turn answers from a real list_runs read; mutating turns queue dispatch_task of the first ready task on the fake executor — FakeWardenCall.input can now be a function of earlier results in the turn, so no fixture ids are hard-coded), and a dispatch.devFakeWarden localStorage devtool that routes new conversations to it. (2) Unlike edit-diff.spec.ts, warden.spec.ts was actually EXECUTED here: I seeded the storefront fixture fully locally (local bare origin — never touched the real GitHub remote demo reset pushes to), booted daemon+vite by hand, and let playwright reuse them. It passed twice back-to-back; light project is skipped by design. (3) First execution caught a real UI race: a turn settling before POST /api/warden resolves broadcasts warden.changed into a not-yet-mounted query, so the transcript hung on the spinner forever — fixed in useWardenSession by invalidating the record key after each mutation write (mutation-tested: reverting it fails the e2e; reverting the FakeWarden input resolution fails the new unit test). (4) Cleanup restores everything the screenshot suite pins: created run review-discarded (the overview feed counts even archived runs while reviewedAt is unset — archive alone leaked '5 Needs review' to 8), archived, task PATCHed back to todo; ribbon counts re-verified intact afterward. Also set playwright workers:1 — every spec file shares one daemon, and my spec temporarily bumps counts views.spec asserts. Pre-existing unrelated failure noted: apps/desktop webkitFloor.test.ts expects the old string-form cask floor while a382a4a5 switched release.yml to symbol form. — none
- 2026-08-11T03:14:20.289Z [run r-6a06aa] finished: finished — 7 files, $42.09 — agent:wsoule679/claude
- 2026-08-11T15:33:58.384Z merge queue: run r-6a06aa restacked onto dispatch/t-6f0378-client-api-bindings-for-warden-3d4e52 after blocker run r-0faef1 merged (via git rebase --onto) — none
- 2026-08-11T15:39:11.271Z run r-6a06aa discarded — human:wsoule679
