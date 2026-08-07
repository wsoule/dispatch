import type { CodeViewItem, FileDiffMetadata } from '@pierre/diffs';
import type {
  CodeViewHandle,
  CodeViewProps,
  CreateEditor,
} from '@pierre/diffs/react';
import { CodeView, EditProvider } from '@pierre/diffs/react';
import { CircleAlert, FileX, Loader2 } from 'lucide-react';
import type { ReactNode, Ref } from 'react';
import { useMemo } from 'react';

import { PierreWorkerPool } from '../runs/PierreWorkerPool';
import { ErrorBoundary } from '../shell/ErrorBoundary';
import { useDiffDisplaySettings } from '@/hooks/useDiffDisplaySettings';
import { toDiffRenderOptions } from '@/lib/diffDisplay';
import { splitPatchFiles } from '@/lib/patchFiles';

/** What a surface renders: the files `only` left standing, or an inline-able parse error. */
export interface ParsedPatchFiles {
  files: FileDiffMetadata[];
  error: string | null;
}

/**
 * The one parse a diff surface does: raw patch in, renderable files out, `only` already applied.
 *
 * Exported because a caller can need the file list *outside* item-building — the review diff
 * reads it from an effect, which no render prop can reach. Such a caller runs this hook itself
 * and hands the result back through `DiffSurface`'s `parsed` prop, so the patch is still parsed
 * exactly once per render rather than once in each place that wants the files.
 */
export function useParsedPatchFiles(
  patch: string | undefined,
  only?: string,
  cacheKeyPrefix?: string
): ParsedPatchFiles {
  // `undefined`/blank means there is nothing to parse yet, which is an empty result rather than
  // a failure — the caller shows its "nothing here" sentence, not an error.
  const parsed = useMemo(
    () =>
      patch === undefined || patch.trim() === ''
        ? null
        : splitPatchFiles(patch, cacheKeyPrefix),
    [patch, cacheKeyPrefix]
  );
  return useMemo(() => {
    if (parsed === null) return { files: [], error: null };
    if (parsed.error !== null) return { files: [], error: parsed.error };
    return {
      files:
        only === undefined
          ? parsed.files
          : parsed.files.filter((f) => f.name === only),
      error: null,
    };
  }, [parsed, only]);
}

