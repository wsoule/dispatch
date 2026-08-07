import type { ApiClient, ReviewComment, RunMeta } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';
import { isValidElement, type ReactNode } from 'react';

// The props of the `CodeView` element the diff built — the only way to reach its per-line render
// props, since happy-dom lays nothing out and `CodeView` renders no rows or gutter.
let codeViewProps: Record<string, unknown> | null = null;

// `PierreWorkerPool` imports a Vite-only specifier `bun test` cannot resolve, stubbed the same
// way `PierreReviewDiff.test.tsx` does.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => {
    codeViewProps = isValidElement(children)
      ? (children.props as Record<string, unknown>)
      : null;
    return children;
  },
}));

// Pierre's editor measures text through a 2d canvas context and throws without one.
HTMLCanvasElement.prototype.getContext = (() => ({
  font: '',
  measureText: () => ({ width: 7 }),
})) as unknown as HTMLCanvasElement['getContext'];

const { RunReviewView } = await import('./RunReviewView');

const PATCH = `diff --git a/a.ts b/a.ts
index 1111111..2222222 100644
--- a/a.ts
+++ b/a.ts
@@ -1,2 +1,2 @@
 const a = 0;
-const b = 1;
+const b = 2;
`;

type GutterRenderer = (
  getHoveredLine: () => { lineNumber?: number; side?: string } | undefined,
  item: { id: string }
) => ReactNode;

// Hover a line and click its gutter affordance, the same gesture `PierreReviewDiff.test.tsx`
// drives — `CodeView` renders no gutter in happy-dom, so the node is asked for exactly the way
// Pierre asks for it, then mounted and clicked.
function clickGutter(line: number, file = 'a.ts'): void {
  const renderGutter = codeViewProps?.renderGutterUtility as
    | GutterRenderer
    | undefined;
  if (renderGutter === undefined) {
    throw new Error('the diff offered no gutter affordance to click');
  }
  const node = renderGutter(() => ({ lineNumber: line, side: 'additions' }), {
    id: file,
  });
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(node, { container: host });
  const button = host.querySelector('button');
  if (button === null) throw new Error('the affordance rendered no button');
  fireEvent.click(button);
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await Promise.resolve();
  });
}

function runMeta(): RunMeta {
  return { id: 'r1', state: 'finished' } as RunMeta;
}

function noop(): Promise<void> {
  return Promise.resolve();
}

function renderRunReview(client: ApiClient) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <RunReviewView
        client={client}
        meta={runMeta()}
        diff={{ patch: PATCH } as never}
        diffLoading={false}
        diffError={null}
        prCapability={false}
        mergeQueue={null}
        tasks={[]}
        latestRunByTaskId={new Map()}
        onMerge={noop}
        onDiscard={noop}
        onRequestChanges={noop}
        onOpenPr={noop}
        onViewPr={() => {}}
        onQueueMerge={noop}
        onQueueStack={noop}
        reviewComments={[]}
        onAddComment={() => Promise.resolve({} as ReviewComment)}
        onResolveComment={noop}
        onReplyComment={noop}
        onSubmitReview={() => Promise.resolve({ published: 0 })}
      />
    </QueryClientProvider>
  );
}

function fakeClient(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    baseUrl: 'http://127.0.0.1:4321',
    fetchRunFile: () =>
      Promise.resolve({ contents: 'const a = 0;\n', sha: 'sha1' }),
    fetchConversation: () => Promise.resolve([]),
    ...overrides,
  } as ApiClient;
}

// The Runs review surface has a run, so it has a conversation subject — unlike a PR target,
// which withholds the chat because there is nothing to hold one. It shipped without the dock
// wired at all, so a reviewer working here got a bar offering Comment and Copy, no chat, and
// nothing on screen saying a chat existed.
describe('RunReviewView — the chat dock', () => {
  it('offers Add to chat on the gutter bar', () => {
    renderRunReview(fakeClient());

    clickGutter(2);

    expect(
      screen.queryByRole('toolbar', { name: 'Selection actions' })
    ).not.toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Add to chat' })
    ).not.toBeNull();
  });

  it('carries an armed line into the store under this run’s subject', async () => {
    const added: Parameters<ApiClient['addChatMessage']>[0][] = [];
    renderRunReview(
      fakeClient({
        addChatMessage: (input: Parameters<ApiClient['addChatMessage']>[0]) => {
          added.push(input);
          return Promise.resolve({
            id: 'cm-1',
            role: 'human' as const,
            body: input.body,
            snippets: input.snippets,
            created: '2026-08-07T00:00:00.000Z',
          });
        },
      })
    );

    clickGutter(2);
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }));

    // The dock opened itself and is holding the snippet as a chip.
    expect(screen.queryByText('a.ts (2)')).not.toBeNull();

    fireEvent.change(screen.getByLabelText('Message'), {
      target: { value: 'why is this needed?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await settle();

    expect(added[0]).toMatchObject({
      subject: 'run:r1',
      role: 'human',
      body: 'why is this needed?',
      snippets: [
        { file: 'a.ts', startLine: 2, endLine: 2, text: 'const b = 2;' },
      ],
    });
  });
});
