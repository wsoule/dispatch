import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs';
import type { CodeViewHandle, CodeViewProps } from '@pierre/diffs/react';
import { CodeView } from '@pierre/diffs/react';
import { CircleAlert, FileX, Loader2 } from 'lucide-react';
import type { Ref } from 'react';
import { useMemo } from 'react';

import { PierreWorkerPool } from '../runs/PierreWorkerPool';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { useDiffDisplaySettings } from '@/hooks/useDiffDisplaySettings';
import { toDiffRenderOptions } from '@/lib/diffDisplay';
import { splitPatchFiles } from '@/lib/patchFiles';

interface DiffSurfaceProps<T> {
  /** The raw multi-file patch. `undefined` (or blank) renders `emptyLabel`. */
  patch: string | undefined;
  loading?: boolean;
  /** Restricts rendering to one file's diff within the patch. Omit to render every file. */
  only?: string;
  /** Kept per caller rather than unified: each surface says something different about what
   * "nothing here" means, and those sentences are user-facing. */
  emptyLabel?: string;
  /**
   * Layers review state (annotations, collapsed, edit) onto the parsed files. A builder rather
   * than a plain array so this component stays the only place a patch is parsed and the
   * empty/parse-error states are decided. Defaults to one plain diff item per file.
   */
  items?: (files: FileDiffMetadata[]) => CodeViewItem<T>[];
  /** Extra `CodeView` options merged over the user's diff-display settings. */
  options?: CodeViewProps<T>['options'];
  renderAnnotation?: CodeViewProps<T>['renderAnnotation'];
  renderGutterUtility?: CodeViewProps<T>['renderGutterUtility'];
  renderHeaderMetadata?: CodeViewProps<T>['renderHeaderMetadata'];
  onSelectedLinesChange?: CodeViewProps<T>['onSelectedLinesChange'];
  /**
   * Classes for the `CodeView` element itself, which must stay the actual scroll container:
   * `CodeView` attaches its scroll listener to this exact element and reads its own `scrollTop`
   * to pick the virtualized row window, so an ancestor owning `overflow-auto` instead leaves it
   * permanently 0 and the diff never advances past the first screenful.
   *
   * The default requires the caller's parent to be a flex column with a resolved height, and
   * `flex-1` then sizes off it directly. A percentage height instead has to resolve through
   * whatever chain of stretched grid/flex ancestors the caller sits in, which some engines
   * collapse to zero — that reads as a pane rendering its file header and no code at all.
   */
  className?: string;
  /** Handle for imperative `scrollTo` — how a file tree jumps to a file within the one scroller. */
  viewRef?: Ref<CodeViewHandle<T>>;
}

// One plain diff item per file: what a surface with no review state layered on top needs.
function toDiffItems<T>(files: FileDiffMetadata[]): CodeViewItem<T>[] {
  return files.map((fileDiff) => ({
    id: fileDiff.name,
    type: 'diff',
    fileDiff,
  }));
}

/**
 * The one diff renderer: patch in, a single virtualized `CodeView` out, plus the loading,
 * parse-error and empty states every diff surface used to spell out for itself.
 *
 * One `CodeView` rather than a stack of `FileDiff`s because only `CodeView` supports line
 * annotations — which is what lets comment threads, findings and selection actions be wired
 * once here instead of once per surface.
 */
export function DiffSurface<T = undefined>({
  patch,
  loading = false,
  only,
  emptyLabel = 'No changes to show.',
  items,
  options,
  renderAnnotation,
  renderGutterUtility,
  renderHeaderMetadata,
  onSelectedLinesChange,
  className = 'min-h-0 w-full flex-1 overflow-auto',
  viewRef,
}: DiffSurfaceProps<T>) {
  // Parsed once per patch: either the per-file diff metadata or an inline-able error.
  // `null` while there is nothing to parse (no patch yet, or an empty one).
  const parsed = useMemo(
    () =>
      patch === undefined || patch.trim() === ''
        ? null
        : splitPatchFiles(patch),
    [patch]
  );
  const [diffDisplay] = useDiffDisplaySettings();
  const diffOptions = useMemo(
    () => ({ ...toDiffRenderOptions(diffDisplay), ...options }),
    [diffDisplay, options]
  );
  const files = useMemo(() => {
    if (parsed === null || parsed.error !== null) return [];
    return only === undefined
      ? parsed.files
      : parsed.files.filter((f) => f.name === only);
  }, [parsed, only]);
  const codeItems = useMemo(
    () => (items === undefined ? toDiffItems<T>(files) : items(files)),
    [items, files]
  );

  // `h-full` fills a caller whose parent is a plain block; `flex-1` does the same where the
  // parent is a flex column, in which a percentage height can resolve to zero.
  const stateClass =
    'text-muted-foreground flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4';

  if (loading) {
    return (
      <div className={stateClass}>
        <Loader2 className="size-4 animate-spin" />
      </div>
    );
  }
  if (parsed !== null && parsed.error !== null) {
    return (
      <div className={`${stateClass} text-center`}>
        <CircleAlert className="size-5" />
        <p className="text-[13px]">
          Couldn&rsquo;t load the diff: {parsed.error}
        </p>
      </div>
    );
  }
  if (files.length === 0) {
    return (
      <div className={`${stateClass} text-center`}>
        <FileX className="size-4" />
        <p className="text-[12px]">{emptyLabel}</p>
      </div>
    );
  }

  return (
    // One boundary for the whole view: with a single `CodeView` there is no longer a per-file
    // subtree to fail on its own, so a crash in any file costs the diff rather than the app.
    <ErrorBoundary label="the diff">
      <PierreWorkerPool lineDiffType={diffOptions.lineDiffType}>
        <CodeView<T>
          ref={viewRef}
          items={codeItems}
          options={diffOptions}
          renderAnnotation={renderAnnotation}
          renderGutterUtility={renderGutterUtility}
          renderHeaderMetadata={renderHeaderMetadata}
          onSelectedLinesChange={onSelectedLinesChange}
          className={className}
        />
      </PierreWorkerPool>
    </ErrorBoundary>
  );
}
