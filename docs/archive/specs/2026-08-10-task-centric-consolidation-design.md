# Task-centric consolidation: retire the Runs and Review pages

## Problem

Run state lives on three surfaces — RunsView, ReviewView, and the expanded
TaskView — and they disagree in feel and navigation. The expanded task view
(TaskView: one task full-window with Details/Chat/Diff tabs) already hosts the
full review surface (`TaskDiffTab` renders `RunReviewView`), so the two pages
mostly duplicate it. Meanwhile the right rail (`MiniOverview`) only appears when
something needs a person, so there is no stable "what is running right now"
surface, and things waiting on a human go unnoticed (a hand-merged run sat NEEDS
REVIEW for six days; a live review agent was invisible after navigating away).

Decisions made with Wyat 2026-08-10: a slim inbox page for "waiting on you"
(option c), a persistent rail of live agents with an attention strip (option b),
and run history folded into the All agents view.

## Design

### Pages

- **Delete `RunsView` and `ReviewView`** — pages and their nav entries.
- **New Inbox view** (slim, list-only): sections _Needs review_ (terminal
  un-reviewed execute runs, from `buildReviewQueue`), _Approvals_, _Questions_,
  _Repo PRs awaiting review_. Rows navigate, never act: reviews open TaskView →
  Diff, approvals/questions open TaskView → Chat, repo PRs open their derived
  task (`derivedFrom: github-pr:<n>`, created on first engagement — existing
  server behavior).
- **All agents absorbs run history**: a History section listing every past run
  (RunsView's job) with state/cost/when, filterable, opening the task expanded.
  Review/verify agent runs appear here too, labeled.

### Rail

Replace `MiniOverview` with a persistent live rail:

- Top: one-line attention strip — "N waiting on you →" — opening the Inbox.
  Count comes from the same `buildFeed`/queue data the Inbox uses; two
  implementations of "what needs me" would drift.
- Body: one row per live agent (execute, review, verify — labeled), showing task
  title, state, and elapsed. Click opens that task's Chat tab.
- Idle state: "No agents running." The rail never hides; a surface that appears
  and disappears cannot be learned.

### Affordance migration (before the pages die)

ReviewView-only affordances move into the TaskView path so it reaches parity:

- "Ask an agent to review" (`startReview`) and the derived agent-reviewing
  indicator (`liveReviewAgentFor`) wired into `RunReviewView` via `TaskDiffTab`
  — that path currently never passes `onStartAiReview`.
- Fix-findings selection (checkboxes per finding + "Fix N selected" →
  request-changes resume). Partially implemented in `ReviewCasePanel`
  (uncommitted at time of writing); lands as part of this work.

### Navigation cleanup

`appNav` ids, keyboard shortcuts, and any deep link targeting the removed pages
redirect: run targets → that run's task expanded (Diff for terminal runs, Chat
for live), review-queue targets → Inbox. Nothing 404s silently.

## Out of scope

Board and Overview/Control room stay as they are (Overview keeps `buildFeed`;
the rail reuses it). The PR review composition is reused inside the derived task
flow, not rewritten. No server/API changes.

## Testing

Pure logic (queue building, rail row derivation, redirect mapping) gets unit
tests beside the existing `buildReviewQueue`/`controlRoom` suites. Component
tests for the Inbox rows' navigation targets and the rail's idle/live states.
Click-path verification of TaskView review parity is a hand check (Pierre
components don't render under happy-dom).
