import type { ApiClient } from '@dispatch/client';
import type {
  FileContents,
  FileDiffContentsLoader,
  FileDiffLoadedFiles,
} from '@pierre/diffs';
import { useCallback, useMemo, useRef } from 'react';

/** One side of a run file's contents, plus the hash `applyRunEdit` needs as its precondition. */
interface RunFileSide {
  contents: string;
  sha: string;
}

export interface UseRunFileLoaderResult {
  /** Pierre's `BaseDiffOptions.loadDiffFiles`, or `undefined` when there is no run to fetch
   * against — callers should omit the option entirely rather than pass a loader that always
   * fails, matching how the diff rendered before this loader existed. */
  loadDiffFiles: FileDiffContentsLoader | undefined;
  /** Ensures the current (`new`) side of `file` is fetched and cached, resolving with it (or
   * `null` on failure). The edit-mode task uses this to check "are this file's contents loaded
   * yet?" and to read the `sha` its save precondition needs. */
  ensureLoaded: (file: string) => Promise<RunFileSide | null>;
}

type Side = 'old' | 'new';

/**
 * Supplies file contents beyond what a patch's own hunks carry, so Pierre's diff view can expand
 * unchanged regions (and, in a later task, edit them). Caches per (path, side) and dedupes
 * concurrent requests for the same one — Pierre can ask for a file more than once as the reviewer
 * scrolls or expands hunks, and two in-flight fetches for one file would race.
 */
export function useRunFileLoader(
  client: ApiClient | null,
  runId: string | undefined
): UseRunFileLoaderResult {
  // Keyed by `${runId}:${side}:${path}` — the `runId` segment is not optional. Two runs can
  // touch the same path (a retry, a related task, a stack), and this Map is a single `useRef`
  // that outlives any one `runId`: neither `PierreReviewDiff` nor its call sites remount when
  // the reviewer switches runs in the same session (the review queue and the run detail panel
  // both swap `runId` in place, no `key` prop tears the component down). Without `runId` in the
  // key, run B would read run A's cached contents and sha — silently wrong code, and a stale
  // sha that would let an edit in the next task write against the wrong baseline. Storing the
  // promise itself (not just its resolved value) is what makes a repeat call before the first
  // one settles reuse it instead of firing a second request.
  const cacheRef = useRef(new Map<string, Promise<RunFileSide | null>>());

  const fetchSide = useCallback(
    (path: string, side: Side): Promise<RunFileSide | null> => {
      const key = `${runId ?? ''}:${side}:${path}`;
      const cached = cacheRef.current.get(key);
      if (cached !== undefined) return cached;
      // With no run to ask, there is nothing to fetch — resolve null rather than reject, same
      // as a missing side, so callers never have to special-case "no runId" separately.
      const promise =
        client === null || runId === undefined
          ? Promise.resolve(null)
          : client.fetchRunFile(runId, path, side).catch(() => null);
      cacheRef.current.set(key, promise);
      return promise;
    },
    [client, runId]
  );

  const ensureLoaded = useCallback(
    (file: string) => fetchSide(file, 'new'),
    [fetchSide]
  );

  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    if (client === null || runId === undefined) return undefined;
    return async (fileDiff): Promise<FileDiffLoadedFiles> => {
      // A rename's old content lives at the pre-rename path on the base side; every other type
      // reads the same path on both sides.
      const oldPath = fileDiff.prevName ?? fileDiff.name;
      const isPureRename = fileDiff.type === 'rename-pure';
      const [oldResult, newResult] = await Promise.all([
        isPureRename ? Promise.resolve(null) : fetchSide(oldPath, 'old'),
        fetchSide(fileDiff.name, 'new'),
      ]);
      const newFile: FileContents = {
        name: fileDiff.name,
        // `FileDiffLoadedFiles` always requires a `newFile` — this only falls back to empty
        // when the new side itself failed to load, which the diff renders as an empty file
        // rather than crashing.
        contents: newResult?.contents ?? '',
      };
      // A pure rename has no old content by definition, and any other failed/missing old side
      // (404 or a fetch error) resolves the same way `FileDiffLoadedFiles` lets a rename report
      // one — Pierre still renders the new side rather than the whole diff failing.
      if (isPureRename || oldResult === null) {
        return { oldFile: null, newFile };
      }
      return {
        oldFile: { name: oldPath, contents: oldResult.contents },
        newFile,
      };
    };
  }, [client, runId, fetchSide]);

  return { loadDiffFiles, ensureLoaded };
}
