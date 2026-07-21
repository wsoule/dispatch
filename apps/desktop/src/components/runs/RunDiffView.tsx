import type { DiffFile, DiffResult } from '@dispatch/client';
import { PatchDiff } from '@pierre/diffs/react';
import { FileTree, useFileTree } from '@pierre/trees/react';
import { CircleAlert, FileX } from 'lucide-react';
import { useEffect, useMemo } from 'react';

import { normalizeDiffFilePath, toTreeGitStatus } from '../../lib/pierreTree';
import { PierreWorkerPool } from './PierreWorkerPool';
import { Skeleton } from '@/ui/skeleton';

// The changed-files tree for a run's diff, git-status decorated (added/modified/deleted/
// renamed). A separate component (rather than inlined) because `useFileTree`'s model is
// constructed once from its first-render options, so this only mounts once `files` is known and
// re-syncs imperatively if the diff is refetched while the view stays open. The tree/diff
// widgets themselves are @pierre internals, themed globally via styles/pierreTheme.css.
function ChangedFilesTree({ files }: { files: DiffFile[] }) {
  const paths = useMemo(
    () => files.map((f) => normalizeDiffFilePath(f.path)),
    [files]
  );
  const gitStatus = useMemo(
    () =>
      files.map((f) => ({
        path: normalizeDiffFilePath(f.path),
        status: toTreeGitStatus(f.status),
      })),
    [files]
  );
  const { model } = useFileTree({
    paths,
    gitStatus,
    initialExpansion: 'open',
  });

  useEffect(() => {
    model.resetPaths(paths);
    model.setGitStatus(gitStatus);
  }, [model, paths, gitStatus]);

  return (
    <FileTree
      model={model}
      header={
        <span className="text-muted-foreground block px-3 py-2 text-[11px] tracking-wide uppercase">
          Changed files
        </span>
      }
      className="size-full"
    />
  );
}

/**
 * The shared unified-diff view: the @pierre/diffs PatchDiff beside a git-status-decorated
 * @pierre/trees changed-files tree. Used by both the run Review surface and the Pull Requests
 * view so the code renders identically wherever it's shown. Purely presentational — the
 * `diff`/loading/error are owned by the caller.
 */
export function RunDiffView({
  diff,
  diffLoading,
  diffError,
}: {
  diff: DiffResult | undefined;
  diffLoading: boolean;
  diffError: string | null;
}) {
  if (diffLoading) {
    return (
      <div className="grid grid-cols-[14rem_1fr] gap-3">
        <Skeleton className="h-80 rounded-md" />
        <Skeleton className="h-80 rounded-md" />
      </div>
    );
  }
  if (diffError !== null) {
    return (
      <div className="text-muted-foreground flex flex-col items-center justify-center gap-2 py-10 text-center">
        <CircleAlert className="size-5" />
        <p className="text-[13px]">Couldn&rsquo;t load the diff: {diffError}</p>
      </div>
    );
  }
  if (diff === undefined) return null;

  return (
    <div className="grid min-h-80 grid-cols-[14rem_1fr] gap-3">
      <div className="border-border bg-muted/30 overflow-auto rounded-md border">
        {diff.files.length === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <FileX className="size-4" />
            <p className="text-[12px]">No file changes recorded.</p>
          </div>
        ) : (
          <ChangedFilesTree files={diff.files} />
        )}
      </div>
      <div className="border-border overflow-auto rounded-md border">
        {diff.patch.trim() === '' ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <FileX className="size-4" />
            <p className="text-[12px]">No changes to show for this run.</p>
          </div>
        ) : (
          <PierreWorkerPool>
            <PatchDiff patch={diff.patch} />
          </PierreWorkerPool>
        )}
      </div>
    </div>
  );
}
