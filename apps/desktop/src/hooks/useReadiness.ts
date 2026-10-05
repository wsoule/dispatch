import type { TaskDoc, TaskMeta } from '@dispatch-foo/core/browser';
import type {
  ApiClient,
  ReadinessReading,
  ReadyTaskRef,
} from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef } from 'react';

type Readings = Record<string, ReadinessReading>;

interface JudgeDelays {
  /** The first judge waits for the list's first render to have settled. */
  first: number;
  /** A spec edit re-judges this long after it, and edits meanwhile ride along — an
   * import or a sync pass costs one judging request per window, never one per task. */
  debounce: number;
  /** After an answer with no readings at all (no judgment client, or the judge failed),
   * the next judge waits this long, doubling per such answer in a row up to 16x. */
  retry: number;
}

const JUDGE_DELAYS: JudgeDelays = {
  first: 1_500,
  debounce: 1_000,
  retry: 30_000,
};
const MAX_RETRY_DOUBLINGS = 4;

export function readinessKey(port: number | undefined) {
  return ['dispatch-readiness', port] as const;
}

/** `readings` with a judging answer laid over it: each task the answer names takes its
 * reading, or loses the old one when it came back unjudged (no judgment client, or the
 * judge failed). */
export function applyJudged(
  readings: Readings | undefined,
  judged: readonly ReadyTaskRef[]
): Readings {
  const next = { ...readings };
  for (const task of judged) {
    if (task.readiness === undefined) delete next[task.id];
    else next[task.id] = task.readiness;
  }
  return next;
}

/** Whether `doc` changed what a reading is judged from (title, body, writes) since
 * `prev`, its list entry, and `lastBody`, the body last seen for it. An unseen body
 * counts as changed. */
export function specChanged(
  prev: TaskMeta | undefined,
  doc: TaskDoc,
  lastBody: string | undefined
): boolean {
  return (
    prev === undefined ||
    lastBody !== doc.body ||
    prev.title !== doc.meta.title ||
    prev.writes.join('\n') !== doc.meta.writes.join('\n')
  );
}

/** `readings` narrowed to the ready set: a reading describes a task waiting to start. */
export function readinessFor(
  readings: Readings | undefined,
  readyIds: ReadonlySet<string>
): Map<string, ReadinessReading> {
  const map = new Map<string, ReadinessReading>();
  if (readings === undefined) return map;
  for (const [id, reading] of Object.entries(readings)) {
    if (readyIds.has(id)) map.set(id, reading);
  }
  return map;
}

/** What one connection's judging keeps between renders. */
interface JudgeState {
  timer: ReturnType<typeof setTimeout> | null;
  /** Judging requests sent, and the newest one whose answer was applied. */
  sent: number;
  applied: number;
  /** Answers in a row that judged nothing, and when the next judge may go. */
  misses: number;
  notBefore: number;
  /** The body last seen per task, to tell a spec edit from any other change. */
  bodies: Map<string, string>;
  /** Tasks whose spec changed since an answer covered them, with `sent` at the time. */
  edited: Map<string, number>;
  /** Edited tasks not yet checked against the ready set. */
  unchecked: Set<string>;
  /** The ready set the last applied answer covered. */
  answered: ReadonlySet<string>;
  /** The ready set last looked at, to spot tasks that just turned ready. */
  seenReady: ReadonlySet<string> | null;
}

function newJudgeState(): JudgeState {
  return {
    timer: null,
    sent: 0,
    applied: 0,
    misses: 0,
    notBefore: 0,
    bodies: new Map(),
    edited: new Map(),
    unchecked: new Set(),
    answered: new Set(),
    seenReady: null,
  };
}

interface Readiness {
  readinessById: ReadonlyMap<string, ReadinessReading>;
  /** A task's doc fetched after a change, with its list entry from before (undefined
   * for a new task). Judges again when a ready task's spec changed. */
  noteTask: (prev: TaskMeta | undefined, doc: TaskDoc) => void;
  /** Tasks changed in ways not looked at one by one (a wide change, a reconnect):
   * judge again shortly. */
  scheduleJudge: () => void;
  /** The socket reconnected, likely to a restarted daemon whose judgment client may
   * differ: drop any back-off and judge again shortly. */
  reconnected: () => void;
}

/**
 * The readiness readings without re-sending ready bodies on every event. The cached
 * readings (`/api/tasks/readiness`, the daemon's readings still matching their tasks'
 * text) paint first. The judging route (`/api/tasks/ready?fields=id`, which judges stale
 * specs and answers ids and readings only) runs once per connection after the list is
 * in, then only when a ready task's spec changes, a task turns ready without a reading,
 * or tasks changed unseen. An edited ready task keeps its old reading until the answer
 * replaces it, so it does not jump lanes and back.
 */
