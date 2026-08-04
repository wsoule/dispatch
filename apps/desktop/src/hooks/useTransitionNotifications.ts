import type {
  DraftRecord,
  MergeQueueEntryState,
  MergeQueueSnapshot,
  PlanRecord,
  RunMeta,
  RunQuestion,
  RunState,
} from '@dispatch/client';
import { useEffect, useRef } from 'react';

import type { InboxEntryDraft } from '../lib/inbox';
import {
  diffQuestionNotifications,
  diffQueueNotifications,
  diffRunNotifications,
  emptyQuestionTracking,
} from '../lib/notificationEdges';
import type { QuestionTracking } from '../lib/notificationEdges';
import { notify } from '../lib/notifications';

/** The previous-snapshot maps this hook diffs against, plus the project root they were
 * captured under — see `resetTrackingForRoot` for why the root travels with them. */
export interface TransitionTrackingState {
  root: string | null;
  runStates: Map<string, RunState>;
  queueStates: Map<string, MergeQueueEntryState>;
  questions: QuestionTracking;
}

// The empty tracking state for a given root — used both as the ref's initial value and
// as what a root change resets onto.
function emptyTracking(root: string | null): TransitionTrackingState {
  return {
    root,
    runStates: new Map(),
    queueStates: new Map(),
    questions: emptyQuestionTracking(),
  };
}

/**
 * Decides whether the active project has changed since the last render and, if so,
 * wipes both tracking maps rather than carrying them into the new project. Without
 * this, the in-app project switcher — which swaps `useDispatchProject`'s `projectPath`
 * argument in place rather than remounting the hook — would leave this hook diffing a
 * newly-reopened project's runs/queue entries against whatever state a *previous*
 * project last left in the maps. That both risks false transitions (a run id that
 * collides across projects reads as a state change) and violates "only transitions
 * observed live" (the previous project's terminal states leak in as fake "previous"
 * values for entries the user never watched transition in the reopened project).
 *
 * Returning a fresh, empty `TransitionTrackingState` on a root change is also what
 * re-arms the "first sighting never notifies" guard in `diffRunNotifications`/
 * `diffQueueNotifications`: with empty maps, the reopened project's next refetch has no
 * `previous` entry for anything, so every run/entry it currently holds — even one
 * already terminal — is treated as initial state, not a live transition.
 *
 * Pure and side-effect free so project-switch reset semantics are unit-testable
 * without rendering the hook — see useTransitionNotifications.test.ts. Returns the same
 * `state` reference when the root hasn't changed, so callers can skip work on a no-op.
 */
export function resetTrackingForRoot(
  state: TransitionTrackingState,
  root: string | null
): TransitionTrackingState {
  return state.root === root ? state : emptyTracking(root);
}

/**
 * Fires a native notification the instant a run lands on finished/failed, a
 * merge-queue entry lands on merged/failed, or a planner or run agent asks the user a
 * question, while this window is open — see notificationEdges.ts for the pure diff
 * logic and why a run/entry's first sighting never notifies (it's what keeps app
 * launch from replaying every already-terminal run/entry as a fresh notification).
 *
 * `projectRoot` is the active project's path from `useDispatchProject` — it exists
 * solely so this hook can detect a project switch and reset its tracking via
 * `resetTrackingForRoot` (see that function's comment for why the reset matters).
 *
 * The tracking state lives in a ref rather than React state: this hook never needs to
 * render from it, it only needs it to persist across renders so the next
 * `runs`/`mergeQueue` update has something to diff against.
 *
 * `onRecord` is called with the same transitions, reshaped into inbox drafts (see
 * inbox.ts), for every batch that produces at least one notification — the toast stays a
 * transient mirror, `onRecord`'s caller (`useDispatchProject`) owns the persisted record a
 * user can come back to after the toast has already disappeared.
 */
export function useTransitionNotifications(
  projectRoot: string | null,
  runs: readonly RunMeta[],
  mergeQueue: MergeQueueSnapshot | null,
  drafts: readonly DraftRecord[],
  planRecord: PlanRecord | undefined,
  openQuestions: ReadonlyMap<string, RunQuestion[]>,
  onRecord: (adds: InboxEntryDraft[]) => void
): void {
  const tracking = useRef<TransitionTrackingState>(emptyTracking(projectRoot));

  // Reset during render, not inside an effect: this guarantees the maps are already
  // cleared by the time either diff effect below runs for this commit, regardless of
  // effect declaration order or whether `runs`/`mergeQueue` happen to keep the same
  // object reference across the switch (e.g. the new project's queries haven't
  // resolved yet, so both still read as their default empty/`null` value).
  tracking.current = resetTrackingForRoot(tracking.current, projectRoot);

  useEffect(() => {
    const { notifications, next } = diffRunNotifications(
      tracking.current.runStates,
      runs
    );
    tracking.current = { ...tracking.current, runStates: next };
    if (notifications.length > 0) {
      const ts = new Date().toISOString();
      onRecord(notifications.map((n) => ({ ...n, ts })));
    }
    for (const n of notifications) void notify(n.title, n.body);
  }, [runs, onRecord]);

  useEffect(() => {
    if (mergeQueue === null) return;
    // See diffQueueNotifications's doc comment: a terminal entry moves out of
    // `entries` and into `history` in the same snapshot that flips its state, so
    // both lists must be combined for the diff to ever see a merged/failed edge.
    const combined = [...mergeQueue.entries, ...mergeQueue.history];
    const { notifications, next } = diffQueueNotifications(
      tracking.current.queueStates,
      combined
    );
    tracking.current = { ...tracking.current, queueStates: next };
    if (notifications.length > 0) {
      const ts = new Date().toISOString();
      onRecord(notifications.map((n) => ({ ...n, ts })));
    }
    for (const n of notifications) void notify(n.title, n.body);
  }, [mergeQueue, onRecord]);

  useEffect(() => {
    const { notifications, next } = diffQuestionNotifications(
      tracking.current.questions,
      drafts,
      planRecord,
      openQuestions
    );
    tracking.current = { ...tracking.current, questions: next };
    if (notifications.length > 0) {
      const ts = new Date().toISOString();
      onRecord(notifications.map((n) => ({ ...n, ts })));
    }
    for (const n of notifications) void notify(n.title, n.body);
  }, [drafts, planRecord, openQuestions, onRecord]);
}
