import type { ApiClient, DocRead, DocRecord } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

// The merge view and review diff reach `PierreWorkerPool`, whose `?worker&url`
// import `bun test` cannot resolve; stubbed as DocHistory.test.tsx does.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));
const { DocPage } = await import('./DocPage');

const doc = (over: Partial<DocRecord> = {}): DocRecord =>
  ({
    id: 'doc-1',
    handle: 'auth',
    title: 'Auth refactor',
    scope: 'team',
    status: 'draft',
    archivedFrom: null,
    restored: null,
    unreviewed: false,
    reviewedRev: 'rev-1',
    conflicted: false,
    head: { id: 'rev-1', n: 1, hash: 'h1', bytes: 10, sealed: true },
    published: null,
    lastPublishPath: null,
    ...over,
  }) as DocRecord;

const readOf = (d: DocRecord, text = '# Auth\nbody\n'): DocRead =>
  ({
    doc: d,
    rev: {
      id: d.head.id,
      n: d.head.n,
      hash: d.head.hash,
      author: 'human:wyat',
    },
    links: [],
    outline: [],
    section: null,
    text,
    offset: 0,
    nextOffset: null,
    total: text.length,
    proposal: null,
  }) as unknown as DocRead;

// A client recording saves and status changes, in order, into `calls`.
function renderPage(opts: {
  doc?: DocRecord;
  text?: string;
  canDecide?: boolean;
  mergeProposal?: string | null;
  client?: Partial<ApiClient>;
}) {
  const calls: string[] = [];
  const d = opts.doc ?? doc();
  const client = {
    getDoc: () => Promise.resolve(readOf(d, opts.text)),
    saveDocBody: (_ref: string, input: { body: string }) => {
      calls.push(`save ${JSON.stringify(input.body)}`);
      return Promise.resolve({
        ok: true,
        result: {
          status: 'amended',
          handle: 'auth',
          rev: { id: 'rev-1', n: 1, hash: 'h2' },
          doc: d,
        },
      });
    },
    setDocStatus: (_ref: string, status: string) => {
      calls.push(`status ${status}`);
      return Promise.resolve(d);
    },
    listDocRevisions: () => Promise.resolve({ revisions: [] }),
    listDocProposals: () => Promise.resolve({ proposals: [] }),
    ...opts.client,
  } as unknown as ApiClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocPage
        client={client}
        port={1}
        refId="doc-1"
        canDecide={opts.canDecide ?? true}
        mergeProposal={opts.mergeProposal ?? null}
      />
    </QueryClientProvider>
  );
  return calls;
}

test('sends what was typed before every status change, not only Accept', async () => {
  for (const [d, label, status] of [
    [doc(), 'Accept', 'accepted'],
    [doc(), 'Archive', 'archived'],
    [doc({ status: 'accepted' }), 'Reopen', 'draft'],
  ] as const) {
    const calls = renderPage({ doc: d });
    const editor =
      await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
    fireEvent.change(editor, { target: { value: '# Auth\ntyped\n' } });
    fireEvent.click(screen.getByRole('button', { name: label }));
    await waitFor(() =>
      expect(calls).toEqual([`save "# Auth\\ntyped\\n"`, `status ${status}`])
    );
    cleanup();
  }
});

test('refuses Accept while the text holds conflict markers or the doc is conflicted', async () => {
  const marked = '<<<<<<< rev-01A\nH\n=======\nM\n>>>>>>> rev-01B\n';
  const calls = renderPage({ text: marked });
  await screen.findByLabelText('Editing auth');
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(calls.filter((c) => c.startsWith('status'))).toEqual([]);
  cleanup();

  const conflicted = renderPage({ doc: doc({ conflicted: true }) });
  await screen.findByLabelText('Editing auth');
  fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
  expect(await screen.findByRole('alert')).toBeDefined();
  expect(conflicted.filter((c) => c.startsWith('status'))).toEqual([]);
});

