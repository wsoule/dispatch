import type { ApiClient, DocRead, DocSummary } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { DocsView } from './DocsView';

const summary = {
  id: 'doc-1',
  handle: 'auth',
  title: 'Auth refactor',
  scope: 'team',
  status: 'draft',
  unreviewed: true,
  conflicted: false,
  restored: null,
  rel: null,
  fromParent: false,
  head: { id: 'rev-1', n: 1, hash: 'h1', bytes: 10, sealed: true },
  updatedBy: 'run:r-1',
  updatedAt: '2026-09-26T10:00:00.000Z',
} as unknown as DocSummary;
const read = {
  doc: summary,
  rev: {
    id: 'rev-1',
    n: 1,
    hash: 'h1',
    author: 'run:r-1',
    summary: 'created',
  },
  links: [
    {
      doc: 'doc-1',
      target: { type: 'task', id: 't-1' },
      rel: 'spec',
      source: 'manual',
    },
  ],
  outline: [],
  section: null,
  text: '# Auth\nbody\n',
  offset: 0,
  nextOffset: null,
  total: 12,
  proposal: null,
} as unknown as DocRead;

function renderView(opts: {
  canDecide: boolean;
  save?: ApiClient['saveDocBody'];
  doc?: DocSummary;
}) {
  const calls: string[] = [];
  const doc = opts.doc ?? summary;
  const client = {
    listDocs: () => Promise.resolve({ docs: [doc], total: 1 }),
    getDoc: () => Promise.resolve({ ...read, doc }),
    saveDocBody:
      opts.save ??
      (() =>
        Promise.resolve({
          ok: true,
          result: {
            status: 'amended',
            handle: 'auth',
            rev: { id: 'rev-1', n: 1, hash: 'h2' },
            doc,
          },
        })),
    markDocReviewed: () => {
      calls.push('reviewed');
      return Promise.resolve(doc);
    },
    setDocStatus: (_ref: string, status: string) => {
      calls.push(`status ${status}`);
      return Promise.resolve(doc);
    },
    listDocRevisions: () =>
      Promise.resolve({
        revisions: [
          { id: 'rev-1', n: 1, author: 'run:r-1', summary: 'created' },
        ],
      }),
  } as unknown as ApiClient;
  const data = {
    client,
    port: 1,
    messageAccess: {
      canDecide: opts.canDecide,
      canMessage: true,
      explanation: null,
    },
  } as unknown as DispatchProjectData;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocsView data={data} />
    </QueryClientProvider>
  );
  return calls;
}

test('lists docs, opens one in the source editor, and previews it', async () => {
  renderView({ canDecide: true });
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  expect(editor.value).toBe('# Auth\nbody\n');
  expect(screen.getAllByText('unreviewed').length).toBeGreaterThan(0);
  expect(screen.getByText('task:t-1')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  expect(await screen.findByRole('heading', { name: 'Auth' })).toBeDefined();
});

test('shows Mark reviewed to decide-tier humans only, listing what it covers first', async () => {
  const calls = renderView({ canDecide: true });
  fireEvent.click(await screen.findByText('Auth refactor'));
  fireEvent.click(await screen.findByRole('button', { name: 'Mark reviewed' }));
  expect(await screen.findByText('rev 1 · run:r-1 · created')).toBeDefined();
  expect(calls).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Confirm reviewed' }));
  await waitFor(() => expect(calls).toEqual(['reviewed']));
});

test('hides Mark reviewed below decide tier', async () => {
  renderView({ canDecide: false });
  fireEvent.click(await screen.findByText('Auth refactor'));
  await screen.findByLabelText('Editing auth');
  expect(screen.queryByRole('button', { name: 'Mark reviewed' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Archive' })).toBeNull();
});

test('archives a doc for decide-tier humans', async () => {
  const calls = renderView({ canDecide: true });
  fireEvent.click(await screen.findByText('Auth refactor'));
  fireEvent.click(await screen.findByRole('button', { name: 'Archive' }));
  await waitFor(() => expect(calls).toEqual(['status archived']));
});

test('an archived doc opens read-only with Restore', async () => {
  const archived = {
    ...summary,
    status: 'archived',
    archivedFrom: 'draft',
  } as DocSummary;
  const calls = renderView({ canDecide: true, doc: archived });
  fireEvent.click(await screen.findByRole('button', { name: 'Archived' }));
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  expect(editor.readOnly).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Restore' }));
  await waitFor(() => expect(calls).toEqual(['status draft']));
});

test('switching docs saves typing the debounce still held', async () => {
  const other = {
    ...summary,
    id: 'doc-2',
    handle: 'plan',
    title: 'Plan',
  } as DocSummary;
  const saves: { ref: string; body: string }[] = [];
  const client = {
    listDocs: () => Promise.resolve({ docs: [summary, other], total: 2 }),
    getDoc: (ref: string) =>
      Promise.resolve({ ...read, doc: ref === 'doc-2' ? other : summary }),
    saveDocBody: (ref: string, input: { body: string }) => {
      saves.push({ ref, body: input.body });
      return Promise.resolve({
        ok: true,
        result: {
          status: 'amended',
          handle: 'auth',
          rev: { id: 'rev-1', n: 1, hash: 'h2' },
          doc: summary,
        },
      });
    },
  } as unknown as ApiClient;
  const data = {
    client,
    port: 1,
    messageAccess: { canDecide: true, canMessage: true, explanation: null },
  } as unknown as DispatchProjectData;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocsView data={data} />
    </QueryClientProvider>
  );
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor = await screen.findByLabelText('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  fireEvent.click(screen.getByRole('button', { name: 'Plan' }));
  await screen.findByLabelText('Editing plan');
  await waitFor(() =>
    expect(saves).toEqual([{ ref: 'doc-1', body: '# Auth\nmine\n' }])
  );
});

test('a 409 loads the marked text under the banner', async () => {
  const save = (() =>
    Promise.resolve({
      ok: false,
      conflict: {
        code: 'conflict',
        reason: 'merge-conflict',
        head: { id: 'rev-2', n: 2, hash: 'h2', body: 'x', author: 'run:r-1' },
        base: { id: 'rev-1', n: 1 },
        hunks: [],
        marked: '<<<<<<< head (rev 2, run:r-1)\n',
      },
    })) as ApiClient['saveDocBody'];
  renderView({ canDecide: true, save });
  fireEvent.click(await screen.findByText('Auth refactor'));
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing auth');
  fireEvent.change(editor, { target: { value: '# Auth\nmine\n' } });
  expect(
    await screen.findByText(
      'Rev 2 by run:r-1 changed the same lines. Resolve the marked blocks, then save.',
      {},
      { timeout: 3000 }
    )
  ).toBeDefined();
  expect(editor.value).toBe('<<<<<<< head (rev 2, run:r-1)\n');
});
