# Run disposition badge

**Date:** 2026-07-26 **Status:** approved, ready for implementation plan

## Problem

`RunStatePill` renders a run's raw `RunState`, and `RunState` cannot answer the
question a human actually has. Two runs both sitting on `finished` mean
completely different things depending on whether anyone has reviewed them, and
two runs both on `failed` differ on whether there is a session left to continue
from. The pill shows "Finished" for a run awaiting review and for a run merged
an hour ago.

This is the confusion that started the work: a run truncated by the Claude usage
limit was recorded `finished`, the UI said "Finished", and the task looked done
when the agent had been cut off mid-sentence. The executor now records that
honestly as `failed` (see `reasonForTruncation` in
`packages/server/src/orchestrator/executors/claude.ts`), but the UI still cannot
distinguish "failed and resumable" from "failed and dead", so the underlying
reporting gap is only half closed.

`deriveRunDisposition` in `apps/desktop/src/lib/runState.ts` already computes
the answer and has 9 passing unit tests covering every disposition. Nothing
renders it.

## Scope

In: surface the disposition wherever a run's state is already shown.

Out, deliberately:

- A review inbox / queue surface.
- The merge-queue Retry button — tracked separately as `t-d6ee2c`.
- A Continue _action_ on stopped-short runs. This spec only _labels_ that
  situation; wiring the action is separate work.

## Design

### Where the badge lives

The badge goes **inside `RunStatePill`**, not beside it at each call site.

`RunStatePill` has five consumers: `RunsView`, `OverviewView`,
`RunDetailHeader`, `TaskDetailDialog`, `StackRail`. A standalone
`RunDispositionBadge` that each surface composes would be five chances to miss
one, and a run reading "Needs review" in the Runs rail but bare "Finished" on a
board card reproduces exactly the inconsistency this fixes. One component means
every surface gains it at once and cannot drift.

The cost is a prop change: `RunStatePill` currently takes `state: RunState`, but
the disposition needs `reviewedAt`, `prUrl`, and `sessionId` too, so it takes
`meta: RunMeta` instead. This is a mechanical update across five files, and it
is the more honest signature — the component's job becomes "show this run's
situation", which requires the run rather than one field of it.

### What it renders

The existing dot + state label are unchanged. A muted secondary badge follows
it, and is absent when there is nothing a human needs to know:

| Disposition           | Renders                               |
| --------------------- | ------------------------------------- |
| `live`                | `● Running` — no badge                |
| `needs-review`        | `● Finished` `[Needs review]`         |
| `stopped-short`       | `● Failed` `[Continue]`               |
| `dead`                | `● Failed` — no badge                 |
| `in-review-elsewhere` | `● Finished` `[PR open]`              |
| `closed`              | `● Finished` `[Merged]`/`[Discarded]` |

Keeping the raw state visible is deliberate: `failed` vs `cancelled` is still
real information, and the badge is additive rather than a replacement that hides
it.

`dead` gets no badge because the raw `failed`/`cancelled` state already says
everything true about it — there is no action available and nothing to review.
Adding "Dead end" would be noise on the one row where the existing label is
already sufficient.

### The `closed` wording

`deriveRunDisposition` returns a single `closed` for any reviewed run, but the
table needs "Merged" vs "Discarded". The disposition function stays coarse: it
answers _what kind of situation this is_, and the badge picks wording from
`meta.reviewAction` for that one case.

Adding merged/discarded variants to `RunDisposition` itself was considered and
rejected — it would make the type encode review bookkeeping rather than "whose
turn is it and to do what", which is the distinction that makes the type worth
having. Wording is a presentation concern; the situation is not.

### Components

- `deriveRunDisposition(meta)` — unchanged. Already the single decision
  function.
- A label map in `RunStatePill.tsx`:
  `(disposition, reviewAction) -> string | null`, where `null` means render no
  badge. Pure, exported for test.
- `RunStatePill({ meta, className })` — computes the disposition, renders dot +
  state label as today, plus the badge when the label map returns non-null.

### Testing

`deriveRunDisposition` is already covered by 9 unit tests. The new logic is a
pure label map, so it is tested directly as
`(disposition, reviewAction) -> label`, including that `live` and `dead` return
`null` and that `closed` yields "Merged"/"Discarded" from `reviewAction`.

No render tests: `apps/desktop` has no React testing setup, and this follows how
`scroll.ts` and `notificationEdges.ts` were covered — extract the decision as a
pure function and test that. The five call-site updates are type-checked by
`bun run tsc`, which is what actually catches a missed conversion.

## Acceptance criteria

- `RunStatePill` takes `meta: RunMeta`; all five consumers updated;
  `bun run tsc` clean for `apps/desktop`.
- A finished, unreviewed run shows `Needs review` in all five surfaces.
- A failed run with a `sessionId` shows `Continue`; without one, no badge.
- A run with `prUrl` set and `reviewedAt` unset shows `PR open`.
- A reviewed run shows `Merged` or `Discarded` per `reviewAction`.
- A live run shows no badge.
- The label map has unit tests covering every disposition, including both `null`
  cases.
- `bun run format` and `bun run lint` clean from the repo root.
