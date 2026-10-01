import type { ApiClient } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

// The diff reaches `PierreWorkerPool`, whose `?worker&url` import `bun test`
// cannot resolve; stubbed the way TaskView.test.tsx does, before the import.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));
const { DocHistory } = await import('./DocHistory');

const REVISIONS = [
  {
    id: 'rev-2',
    n: 2,
    author: 'run:r-1',
    cause: 'edit',
    summary: 'replaced "## API"',
    createdAt: '2026-09-26T10:00:00.000Z',
  },
  {
    id: 'rev-1',
    n: 1,
    author: 'human:wyat',
    cause: 'create',
    summary: 'created',
    createdAt: '2026-09-26T09:00:00.000Z',
  },
];

function renderHistory(client: ApiClient, canWrite = true) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocHistory client={client} port={1} refId="spec" canWrite={canWrite} />
    </QueryClientProvider>
  );
}

// The daemon's diff of rev 1 against rev 2, one line replaced.
function diffOf(spent: boolean) {
  return {
    from: { ...REVISIONS[1], hash: 'h1' },
    to: { ...REVISIONS[0], hash: 'h2' },
    chunks: [{ equal: false, a: ['old\n'], b: ['new\n'] }],
    spent,
  };
}

test('lists revisions with author, cause and summary, and restores one', async () => {
  const reverted: unknown[] = [];
  const client = {
    listDocRevisions: () => Promise.resolve({ revisions: REVISIONS }),
    revertDoc: (ref: string, rev: number) => {
      reverted.push([ref, rev]);
      return Promise.resolve({});
    },
  } as unknown as ApiClient;
  renderHistory(client);
  expect(await screen.findByText('replaced "## API"')).toBeDefined();
  fireEvent.click(screen.getAllByRole('button', { name: 'Restore' })[1]);
  await waitFor(() => expect(reverted).toEqual([['spec', 1]]));
});

test('diffs the two picked revisions, older first, whichever was picked first', async () => {
  const asked: unknown[] = [];
  const client = {
    listDocRevisions: () => Promise.resolve({ revisions: REVISIONS }),
    diffDoc: (ref: string, from: number, to: number) => {
      asked.push([ref, from, to]);
      return Promise.resolve(diffOf(false));
    },
  } as unknown as ApiClient;
  renderHistory(client);
  fireEvent.click(await screen.findByLabelText('Compare rev 2'));
  expect(
    await screen.findByText('Pick another revision to compare.')
  ).toBeDefined();
  fireEvent.click(screen.getByLabelText('Compare rev 1'));
  await waitFor(() => expect(asked).toEqual([['spec', 1, 2]]));
});

test('offers no Restore to a reader who cannot write', async () => {
  const client = {
    listDocRevisions: () => Promise.resolve({ revisions: REVISIONS }),
  } as unknown as ApiClient;
  renderHistory(client, false);
  expect(await screen.findByText('replaced "## API"')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Restore' })).toBeNull();
});

test('says why a restore failed', async () => {
  const client = {
    listDocRevisions: () => Promise.resolve({ revisions: REVISIONS }),
    revertDoc: () => Promise.reject(new Error('rev 1 is gone')),
  } as unknown as ApiClient;
  renderHistory(client);
  fireEvent.click(
    (await screen.findAllByRole('button', { name: 'Restore' }))[1]
  );
  expect((await screen.findByRole('alert')).textContent).toBe('rev 1 is gone');
});

test('notes a diff that ran out of budget', async () => {
  const client = {
    listDocRevisions: () => Promise.resolve({ revisions: REVISIONS }),
    diffDoc: () => Promise.resolve(diffOf(true)),
  } as unknown as ApiClient;
  renderHistory(client);
  fireEvent.click(await screen.findByLabelText('Compare rev 2'));
  fireEvent.click(screen.getByLabelText('Compare rev 1'));
  expect(await screen.findByText(/The diff hit its work limit/)).toBeDefined();
});
