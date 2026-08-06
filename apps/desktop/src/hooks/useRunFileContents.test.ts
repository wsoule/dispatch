import type { ApiClient } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import type { FileDiffMetadata } from '@pierre/diffs';
import { renderHook } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { useRunFileLoader } from './useRunFileContents';

const RUN_ID = 'run-1';

// Minimal but type-complete `FileDiffMetadata` — only `name`/`prevName`/`type` vary per test,
// the rest are fields the loader never reads.
function metadata(
  overrides: Partial<FileDiffMetadata> & {
    name: string;
    type: FileDiffMetadata['type'];
  }
): FileDiffMetadata {
  return {
    hunks: [],
    splitLineCount: 0,
    unifiedLineCount: 0,
    isPartial: true,
    deletionLines: [],
    additionLines: [],
    ...overrides,
  };
}

interface FetchCall {
  runId: string;
  path: string;
  side: 'old' | 'new';
}

// A `fetchRunFile` stub that logs every call and resolves/rejects per a caller-supplied map
// keyed the same way the hook's own cache is (`${side}:${path}`), so a test can assert both
// the returned value and exactly how many real requests it took to get there.
function stubClient(
  responses: Record<string, { contents: string; sha: string } | ApiError>
): { client: ApiClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const client = {
    fetchRunFile: (runId: string, path: string, side: 'old' | 'new') => {
      calls.push({ runId, path, side });
      const response = responses[`${side}:${path}`];
      if (response === undefined) {
        return Promise.reject(new ApiError('no such file: ' + path, 404));
      }
      if (response instanceof ApiError) return Promise.reject(response);
      return Promise.resolve(response);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

// Same shape as `stubClient`, but the response map is keyed by `runId` first — for asserting
// that switching runs actually reaches the server again rather than serving a previous run's
// cached answer.
function stubClientPerRun(
  responses: Record<
    string,
    Record<string, { contents: string; sha: string } | ApiError>
  >
): { client: ApiClient; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const client = {
    fetchRunFile: (runId: string, path: string, side: 'old' | 'new') => {
      calls.push({ runId, path, side });
      const response = responses[runId]?.[`${side}:${path}`];
      if (response === undefined) {
        return Promise.reject(new ApiError('no such file: ' + path, 404));
      }
      if (response instanceof ApiError) return Promise.reject(response);
      return Promise.resolve(response);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

describe('useRunFileLoader — loadDiffFiles', () => {
  test('with no runId, supplies no loader at all', () => {
    const { client } = stubClient({});
    const { result } = renderHook(() => useRunFileLoader(client, undefined));
    expect(result.current.loadDiffFiles).toBeUndefined();
  });

  test('with no client, supplies no loader at all', () => {
    const { result } = renderHook(() => useRunFileLoader(null, RUN_ID));
    expect(result.current.loadDiffFiles).toBeUndefined();
  });

  test('a changed file fetches and returns both sides', async () => {
    const { client, calls } = stubClient({
      'old:a.txt': { contents: 'before\n', sha: 's1' },
      'new:a.txt': { contents: 'after\n', sha: 's2' },
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const loaded = await result.current.loadDiffFiles?.(
      metadata({ name: 'a.txt', type: 'change' })
    );
    expect(loaded).toEqual({
      oldFile: { name: 'a.txt', contents: 'before\n' },
      newFile: { name: 'a.txt', contents: 'after\n' },
    });
    expect(calls).toHaveLength(2);
  });

  test('a pure rename fetches only the new side and reports oldFile null', async () => {
    const { client, calls } = stubClient({
      'new:new-name.txt': { contents: 'same\n', sha: 's1' },
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const loaded = await result.current.loadDiffFiles?.(
      metadata({
        name: 'new-name.txt',
        prevName: 'old-name.txt',
        type: 'rename-pure',
      })
    );
    expect(loaded).toEqual({
      oldFile: null,
      newFile: { name: 'new-name.txt', contents: 'same\n' },
    });
    // The old side of a pure rename is never even asked for.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ path: 'new-name.txt', side: 'new' });
  });

  test('a changed rename reads the old side at its pre-rename path', async () => {
    const { client, calls } = stubClient({
      'old:old-name.txt': { contents: 'before\n', sha: 's1' },
      'new:new-name.txt': { contents: 'after\n', sha: 's2' },
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const loaded = await result.current.loadDiffFiles?.(
      metadata({
        name: 'new-name.txt',
        prevName: 'old-name.txt',
        type: 'rename-changed',
      })
    );
    expect(loaded).toEqual({
      oldFile: { name: 'old-name.txt', contents: 'before\n' },
      newFile: { name: 'new-name.txt', contents: 'after\n' },
    });
    expect(calls.map((c) => c.path)).toEqual(['old-name.txt', 'new-name.txt']);
  });

  test('a 404 on the old side (added file) resolves oldFile to null rather than throwing', async () => {
    const { client } = stubClient({
      'new:added.txt': { contents: 'new content\n', sha: 's1' },
      // 'old:added.txt' intentionally absent from the map, so the stub 404s.
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const loaded = await result.current.loadDiffFiles?.(
      metadata({ name: 'added.txt', type: 'new' })
    );
    expect(loaded).toEqual({
      oldFile: null,
      newFile: { name: 'added.txt', contents: 'new content\n' },
    });
  });

  test('a 404 on the new side (deleted file) falls back to empty content rather than throwing', async () => {
    const { client } = stubClient({
      'old:removed.txt': { contents: 'old content\n', sha: 's1' },
      // 'new:removed.txt' intentionally absent from the map, so the stub 404s — the file no
      // longer exists in the run's worktree.
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const loaded = await result.current.loadDiffFiles?.(
      metadata({ name: 'removed.txt', type: 'deleted' })
    );
    // `FileDiffLoadedFiles` has no "no newFile" variant — an empty string is the closest thing
    // to absent the type allows, and the diff still renders rather than throwing.
    expect(loaded).toEqual({
      oldFile: { name: 'removed.txt', contents: 'old content\n' },
      newFile: { name: 'removed.txt', contents: '' },
    });
  });

  test('a non-404 failure also resolves to null rather than crashing the diff', async () => {
    const { client } = stubClient({
      'old:flaky.txt': new ApiError('boom', 500),
      'new:flaky.txt': { contents: 'ok\n', sha: 's1' },
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const loaded = await result.current.loadDiffFiles?.(
      metadata({ name: 'flaky.txt', type: 'change' })
    );
    expect(loaded).toEqual({
      oldFile: null,
      newFile: { name: 'flaky.txt', contents: 'ok\n' },
    });
  });

  test('caches per (file, side): a second request for the same file does not refetch', async () => {
    const { client, calls } = stubClient({
      'old:a.txt': { contents: 'before\n', sha: 's1' },
      'new:a.txt': { contents: 'after\n', sha: 's2' },
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const fileDiff = metadata({ name: 'a.txt', type: 'change' });
    await result.current.loadDiffFiles?.(fileDiff);
    await result.current.loadDiffFiles?.(fileDiff);
    expect(calls).toHaveLength(2);
  });

  test('dedupes concurrent in-flight requests for the same file', async () => {
    let resolveOld:
      | ((v: { contents: string; sha: string }) => void)
      | undefined;
    let resolveNew:
      | ((v: { contents: string; sha: string }) => void)
      | undefined;
    const calls: FetchCall[] = [];
    const client = {
      fetchRunFile: (runId: string, path: string, side: 'old' | 'new') => {
        calls.push({ runId, path, side });
        return new Promise<{ contents: string; sha: string }>((resolve) => {
          if (side === 'old') resolveOld = resolve;
          else resolveNew = resolve;
        });
      },
    } as unknown as ApiClient;
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const fileDiff = metadata({ name: 'a.txt', type: 'change' });

    // Two concurrent requests before either side has resolved — a naive implementation would
    // fire the request twice per side.
    const first = result.current.loadDiffFiles?.(fileDiff);
    const second = result.current.loadDiffFiles?.(fileDiff);
    expect(calls).toHaveLength(2); // one 'old' + one 'new', not four

    resolveOld?.({ contents: 'before\n', sha: 's1' });
    resolveNew?.({ contents: 'after\n', sha: 's2' });
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
  });
});

describe('useRunFileLoader — ensureLoaded', () => {
  test('resolves the new side with its sha', async () => {
    const { client } = stubClient({
      'new:a.txt': { contents: 'hello\n', sha: 'abc123' },
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const loaded = await result.current.ensureLoaded('a.txt');
    expect(loaded).toEqual({ contents: 'hello\n', sha: 'abc123' });
  });

  test('resolves null on a 404 rather than throwing', async () => {
    const { client } = stubClient({});
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    const loaded = await result.current.ensureLoaded('missing.txt');
    expect(loaded).toBeNull();
  });

  test('resolves null with no client or runId', async () => {
    const { result: noClient } = renderHook(() =>
      useRunFileLoader(null, RUN_ID)
    );
    expect(await noClient.current.ensureLoaded('a.txt')).toBeNull();

    const { client } = stubClient({});
    const { result: noRun } = renderHook(() =>
      useRunFileLoader(client, undefined)
    );
    expect(await noRun.current.ensureLoaded('a.txt')).toBeNull();
  });

  test('caches: a second call for the same file does not refetch', async () => {
    const { client, calls } = stubClient({
      'new:a.txt': { contents: 'hello\n', sha: 'abc123' },
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    await result.current.ensureLoaded('a.txt');
    await result.current.ensureLoaded('a.txt');
    expect(calls).toHaveLength(1);
  });

  test('shares its cache with loadDiffFiles for the same file', async () => {
    const { client, calls } = stubClient({
      'old:a.txt': { contents: 'before\n', sha: 's1' },
      'new:a.txt': { contents: 'after\n', sha: 's2' },
    });
    const { result } = renderHook(() => useRunFileLoader(client, RUN_ID));
    await result.current.ensureLoaded('a.txt');
    await result.current.loadDiffFiles?.(
      metadata({ name: 'a.txt', type: 'change' })
    );
    // ensureLoaded already warmed the 'new' side; loadDiffFiles only had to fetch 'old'.
    expect(calls).toHaveLength(2);
    expect(calls.filter((c) => c.side === 'new')).toHaveLength(1);
  });
});

describe('useRunFileLoader — cache scoping by runId', () => {
  // `PierreReviewDiff` does not remount when the reviewer picks a different run in the same
  // session — the review queue and the run detail panel both swap the `runId` prop in place,
  // no `key` prop tears the component (and its cache) down. `rerender` here reproduces exactly
  // that: same hook instance, same underlying `cacheRef`, new `runId`.
  test('ensureLoaded does not serve one run’s content and sha for another run', async () => {
    const { client } = stubClientPerRun({
      'run-a': {
        'new:src/foo.ts': { contents: 'run A content\n', sha: 'sha-a' },
      },
      'run-b': {
        'new:src/foo.ts': { contents: 'run B content\n', sha: 'sha-b' },
      },
    });
    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) => useRunFileLoader(client, runId),
      { initialProps: { runId: 'run-a' } }
    );

    const runAContent = await result.current.ensureLoaded('src/foo.ts');
    expect(runAContent).toEqual({ contents: 'run A content\n', sha: 'sha-a' });

    rerender({ runId: 'run-b' });
    const runBContent = await result.current.ensureLoaded('src/foo.ts');
    // The precondition for the next task's edit mode: run B's sha, not run A's stale one.
    expect(runBContent).toEqual({ contents: 'run B content\n', sha: 'sha-b' });
  });

  test('loadDiffFiles does not serve one run’s content for another run', async () => {
    const { client } = stubClientPerRun({
      'run-a': {
        'old:src/foo.ts': { contents: 'A before\n', sha: 'sha-a-old' },
        'new:src/foo.ts': { contents: 'A after\n', sha: 'sha-a-new' },
      },
      'run-b': {
        'old:src/foo.ts': { contents: 'B before\n', sha: 'sha-b-old' },
        'new:src/foo.ts': { contents: 'B after\n', sha: 'sha-b-new' },
      },
    });
    const { result, rerender } = renderHook(
      ({ runId }: { runId: string }) => useRunFileLoader(client, runId),
      { initialProps: { runId: 'run-a' } }
    );
    const fileDiff = metadata({ name: 'src/foo.ts', type: 'change' });

    const runALoaded = await result.current.loadDiffFiles?.(fileDiff);
    expect(runALoaded).toEqual({
      oldFile: { name: 'src/foo.ts', contents: 'A before\n' },
      newFile: { name: 'src/foo.ts', contents: 'A after\n' },
    });

    rerender({ runId: 'run-b' });
    const runBLoaded = await result.current.loadDiffFiles?.(fileDiff);
    expect(runBLoaded).toEqual({
      oldFile: { name: 'src/foo.ts', contents: 'B before\n' },
      newFile: { name: 'src/foo.ts', contents: 'B after\n' },
    });
  });
});
