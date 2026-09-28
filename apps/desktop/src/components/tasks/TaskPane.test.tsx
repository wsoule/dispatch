import { render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import {
  fakeHost,
  newLog,
  PageProviders,
  task,
} from './page/pageHost.test-helper';
import type { TaskPageHost } from './page/TaskPageHost';

// The page's Review mode pulls in the Pierre diff, whose worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { TaskPane } = await import('./TaskPane');

function mount(host: TaskPageHost | null) {
  return render(
    <PageProviders host={host}>
      <TaskPane taskId="t-1" onClose={() => {}} onExpand={() => {}} />
    </PageProviders>
  );
}

// The Cockpit's split pane: callers name a task, the page draws it from the cached list
// before its body has loaded.
test('draws the listed task at once, in the split layout', () => {
  mount(fakeHost(newLog(), { tasks: [task('t-1')] }));
  expect(screen.getByLabelText('Task title')).toHaveProperty(
    'value',
    'Title of t-1'
  );
  expect(
    document.querySelector('[data-slot=task-page]')?.getAttribute('data-layout')
  ).toBe('split');
});

test('a task that left the list reads as gone', () => {
  mount(fakeHost(newLog(), { tasks: [] }));
  expect(screen.getByText('That task is no longer available.')).not.toBeNull();
});

test('without a host it draws only its frame', () => {
  const { container } = mount(null);
  expect(container.textContent).toBe('');
});
