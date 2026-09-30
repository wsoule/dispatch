import { useCallback, useEffect, useRef, useState } from 'react';

import {
  NO_PENDING,
  PENDING_TIMEOUT_MS,
  type PendingDispatches,
  reconcileDispatches,
  rollbackDispatch,
  settleDispatch,
  startDispatch,
} from '../lib/optimisticDispatch';

interface OptimisticDispatch {
  pending: PendingDispatches;
  /** Moves the task into flight now and sends the request; resolves either way. */
  dispatch: (taskId: string) => Promise<void>;
}

/**
 * Wraps a dispatch that rejects on failure with the Cockpit's optimistic state: the task is
 * pending (in flight) the moment `dispatch` is called, settles when the request resolves,
 * leaves once the caches show its run (`liveTaskIds`) or its status moved (`stillWaiting`),
 * and rolls back — with `onError` — when the request fails.
 */
export function useOptimisticDispatch(
  send: (taskId: string) => Promise<void>,
  liveTaskIds: ReadonlySet<string>,
  stillWaiting: (taskId: string) => boolean,
  onError: (taskId: string, message: string) => void
): OptimisticDispatch {
  const [pending, setPending] = useState<PendingDispatches>(NO_PENDING);
  // Read through refs so `dispatch` keeps one identity across renders.
  const sendRef = useRef(send);
  const onErrorRef = useRef(onError);
  const liveRef = useRef(liveTaskIds);
  const waitingRef = useRef(stillWaiting);
  useEffect(() => {
    sendRef.current = send;
    onErrorRef.current = onError;
    liveRef.current = liveTaskIds;
    waitingRef.current = stillWaiting;
  }, [send, onError, liveTaskIds, stillWaiting]);

  const dispatch = useCallback(async (taskId: string) => {
    setPending((prev) => startDispatch(prev, taskId, Date.now()));
    try {
      await sendRef.current(taskId);
      setPending((prev) => settleDispatch(prev, taskId));
    } catch (err) {
      setPending((prev) => rollbackDispatch(prev, taskId));
      onErrorRef.current(
        taskId,
        err instanceof Error ? err.message : 'The daemon refused the dispatch.'
      );
    }
  }, []);

  // Also on every pending change: a run the WebSocket delivered before the request
  // answered is already live by the time the dispatch settles.
  useEffect(() => {
    if (pending.size === 0) return;
    setPending((prev) =>
      reconcileDispatches(prev, liveTaskIds, stillWaiting, Date.now())
    );
  }, [pending, liveTaskIds, stillWaiting]);

  // A sent dispatch whose run never shows up still leaves, once it times out.
  const hasSent = [...pending.values()].some((e) => e.state === 'sent');
  useEffect(() => {
    if (!hasSent) return;
    const timer = setTimeout(() => {
      setPending((prev) =>
        reconcileDispatches(
          prev,
          liveRef.current,
          waitingRef.current,
          Date.now()
        )
      );
    }, PENDING_TIMEOUT_MS + 100);
    return () => clearTimeout(timer);
  }, [hasSent]);

  return { pending, dispatch };
}
