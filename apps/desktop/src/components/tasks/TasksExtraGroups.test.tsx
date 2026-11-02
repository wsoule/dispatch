import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { TasksExtraGroups } from './TasksExtraGroups';

// Only what the groups read; no daemon, so the docs group stays hidden.
const data = {
  inbox: [],
  runs: [],
  repoPrs: [],
  client: null,
  port: undefined,
  messageAccess: { canMessage: false },
} as unknown as DispatchProjectData;

test('the Notes group has no door to a Notes page: notes live in Coming in', () => {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TasksExtraGroups
        data={data}
        onOpenPr={() => {}}
        onOpenDoc={() => {}}
        onOpenAllDocs={() => {}}
      />
    </QueryClientProvider>
  );
  expect(screen.queryByRole('button', { name: 'All notes →' })).toBeNull();
});

test('an open group lists its rows: a PR row opens the PR, a note converts', () => {
  const opened: number[] = [];
  const converted: string[][] = [];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TasksExtraGroups
        data={
          {
            ...data,
            inbox: [{ id: 'n-1', text: 'look at the flaky test', done: false }],
            repoPrs: [
              {
                number: 12,
                title: 'Fix login',
                author: 'sam',
                state: 'OPEN',
                url: 'https://example.test/pull/12',
              },
            ],
            handleConvertInbox: (ids: string[]) => {
              converted.push(ids);
              return Promise.resolve();
            },
          } as unknown as DispatchProjectData
        }
        onOpenPr={(n) => opened.push(n)}
        onOpenDoc={() => {}}
        onOpenAllDocs={() => {}}
      />
    </QueryClientProvider>
  );
  const prs = screen.getByTestId('tasks-group-prs');
  expect(within(prs).queryByRole('list')).toBeNull();
  fireEvent.click(within(prs).getByRole('button', { name: 'Expand group' }));
  fireEvent.click(within(prs).getByRole('button', { name: '#12 Fix login' }));
  expect(opened).toEqual([12]);

  const notes = screen.getByTestId('tasks-group-notes');
  fireEvent.click(within(notes).getByRole('button', { name: 'Expand group' }));
  expect(within(notes).getByText('look at the flaky test')).toBeTruthy();
  fireEvent.click(within(notes).getByRole('button', { name: 'Convert' }));
  expect(converted).toEqual([['n-1']]);
});
