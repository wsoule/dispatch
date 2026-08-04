# Demo Environment

A live, driveable demo of every capability Dispatch gained between 2026-08-02
and 2026-08-04: team identity, board sync, carto, the review surface, findings,
the fix loop, verification evidence, scope requests, the git panel, per-project
Linear keys, and the rebuilt settings and chrome.

## Purpose

Wyat drives this demo himself, in front of someone, without a script he can be
knocked off. That sets the bar: every screen has to look populated when asked
for out of order, and the pieces that move — a run, the sync chip, a merge —
have to genuinely move rather than be narrated.

An existing fixture (`.agents/ignore/gen-demo.py`, 2026-07-28) seeds a
"storefront" project with 12 tasks, an inbox, and 8 run transcripts. It predates
every feature above and its project is a bare README. This design keeps its
narrative and replaces its mechanics.

## Non-Goals

- Not a repo other people clone and boot. Setup may assume Wyat's machine.
- Not a recorded walkthrough. No fixed narrative ordering is enforced.
- Not a test fixture. The desktop e2e fixture stays separate and untouched.

## Architecture

Four artifacts:

| Path | Role |
| --- | --- |
| `github.com/wsoule/storefront` | public repo: storefront code plus committed `.dispatch/` state |
| `.agents/ignore/storefront/` | Wyat's clone — the project the daemon runs against |
| `.agents/ignore/storefront-home/` | isolated `DISPATCH_HOME`: run transcripts, actor identity |
| `.agents/ignore/teammate/` | second clone plus second `DISPATCH_HOME` — the puppet |

The split follows what Dispatch actually syncs. Shared board state — tasks,
`team.yml`, `findings.jsonl`, `ledger.jsonl`, per-actor inboxes — is committed
and is what the board syncer moves between clones. Run transcripts and actor
identity live under `DISPATCH_HOME`, keyed by `sha256(rootDir)[:12]`, and never
sync. The teammate therefore needs its own `DISPATCH_HOME`, not merely a
different git author, or it has no identity and no run history of its own.

Everything generated stays under `.agents/ignore/`, which is gitignored, so no
step can touch a real checkout.

## Components

### 1. Storefront codebase

Real Bun + TypeScript. `bun test`, `bun run tsc`, and `bun run lint` must all
pass on a clean checkout — the verify panel, the fix loop, and the merge gate
show real output or they show nothing.

- `src/cart/` — `CartProvider` holding state in localStorage, the defect
  `t-2e91aa` moves to the session store
- `src/search/` — tokenizer, ranking, index; the hyphen bug is already fixed, so
  `t-0c9b88` is a `done` task with a merged run behind it
- `src/checkout/` — discount validation on the client, the defect `t-3f8a21`
  moves server-side
- `src/db/`, `src/server/` — imported by several of the above

The import graph is load-bearing. Review scope is computed from reverse
dependents, so `src/db/client.ts` needs multiple importers for blast radius to
be non-trivial. A flat repo of unrelated files makes carto and the built-in
scanner return identical empty answers, hiding the reason carto exists.

Which defects live where follows each task's status, and the generator builds
branches accordingly:

- `done` tasks (`t-0c9b88`, `t-71ff03`, `t-4e01af`) — fixed on `main`, with a
  merged run behind them
- `in-review` tasks (`t-2e91aa`, `t-58cc03`) — still broken on `main`, fixed on
  their run branch, so the review surface has a real diff to show
- `todo` and `backlog` tasks (`t-3f8a21` chief among them) — broken on `main`
  and untouched, so a live run has genuine work

### 2. Seeded board state

Committed under `storefront/.dispatch/`. Every new format carries realistic
records across its full range, not one example:

- `config.yml` — every new setting non-default: `verifySteps`, `fixLoop.cap` and
  its `escalation` ladder, per-role `models`, `carto.enabled`, the `verify`
  recipe, orchestrator caps
- `team.yml` — three members, so assignees and attribution are visibly plural
- `tasks/*.md` — the existing 12, reassigned across all three actors, with
  `Activity:` lines crediting different actors
