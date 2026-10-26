import type {
  ApiClient,
  DiffResult,
  LiveTextView,
  NormalizedEntry,
  ReviewComment,
  ReviewVerdict,
  RunDetail,
  ServerEvent,
} from '@dispatch/client';
import { liveTextStore, runLiveKey, useLiveText } from '@dispatch/client';
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

import { isTerminalRunState } from '../lib/runState';

// One run's detail, diff and line comments for a surface that shows a run of its own
// choosing (the task page in a split pane or peek), rather than the app's selected run.
// The keys are the ones useDispatchProject uses for the selected run, so both share one
// cache: `run.log` appends to this detail, and `run.changed`/`review.changed` refresh it.
// A live run's text in progress is not in the cache but the window's live text store,
// which `run.delta` feeds and each detail fetch repairs (applyRunEvent, fetchRunDetail).

export function runDetailKey(port: number | undefined, runId: string) {
  return ['dispatch-run', port, runId] as const;
}

// Refetches a run's detail so its `live` snapshot fills a gap in the run's live text. A
// tick late: a repair asked for from inside the detail's own queryFn must not cancel the
// fetch that is about to land.
// A fetch already out is left to land (its snapshot is read after the frames that went
// before it), so a run opened mid-stream does not throw away its first fetch.
function repairRunLive(
  queryClient: QueryClient,
  port: number | undefined,
  runId: string
): void {
  setTimeout(() => {
    void queryClient.invalidateQueries(
      { queryKey: runDetailKey(port, runId), exact: true },
      { cancelRefetch: false }
    );
  }, 0);
}

// Whether a surface of this window shows run `runId`: its detail query has an observer.
// Only such a run's text is kept; one opened later starts from its detail's snapshot
// (forgetHiddenRunLive).
function isWatched(
  queryClient: QueryClient,
  port: number | undefined,
  runId: string
): boolean {
  const query = queryClient
    .getQueryCache()
    .find({ queryKey: runDetailKey(port, runId), exact: true });
  return (query?.getObserversCount() ?? 0) > 0;
}

// Lets go of the live text of a run no surface shows. Its frames go unread while it is
// hidden, so what the store held would be wrong when it is shown again: a segment
// abandoned meanwhile would stay on screen for the rest of the run, since no row ever
// replaces it. Its cached detail is marked stale (not refetched), so a surface that shows
// the run again fetches the snapshot instead of starting from nothing.
function forgetHiddenRunLive(
  queryClient: QueryClient,
  port: number | undefined,
  runId: string
): void {
  liveTextStore.forget(port, runLiveKey(runId));
  const key = runDetailKey(port, runId);
  const state = queryClient.getQueryState(key);
  if (state !== undefined && !state.isInvalidated) {
    void queryClient.invalidateQueries({
      queryKey: key,
      exact: true,
      refetchType: 'none',
    });
  }
}

type RunLogFrame = Extract<ServerEvent, { type: 'run.log' }>;

// The run.log frames that arrived while a run detail fetch was out, one list per fetch,
// by `port:runId`. The response may have been read before them, so fetchRunDetail adds
// the ones it lacks before the response lands; no frame ever restarts a fetch.
const framesInFlight = new Map<string, Set<RunLogFrame[]>>();

function flightKey(port: number | undefined, runId: string): string {
  return `${port ?? ''}:${runId}`;
}

// Where a run.log frame's entry goes in a detail holding `length` entries: `next` (append
// it), `held` (the detail has it already) or `gap` (frames before it were missed). A frame
// with no index (an older daemon) is always `next`, as run.log was before it had one.
function placeOf(
  index: number | undefined,
  length: number
): 'next' | 'held' | 'gap' {
  if (index === undefined || index === length) return 'next';
  return index < length ? 'held' : 'gap';
}

// Refetches a run's detail once to fill entries its frames missed, without cancelling a
// fetch already out (whose landing adds the frames it lacks). A tick late, like
// repairRunLive, when asked for from inside the detail's own queryFn.
function repairRunDetail(
  queryClient: QueryClient,
  port: number | undefined,
  runId: string
): void {
  setTimeout(() => {
    void queryClient.invalidateQueries(
      { queryKey: runDetailKey(port, runId), exact: true },
      { cancelRefetch: false }
    );
  }, 0);
}

/** Keeps cached run details current from the event stream: `run.log` appends its entry to
 * the run's cached detail in place, for every surface showing that run, and `run.delta`
 * folds the text a live run is writing into the window's live text store, for a run a
 * surface shows (every run's frames reach every window). A frame never cancels a fetch: a
 * delta that missed another refetches the detail once, whose `live` snapshot repairs the
 * text, and a log entry that lands mid-fetch is added to the response by its index
 * (fetchRunDetail). An entry that finishes a segment takes it out of the store. */
