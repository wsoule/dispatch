import { DEFAULT_THEMES } from '@pierre/diffs';
import { WorkerPoolContextProvider } from '@pierre/diffs/react';
// Vite's `?worker&url` import query resolves this to the built worker
// script's URL rather than its module contents — the exact pattern
// @pierre/diffs' own Vite demo app uses (apps/demo/src/utils/createWorkerAPI.ts
// in pierrecomputer/pierre) for constructing the worker `PatchDiff`'s
// `WorkerPoolContext` needs to run Shiki syntax highlighting off the main
// thread. `vite/client`'s ambient types (referenced from vite-env.d.ts)
// declare this module shape, so no local `.d.ts` is needed for it. The
// import-resolution lint rule doesn't understand Vite's virtual module
// semantics for this query suffix, hence the disable below.
// oxlint-disable-next-line import/default
import WorkerUrl from '@pierre/diffs/worker/worker.js?worker&url';
import type { ReactNode } from 'react';

interface PierreWorkerPoolProps {
  children: ReactNode;
}

/**
 * Wraps `PatchDiff` (RunReviewView) in the worker pool @pierre/diffs uses to
 * tokenize/highlight file contents off the main thread, per the plan's
 * "PatchDiff ... with WorkerPoolContext" requirement. Scoped to just the
 * review view rather than the whole app — the pool (and its Shiki
 * highlighter) only needs to exist while a finished run's diff is actually
 * open, not for the lifetime of the Tasks tab. A small fixed pool size (2)
 * is plenty for one diff view at a time; @pierre/diffs defaults to 8, sized
 * for apps rendering many diffs concurrently, which this isn't.
 */
export function PierreWorkerPool({ children }: PierreWorkerPoolProps) {
  return (
    <WorkerPoolContextProvider
      poolOptions={{
        poolSize: 2,
        workerFactory: () => new Worker(WorkerUrl, { type: 'module' }),
      }}
      highlighterOptions={{ theme: DEFAULT_THEMES }}
    >
      {children}
    </WorkerPoolContextProvider>
  );
}
