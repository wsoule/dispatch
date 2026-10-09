import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

function renderEmpty(filter: DocFilter, onNew?: () => void) {
  render(
    <DocList
      layout="page"
      docs={[]}
      filter={filter}
      onFilter={() => undefined}
      selected={null}
      onSelect={() => undefined}
      error={null}
      onNew={onNew}
    />
  );
}

test('an empty project offers a first doc', () => {
  let started = 0;
  renderEmpty(ALL, () => {
    started += 1;
  });
  expect(screen.getByText('No docs yet')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'New doc' }));
  expect(started).toBe(1);
});

test('a search with no results says so instead of offering a new doc', () => {
  renderEmpty({ ...ALL, query: 'roadmap' }, () => undefined);
  expect(screen.getByText('No docs match')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'New doc' })).toBeNull();
});
