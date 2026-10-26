import type {
  ApiClient,
  LiveText,
  NormalizedEntry,
  RunDetail,
  RunDetailView,
  RunMeta,
} from '@dispatch/client';
import { liveTextStore, resetLiveText, runLiveKey } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'bun:test';
import type { ReactNode } from 'react';

import {
  applyRunEvent,
  runDetailKey,
  useRunDetail,
  useRunLive,
} from './useRunData';

const PORT = 4100;
const RUN = 'r-000001';

afterEach(() => {
  // The live text store is one per window, so each test starts it empty.
  resetLiveText(PORT);
});

function entry(text: string): NormalizedEntry {
  return { ts: '2026-10-25T10:00:00.000Z', kind: 'assistant', text };
}

// A daemon whose run detail reads can be held open, standing in for a fetch
// that is in flight when a run.log frame arrives. `log` appends an entry the
// way the daemon does: to the transcript first, then the frame.
function gatedRunServer() {
  const entries: NormalizedEntry[] = [entry('first')];
  const pending: (() => void)[] = [];
  const server = {
    entries,
    gated: false,
    pending,
    fetches: 0,
    client: {
      fetchRun: () => {
        server.fetches += 1;
        const snapshot: RunDetail = {
          meta: { id: RUN, state: 'running' } as RunMeta,
          entries: [...entries],
          evidence: [],
          mutations: [],
        };
        if (!server.gated) return Promise.resolve(snapshot);
        return new Promise<RunDetail>((resolve) => {
          pending.push(() => resolve(snapshot));
        });
      },
    } as unknown as ApiClient,
    log(qc: QueryClient, text: string) {
      const next = entry(text);
      entries.push(next);
      applyRunEvent(qc, PORT, {
        type: 'run.log',
        runId: RUN,
        entry: next,
        index: entries.length - 1,
      });
    },
    snapshot: (): RunDetail => ({
      meta: { id: RUN, state: 'running' } as RunMeta,
      entries: [...entries],
      evidence: [],
      mutations: [],
    }),
    release() {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
  return server;
}

function mount(client: ApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return {
    qc,
    ...renderHook(() => useRunDetail(client, PORT, RUN), { wrapper }),
  };
}

const texts = (detail: RunDetail | undefined) =>
  detail?.entries.map((e) => e.text);

describe('applyRunEvent run.log', () => {
  it('appends to a cached detail and leaves an uncached run alone', () => {
    const qc = new QueryClient();
    qc.setQueryData<RunDetail>(runDetailKey(PORT, RUN), {
      meta: { id: RUN } as RunMeta,
      entries: [entry('first')],
      evidence: [],
      mutations: [],
    });
    applyRunEvent(qc, PORT, {
      type: 'run.log',
      runId: RUN,
      entry: entry('second'),
    });
    applyRunEvent(qc, PORT, {
      type: 'run.log',
      runId: 'r-000002',
      entry: entry('elsewhere'),
    });
    expect(texts(qc.getQueryData<RunDetail>(runDetailKey(PORT, RUN)))).toEqual([
      'first',
      'second',
    ]);
    expect(qc.getQueryData(runDetailKey(PORT, 'r-000002'))).toBeUndefined();
  });

  // The fetch was read before the entry was logged, so landing as it is would
  // wipe the entry the frame just appended.
  it('keeps an entry logged while the detail is first fetched', async () => {
    const server = gatedRunServer();
    server.gated = true;
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(server.pending).toHaveLength(1);
    });
    server.log(qc, 'second');
    server.gated = false;
    server.release();
    await waitFor(() => {
      expect(qc.isFetching()).toBe(0);
      expect(texts(result.current)).toEqual(['first', 'second']);
    });
    expect(qc.getQueryState(runDetailKey(PORT, RUN))?.status).toBe('success');
  });

  it('keeps an entry logged during a background refetch', async () => {
    const server = gatedRunServer();
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(texts(result.current)).toEqual(['first']);
    });
    server.gated = true;
    void qc.invalidateQueries({ queryKey: runDetailKey(PORT, RUN) });
    await waitFor(() => {
      expect(server.pending).toHaveLength(1);
    });
    server.log(qc, 'second');
    // Shown at once, while the repair fetch is still out.
    await waitFor(() => {
      expect(texts(result.current)).toEqual(['first', 'second']);
    });
    server.gated = false;
    server.release();
    await waitFor(() => {
      expect(qc.isFetching()).toBe(0);
      expect(texts(result.current)).toEqual(['first', 'second']);
    });
    expect(qc.getQueryState(runDetailKey(PORT, RUN))?.status).toBe('success');
  });

  // A daemon from before run.log carried `index`: the response may have been
  // read before the entry was written, so landing it as it is would lose it.
  it('fetches once more after a frame with no index lands during a fetch', async () => {
    const server = gatedRunServer();
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(texts(result.current)).toEqual(['first']);
    });
    server.gated = true;
    void qc.invalidateQueries({ queryKey: runDetailKey(PORT, RUN) });
    await waitFor(() => {
      expect(server.pending).toHaveLength(1);
    });
    const second = entry('second');
    server.entries.push(second);
    applyRunEvent(qc, PORT, { type: 'run.log', runId: RUN, entry: second });
    await waitFor(() => {
      expect(texts(result.current)).toEqual(['first', 'second']);
    });
    server.gated = false;
    server.release();
    await waitFor(() => {
      expect(server.fetches).toBe(3);
      expect(qc.isFetching()).toBe(0);
      expect(texts(result.current)).toEqual(['first', 'second']);
    });
  });

  // An agent that writes faster than a fetch round trip: restarting the fetch
  // per frame would never let the detail land.
  it('lands the first fetch while entries keep streaming, with every entry', async () => {
    const server = gatedRunServer();
    server.gated = true;
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(server.pending).toHaveLength(1);
    });
    for (let i = 0; i < 50; i++) server.log(qc, `chunk ${i}`);
    server.release();
    await waitFor(() => {
      expect(result.current?.entries).toHaveLength(51);
    });
    for (let i = 50; i < 60; i++) server.log(qc, `chunk ${i}`);
    await waitFor(() => {
      expect(texts(result.current)).toEqual(texts(server.snapshot()));
    });
    expect(server.fetches).toBe(1);
  });

  it('skips a frame the detail already holds and refetches once after a missed one', async () => {
    const server = gatedRunServer();
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(texts(result.current)).toEqual(['first']);
    });
    // The response held it, and its frame comes in late.
    applyRunEvent(qc, PORT, {
      type: 'run.log',
      runId: RUN,
      entry: entry('first'),
      index: 0,
    });
    expect(texts(result.current)).toEqual(['first']);
    // Entry 1 was never heard of: 2 and 3 cannot be placed, and one fetch fills it in.
    server.entries.push(entry('second'), entry('third'), entry('fourth'));
    for (const index of [2, 3]) {
      applyRunEvent(qc, PORT, {
        type: 'run.log',
        runId: RUN,
        entry: server.entries[index],
        index,
      });
    }
    await waitFor(() => {
      expect(texts(result.current)).toEqual([
        'first',
        'second',
        'third',
        'fourth',
      ]);
    });
    expect(server.fetches).toBe(2);
  });
});

