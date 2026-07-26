import type {
  MergeQueueEntryState,
  MergeQueueSnapshot,
  RunMeta,
  RunState,
} from '@dispatch/client';
import { useEffect, useRef } from 'react';

import {
  diffQueueNotifications,
  diffRunNotifications,
} from '../lib/notificationEdges';
import { notify } from '../lib/notifications';

/**
 * Fires a native notification the instant a run lands on finished/failed, or a
 * merge-queue entry lands on merged/failed, while this window is open — see
 * notificationEdges.ts for the pure diff logic and why a run/entry's first sighting
 * never notifies (it's what keeps app launch from replaying every already-terminal
 * run/entry as a fresh notification).
 *
 * The previous-snapshot maps live in refs rather than React state: this hook never
 * needs to render from them, it only needs them to persist across renders so the next
 * `runs`/`mergeQueue` update has something to diff against.
 */
export function useTransitionNotifications(
  runs: readonly RunMeta[],
  mergeQueue: MergeQueueSnapshot | null
): void {
  const previousRunStates = useRef<Map<string, RunState>>(new Map());
  const previousQueueStates = useRef<Map<string, MergeQueueEntryState>>(
    new Map()
  );

  useEffect(() => {
    const { notifications, next } = diffRunNotifications(
      previousRunStates.current,
      runs
    );
    previousRunStates.current = next;
    for (const n of notifications) void notify(n.title, n.body);
  }, [runs]);

  useEffect(() => {
    if (mergeQueue === null) return;
    // See diffQueueNotifications's doc comment: a terminal entry moves out of
    // `entries` and into `history` in the same snapshot that flips its state, so
    // both lists must be combined for the diff to ever see a merged/failed edge.
    const combined = [...mergeQueue.entries, ...mergeQueue.history];
    const { notifications, next } = diffQueueNotifications(
      previousQueueStates.current,
      combined
    );
    previousQueueStates.current = next;
    for (const n of notifications) void notify(n.title, n.body);
  }, [mergeQueue]);
}
