import type { ApiClient, DocLinking } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { DocsLinkingList } from './DocsLinkingList';

function renderList(
  target: string,
  docs: DocLinking[],
  onOpenDoc: (id: string) => void = () => undefined
) {
  const asked: string[] = [];
  const client = {
    docsLinking: (t: string) => {
      asked.push(t);
      return Promise.resolve({ docs });
    },
  } as unknown as ApiClient;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <DocsLinkingList
        client={client}
        port={1}
        target={target}
        onOpenDoc={onOpenDoc}
      />
    </QueryClientProvider>
  );
  return asked;
}

test('lists the docs that link a thread, and opens one', async () => {
  const opened: string[] = [];
  const asked = renderList(
    'thread:m-01',
    [
      {
        doc: { id: 'doc-1', handle: 'auth', title: 'Auth refactor' },
        rel: 'context',
      } as unknown as DocLinking,
    ],
    (id) => opened.push(id)
  );
  fireEvent.click(await screen.findByRole('button', { name: /Auth refactor/ }));
  expect(asked).toEqual(['thread:m-01']);
  expect(opened).toEqual(['doc-1']);
});

test('renders nothing when no doc links the target', async () => {
  const asked = renderList('thread:m-02', []);
  await waitFor(() => expect(asked).toEqual(['thread:m-02']));
  expect(screen.queryByRole('region', { name: 'Linked docs' })).toBeNull();
});
