# Universal job runner — design

**Date:** 2026-08-05 **Status:** draft, direction approved

Generalize Dispatch from a code-task orchestrator into a local-first **outcome
runner**: a user describes what they want — "build me an inventory app", "every
Monday compile this report", "when a form submission arrives, do X" — and
Dispatch's existing loop (plan → execute → verify → fix → deliver) carries it
out. Job specs and their full history stay plain files synced by git; for the
new audience, git itself becomes invisible infrastructure.

## Why

Dispatch already is a job runner — a highly specialized one. The pipeline
(planner → executors in git worktrees → verify → fix loops → review → merge
queue → PR) is a universal shape with every stage hardcoded to "change code in a
git repo":

- **Executor** assumes the Claude Agent SDK
  (`packages/server/src/orchestrator/executors/claude.ts`), though the
  `Executor` interface in `packages/server/src/orchestrator/types.ts` is already
  a clean seam — `FakeExecutor` proves it.
- **Workspace** assumes a git worktree cut from the user's repo
  (`orchestrator/worktree.ts`); `ExecutorStartOptions.cwd` is always one.
- **Verification** means build/test/lint (`orchestrator/verify.ts`,
  `fixLoop.ts`).
- **Delivery** means a squash-merge or a PR (`RunMeta.reviewAction`,
  `mergeQueue.ts`, `pr.ts`).
- **Trigger** means a human pressing dispatch. Nothing starts a job on a
  schedule or an event.

None of these couplings is essential to the loop. The assets that make Dispatch
different from cron, CI, Temporal, and n8n all generalize: human-readable
markdown job specs with a ledger, the plan/verify/fix discipline, the daemon +
event stream + desktop dashboard, and git-native storage with no server lock-in.

## Product direction

Decided in discussion (2026-08-05):

- **Audience: technical non-devs first.** PMs, analysts, writers — comfortable
  with an app, not with git. Developers keep everything they have today; the
  non-dev experience is a layer on top, not a fork.
- **Job types: all of them.** Agent jobs (outcome described, agent plans and
  executes), scheduled/recurring jobs, arbitrary command jobs with logs and
  retries, webhook/event-driven jobs — and, as the headline promise, "everything
  a non-coder needs to build and run an app".
- **Executors: pluggable, Claude default.** The executor contract is formalized
  so shell commands and other agent CLIs can implement it; Claude Code stays the
  polished first-class default.

The concepts a non-dev sees are **projects, jobs, runs, and checkpoints** —
never branches, worktrees, or PRs. "New Project" silently creates and manages a
repo; the merge queue and review pipeline become the internal mechanism behind a
checkpoint/restore UX.

## Decisions

1. **The job spec stays a markdown file.** Jobs are tasks: `TaskMeta`
   (`packages/core/src/types.ts`) grows optional fields (schema below) rather
   than a parallel "job" document type. A task file without the new fields means
   exactly what it means today, so every existing tracker is already valid.
2. **Generalize by extracting seams, not by rewriting.** Executor, workspace,
   verification, and delivery each become an interface whose first
   implementation is the current behavior. The existing pipeline becomes the
   "code job" profile of a general loop.
3. **Triggers land in the daemon.** `dispatchd` is already long-lived; it gains
   a scheduler (cron-style), a file watcher, and — last — webhook intake. Public
   webhooks require a hosted relay (a local daemon has no ingress), which is
   deliberately the final trigger shipped.
4. **Unattended runs get a declared-scope trust model.** Scheduled and
   event-driven jobs run with nobody watching, and agents will author
   automations on the user's behalf. A job declares what it may touch (folders,
   credentials, network); anything outside that pauses the run via the existing
   approval flow (`ApprovalDecision`, `RunState 'awaiting-approval'`) instead of
   proceeding. The task ledger is the audit trail.
5. **"Done" for an app means an agent used it.** For the non-dev audience,
   verification cannot stop at "tests pass": the browser-automation
   infrastructure (`packages/core/src/browser.ts`, Playwright tooling) is
   promoted into a first-class verifier that exercises the running app before a
   run may deliver.
6. **Running the result is a pillar.** An app-building job dead-ends at "the
   code exists" unless Dispatch also starts/stops the dev server, shows a live
   preview in the desktop app, and eventually offers a deploy path.
7. **`packages/web` stays frozen.** All new UI work happens in `apps/desktop`,
   per the existing convention.

## Job spec schema

New optional frontmatter on the task file. Every field has a default that
reproduces today's behavior, so the schema is purely additive:

