import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  fakeHost,
  newLog,
  PageProviders,
  task,
} from '../components/tasks/page/pageHost.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';

// The Overseer's middle column embeds the same task page as Tasks. The page's Review
// mode pulls in the Pierre diff, whose worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { OverseerFocusView } = await import('./OverseerFocusView');

afterEach(cleanup);

test('a focused task is the task page, embedded under the Overseer at heading level 2', () => {
  const host = fakeHost(newLog(), { tasks: [task('t-1')] });
  let closed = 0;
  const opened: string[] = [];
  render(
    <PageProviders host={host}>
      <OverseerFocusView
        focus={{ kind: 'task', taskId: 't-1' }}
        data={host.project as DispatchProjectData}
        name={(address) => address}
        conversationCount={() => 3}
        onOpenRef={() => {}}
        onOpenInTasks={(taskId) => opened.push(taskId)}
        onClose={() => {
          closed++;
        }}
      />
    </PageProviders>
  );
  expect(
    screen.getByRole('heading', { level: 2, name: 'Title of t-1' })
  ).toBeTruthy();
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  expect(screen.getByRole('navigation', { name: 'Lifecycle' })).toBeTruthy();
  // No conversation toggle without a thread view, so the count has nowhere to show.
  expect(screen.queryByRole('button', { name: /Conversation/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open the full page' }));
  expect(opened).toEqual(['t-1']);
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(closed).toBe(1);
});

test('a message about the task opens on its conversation', () => {
  const host = {
    ...fakeHost(newLog(), { tasks: [task('t-1')] }),
    threadView: (taskId: string) => <p>threads of {taskId}</p>,
  };
  render(
    <PageProviders host={host}>
      <OverseerFocusView
        focus={{ kind: 'task', taskId: 't-1', conversation: true }}
        data={host.project as DispatchProjectData}
        name={(address) => address}
        conversationCount={() => 2}
        onOpenRef={() => {}}
        onOpenInTasks={() => {}}
        onClose={() => {}}
      />
    </PageProviders>
  );
  expect(screen.getByText('threads of t-1')).toBeTruthy();
  expect(
    screen
      .getByRole('button', { name: 'Conversation · 2' })
      .getAttribute('aria-pressed')
  ).toBe('true');
});
