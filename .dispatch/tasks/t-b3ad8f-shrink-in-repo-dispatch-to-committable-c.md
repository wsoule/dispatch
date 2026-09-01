---
id: t-b3ad8f
title: Shrink in-repo .dispatch/ to committable config only
status: in-progress
kind: task
parent: e-99e113
milestone: null
blocked-by:
  - t-9d89bb
  - t-880ce2
labels: []
priority: medium
assignee: none
created: 2026-08-22T16:39:15.687Z
updated: 2026-09-01T18:10:53.079Z
external: null
writes:
  - packages/core/src/**
  - packages/core/test/**
  - packages/cli/src/**
  - packages/cli/test/**
  - packages/server/src/**
  - packages/server/test/**
  - packages/mcp/src/**
  - packages/mcp/test/**
  - packages/client/src/**
  - apps/desktop/src-tauri/src/**
  - apps/desktop/src/**
  - docs/**
  - README.md
  - .gitignore
---

## Description

Once the DB is the source of truth and receipts live outside the repo, the project's .dispatch/ carries only genuinely-committable config (config.yml, team.yml). Stop writing tasks/, findings.jsonl, ledger.jsonl, fix-loops.jsonl, notes.json, and inbox/ into the repo; the import task already moved their contents. Update init/docs/README so the "tasks are markdown files in your repo" story becomes "your repo holds config; state lives in the daemon with git receipts."

## Acceptance Criteria

## Activity
- 2026-09-01T16:11:44.563Z dispatched (claude, branch dispatch/t-b3ad8f-shrink-in-repo-dispatch-to-committable-c-59aae9) — human:wsoule679
- 2026-09-01T16:14:49.677Z Orientation done. State of the repo before I change anything: on the sqlite backend the daemon ALREADY stops writing tasks/, findings.jsonl and ledger.jsonl into the project — startServer selects stores.records.findings/ledger over the JSONL stores, skips watchTasks (no tasksDir), and skips the BoardSyncer (its comment already defers to the receipts exporter). So the "stop writing" half of this task is largely landed by t-c6dbd3. What is genuinely left: (1) the leftovers — the import is non-destructive by design, so 192 files are still tracked under .dispatch/ with nothing removing them; (2) fix-loops.jsonl, notes.json and inbox/ are still written into the repo unconditionally on BOTH backends (FixLoopStore/NoteStore/InboxStore take rootDir and have no backend seam), so the task's premise that "the import already moved their contents" is false for exactly those three — the epic ledger flags this and warns that deleting them would lose them outright; (3) `dispatch init` still scaffolds .dispatch/tasks and leaves the project on the files backend, so a new project does not get the new story at all; (4) docs/README still lead with "Tasks live in your repo. Every task is a markdown file in .dispatch/tasks/*.md". Also noted: .dispatch/dispatch.db* and storage.json are gitignored in THIS repo by hand, but nothing ships that ignore rule to a user's project, and index.ts's comment calls storage.json committable while this repo's .gitignore excludes it — those two disagree. Asking the human to settle retire-vs-leave, what happens to the three file-only stores, and whether init should default to sqlite before I write code. — none
- 2026-09-01T17:49:01.861Z Done, 3 commits (b0659ce7 core, 88ebf520 cli, 860e800e docs). WHAT SHIPPED. (1) retireLegacySources + `dispatch migrate --retire`: deletes .dispatch/tasks, findings.jsonl and ledger.jsonl, but only what the receipt log already holds, checked SOURCE->LOG per record on the JSONL compaction key (id + createdAt, so a re-created id is not covered by its namesake). Refuses on a file-backed project and with no receipt log; keeps and explains any source that fails rather than aborting; refuses while dispatchd runs, because the receipt exporter runs inside it. (2) ensureProjectGitignore writes .dispatch/.gitignore from initProjectStores (so the desktop add-project path gets it too), topping up rather than rewriting. (3) `dispatch init --db`. (4) README/docs rewritten around the two backends. VERIFIED END TO END, not just unit-tested: in a throwaway repo with its own DISPATCH_HOME I ran init -> 2 tasks -> migrate -> real daemon export -> retire, and `git add -n .dispatch` then listed exactly .gitignore, config.yml, storage.json, team.yml. The daemon exported to projects/41238c502f96/receipts — the same path core's new receiptLogDir had named in the earlier refusal, so the two independent hash schemes agree.

TWO BUGS FOUND BY RUNNING IT RATHER THAN READING IT. Both were invisible to unit tests. (a) Nothing ever shipped a gitignore rule for dispatch.db to a USER's project — this repo has one hand-written in its root .gitignore, which is precisely why the gap survived: every developer working on Dispatch was covered and every project using Dispatch was not. A migrated project would commit its database, -wal and -shm on the next `git add .`. (b) initIfMissing decided "already initialized" by testing for the .dispatch/tasks DIRECTORY, so every `dispatch init` and every bare `dispatch` in a database-backed project re-created an empty markdown board beside the database — silently undoing a --retire I had just run, then printing "create your first task with: dispatch task create", which on that backend fails with DAEMON_REQUIRED. Fixed in 88ebf520.

BLOCKER TO REPORT: SCOPE DENIED. I requested packages/cli/test/** and nobody decided in time, so it came back denied. I kept every guard in packages/core (21 new tests, 5 mutation-tested — each guard reverted individually and each killed at least one test) and left the CLI a thin terminal, which is already this codebase's pattern for migrate. What is therefore NOT covered by a test: the --retire flag wiring, the daemon-running refusal, and `init --db`'s two branches. I exercised all of them by hand against the built CLI (evidence recorded) but that is not a regression net. Knock-on: knip failed on runRetire as an unused export, and since suppressions are not acceptable here I un-exported it rather than adding an ignore — the comment above it says to export it again when the test lands. runMigrate beside it stays exported precisely because migrate-cmd.test.ts imports it.

THREE THINGS I DELIBERATELY DID NOT DO, with reasons in ledger l-7dfa5b so they are not re-derived. (1) `dispatch init` still defaults to FILES. I intended to flip it and stopped: resolveTaskRoute discovers a daemon with findRunningDaemon and never ensureDaemon (deliberate — "a read should not leave a background daemon running behind it"), and task.ts:154 throws DAEMON_REQUIRED for a db-backed project with no daemon. So defaulting to sqlite would make the README quickstart fail on its own second line. The real blocker is that the database backend has no no-daemon read path; that is a product decision, not plumbing. (2) fix-loops.jsonl / notes.json / inbox/ stay in place. The t-880ce2 decision already scoped porting them out as unowned work, and the inbox is deliberately hand-editable ("the cheapest possible capture is opening the file in your editor and typing a line") — a sha256-keyed path under the home directory destroys that, which is a UX call, not plumbing. They are gitignored on the sqlite backend instead, which gets the epic's stated goal (no churn in project diffs) without moving a file anybody types into. (3) storage.json stays committable, following index.ts's comment rather than this repo's own root .gitignore, which disagrees with it — on a retired project the marker is the only thing telling a fresh clone "this board is in a database, restore it from the receipt log" instead of "never initialized". If anyone flips that, flip index.ts's comment in the same commit.

NOTE ON THIS REPO: it is still file-backed, so nothing here changed. Its own 192 tracked files under .dispatch/ come off only when someone runs `dispatch migrate` then `dispatch migrate --retire` on it deliberately. — none
- 2026-09-01T17:49:22.402Z [run r-59aae9] finished: finished — 10 files, $15.35 — agent:wsoule679/claude
- 2026-09-01T18:10:53.079Z requested changes (run r-525b9f): Code review: 17 confirmed/plausible findings. The task fence has been WIDENED (verify via the canonical task file) to include packages/server, mcp, client, apps/desktop/src-tauri, and .gitignore — several fixes need them. REQUIRED before merge, ranked:
1. cli daemon.ts:395/422 — dispatch serve and ui still gate on file-only requireStore, so a db-backed project can NEVER start the daemon it is required to use (total dead end). Wire in requireInitialized() like orchestrate/plan/scope got.
2. sidecar.rs:891 — the desktop's needs_init() keys on .dispatch/tasks existing (permanently false on sqlite), so every app launch kills the healthy daemon (force-failing live runs) and respawns with --init. Make needs_init backend-aware (storage marker or db presence).
3. retire.ts:280 — --retire deletes a git-shared board after verifying against a LOCAL-ONLY receipt log, then tells the user to commit; teammates pull an empty board. Add a team-safety gate: refuse when the repo has a remote unless an explicit --force-solo (or equivalent) is passed, with wording that names the teammate hazard. Reconcile with the marker design coherently: storage.json stays GITIGNORED (per t-880ce2's clone-trap fix — the review's cut finding notes the repo's .gitignore contradicts the committable-marker language in the retire report; gitignored/local is the decided direction, fix the report text).
4. index.ts:518 — boot import writes the sqlite marker even when the import reported problems, stranding failed records; mirror runMigrate's problems.length guard.
5. index.ts:436 — 'already migrated' guard keys on tasks count only, so findings/ledger JSONL appended later (git pull) are never imported and blocked findings go invisible to the merge gate; the import is idempotent — run it whenever hasLegacyState, or key the guard per record type.
6. receipts.ts:354 — nothing writes the evidence/mutations tables (orchestrator writes transcripts), so the log's evidence half is dead code and the README's rebuild claim is false; either wire recordEvidence/recordMutation through to the DB stores on the sqlite backend, or export evidence FROM transcripts, or correct the README + remove the dead sweep — pick one and say which in the task Activity.
7. task.ts:389 — filtering archived tasks BEFORE readyTasks makes graph.ts treat a missing blocker as satisfied, so archiving an unfinished blocker springs its dependents ready (CLI, MCP, and daemon route all affected). Filter archived from the CANDIDATES, not from the blocker-resolution set.
8. index.ts:436 — boot gate calls throwing list() instead of listSafe(); one damaged row kills daemon boot with no fallback. Use listSafe.
9. mcp tools.ts:437 + cli apiClient.ts:205 — a daemon dying between health probe and request surfaces as a raw TypeError with no local fallback on file-backed projects; catch fetch rejection and fall back like taskComment does.
10. client api.ts:1227 + server api.ts:897 — GET /api/sync claims a false 'disabled… needs restart' on sqlite projects; add the receipts field + receipts.export event to the client types and make SyncChip render receipts state instead of the false error.
ALSO (verified, cut for cap — fix if quick): timeout on the daemon health fetch (hang on stale port); failed migrate must not pre-append sqlite rules to .dispatch/.gitignore before success; task show daemon-vs-file byte drift; edit --add-label read-modify-write against the stale cache; receipts-dir path scheme triplication with diverged hash inputs (resolve() vs raw) — unify in core.
Run core+cli+server+mcp tests and cargo check for the sidecar change, commit. — human:wsoule679