function delta(seq: number, segmentId: string, text: string) {
  return {
    type: 'run.delta' as const,
    runId: RUN,
    turnId: 'turn-1',
    seq,
    segmentId,
    text,
  };
}

const liveOf = () => liveTextStore.get(PORT, runLiveKey(RUN));

describe('applyRunEvent run.delta', () => {
  // Frames are view-only: refetching the detail per frame would cancel the
  // very fetch that repairs a gap.
  it('folds frames into the run’s live text and leaves the detail alone', async () => {
    const server = gatedRunServer();
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(result.current).toBeDefined();
    });
    applyRunEvent(qc, PORT, delta(1, 'msg_1:0', 'Reading '));
    applyRunEvent(qc, PORT, delta(2, 'msg_1:0', 'the tests.'));
    expect(liveOf()?.segments).toEqual([
      { id: 'msg_1:0', text: 'Reading the tests.' },
    ]);
    expect(qc.getQueryState(runDetailKey(PORT, RUN))?.isInvalidated).toBe(
      false
    );
  });

  it('refetches the detail once after a missed frame', async () => {
    const server = gatedRunServer();
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(result.current).toBeDefined();
    });
    applyRunEvent(qc, PORT, delta(4, 'msg_1:0', 'tail only'));
    applyRunEvent(qc, PORT, delta(5, 'msg_1:0', ' and more'));
    expect(liveOf()?.stale).toBe(true);
    await waitFor(() => {
      expect(server.fetches).toBe(2);
      expect(qc.isFetching()).toBe(0);
    });
  });

  // Every run's frames reach every window: a run nobody here shows would
  // otherwise keep all the text it ever streamed, until the next hello.
  it('keeps no text for a run no surface shows', () => {
    const qc = new QueryClient();
    qc.setQueryData(runDetailKey(PORT, RUN), {
      meta: { id: RUN } as RunMeta,
      entries: [],
      evidence: [],
      mutations: [],
    });
    applyRunEvent(qc, PORT, delta(1, 'msg_1:0', 'Reading '));
    expect(liveOf()).toBeUndefined();
  });

  it('drops a segment its stream abandoned', async () => {
    const server = gatedRunServer();
    const { qc, result } = mount(server.client);
    await waitFor(() => {
      expect(result.current).toBeDefined();
    });
    applyRunEvent(qc, PORT, delta(1, 'msg_A:0', 'Half a sen'));
    applyRunEvent(qc, PORT, {
      ...delta(2, 'msg_A:0', ''),
      abandoned: true,
    });
    expect(liveOf()?.segments).toEqual([]);
    expect(liveOf()?.abandoned).toEqual(['msg_A:0']);
  });
});