| Field       | Values                                                                      | Default (today's behavior) |
| ----------- | --------------------------------------------------------------------------- | -------------------------- |
| `job`       | `code` \| `agent` \| `command` \| `app`                                     | `code`                     |
| `trigger`   | `manual` \| `cron:<expr>` \| `watch:<glob>` \| `webhook:<name>`             | `manual`                   |
| `executor`  | registry id (`claude`, `command`, …)                                        | `claude`                   |
| `workspace` | `worktree` \| `dir:<path>` \| `none`                                        | `worktree`                 |
| `verify`    | list: commands, checklist items, `agent-judge`, `browser:<check>`           | build/test/lint            |
| `deliver`   | `merge` \| `pr` \| `checkpoint` \| `files:<path>` \| `artifact` \| `notify` | review flow (merge/pr)     |
| `scopes`    | folders/credentials/network a run may touch unattended                      | none (attended runs only)  |

Two sketches:

```yaml
# Weekly report — agent job, no repo surface at all
job: agent
trigger: 'cron:0 8 * * 1'
workspace: none
verify: [agent-judge]
deliver: 'files:~/Reports'
scopes: { network: ['api.example.com'], folders: ['~/Reports'] }
```

```yaml
# Non-dev app project — the headline case
job: app
trigger: manual
workspace: worktree # hidden repo, managed by Dispatch
verify: ['browser:signup-flow-works', 'bun test']
deliver: checkpoint
```

## Interfaces

- **Executor** — the existing interface
  (`Executor`/`ExecutorRun`/`ExecutorEvents` in `orchestrator/types.ts`)
  survives nearly unchanged; it was designed as this seam. Work needed: an
  executor registry keyed by the `executor` field, `ExecutorStartOptions.cwd`
  generalized to a workspace handle (nullable for `workspace: none`), and a
  `CommandExecutor` that runs a process and streams its output as
  `NormalizedEntry` rows — proving the contract holds for non-agent backends.
- **WorkspaceProvider** — `prepare(job) → { path? }`, `checkpoint()`,
  `cleanup()`. Implementations: `worktree` (current `WorktreeManager`), `dir`,
  `none`. `RunMeta`'s worktree-specific fields (`branch`, `worktreePath`,
  `survey`) become provider-owned.
- **Verifier** — `verify(run) → findings`. Implementations: command runner
  (current verify/fix loop), checklist, agent-judge, browser check. The fix loop
  itself is generic once findings are; it re-dispatches regardless of which
  verifier produced them.
- **Deliverer** — `deliver(run) → outcome`. Implementations: merge/PR (current
  review pipeline), checkpoint (squash-merge into the hidden repo's main,
  surfaced as a named restore point), files, artifact, notification.
- **TriggerScheduler** — daemon-side. Watches job files for `trigger` fields,
  fires dispatches, records every firing in the ledger. Missed-schedule policy
  (daemon was asleep) is an open question below.

## Phases

**A — extract the seams (invisible refactor).** Introduce the four interfaces
with current behavior as the only implementations; add the schema fields with
defaults; no user-facing change. De-risks everything after and can ship
piecemeal.

**B — jobs that aren't code changes.** `agent` jobs with `workspace: none` and
files/artifact delivery; `command` jobs with logs, retries, and history in the
existing runs UI. Proves the abstraction before any UX investment.

**C — triggers.** Cron scheduler in the daemon first, then file watchers,
webhooks last (needs the relay design — a separate spec when we get there).
Ships with the `scopes` trust model, which unattended execution makes mandatory.

**D — the non-dev app experience.** Hidden-repo projects, project templates,
checkpoint/restore UX, live preview with dev-server lifecycle management,
secrets vault, deploy integration. Lands on top of A–C rather than being blocked
by them.

Phases A–C make the product better for the current developer audience while
building the substrate, so D is an additive layer, not a rewrite.

## Hard problems flagged early

- **Webhook ingress.** The first component that cannot be purely local-first.
  Options (relay service vs. polling adapters vs. tailscale-style tunnels) need
  their own spec; nothing in phases A–C depends on the choice.
- **Quality ceiling on "non-coders build apps".** Several products have made
  this promise and under-delivered. Dispatch's edge is the verify/fix-loop
  discipline; the credibility hinges on decision 5 (browser verification gates
  delivery), not on better prompts.
- **Secrets.** Scheduled jobs calling external APIs need credentials stored
  outside the repo (`packages/core/src/credentials.ts` is the seed), with a UI a
  non-dev can use and scope-based release to runs.
- **Missed schedules.** A laptop daemon sleeps. Per-job policy — fire on wake,
  skip, or coalesce — with "fire on wake, once" as the likely default.

## Non-goals

- Not a DAG/workflow engine — no cross-job dependency graphs beyond the existing
  `blockedBy`.
- Not hosted CI; execution stays on the user's machine. The webhook relay, if
  built, forwards events and nothing else.
- No multi-tenant server. Team sync remains git-based, as today.

## Open questions

1. Naming: does "task" survive as the user-facing word for a job, or do tasks
   (outcomes) and jobs (their standing definition, e.g. a schedule) split?
2. Where does the hidden repo for non-dev projects live, and does it ever get an
   origin remote (backup/sync story for people who don't have GitHub accounts)?
3. Executor plugin distribution: compiled-in registry first, but is there a path
   to third-party executors without loading arbitrary code into the daemon?
