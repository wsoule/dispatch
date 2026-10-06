import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen } from '@testing-library/react';
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

test('the Notes group opens the full Notes page', () => {
  let opened = 0;
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TasksExtraGroups
        data={data}
        onOpenPr={() => {}}
        onOpenDoc={() => {}}
        onOpenAllDocs={() => {}}
        onOpenNotes={() => opened++}
      />
    </QueryClientProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: 'All notes →' }));
  expect(opened).toBe(1);
});
