import type { DocSummary } from '@dispatch/client';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import type { DocFilter } from '../../lib/docs';
import { DocList } from './DocList';

afterEach(cleanup);

const ALL: DocFilter = {
  query: '',
  scope: 'all',
  status: 'active',
  unreviewedOnly: false,
};

const doc = (over: Partial<DocSummary>): DocSummary =>
  ({
    id: 'doc-1',
    handle: 'auth',
    title: 'Auth refactor',
    scope: 'team',
    status: 'draft',
    unreviewed: false,
    conflicted: false,
    restored: null,
    ...over,
  }) as DocSummary;

function renderList(opts: {
  docs?: DocSummary[];
  filter?: DocFilter;
  onFilter?: (next: DocFilter) => void;
  onSelect?: (id: string) => void;
  selected?: string | null;
  onNew?: () => void;
  loading?: boolean;
  error?: Error | null;
}) {
  render(
    <DocList
      docs={opts.docs ?? []}
      filter={opts.filter ?? ALL}
      onFilter={opts.onFilter ?? (() => undefined)}
      selected={opts.selected ?? null}
      onSelect={opts.onSelect ?? (() => undefined)}
      error={opts.error ?? null}
      loading={opts.loading}
      onNew={opts.onNew}
    />
  );
}

test('an empty project offers a first doc', () => {
  let started = 0;
  renderList({
    onNew: () => {
      started += 1;
    },
  });
  expect(screen.getByText('No docs yet')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'New doc' }));
  expect(started).toBe(1);
});

test('a search with no results says so instead of offering a new doc', () => {
  renderList({ filter: { ...ALL, query: 'roadmap' }, onNew: () => undefined });
  expect(screen.getByText('No docs match')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'New doc' })).toBeNull();
});

test('says the list is loading, and a failed load in an alert', () => {
  renderList({ loading: true });
  expect(screen.getByText('Loading docs…')).toBeDefined();
  cleanup();
  renderList({ error: new Error('daemon gone') });
  expect(screen.getByRole('alert').textContent).toBe('daemon gone');
});

test('each row is a button named by its title, with toned badges and its slug', () => {
  const picked: string[] = [];
  renderList({
    docs: [
      doc({ unreviewed: true }),
      doc({ id: 'doc-2', handle: 'plan', title: 'Plan', status: 'accepted' }),
    ],
    selected: 'doc-2',
    onSelect: (id) => picked.push(id),
  });
  const list = screen.getByRole('list', { name: 'Docs' });
  const auth = within(list).getByRole('button', { name: 'Auth refactor' });
  const row = auth.closest('li');
  if (row === null) throw new Error('no row');
  expect(within(row).getByText('auth')).toBeDefined();
  expect(
    within(row)
      .getByText('unreviewed')
      .closest('[data-tone]')
      ?.getAttribute('data-tone')
  ).toBe('warning');
  expect(row.getAttribute('aria-current')).toBeNull();
  const plan = within(list).getByRole('button', { name: 'Plan' });
  expect(plan.closest('li')?.getAttribute('aria-current')).toBe('true');
  fireEvent.click(auth);
  expect(picked).toEqual(['doc-1']);
});

test('the toolbar sets the search, the scope and the two toggles', () => {
  const sent: DocFilter[] = [];
  renderList({
    filter: { ...ALL, unreviewedOnly: true },
    onFilter: (next) => sent.push(next),
  });
  fireEvent.change(screen.getByLabelText('Search docs'), {
    target: { value: 'auth' },
  });
  const scope = screen.getByRole('radiogroup', { name: 'Scope' });
  expect(
    within(scope)
      .getByRole('radio', { name: 'All' })
      .getAttribute('aria-checked')
  ).toBe('true');
  fireEvent.click(within(scope).getByRole('radio', { name: 'Personal' }));
  const archived = screen.getByRole('button', { name: 'Archived' });
  const unreviewed = screen.getByRole('button', { name: 'Unreviewed' });
  expect(archived.getAttribute('aria-pressed')).toBe('false');
  expect(unreviewed.getAttribute('aria-pressed')).toBe('true');
  // A pressed toggle leads with a check, not only the pressed fill.
  expect(unreviewed.querySelector('svg')).not.toBeNull();
  expect(archived.querySelector('svg')).toBeNull();
  fireEvent.click(archived);
  fireEvent.click(unreviewed);
  expect(sent).toEqual([
    { ...ALL, unreviewedOnly: true, query: 'auth' },
    { ...ALL, unreviewedOnly: true, scope: 'personal' },
    { ...ALL, unreviewedOnly: true, status: 'archived' },
    { ...ALL, unreviewedOnly: false },
  ]);
});
