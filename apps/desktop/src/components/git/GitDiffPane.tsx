import { FileDiff } from '@pierre/diffs/react';
import { CircleAlert, FileX, Loader2 } from 'lucide-react';
import { useMemo } from 'react';

import { PierreWorkerPool } from '../runs/PierreWorkerPool';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { splitPatchFiles } from '@/lib/patchFiles';

interface GitDiffPaneProps {
  patch: string | undefined;
  loading: boolean;
  /** Restricts rendering to one file's diff within the patch. Omit to render every file. */
  only?: string;
  emptyLabel?: string;
}

/** The Git page's diff renderer: `splitPatchFiles` + Pierre's `<FileDiff>`, the same building
 * blocks `RunDiffView` uses for a run's diff — no file tree, no review-comment annotations. */
export function GitDiffPane({
  patch,
  loading,
  only,
  emptyLabel = 'No changes to show.',
}: GitDiffPaneProps) {
  const parsed = useMemo(() => {
    if (patch === undefined || patch.trim() === '') return null;
    return splitPatchFiles(patch);
  }, [patch]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4">
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (parsed === null) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <FileX className="size-4" />
        <p className="text-[12px]">{emptyLabel}</p>
      </div>
    );
  }
  if (parsed.error !== null) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <CircleAlert className="size-5" />
        <p className="text-[13px]">
          Couldn&rsquo;t load the diff: {parsed.error}
        </p>
      </div>
    );
  }

  const files =
    only === undefined
      ? parsed.files
      : parsed.files.filter((f) => f.name === only);

  if (files.length === 0) {
    return (
      <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
        <FileX className="size-4" />
        <p className="text-[12px]">{emptyLabel}</p>
      </div>
    );
  }

  return (
    <PierreWorkerPool>
      <div className="flex flex-col">
        {files.map((file) => (
          <ErrorBoundary key={file.name} label={`the diff for ${file.name}`}>
            <FileDiff fileDiff={file} />
          </ErrorBoundary>
        ))}
      </div>
    </PierreWorkerPool>
  );
}
