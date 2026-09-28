import type { ApiClient, DocLinking, DocSummary } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { groupTaskDocs, TaskDocsBlock } from './TaskDocsBlock';

const link = (
  handle: string,
  rel: DocLinking['rel'],
  fromParent = false
): DocLinking =>
  ({
    doc: {
      id: `doc-${handle}`,
      handle,
      title: handle.toUpperCase(),
      scope: 'team',
      status: 'draft',
      unreviewed: false,
      conflicted: false,
      restored: null,
    },
    rel,
    source: 'manual',
    fromParent,
  }) as unknown as DocLinking;

const summary = (handle: string, title: string): DocSummary =>
  ({
    id: `doc-${handle}`,
    handle,
    title,
    scope: 'team',
    status: 'draft',
    unreviewed: false,
    conflicted: false,
    restored: null,
    rel: null,
    fromParent: false,
  }) as unknown as DocSummary;

function mount(
  client: ApiClient,
  { canLink = true, opened = [] as string[] } = {}
) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TaskDocsBlock
        client={client}
        port={1}
        taskId="t-1"
        canLink={canLink}
        onOpenDoc={(id) => opened.push(id)}
      />
    </QueryClientProvider>
  );
}

describe('groupTaskDocs', () => {
  test('puts the spec first, then plans, context and docs from parents', () => {
    const g = groupTaskDocs([
      link('s', 'spec'),
      link('p', 'plan'),
      link('c', 'context'),
      link('ps', 'spec', true),
    ]);
    expect(g.spec?.doc.handle).toBe('s');
    expect(g.plans.map((l) => l.doc.handle)).toEqual(['p']);
    expect(g.context.map((l) => l.doc.handle)).toEqual(['c']);
    expect(g.fromParents.map((l) => l.doc.handle)).toEqual(['ps']);
  });
});

test('offers New spec when the task has none, and creates it linked as spec', async () => {
  const created: unknown[] = [];
  const client = {
    docsLinking: () => Promise.resolve({ docs: [link('p', 'plan')] }),
    createDoc: (input: unknown) => {
      created.push(input);
      return Promise.resolve({
        doc: { id: 'doc-new' },
        handle: 'new',
        rev: { id: 'rev-1', n: 1, hash: 'h' },
        status: 'saved',
      });
    },
  } as unknown as ApiClient;
  const opened: string[] = [];
  mount(client, { opened });
  fireEvent.click(await screen.findByRole('button', { name: 'New spec' }));
  await waitFor(() => expect(opened).toEqual(['doc-new']));
  expect(created).toEqual([
    {
      title: 'Spec for t-1',
      body: '# Spec for t-1\n',
      links: [{ target: 'task:t-1', rel: 'spec' }],
    },
  ]);
});

test('lists the linked docs by role and opens one on click', async () => {
  const client = {
    docsLinking: (target: string) =>
      Promise.resolve({
        docs:
          target === 'task:t-1'
            ? [link('p', 'plan'), link('s', 'spec'), link('e', 'spec', true)]
            : [],
      }),
  } as unknown as ApiClient;
  const opened: string[] = [];
  mount(client, { opened });
  const rows = await screen.findAllByRole('listitem');
  expect(rows.map((r) => r.textContent)).toEqual([
    'specS',
    'planP',
    'from parent · specE',
  ]);
  expect(screen.queryByRole('button', { name: 'New spec' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /S$/ }));
  expect(opened).toEqual(['doc-s']);
});

test('Link doc finds a doc by title and links it as context', async () => {
  const linked: unknown[] = [];
  const client = {
    docsLinking: () => Promise.resolve({ docs: [link('s', 'spec')] }),
    listDocs: () =>
      Promise.resolve({
        docs: [
          summary('s', 'Already the spec'),
          summary('auth', 'Auth runbook'),
          summary('ui', 'UI notes'),
        ],
        total: 3,
      }),
    linkDoc: (ref: string, input: unknown) => {
      linked.push([ref, input]);
      return Promise.resolve({ links: [] });
    },
  } as unknown as ApiClient;
  mount(client);
  fireEvent.click(await screen.findByRole('button', { name: 'Link doc' }));
  fireEvent.change(screen.getByRole('textbox', { name: 'Find a doc' }), {
    target: { value: 'auth' },
  });
  const pick = await screen.findByRole('button', { name: 'Auth runbook' });
  expect(screen.queryByRole('button', { name: 'UI notes' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Already the spec' })).toBeNull();
  fireEvent.click(pick);
  await waitFor(() =>
    expect(linked).toEqual([
      ['doc-auth', { target: 'task:t-1', rel: 'context' }],
    ])
  );
  await waitFor(() =>
    expect(screen.queryByRole('textbox', { name: 'Find a doc' })).toBeNull()
  );
});

test('a caller who may not link sees the docs and no New spec or Link doc', async () => {
  const client = {
    docsLinking: () => Promise.resolve({ docs: [link('p', 'plan')] }),
  } as unknown as ApiClient;
  mount(client, { canLink: false });
  expect(await screen.findByText('P')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'New spec' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Link doc' })).toBeNull();
});
