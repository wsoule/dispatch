import type { FileDiffMetadata } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';
import { createRef, isValidElement } from 'react';

import {
  DEFAULT_DIFF_DISPLAY_SETTINGS,
  DIFF_DISPLAY_STORAGE_KEY,
  serializeDiffDisplaySettings,
} from '@/lib/diffDisplay';

// The props of the `CodeView` element `DiffSurface` built, captured by the stub below.
// happy-dom has no layout, so `CodeView` renders no code rows at all and nothing option-driven
// shows up in the output — inspecting the element is the only way to pin what reached it.
let codeViewProps: Record<string, unknown> | null = null;

// `PierreWorkerPool` imports `@pierre/diffs/worker/worker.js?worker&url`, a
// Vite-only specifier `bun test` cannot resolve — stubbed to a passthrough so
// the component itself can be rendered, the same way `PierreReviewDiff.test.tsx` does.
// `DiffSurface` renders exactly one child inside it: the `CodeView` element.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => {
    codeViewProps = isValidElement(children)
      ? (children.props as Record<string, unknown>)
      : null;
    return children;
  },
}));

const { DiffSurface, useParsedPatchFiles } = await import('./DiffSurface');

const TWO_FILE_PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 const a = 0;
-const b = 1;
+const b = 2;
diff --git a/b.ts b/b.ts
index 3333333..4444444 100644
--- a/b.ts
+++ b/b.ts
@@ -1,2 +1,2 @@
 const c = 0;