- `findings.jsonl` — all three severities across all four verdicts, including
  one `parked` with a written ruling and one `blocked`
- `ledger.jsonl` — one each of `constraint`, `hazard`, `decision`, `handoff`
- `inbox/<handle>.md` — three per-actor inboxes
- `.gitattributes` — merge drivers registered, so a teammate conflict resolves
  field-by-field on a fresh clone

### 3. Seeded run history

Under `storefront-home`, extending the current generator to the run kinds added
this week: a review run with findings anchored to diff lines, a fix loop that
ran three rounds and escalated, a verify run carrying command and mutation
evidence, a granted scope request, a plan draft holding unanswered questions,
and one gracefully stopped run.

Every seeded run must be terminal. `reconcileOnBoot` fails any run left
non-terminal with no process behind it, which is correct behaviour after a
daemon restart and cannot be worked around from static files.

### 4. Teammate puppet

`teammate.ts` drives the second clone. Subcommands fired on cue:

- `claim <task>` — teammate takes a task and pushes; the sync chip lights and
  the assignee changes under Wyat
- `add-task` — a task appears on the board he did not create
- `conflict <task>` — both sides edit different fields of the same task, so the
  merge driver resolves what plain git would have conflicted on

### 5. Live rails

**Carto.** Installed, container built by `dispatch init`, `carto.enabled: on`.
Carto degrades silently to the built-in scanner when the binary is absent, so
`dispatch doctor` reporting graph health green is a pre-flight gate, not a
nicety.

**Linear.** The API key lives in `~/.dispatch/credentials.json`. Only `teamId`,
`statusMap`, and `direction` reach `config.yml`, which holds no secret by
design. This is what makes a public repo safe and is checked before first push.

**Live agent run.** `t-3f8a21`, moving discount validation server-side: small,
self-contained, genuinely broken in the code, labelled `security`, and its
verify steps really run. A pre-recorded transcript of the same task ships in the
fixture as a fallback.

### 6. Operations

**`reset`** — restores the repo, both `DISPATCH_HOME`s, and the remote to a
known state in one command. The demo will be run more than once, and the second
run starts from a board someone already moved.

**`preflight`** — asserts carto green, Linear connected, teammate clone in sync,
and no credentials staged for commit.

## Demo path

Ordered so each stop sets up the next:

1. Task board — colour and glyph pass, chrome primitives. Open a task, edit its
   body in the Pierre editor.
2. Inbox — per-actor. Cluster captures, enrich one into a task.
3. Drafts tray — badge shows a planner waiting. Answer its questions on the
   draft page.
4. Dispatch `t-3f8a21` live. Tool calls stream. Hit Stop; it halts gracefully.
   Redispatch.
5. Review surface — case panel, thread index, verdict footer, findings anchored
   to diff lines as comments.
6. Rule on findings — park one with a reason, block another. The fix loop picks
   them up; show the escalation ladder in Settings.
7. Verify evidence, then the ledger the next agent inherits, then a scope
   request only Wyat can grant.
8. Carto blast radius on `src/db/client.ts`.
9. Git panel — branches, files, stashes, commit composer, diff pane.
10. `teammate claim`, then `teammate conflict`. Finish in Linear.
11. Settings tour, by which point every section means something.

## Risks

- **A live run is unpredictable and costs tokens.** Mitigated by picking a small
  well-understood task and shipping a fallback transcript.
- **Carto and Linear fail quietly.** Both degrade rather than error, so both are
  pre-flight assertions.
- **A public repo plus a Linear key.** The key never enters the repo by design;
  `preflight` asserts it.
- **Concurrent sessions.** Generated state is regenerated, never hand-edited, so
  a stale clone is fixed by `reset` rather than debugged.

## Testing

The generator and puppet are scripts, not shipped code, so the bar is that they
are re-runnable and self-checking rather than unit-tested:

- `reset` followed by `preflight` passes from a cold start
- the seeded board loads with no run showing as failed-on-boot
- `teammate conflict` resolves without a manual merge
- `bun test`, `bun run tsc`, `bun run lint` pass in the storefront clone
