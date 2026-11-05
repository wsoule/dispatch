import type { DiffResult } from '@dispatch/client';
import { act, render } from '@testing-library/react';
import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';
import { isValidElement } from 'react';

import { SPLIT_MIN_WIDTH } from '@/hooks/useFittedDiffLayout';
import { DIFF_DISPLAY_STORAGE_KEY } from '@/lib/diffDisplay';

// The `diffStyle` of every `CodeView` element the diff built, in order. happy-dom has no
// layout, so `CodeView` draws no rows, and its element's props are what can be checked.
const codeViewStyles: unknown[] = [];

// `PierreWorkerPool` imports a Vite-only worker specifier `bun test` cannot resolve, so it is
// stubbed to a passthrough that records the `CodeView` element inside it, as the
// `DiffSurface` and `PierreReviewDiff` tests do.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => {
    const props = isValidElement(children)
      ? (children.props as { options?: { diffStyle?: unknown } })
      : null;
    codeViewStyles.push(props?.options?.diffStyle);
    return children;
  },
}));

const { RunDiffView } = await import('./RunDiffView');

const PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 const a = 0;
-const b = 1;
+const b = 2;
`;

// No changed-files list, so the tree column shows its empty state and the test stays on the
// diff column (the file tree is @pierre/trees, which happy-dom cannot lay out).
const diff = { files: [], patch: PATCH } as unknown as DiffResult;

describe('RunDiffView — the live run diff fits its column', () => {
  // The diff column's width as the stub below reports it.
  let columnWidth = 0;
  let observers: { callback: () => void; targets: Element[] }[] = [];
  const RealResizeObserver = globalThis.ResizeObserver;

  // Gives the diff column a width, and swaps in a ResizeObserver a test can fire. Both live on
  // prototypes and globals every test file shares, so afterEach undoes them.
  function stubLayout(width: number): void {
    columnWidth = width;
    Object.defineProperty(HTMLDivElement.prototype, 'clientWidth', {
      configurable: true,
      get(this: HTMLDivElement) {
        return this.dataset.slot === 'run-diff-column' ? columnWidth : 0;
      },
    });
    observers = [];
    globalThis.ResizeObserver = class {
      private readonly entry: { callback: () => void; targets: Element[] };
      constructor(callback: () => void) {
        this.entry = { callback, targets: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.targets.push(target);
      }
      unobserve() {}
      disconnect() {
        this.entry.targets = [];
      }
    } as unknown as typeof ResizeObserver;
  }

  // Reports a new column width to whatever observes the column, as a window resize would.
  function resizeColumn(width: number): void {
    columnWidth = width;
    const target = document.querySelector('[data-slot=run-diff-column]');
    act(() => {
      for (const o of observers) {
        if (target !== null && o.targets.includes(target)) o.callback();
      }
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(HTMLDivElement.prototype, 'clientWidth');
    globalThis.ResizeObserver = RealResizeObserver;
    window.localStorage.removeItem(DIFF_DISPLAY_STORAGE_KEY);
    codeViewStyles.length = 0;
  });

  const column = () => document.querySelector('[data-slot=run-diff-column]');

  function renderView(): void {
    render(<RunDiffView diff={diff} diffLoading={false} diffError={null} />);
  }

  it('draws a split setting unified in the review column, and never split first', () => {
    stubLayout(702);
    renderView();
    expect(column()?.getAttribute('data-diff-layout')).toBe('unified');
    expect(codeViewStyles.length).toBeGreaterThan(0);
    expect([...new Set(codeViewStyles)]).toEqual(['unified']);
  });

  it('keeps split in a column wide enough for two sides, and follows a resize', () => {
    stubLayout(SPLIT_MIN_WIDTH);
    renderView();
    expect(column()?.getAttribute('data-diff-layout')).toBe('split');
    expect(codeViewStyles.at(-1)).toBe('split');
    resizeColumn(530);
    expect(column()?.getAttribute('data-diff-layout')).toBe('unified');
    expect(codeViewStyles.at(-1)).toBe('unified');
  });

  it('a unified setting stays unified at any width', () => {
    window.localStorage.setItem(
      DIFF_DISPLAY_STORAGE_KEY,
      JSON.stringify({ layout: 'unified' })
    );
    stubLayout(1600);
    renderView();
    expect(column()?.getAttribute('data-diff-layout')).toBe('unified');
    expect([...new Set(codeViewStyles)]).toEqual(['unified']);
  });
});
