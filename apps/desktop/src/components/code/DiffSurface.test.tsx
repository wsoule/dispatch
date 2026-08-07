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

const { DiffSurface } = await import('./DiffSurface');

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
});