export function applyRunEvent(
  queryClient: QueryClient,
  port: number | undefined,
  event: ServerEvent
): void {
  if (event.type === 'run.delta') {
    const { runId, turnId, seq, segmentId, text, abandoned } = event;
    if (!isWatched(queryClient, port, runId)) {
      forgetHiddenRunLive(queryClient, port, runId);
      return;
    }
    liveTextStore.applyDelta(
      port,
      runLiveKey(runId),
      {
        turnId,
        seq,
        segmentId,
        text,
        ...(abandoned === true ? { abandoned } : {}),
      },
      () => repairRunLive(queryClient, port, runId)
    );
    return;
  }
  if (event.type !== 'run.log') return;
  if (event.entry.streamId !== undefined) {
    liveTextStore.drop(port, runLiveKey(event.runId), event.entry.streamId);
  }
  for (const frames of framesInFlight.get(flightKey(port, event.runId)) ?? []) {
    frames.push(event);
  }
  const key = runDetailKey(port, event.runId);
  const prev = queryClient.getQueryData<RunDetail>(key);
  if (prev === undefined) return;
  const place = placeOf(event.index, prev.entries.length);
  if (place === 'next') {
    queryClient.setQueryData<RunDetail>(key, {
      ...prev,
      entries: [...prev.entries, event.entry],
    });
  } else if (
    place === 'gap' &&
    queryClient.getQueryState(key)?.fetchStatus !== 'fetching'
  ) {
    repairRunDetail(queryClient, port, event.runId);
  }
}

// `entries` with the frames that arrived during its fetch added where they continue it,
// and whether a frame showed entries missing that neither holds, or came with no index
// (an older daemon), so the detail is to be fetched once more.
function withFrames(
  entries: NormalizedEntry[],
  frames: RunLogFrame[]
): { entries: NormalizedEntry[]; gap: boolean } {
  const merged = [...entries];
  let gap = false;
  for (const frame of frames) {
    // Without an index there is no telling whether the response holds it, so the
    // fetch after this one, read once the entry was written, is what shows it.
    if (frame.index === undefined) {
      gap = true;
      continue;
    }
    const place = placeOf(frame.index, merged.length);
    if (place === 'next') merged.push(frame.entry);
    else if (place === 'gap') gap = true;
  }
  return { entries: merged, gap };
}

export function runDiffKey(port: number | undefined, runId: string) {
  return ['dispatch-run-diff', port, runId] as const;
}

export function runReviewKey(port: number | undefined, runId: string) {
  return ['dispatch-review', port, runId] as const;
}

/** Reads a run's detail for a run detail query: the `live` snapshot it carries goes to the
 * live text store (repairing a gap there), and the detail is cached without it, plus the
 * entries whose run.log frames arrived while it was out and it was read too early to hold.
 * Every query on these keys fetches through here, so the store has whichever snapshot
 * landed last. */
export async function fetchRunDetail(
  client: ApiClient,
  queryClient: QueryClient,
  port: number | undefined,
  runId: string
): Promise<RunDetail> {
  const flight = flightKey(port, runId);
  const frames: RunLogFrame[] = [];
  const flights = framesInFlight.get(flight) ?? new Set<RunLogFrame[]>();
  framesInFlight.set(flight, flights.add(frames));
  let fetched: Awaited<ReturnType<ApiClient['fetchRun']>>;
  try {
    fetched = await client.fetchRun(runId);
  } finally {
    flights.delete(frames);
    if (flights.size === 0) framesInFlight.delete(flight);
  }
  const { live, ...detail } = fetched;
  // A run that ended takes no more text: its key goes, rather than wait for `hello`.
  if (isTerminalRunState(detail.meta.state)) {
    liveTextStore.forget(port, runLiveKey(runId));
  } else {
    liveTextStore.mergeSnapshot(port, runLiveKey(runId), live, () =>
      repairRunLive(queryClient, port, runId)
    );
  }
  const { entries, gap } = withFrames(detail.entries, frames);
  if (gap) repairRunDetail(queryClient, port, runId);
  return { ...detail, entries };
}

const NO_STREAM_IDS: ReadonlySet<string> = new Set();

/** The text a run's agent is writing right now and its transcript does not hold yet, one
 * segment per text block, as the run's chat shows it; null once the run has ended. */
export function useRunLive(
  port: number | undefined,
  detail: RunDetail | undefined
): LiveTextView | null {
  const entries = detail?.entries;
  const committed = useMemo(
    () =>
      entries === undefined
        ? NO_STREAM_IDS
        : new Set(
            entries.flatMap((e) =>
              e.streamId === undefined ? [] : [e.streamId]
            )
          ),
    [entries]
  );
  return useLiveText(
    port,
    detail === undefined ? null : runLiveKey(detail.meta.id),
    detail !== undefined && !isTerminalRunState(detail.meta.state),
    committed
  );
}

