# Remaining Lovable workstreams: lens, policy, front doors, sharing, hosted

Status: working spec, 2026-08-22. Companion to `lovable-direction.md` (the
agreed direction) — this doc decomposes what that direction left unfiled into
epics and tasks, and records one reconciliation against an older epic. Epic ids
are filled in at the end of each section.

## Already filed (2026-08-22 planning discussion)

The same-day planning-engine discussion produced five epics that cover part of
the direction:

- `e-99e113` Storage spine: daemon-owned SQLite in dispatchd, git receipts
  outside the project repo, `.dispatch/` shrinks to committable config.
- `e-be4827` Planning hierarchy: initiative → project → milestone (today's epic,
  renamed and dated) → task; native, Linear-syncable.
- `e-4ba988` Layered agent memory at initiative/project/milestone.
- `e-ba8bf1` Planning queue: weighted scoring, transparent ranking, human pull.
- `e-a27691` Preview per run — cell 1 of the lovable doc.

## Reconciliation: storage spine supersedes the store-repo mechanism

`e-5434b7` (shared team runtime) carries a 2026-08-10 amendment that
externalizes all of `.dispatch/` into a dedicated git repo on code.storage —
"tasks are markdown in _a_ git repo — its own one." The 2026-08-22 storage
decision supersedes that **mechanism**: locally, state lives in a daemon-owned
SQLite store with git receipts; git stops being the sync layer.

The epic's **goal** stands unchanged — sessions leave the machine, the team sees
what happened and where to resume. Its mechanism becomes: a hosted TaskStore
implementation backed by code.storage behind the same seam the SQLite store
uses. Consequences the amendment already accepted still hold (boardSyncer
superseded, task state no longer branch-scoped, solo/team as the open-core
line). `e-5434b7` is now blocked by `e-99e113`.

## Lens: builder and engineer presentation modes

Per `lovable-direction.md`: lens is which surfaces you see — `builder` (prompt
box and live preview are the stage) or `engineer` (board, diffs, findings, merge
queue; preview docked beside the diff). Decisions already made there:

- Lens is **per-project**, set by which front door created the project (prompt →
  builder, cloned repo → engineer).
- A settings escape hatch switches lens any time; both lenses read the same
  state, so switching migrates nothing.
- Mixed teams (different members, different lenses, same project,
  simultaneously) are explicitly not designed for.

Scope here is the _decomposition_: a lens field on the project, an engineer
preset that is exactly today's UI, and a builder shell whose stage is the prompt
box plus preview. The builder shell ships empty-but-real: the front-door epic
fills it. Epic: `e-3a6884`.

## Builder front door, locally (cell 2)

The empty/first-run state becomes a single prompt box — "what do you want to
change?" — over the existing planner (`orchestrator/planner.ts` in
packages/server), showing the proposed task graph inline, dispatching on
confirm. Mostly information architecture over machinery that exists; no Modal,
no code.storage. This is the free tier's viral surface.

Decisions:

- The prompt box **files real tasks** through the normal store — a builder
  project's work is inspectable from the engineer lens with zero translation.
- The proposed-graph preview shows what will be created (milestone + tasks,
  writes, order) and dispatches only on confirm — autonomy stays scoped and
  recorded, the anti-Lovable property we keep.
- After dispatch, the preview (from `e-a27691`) is the stage; progress reads as
  the app changing, not as a board.

Epic: `e-16ef06`, blocked by the lens epic and the preview epic.

## Policy: autonomy with receipts

Per the direction: policy is what the agent may do without a human gate —
per-project, shared, visible in both lenses. Gates demote from _blocking_ to
_recording_, with every decision still landing in the ledger, findings, and
evidence trail. A small **irreversibility floor** always stays blocking
regardless of policy: force-push, deletes outside declared `writes`, spend above
the budget cap.

Proposed autonomy ladder (the slider's stops — to be settled by the design task
before implementation):