test('shows status actions to a decider only, and Publish to any human on a reviewed team doc', async () => {
  renderPage({ canDecide: false });
  await screen.findByLabelText('Editing auth');
  for (const name of ['Accept', 'Archive', 'Mark reviewed']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  expect(screen.getByRole('button', { name: 'Publish to repo' })).toBeDefined();
  cleanup();
  renderPage({ canDecide: true });
  await screen.findByLabelText('Editing auth');
  expect(screen.getByRole('button', { name: 'Accept' })).toBeDefined();
  expect(screen.getByRole('button', { name: 'Archive' })).toBeDefined();
});

test("opens on a conflicting proposal's marked merge and saves the resolution", async () => {
  const marked =
    '# Auth\n<<<<<<< rev-head\nhuman\n||||||| rev-base\nv1\n=======\nrun\n>>>>>>> rev-p\n';
  const getDocProposal = mock((_rev: string) =>
    Promise.resolve({
      proposal: { rev: 'rev-p', author: 'run:r-1', state: 'open' },
      title: 'Auth refactor',
      body: '# Auth\nrun\n',
      chunks: [],
      mergeable: { clean: false, headN: 2 },
      marked,
    })
  );
  const calls = renderPage({
    doc: doc({ status: 'accepted' }),
    mergeProposal: 'rev-p',
    client: { getDocProposal } as unknown as Partial<ApiClient>,
  });
  const conflict = await screen.findByRole('region', {
    name: 'Conflict 1 of 1',
  });
  expect(getDocProposal).toHaveBeenCalledWith('rev-p');
  fireEvent.click(within(conflict).getByRole('button', { name: 'Take yours' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save resolution' }));
  await waitFor(() => expect(calls).toEqual([`save "# Auth\\nrun\\n"`]));
  expect(
    await screen.findByText(/reject the proposal as resolved/)
  ).toBeDefined();
});

test('lists open proposals with how long ago each was made', async () => {
  const createdAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
  renderPage({
    doc: doc({ status: 'accepted' }),
    client: {
      listDocProposals: () =>
        Promise.resolve({
          proposals: [{ rev: 'rev-p', author: 'run:r-1', createdAt }],
        }),
    } as unknown as Partial<ApiClient>,
  });
  expect(await screen.findByText(/rev-p · run:r-1 · 3h ago/)).toBeDefined();
});

test('uploads a pasted image and inserts its link at the caret', async () => {
  const name = `${'a'.repeat(64)}.png`;
  const uploads: unknown[] = [];
  const uploadDocAsset = (ref: string, bytes: Uint8Array) => {
    uploads.push([ref, Array.from(bytes)]);
    return Promise.resolve({ name, markdown: `![](asset:${name})` });
  };
  renderPage({
    text: 'ab',
    client: { uploadDocAsset } as unknown as Partial<ApiClient>,
  });
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  editor.setSelectionRange(1, 1);
  const file = new File([new Uint8Array([0x89, 0x50])], 'shot.png', {
    type: 'image/png',
  });
  fireEvent.paste(editor, { clipboardData: { files: [file] } });
  await waitFor(() => expect(editor.value).toBe(`a![](asset:${name})b`));
  expect(uploads).toEqual([['doc-1', [0x89, 0x50]]]);
});

test("the preview shows a doc's asset: image through the docs API", async () => {
  const name = `${'a'.repeat(64)}.png`;
  const fetchDocAsset = mock((_doc: string, _name: string) =>
    Promise.resolve(new Blob([new Uint8Array([1])], { type: 'image/png' }))
  );
  renderPage({
    text: `![shot](asset:${name})\n`,
    client: { fetchDocAsset } as unknown as Partial<ApiClient>,
  });
  await screen.findByLabelText('Editing auth');
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByRole('img', { name: 'shot' })).toBeDefined();
  expect(fetchDocAsset).toHaveBeenCalledWith('doc-1', name);
});

test('saves a proposal resolution against the head its merge was computed from', async () => {
  const marked = '# Auth\n<<<<<<< rev-1\nhuman\n=======\nrun\n>>>>>>> rev-p\n';
  const saves: { baseRev: unknown; baseHash: unknown; body: string }[] = [];
  const saveDocBody = (
    _ref: string,
    input: { baseRev: unknown; baseHash?: unknown; body: string }
  ) => {
    saves.push({
      baseRev: input.baseRev,
      baseHash: input.baseHash,
      body: input.body,
    });
    return Promise.resolve({
      ok: true,
      result: {
        status: 'merged',
        handle: 'auth',
        rev: { id: 'rev-3', n: 3, hash: 'h3' },
        doc: doc(),
      },
    });
  };
  // A newer head (rev 2) arrived after the merge was computed against rev 1.
  renderPage({
    doc: doc({
      status: 'accepted',
      head: { id: 'rev-2', n: 2, hash: 'h2', bytes: 10, sealed: true },
    }),
    mergeProposal: 'rev-p',
    client: {
      saveDocBody,
      getDocProposal: () =>
        Promise.resolve({
          proposal: { rev: 'rev-p', author: 'run:r-1', state: 'open' },
          title: 'Auth refactor',
          body: '# Auth\nrun\n',
          chunks: [],
          mergeable: {
            clean: false,
            headN: 1,
            headRev: 'rev-1',
            headHash: 'h1',
          },
          marked,
        }),
    } as unknown as Partial<ApiClient>,
  });
  const conflict = await screen.findByRole('region', {
    name: 'Conflict 1 of 1',
  });
  fireEvent.click(within(conflict).getByRole('button', { name: 'Take yours' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save resolution' }));
  await waitFor(() =>
    expect(saves[0]).toEqual({
      baseRev: 'rev-1',
      baseHash: 'h1',
      body: '# Auth\nrun\n',
    })
  );
});