/** A run's transcript and meta; undefined until fetched or with no run. */
export function useRunDetail(
  client: ApiClient | null,
  port: number | undefined,
  runId: string | null
): RunDetail | undefined {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: runDetailKey(port, runId ?? ''),
    queryFn: () => {
      if (client === null || runId === null) throw new Error('no run');
      return fetchRunDetail(client, queryClient, port, runId);
    },
    enabled: client !== null && runId !== null,
    // A stale id from another daemon should surface, not retry forever.
    retry: false,
  });
  return runId === null ? undefined : data;
}

export interface RunDiffState {
  diff: DiffResult | undefined;
  loading: boolean;
  error: string | null;
}

/** A run's diff against its base, polled while the run is still writing. */
export function useRunDiff(
  client: ApiClient | null,
  port: number | undefined,
  runId: string | null,
  live: boolean
): RunDiffState {
  const { data, isLoading, error } = useQuery({
    queryKey: runDiffKey(port, runId ?? ''),
    queryFn: () => {
      if (client === null || runId === null) throw new Error('no run');
      return client.fetchRunDiff(runId);
    },
    enabled: client !== null && runId !== null,
    refetchInterval: live ? 4000 : false,
    retry: false,
  });
  return {
    diff: runId === null ? undefined : data,
    loading: runId !== null && isLoading,
    error: error instanceof Error ? error.message : null,
  };
}

export interface RunReviewThreads {
  comments: ReviewComment[];
  add: (input: {
    file: string;
    line: number;
    startLine?: number;
    anchorText: string;
    body: string;
    suggestion?: string;
  }) => Promise<ReviewComment>;
  resolve: (commentId: string, resolved: boolean) => Promise<void>;
  reply: (commentId: string, body: string) => Promise<void>;
  apply: (commentId: string) => Promise<void>;
  /** Publishes the staged comments and acts on the verdict. */
  submit: (
    verdict: ReviewVerdict,
    body: string,
    postToGitHub: boolean
  ) => Promise<{ published: number; error?: string }>;
}

const NO_COMMENTS: ReviewComment[] = [];

/** A run's line comments and the four actions the review diff offers over them. */
export function useRunReviewThreads(
  client: ApiClient | null,
  port: number | undefined,
  runId: string | null
): RunReviewThreads {
  const queryClient = useQueryClient();
  const { data } = useQuery({
    queryKey: runReviewKey(port, runId ?? ''),
    queryFn: () => {
      if (client === null || runId === null) throw new Error('no run');
      return client.fetchReviewComments({ kind: 'run', runId });
    },
    enabled: client !== null && runId !== null,
  });
  const refresh = useCallback(() => {
    if (runId === null) return;
    void queryClient.invalidateQueries({ queryKey: runReviewKey(port, runId) });
  }, [queryClient, port, runId]);
  // Each action must resolve only once its request really went out, or throw: the diff's
  // `Apply now` and `Applied` states trust that.
  const ready = useCallback(() => {
    if (client === null || runId === null) {
      throw new Error('dispatchd client not ready');
    }
    return { client, runId };
  }, [client, runId]);

  const add = useCallback<RunReviewThreads['add']>(
    async (input) => {
      const { client: c, runId: id } = ready();
      const created = await c.addReviewComment(
        { kind: 'run', runId: id },
        input
      );
      refresh();
      return created;
    },
    [ready, refresh]
  );
  const resolve = useCallback(
    async (commentId: string, resolved: boolean) => {
      const { client: c, runId: id } = ready();
      await c.resolveReviewComment(
        { kind: 'run', runId: id },
        commentId,
        resolved
      );
      refresh();
    },
    [ready, refresh]
  );
  const reply = useCallback(
    async (commentId: string, body: string) => {
      const { client: c, runId: id } = ready();
      await c.replyReviewComment({ kind: 'run', runId: id }, commentId, body);
      refresh();
    },
    [ready, refresh]
  );
  const apply = useCallback(
    async (commentId: string) => {
      const { client: c, runId: id } = ready();
      await c.applySuggestion(id, commentId);
      refresh();
    },
    [ready, refresh]
  );
  const submit = useCallback<RunReviewThreads['submit']>(
    async (verdict, body, postToGitHub) => {
      const { client: c, runId: id } = ready();
      const res = await c.submitReview(id, verdict, body, postToGitHub);
      refresh();
      return { published: res.published, error: res.error };
    },
    [ready, refresh]
  );
  return useMemo(
    () => ({
      comments: data ?? NO_COMMENTS,
      add,
      resolve,
      reply,
      apply,
      submit,
    }),
    [data, add, resolve, reply, apply, submit]
  );
}