// A daemon answering every detail read with the run's state, entries and live
// text as they stand when the read is made.
function liveRunServer(live: LiveText | undefined) {
  const server = {
    state: 'running' as RunMeta['state'],
    entries: [] as NormalizedEntry[],
    live,
    client: {
      fetchRun: (): Promise<RunDetailView> =>
        Promise.resolve({
          meta: { id: RUN, state: server.state } as RunMeta,
          entries: [...server.entries],
          evidence: [],
          mutations: [],
          ...(server.live === undefined ? {} : { live: server.live }),
        }),
    } as unknown as ApiClient,
  };
  return server;
}

function mountLive(client: ApiClient) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return {
    qc,
    ...renderHook(
      () => {
        const detail = useRunDetail(client, PORT, RUN);
        return { detail, live: useRunLive(PORT, detail) };
      },
      { wrapper }
    ),
  };
}

// The app's own query default: a detail fetched in the last 30s is not
// refetched when a surface shows its run again.
function mountShared(client: ApiClient) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  const show = () =>
    renderHook(
      () => {
        const detail = useRunDetail(client, PORT, RUN);
        return { detail, live: useRunLive(PORT, detail) };
      },
      { wrapper }
    );
  return { qc, show };
}

describe('a run’s live text', () => {
  it('starts from the snapshot its detail carries, which the cache never keeps', async () => {
    const server = liveRunServer({
      seq: 3,
      turnId: 'turn-1',
      segments: [{ id: 'msg_1:0', text: 'Reading the tests.' }],
    });
    const { qc, result } = mountLive(server.client);
    await waitFor(() => {
      expect(result.current.live?.segments).toEqual([
        { id: 'msg_1:0', text: 'Reading the tests.' },
      ]);
    });
    expect(
      'live' in (qc.getQueryData<object>(runDetailKey(PORT, RUN)) ?? {})
    ).toBe(false);

    // The next frame follows on from the snapshot.
    act(() => {
      applyRunEvent(qc, PORT, delta(4, 'msg_1:1', 'Next.'));
    });
    expect(result.current.live?.segments.map((s) => s.id)).toEqual([
      'msg_1:0',
      'msg_1:1',
    ]);
  });

  // Frames go unread while no surface shows the run, so text kept from before
  // would be wrong when it is shown again: a segment abandoned meanwhile
  // would stay on screen for the rest of the run.
  it('lets go of a hidden run’s text and starts again from the snapshot when it is shown', async () => {
    const server = liveRunServer(undefined);
    const { qc, show } = mountShared(server.client);
    const first = show();
    await waitFor(() => {
      expect(first.result.current.detail).toBeDefined();
    });
    act(() => {
      applyRunEvent(qc, PORT, delta(1, 'msg_A:0', 'Half a sen'));
    });
    expect(first.result.current.live?.segments.map((s) => s.id)).toEqual([
      'msg_A:0',
    ]);
    first.unmount();

    applyRunEvent(qc, PORT, { ...delta(2, 'msg_A:0', ''), abandoned: true });
    applyRunEvent(qc, PORT, delta(3, 'msg_B:0', 'Retrying.'));
    expect(liveOf()).toBeUndefined();
    server.live = {
      turnId: 'turn-1',
      seq: 3,
      segments: [{ id: 'msg_B:0', text: 'Retrying.' }],
    };

    const second = show();
    expect(second.result.current.live?.segments ?? []).toEqual([]);
    await waitFor(() => {
      expect(second.result.current.live?.segments).toEqual([
        { id: 'msg_B:0', text: 'Retrying.' },
      ]);
    });
  });

  it('drops a segment once its entry lands, and everything once the run ends', async () => {
    const server = liveRunServer(undefined);
    const { qc, result } = mountLive(server.client);
    await waitFor(() => {
      expect(result.current.detail).toBeDefined();
    });
    act(() => {
      applyRunEvent(qc, PORT, delta(1, 'msg_1:0', 'Done reading.'));
      applyRunEvent(qc, PORT, delta(2, 'msg_1:1', 'Now'));
    });
    expect(result.current.live?.segments).toHaveLength(2);

    const finished: NormalizedEntry = {
      ...entry('Done reading.'),
      streamId: 'msg_1:0',
    };
    server.entries.push(finished);
    act(() => {
      applyRunEvent(qc, PORT, { type: 'run.log', runId: RUN, entry: finished });
    });
    await waitFor(() => {
      expect(result.current.live?.segments).toEqual([
        { id: 'msg_1:1', text: 'Now' },
      ]);
    });
    // The store does not keep the text of a segment its entry now holds.
    expect(liveOf()?.segments.map((s) => s.id)).toEqual(['msg_1:1']);

    server.state = 'finished';
    await act(() =>
      qc.invalidateQueries({ queryKey: runDetailKey(PORT, RUN) })
    );
    await waitFor(() => {
      expect(result.current.detail?.meta.state).toBe('finished');
    });
    expect(result.current.live).toBeNull();
    // A finished run takes no more text: its key leaves the store.
    expect(liveOf()).toBeUndefined();
  });
});