-const d = 1;
+const d = 2;
`;

// Names every rendered item in the DOM, so a test can assert which files the surface
// actually handed to `CodeView` rather than trusting the parse alone.
function nameItem(item: { id: string }) {
  return <span data-testid="rendered-file">{item.id}</span>;
}

function renderedFiles(): string[] {
  return screen.queryAllByTestId('rendered-file').map((el) => el.textContent);
}

describe('DiffSurface — states around the diff', () => {
  it('renders the caller’s empty label when there is no patch at all', () => {
    render(
      <DiffSurface patch={undefined} emptyLabel="Nothing for this run." />
    );

    expect(screen.queryByText('Nothing for this run.')).not.toBeNull();
  });

  it('renders the caller’s empty label for a whitespace-only patch', () => {
    render(<DiffSurface patch={'   \n'} emptyLabel="Nothing here." />);

    expect(screen.queryByText('Nothing here.')).not.toBeNull();
  });

  it('renders the parse failure inline instead of throwing', () => {
    render(<DiffSurface patch="this is not a patch" emptyLabel="Empty." />);

    expect(
      screen.queryByText(/Couldn’t load the diff: No file diffs found in patch/)
    ).not.toBeNull();
    expect(screen.queryByText('Empty.')).toBeNull();
  });

  it('renders neither the diff nor the empty label while loading', () => {
    render(
      <DiffSurface
        patch={TWO_FILE_PATCH}
        loading
        emptyLabel="Empty."
        renderHeaderMetadata={nameItem}
      />
    );

    expect(screen.queryByText('Empty.')).toBeNull();
    expect(renderedFiles()).toEqual([]);
  });
});

describe('DiffSurface — which files it renders', () => {
  it('renders every file in the patch by default', () => {
    render(
      <DiffSurface patch={TWO_FILE_PATCH} renderHeaderMetadata={nameItem} />
    );

    expect(renderedFiles()).toEqual(['a.ts', 'b.ts']);
  });

  it('restricts rendering to `only` when given', () => {
    render(
      <DiffSurface
        patch={TWO_FILE_PATCH}
        only="b.ts"
        renderHeaderMetadata={nameItem}
      />
    );

    expect(renderedFiles()).toEqual(['b.ts']);
  });

  it('falls back to the empty label when `only` matches no file in the patch', () => {
    render(
      <DiffSurface
        patch={TWO_FILE_PATCH}
        only="gone.ts"
        emptyLabel="No changes to show."
        renderHeaderMetadata={nameItem}
      />
    );

    expect(screen.queryByText('No changes to show.')).not.toBeNull();
    expect(renderedFiles()).toEqual([]);
  });

  it('hands the filtered files to a caller-supplied item builder', () => {
    let seen: string[] = [];
    render(
      <DiffSurface
        patch={TWO_FILE_PATCH}
        only="a.ts"
        items={(files: FileDiffMetadata[]) => {
          seen = files.map((f) => f.name);
          return files.map((fileDiff) => ({
            id: fileDiff.name,
            type: 'diff' as const,
            fileDiff,
          }));
        }}
        renderHeaderMetadata={nameItem}
      />
    );

    expect(seen).toEqual(['a.ts']);
    expect(renderedFiles()).toEqual(['a.ts']);
  });
});

describe('DiffSurface — what reaches CodeView', () => {
  afterEach(() => {
    localStorage.removeItem(DIFF_DISPLAY_STORAGE_KEY);
  });

  // `RunDiffView`'s changed-files tree scrolls by calling `scrollTo` on this handle, so a
  // dropped `ref` would silently kill the one caller-visible behaviour the move to a single
  // scroller had to re-implement — with every other test here still green.
  it('hands the live CodeView handle back through `viewRef`', () => {
    const ref = createRef<CodeViewHandle<undefined>>();

    render(<DiffSurface patch={TWO_FILE_PATCH} viewRef={ref} />);

    expect(typeof ref.current?.scrollTo).toBe('function');
  });

  // Both surfaces read the reviewer's diff-display preferences through this one path now, so a
  // regression here drops them everywhere at once.
  it('passes the stored display settings, with the caller’s options merged over them', () => {
    localStorage.setItem(
      DIFF_DISPLAY_STORAGE_KEY,
      serializeDiffDisplaySettings({
        ...DEFAULT_DIFF_DISPLAY_SETTINGS,
        showLineNumbers: false,
        inlineHighlight: 'char',
      })
    );

    render(
      <DiffSurface patch={TWO_FILE_PATCH} options={{ diffStyle: 'unified' }} />
    );

    expect(codeViewProps?.options).toMatchObject({
      // From the stored settings, via `toDiffRenderOptions`.
      disableLineNumbers: true,
      lineDiffType: 'char',
      // The caller's own option wins over the stored `layout: 'split'`.
      diffStyle: 'unified',
    });
  });

  it('renders the CodeView element itself as the scroll container', () => {
    const { container } = render(<DiffSurface patch={TWO_FILE_PATCH} />);

    // The default has to keep `overflow-auto` on this exact element: `CodeView` reads its own
    // `scrollTop` to pick the virtualized row window.
    expect(container.firstElementChild?.className).toBe(
      'min-h-0 w-full flex-1 overflow-auto'
    );
  });

  it('lets a caller restyle that scroll container', () => {
    const { container } = render(
      <DiffSurface patch={TWO_FILE_PATCH} className="h-full overflow-auto" />
    );

    expect(container.firstElementChild?.className).toBe('h-full overflow-auto');
  });

  // The worker pool reuses a rendered diff by cache key, and Pierre defaults an unkeyed file's
  // key to its own path — so two surfaces showing the same path with different content would
  // share one entry. A prefix namespaces a surface's patch out of that collision, and nothing
  // about it is visible in the DOM.
  it('stamps prefixed cache keys on the parsed files', () => {
    render(<DiffSurface patch={TWO_FILE_PATCH} cacheKeyPrefix="review" />);

    const items = codeViewProps?.items as {
      fileDiff: FileDiffMetadata;
    }[];
    expect(items.map((i) => i.fileDiff.cacheKey)).toEqual([
      'review-0-0',
      'review-0-1',
    ]);
  });

  // `onItemEditComplete` is how an edit gets committed; `createEditor` is what makes an
  // `edit: true` item editable at all. Neither shows up in the DOM.
  it('hands the edit callbacks through to CodeView', () => {
    const onItemEditComplete = () => undefined;

    render(
      <DiffSurface
        patch={TWO_FILE_PATCH}
        onItemEditComplete={onItemEditComplete}
        createEditor={(() => undefined) as never}
      />
    );

    expect(codeViewProps?.onItemEditComplete).toBe(onItemEditComplete);
  });
});

describe('DiffSurface — per-file crash isolation', () => {
  // The one-`CodeView` consolidation replaced `RunDiffView`/`GitDiffPane`'s per-file boundaries
  // with a single one for the whole pane, and Pierre only catches on the file *load* path — so a
  // throw while rendering one file's slots blanked every file. Each file's slots get their own
  // boundary again.
  it('keeps the other files rendered when one file’s slot throws', () => {
    render(
      <DiffSurface
        patch={TWO_FILE_PATCH}
        renderHeaderMetadata={(item) => {
          if (item.id === 'a.ts') throw new Error('this file’s slot is broken');
          return nameItem(item);
        }}
      />
    );

    expect(renderedFiles()).toEqual(['b.ts']);
    // The pane itself is still a diff, not the whole-view fallback.
    expect(screen.queryByText(/Couldn’t load the diff/)).toBeNull();
  });

  // `renderHeaderMetadata` is the only slot happy-dom actually drives (no rows, so no annotations;
  // an unhovered gutter). Isolating only that one would still pass the two tests above while
  // `renderAnnotation` and `renderGutterUtility` went to `CodeView` bare — a fixture simpler than
  // production, which is exactly the shape that let the abandoned gesture ship green. These three
  // read the props `DiffSurface` actually handed over and render each one's output: an unwrapped
  // prop throws on the call, before anything can catch it.
  it.each([
    [
      'renderAnnotation',
      () => codeViewProps?.renderAnnotation,
      // What `CodeView` passes: the annotation, then the item.
      [{ lineNumber: 1, side: 'additions' }, { id: 'a.ts' }],
    ],
    [
      'renderGutterUtility',
      () => codeViewProps?.renderGutterUtility,
      // A hovered-line *getter*, then the item — Pierre never passes the line directly.
      [() => ({ lineNumber: 1, side: 'additions' }), { id: 'a.ts' }],
    ],
    [
      'renderHeaderMetadata',
      () => codeViewProps?.renderHeaderMetadata,
      [{ id: 'a.ts' }],
    ],
  ] as const)('isolates a throw from %s', (_name, pick, args) => {
    const boom = () => {
      throw new Error('this file’s slot is broken');
    };
    render(
      <DiffSurface
        patch={TWO_FILE_PATCH}
        renderAnnotation={boom}
        renderGutterUtility={boom}
        renderHeaderMetadata={boom}
      />
    );

    const slot = pick() as (...args: unknown[]) => ReactNode;
    expect(typeof slot).toBe('function');
    render(<>{slot(...args)}</>);

    expect(screen.queryAllByText(/the diff for a\.ts/).length).toBeGreaterThan(
      0
    );
  });

  it('names the file that crashed rather than the whole diff', () => {
    render(
      <DiffSurface
        patch={TWO_FILE_PATCH}
        renderHeaderMetadata={(item) => {
          if (item.id === 'a.ts') throw new Error('this file’s slot is broken');
          return nameItem(item);
        }}
      />
    );

    expect(screen.queryAllByText(/the diff for a\.ts/).length).toBeGreaterThan(
      0
    );
  });
});

describe('DiffSurface — a caller that parses the patch itself', () => {
  // `PierreReviewDiff` reads the file list from an effect, which no render prop can reach, so it
  // owns the parse and hands the result back. The surface must then render *that* list rather
  // than re-parsing — otherwise the two could disagree about which files exist.
  it('renders the caller’s parsed files instead of parsing again', () => {
    function Harness() {
      const parsed = useParsedPatchFiles(TWO_FILE_PATCH, 'b.ts', 'review');
      return (
        <DiffSurface
          patch={TWO_FILE_PATCH}
          parsed={parsed}
          only="b.ts"
          renderHeaderMetadata={nameItem}
        />
      );
    }

    render(<Harness />);

    expect(renderedFiles()).toEqual(['b.ts']);
  });

  it('shows the caller’s parse error rather than its own empty label', () => {
    function Harness() {
      const parsed = useParsedPatchFiles('this is not a patch');
      return (
        <DiffSurface
          patch="this is not a patch"
          parsed={parsed}
          emptyLabel="Empty."
        />
      );
    }

    render(<Harness />);

    expect(
      screen.queryByText(/Couldn’t load the diff: No file diffs found in patch/)
    ).not.toBeNull();
    expect(screen.queryByText('Empty.')).toBeNull();
  });
});

describe('useParsedPatchFiles', () => {
  function readFiles(
    patch: string | undefined,
    only?: string
  ): { names: string[]; error: string | null } {
    let seen: { names: string[]; error: string | null } = {
      names: [],
      error: null,
    };
    function Harness() {
      const parsed = useParsedPatchFiles(patch, only);
      seen = {
        names: parsed.files.map((f) => f.name),
        error: parsed.error,
      };
      return null;
    }
    render(<Harness />);
    return seen;
  }

  it('reports an empty, error-free result when there is nothing to parse', () => {
    expect(readFiles(undefined)).toEqual({ names: [], error: null });
    expect(readFiles('   \n')).toEqual({ names: [], error: null });
  });

  it('narrows to `only` before handing the files back', () => {
    expect(readFiles(TWO_FILE_PATCH, 'a.ts').names).toEqual(['a.ts']);
  });

  it('reports a parse failure as an error rather than throwing', () => {
    expect(readFiles('this is not a patch')).toEqual({
      names: [],
      error: 'No file diffs found in patch',
    });
  });
});
