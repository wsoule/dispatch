import type { FileDiffMetadata } from '@pierre/diffs';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';

// `PierreWorkerPool` imports `@pierre/diffs/worker/worker.js?worker&url`, a
// Vite-only specifier `bun test` cannot resolve — stubbed to a passthrough so
// the component itself can be rendered, the same way `PierreReviewDiff.test.tsx` does.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
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
