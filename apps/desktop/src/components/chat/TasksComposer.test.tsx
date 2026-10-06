import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { OverseerSession } from '../../hooks/useOverseerSession';
import { TasksComposer } from './TasksComposer';

const overseer = {
  record: undefined,
  sending: false,
  sendError: null,
  submit: () => Promise.resolve(),
} as unknown as OverseerSession;

test('sits as one line until used, carrying the context pill', () => {
  render(
    <TasksComposer
      overseer={overseer}
      about={{ taskId: 't-1', title: 'Fix login' }}
      onOpenOverseer={() => {}}
      disabled={false}
    />
  );
  const collapsed = screen.getByTestId('tasks-composer-collapsed');
  expect(collapsed.textContent).toContain('about t-1');
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(collapsed);
  expect(
    screen.getByRole('textbox', { name: 'Say something to your agent' })
  ).toBeTruthy();
});