interface DiffSurfaceProps<T> {
  /** The raw multi-file patch. `undefined` (or blank) renders `emptyLabel`. */
  patch: string | undefined;
  /**
   * The already-parsed form of `patch`, from `useParsedPatchFiles`. Only for a caller that also
   * reads the files itself (see that hook) — passing it skips this component's own parse, so the
   * two can never disagree and the patch is never parsed twice.
   */
  parsed?: ParsedPatchFiles;
  loading?: boolean;
  /** Restricts rendering to one file's diff within the patch. Omit to render every file. */
  only?: string;
  /**
   * Namespaces this patch's entries in the worker pool's render cache. Pierre falls back to
   * keying a file by its path alone, which collides with any other surface showing that path.
   */
  cacheKeyPrefix?: string;
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
  onItemEditComplete?: CodeViewProps<T>['onItemEditComplete'];
  /**
   * Makes items with `edit: true` actually editable: `CodeView` resolves its editor factory from
   * an ancestor `EditProvider`, which is mounted here only when a caller supplies one. Omitted
   * on a read-only surface so no editor machinery is set up for items that never ask for it.
   */
  createEditor?: CreateEditor<T>;
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

/**
 * Runs a slot's render prop inside its own component, so a throw from the *call* lands under the
 * boundary wrapping this rather than above it.
 */
function Slot({ render }: { render: () => ReactNode }) {
  return <>{render()}</>;
}

/**
 * One file's React-rendered slot, isolated. `CodeView` portals each item's header metadata,
 * annotations and gutter into that file's own subtree, so a throw in one file's thread or
 * finding costs that slot instead of blanking the whole pane — the per-file boundaries the
 * one-`CodeView` consolidation would otherwise have dropped.
 */
function isolateSlot(file: string, render: () => ReactNode): ReactNode {
  return (
    <ErrorBoundary label={`the diff for ${file}`}>
      <Slot render={render} />
    </ErrorBoundary>
  );
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
  parsed,
  loading = false,
  only,
  cacheKeyPrefix,
  emptyLabel = 'No changes to show.',
  items,
  options,
  renderAnnotation,
  renderGutterUtility,
  renderHeaderMetadata,
  onSelectedLinesChange,
  onItemEditComplete,
  createEditor,
  className = 'min-h-0 w-full flex-1 overflow-auto',
  viewRef,
}: DiffSurfaceProps<T>) {
  // Skipped when the caller already parsed: `patch` goes in as `undefined`, so the hook returns
  // its empty result without touching the parser rather than parsing the same string twice.
  const ownParse = useParsedPatchFiles(
    parsed === undefined ? patch : undefined,
    only,
    cacheKeyPrefix
  );
  const { files, error } = parsed ?? ownParse;
  const [diffDisplay] = useDiffDisplaySettings();
  const diffOptions = useMemo(
    () => ({ ...toDiffRenderOptions(diffDisplay), ...options }),
    [diffDisplay, options]
  );
  const codeItems = useMemo(
    () => (items === undefined ? toDiffItems<T>(files) : items(files)),
    [items, files]
  );
  // Memoized because `CodeView` memoizes its slot portals on these identities — a fresh wrapper
  // each render would re-render every file's slots on every keystroke in a composer.
  const slots = useMemo(
    () => ({
      renderAnnotation:
        renderAnnotation === undefined
          ? undefined
          : (
              annotation: Parameters<NonNullable<typeof renderAnnotation>>[0],
              item: Parameters<NonNullable<typeof renderAnnotation>>[1]
            ) => isolateSlot(item.id, () => renderAnnotation(annotation, item)),
      renderGutterUtility:
        renderGutterUtility === undefined
          ? undefined
          : (
              getHoveredLine: Parameters<
                NonNullable<typeof renderGutterUtility>
              >[0],
              item: Parameters<NonNullable<typeof renderGutterUtility>>[1]
            ) =>
              isolateSlot(item.id, () =>
                renderGutterUtility(getHoveredLine, item)
              ),
      renderHeaderMetadata:
        renderHeaderMetadata === undefined
          ? undefined
          : (item: Parameters<NonNullable<typeof renderHeaderMetadata>>[0]) =>
              isolateSlot(item.id, () => renderHeaderMetadata(item)),
    }),
    [renderAnnotation, renderGutterUtility, renderHeaderMetadata]
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
  if (error !== null) {
    return (
      <div className={`${stateClass} text-center`}>
        <CircleAlert className="size-5" />
        <p className="text-[13px]">Couldn&rsquo;t load the diff: {error}</p>
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

  const view = (
    <PierreWorkerPool lineDiffType={diffOptions.lineDiffType}>
      <CodeView<T>
        ref={viewRef}
        items={codeItems}
        options={diffOptions}
        renderAnnotation={slots.renderAnnotation}
        renderGutterUtility={slots.renderGutterUtility}
        renderHeaderMetadata={slots.renderHeaderMetadata}
        onSelectedLinesChange={onSelectedLinesChange}
        onItemEditComplete={onItemEditComplete}
        className={className}
      />
    </PierreWorkerPool>
  );

  return (
    // The outer boundary: the per-file ones above cover each file's own slots, and this catches
    // everything that is not one file's — the parse, the virtualizer, the worker pool.
    <ErrorBoundary label="the diff">
      {/* Outside the worker pool, not between it and `CodeView`: `EditProvider` is only a
          context, and keeping the pool's child the `CodeView` element itself means the
          arrangement doesn't change based on whether a caller edits. */}
      {createEditor === undefined ? (
        view
      ) : (
        <EditProvider<T> createEditor={createEditor}>{view}</EditProvider>
      )}
    </ErrorBoundary>
  );
}