export function useReadiness(
  client: ApiClient | null,
  port: number | undefined,
  listLoaded: boolean,
  readyIds: ReadonlySet<string>,
  delays: JudgeDelays = JUDGE_DELAYS
): Readiness {
  const queryClient = useQueryClient();
  const key = useMemo(() => readinessKey(port), [port]);
  const { data: readings } = useQuery({
    queryKey: key,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.fetchReadiness();
    },
    enabled: client !== null && listLoaded,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const state = useRef<JudgeState>(newJudgeState());

  const judge = useCallback(async () => {
    if (client === null) return;
    const s = state.current;
    const sent = ++s.sent;
    const judged = await client.fetchReadyTaskIds();
    // A newer answer already landed, or the connection changed meanwhile.
    if (state.current !== s || sent < s.applied) return;
    s.applied = sent;
    s.answered = new Set(judged.map((task) => task.id));
    // Backs off rather than stopping: a failed judge answers like no client at all.
    if (judged.some((task) => task.readiness !== undefined)) {
      s.misses = 0;
      s.notBefore = 0;
    } else if (judged.length > 0) {
      const doublings = Math.min(s.misses, MAX_RETRY_DOUBLINGS);
      s.misses += 1;
      s.notBefore = Date.now() + delays.retry * 2 ** doublings;
    }
    // Edited before this request and not ready when judged: its old reading is stale.
    const dropped: string[] = [];
    for (const [id, at] of s.edited) {
      if (at >= sent) continue;
      s.edited.delete(id);
      if (!s.answered.has(id)) dropped.push(id);
    }
    queryClient.setQueryData<Readings>(key, (old) => {
      const next = applyJudged(old, judged);
      for (const id of dropped) delete next[id];
      return next;
    });
  }, [client, queryClient, key, delays.retry]);

  const schedule = useCallback(
    (delay: number) => {
      const s = state.current;
      if (s.timer !== null) return;
      const wait = Math.max(delay, s.notBefore - Date.now());
      s.timer = setTimeout(() => {
        s.timer = null;
        judge().catch(() => {});
      }, wait);
    },
    [judge]
  );

  // A new connection starts over and judges afresh.
  useEffect(() => {
    const s = newJudgeState();
    state.current = s;
    if (!listLoaded) return;
    schedule(delays.first);
    return () => {
      if (s.timer !== null) clearTimeout(s.timer);
      s.timer = null;
    };
  }, [listLoaded, schedule, delays.first]);

  // Runs once the ready set reflects the latest changes. An edited task judges again if
  // it is ready now; one that is not ready loses its stale reading at once, since it is
  // not shown. A task that just turned ready is judged when its spec changed since its
  // reading, or it has none and the daemon was not already asked for one.
  useEffect(() => {
    const s = state.current;
    let rejudge = false;
    const stale: string[] = [];
    for (const id of s.unchecked) {
      if (readyIds.has(id)) rejudge = true;
      else if (readings?.[id] !== undefined) stale.push(id);
    }
    s.unchecked.clear();
    const seen = s.seenReady;
    s.seenReady = readyIds;
    if (seen !== null && !rejudge) {
      for (const id of readyIds) {
        if (seen.has(id)) continue;
        if (
          s.edited.has(id) ||
          (readings?.[id] === undefined && !s.answered.has(id))
        ) {
          rejudge = true;
          break;
        }
      }
    }
    if (rejudge) schedule(delays.debounce);
    if (stale.length === 0) return;
    queryClient.setQueryData<Readings>(key, (old) => {
      const next = { ...old };
      for (const id of stale) delete next[id];
      return next;
    });
  }, [readyIds, readings, schedule, delays.debounce, queryClient, key]);

  // Checked against the ready set after the change lands (the effect above), not before:
  // a dispatched task is still ready here and would cost a judge for nothing.
  const noteTask = useCallback((prev: TaskMeta | undefined, doc: TaskDoc) => {
    const s = state.current;
    const { id } = doc.meta;
    if (prev !== undefined && doc.meta.updated < prev.updated) return;
    const changed = specChanged(prev, doc, s.bodies.get(id));
    s.bodies.set(id, doc.body);
    if (!changed) return;
    s.edited.set(id, s.sent);
    s.unchecked.add(id);
  }, []);

  const scheduleJudge = useCallback(
    () => schedule(delays.debounce),
    [schedule, delays.debounce]
  );
  const reconnected = useCallback(() => {
    const s = state.current;
    s.misses = 0;
    s.notBefore = 0;
    if (s.timer !== null) clearTimeout(s.timer);
    s.timer = null;
    schedule(delays.debounce);
  }, [schedule, delays.debounce]);
  const readinessById = useMemo(
    () => readinessFor(readings, readyIds),
    [readings, readyIds]
  );
  return { readinessById, noteTask, scheduleJudge, reconnected };
}
