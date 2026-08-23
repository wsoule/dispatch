# Merge-queue reliability and observability

**Date:** 2026-07-26 **Status:** approved, ready for implementation plan

## Problem

The merge queue can stop making progress in a way nothing surfaces. Observed
today, in one session:

1. An entry sat in `verifying` for **11 minutes** with no process running in its
   worktree and no file activity for three of those minutes. The daemon had died
   mid-verify. From the queue snapshot and the UI, "wedged" and "working" are
   the same picture — `verifying` with no further information.
2. Recovering required noticing the problem, checking `ps` and `lsof` to prove
   no process was running, and re-enqueueing by hand. `hydrate()` files
   mid-flight entries to failed history with the advice "re-enqueue to retry",
   which is a manual step for something the queue could do itself.
3. `verifyCommand` has no timeout. A hanging test suite or an install waiting on
   a network prompt holds the queue forever, since the queue is strictly serial
   — one wedged entry blocks every entry behind it.

The trigger for all three was adding a `verifyCommand` at all. Before that,
verify was skipped and the queue's steps were fast git operations; now a normal
entry takes ~2-3 minutes, so a long-running step is expected and there is no
baseline against which "too long" is obvious.

## Design

### 1. Verify timeout

New `verifyTimeoutSec` in `.dispatch/config.yml`'s `orchestrator` block,
default 600. Read fresh per entry via `loadConfig`, exactly as `verifyCommand`
already is.

The `CommandRunner` seam grows an optional third parameter:

```ts
export type CommandRunner = (
  cwd: string,
  cmd: string[],
  opts?: { timeoutMs?: number; onOutput?: (chunk: string) => void }
) => Promise<CommandResult>;
```

This is backward compatible with every existing stub: TypeScript allows a
function of fewer parameters where more are expected, so `merge-queue.test.ts`'s
`StubRunner` and `pr.test.ts`'s stub keep compiling untouched.

On expiry `defaultCommandRunner` kills the process and returns `ok: false`, and
the queue fails the entry with a reason that names the remedy:

```text
verify timed out after 10m — raise orchestrator.verifyTimeoutSec or narrow verifyCommand
```

Only the verify step passes `timeoutMs`. Rebase and merge are fast local git
operations, and a timeout on a merge is more dangerous than a hang.

### 2. Auto-requeue after an interrupted attempt

`hydrate()` currently files any entry found in `rebasing`/`verifying`/`merging`
straight to failed history. Instead it returns the entry to `queued` and
increments a new `attempts` counter.

`attempts` is a field on `MergeQueueEntry` and therefore **persisted** to
`merge-queue.json` like every other entry field. This is not optional: the
scenario the cap exists to stop is a hang that recurs across daemon restarts,
and an in-memory counter resets to zero on every boot — which is precisely the
infinite loop, just with an extra field that looks like it prevents one.

This is safe for exactly the reason the existing code comment already gives for
telling the user to re-enqueue: the downstream steps are idempotent against a
half-done prior attempt — `merge()`'s local path is a no-op the second time via
`review()`/`mergeRun`'s `hasChanges` skip, and its PR path either force-pushes
again harmlessly or hits `gh pr merge`'s "already merged" error. This change
only stops making a human do it.

**The attempt cap is load-bearing.** Auto-requeue plus a reproducible hang is an
infinite loop: the daemon dies mid-verify, boots, requeues, wedges again. Past 3
attempts the entry fails for real:

```text
abandoned after 3 interrupted attempts — check verifyCommand
```

The timeout above prevents most of this, but the cap covers the case a timeout
cannot: the daemon being killed rather than the command overrunning. Without it,
"doesn't fail poorly" would become "never fails at all, silently retrying" —
strictly worse than today, because today at least the failure is visible.

### 3. Elapsed time on in-flight entries

Add `stateSince: string` to `MergeQueueEntry`, stamped on every state transition
(not just on enqueue — `enqueuedAt` already covers that and does not move).

The UI renders it on in-flight entries: `Verifying · 4m`. Cheapest of the four
changes and the one that actually makes slow-vs-wedged legible without asking
anyone to inspect processes.

### 4. Live verify output

A new `ServerEvent`, mirroring the existing `run.log` shape:

```ts
| { type: 'merge-queue.log'; runId: string; chunk: string }
```

`verify()` passes `onOutput` and broadcasts each chunk. The entry also keeps a
bounded tail (last ~8KB) so a client that opens mid-verify or refreshes sees
recent output instead of nothing, and so the failure reason can reuse the tail
rather than capturing output separately.

Bounded deliberately: an unbounded buffer against a multi-minute test suite is a
memory leak in a long-lived daemon, and the complete log belongs in the failure
reason, not in memory. Chunks are broadcast rather than folded into
`merge-queue.changed` because that event carries a full snapshot — emitting one
per output chunk would be pathologically chatty.

## Sequencing

Timeout → elapsed time → auto-requeue → streaming. The first two deliver most of
the value for a small fraction of the work; streaming is the largest build and
the least essential. Each is independently shippable.

## Testing

- **Timeout:** a `CommandRunner` stub that never resolves, plus a short
  configured `verifyTimeoutSec`; assert the entry fails with a reason matching
  `/timed out/` and that the queue moves on to the next entry rather than
  stalling.
- **Auto-requeue:** `hydrate()` against a persisted file holding a `verifying`
  entry; assert it comes back as `queued` with `attempts: 1`, and that a fourth
  boot fails it with `/abandoned after 3/`. The existing test "files a
  mid-flight persisted entry to failed history with a restart reason" asserts
  the old behavior and must be rewritten, not deleted — its scenario is still
  the one under test, only the expected outcome changes.
- **Elapsed time:** assert `stateSince` advances across a state transition and
  is present on the snapshot.
- **Streaming:** drive a stub whose `onOutput` emits two chunks; assert two
  `merge-queue.log` events via `merge-queue.test.ts`'s existing `captureEvents`
  helper, and that the entry's tail is bounded when fed more than the cap.

## Acceptance criteria

- `verifyTimeoutSec` is configurable, defaults to 600, and a hanging verify
  fails the entry with a reason naming both remedies.
- A timed-out or interrupted entry never blocks the entries behind it.
- An entry interrupted by a daemon restart returns to `queued` automatically and
  fails for real after 3 attempts.
- In-flight entries expose `stateSince`; the UI shows elapsed time.
- Verify output streams as `merge-queue.log` events, with a bounded tail on the
  entry.
- `bun run format`, `bun run lint`, and `bun test packages/server` clean.
