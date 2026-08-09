import { DiffSurface } from '../code/DiffSurface';

interface GitDiffPaneProps {
  patch: string | undefined;
  loading: boolean;
  /** Restricts rendering to one file's diff within the patch. Omit to render every file. */
  only?: string;
  emptyLabel?: string;
}

/** The Git page's diff renderer: the shared `DiffSurface` with no review state layered on —
 * no file tree, no comment threads, no findings. */
export function GitDiffPane({
  patch,
  loading,
  only,
  emptyLabel = 'No changes to show.',
}: GitDiffPaneProps) {
  return (
    <DiffSurface
      patch={patch}
      loading={loading}
      only={only}
      emptyLabel={emptyLabel}
    />
  );
}