1. **Review everything** — every gate blocks (today's strictest behavior).
2. **Auto-accept scope** — scope/writes-extension requests auto-approve and
   record; review and merge still block.
3. **Auto-verify** — verify failures auto-retry through the fix loop up to the
   round cap; merge still blocks.
4. **Auto-merge on green** — merge queue lands green runs; humans review
   receipts after the fact.

Builder preset defaults to 3; engineer preset defaults to 2; both surface the
same underlying config (builder as a slider, engineer as the full gate table).
Epic: `e-ad1978`.

## Shareable run URLs

`dispatch share <runId>` → a static, self-contained, read-only page of the run:
transcript, diff, findings, rulings. Highest perceived-Lovable per unit of
engineering; no hosting dependency — the output is a file you can host anywhere
or hand to anyone. Epic: `e-dff6d3`, independent and unblocked.

## Hosted Builder (cell 3)

Promote `apps/demo` to a product: repo in code.storage (created from a prompt,
or cloned in via GitHub App + sync), agent runs in Modal sandboxes, preview
proxied same as local. Builder sessions hold a persistent sandbox with a live
dev server; the free-tier cap is sandbox-minutes. `__DISPATCH_DEMO__`
generalizes to `__DISPATCH_HOST__`; the `isTauri()` fallbacks complete (registry
→ server-side project list, native dialog → repo picker, editor/Finder actions →
hidden).

Open questions from the direction doc become design tasks inside the epic rather
than blockers on filing it: hosted identity (accounts, GitHub App scopes,
per-user vs platform keys, billing) and Modal specifics (image strategy,
snapshot/hibernate, cost per free-tier minute).

Epic: `e-2a8f00`, blocked by the builder front door, the storage spine (the
hosted TaskStore rides its seam), and coordinated with `e-5434b7` for the
code.storage backend.

## Hosted Engineer (cell 4)

The full board/review/merge-queue surface over hosted backends, ephemeral
per-run sandboxes, roles, centralized billing. The paid tier and the last thing
built. Filed thin — a single design task — because everything about it depends
on what Hosted Builder and the shared team runtime learn. Epic: `e-e2d9c0`,
blocked by Hosted Builder, `e-5434b7`, and `e-ff5a2c`.

## Audit amendments (2026-08-22)

An audit of the filed board against the goal — "use it with my team, localized,
better than Linear" — produced four changes:

1. **Team-local mode** (`e-5f3530`, blocked by the storage spine): the plan as
   first filed made Dispatch _more_ local (per-machine SQLite, dispatchd on
   127.0.0.1, single-user) while the only team story was the hosted tier, last
   in the build order. This epic is the near-term team product: one shared
   dispatchd on a machine the team can reach, per-user tokens over the existing
   two-tier auth, the desktop web bundle served to browsers, presence and
   per-user attribution. The hosted tier later generalizes it.
2. **Notification center** (`e-6cfcc7`, unblocked): nothing answered "what do
   humans need to decide next" (evidence: inbox `^in-1149a8`). A daemon decision
   feed — pending gates, agent input requests, exhausted fix loops, stalled runs
   — with an in-app center plus OS/webhook delivery. The policy epic's
   blocking-vs-recorded split later becomes this feed's filter.
3. **Queue v0 first** (`t-06e1b0`; the queue epic is no longer blocked by the
   hierarchy): urgency, unblocking value, and age exist in today's store, so the
   scoring core, queue view, and pull dispatch ship against them now. The full
   scoring task adds project rank, initiative rank, and due-date proximity when
   the hierarchy lands — same function, more factors.
4. **Legacy `milestone` field**: tasks already carry a free-text `milestone`
   ("grouping above epics" — the opposite of the new milestone-below-project).
   Recorded on the entity-model and migration tasks: distinct legacy values seed
   projects, the field is retired at the end of the migration.

## Build order

Three independent starting points exist today: the storage spine (`e-99e113`),
preview per run (`e-a27691`), and the notification center (`e-6cfcc7`) — joined
by queue v0 (`t-06e1b0`), shareable run URLs (`e-dff6d3`), and the lens
decomposition (`e-3a6884`) as cheap parallel work. Then:

```text
storage spine ─┬─ team-local mode (e-5f3530 — when the team starts using it)
               ├─ planning hierarchy ─┬─ memory
               │                      └─ queue v1 (full factors)
               ├─ shared team runtime (e-5434b7, mechanism updated)
               └────────────┐
lens ── builder front door ─┴─ Hosted Builder ── Hosted Engineer
preview ──┘                                   (also ← e-5434b7, e-ff5a2c)
queue v0, policy, notifications, share URLs (independent, start any time)
```
