import { ApiError, type OverseerRecord } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, test } from 'bun:test';

import { DockedConversation } from './DockedConversation';

afterEach(cleanup);

function record(over: Partial<OverseerRecord> = {}): OverseerRecord {
  return {
    id: 'w-1',
    prompt: 'why did r-41 fail?',
    backendName: 'fake',
    state: 'ready',
    messages: [
      { role: 'user', text: 'why did r-41 fail?', at: '2026-10-06T09:00:00Z' },
      {
        role: 'assistant',
        text: 'The cache test timed out.',
        at: '2026-10-06T09:01:00Z',
      },
    ],
    pendingActions: [],
    pendingApprovals: [],
    undeliveredDecisions: [],
    createdAt: '2026-10-06T09:00:00Z',
    updatedAt: '2026-10-06T09:01:00Z',
    ...over,
  };
}

// Renders one docked conversation over a client whose getOverseer answers
// with `load`, and counts restores and closes.
function renderDocked(
  load: () => Promise<OverseerRecord>,
  compact = false
): { restores: () => number; closes: () => number } {
  let restores = 0;
  let closes = 0;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <DockedConversation
        client={{ getOverseer: load }}
        port={4321}
        conversationId="w-1"
        compact={compact}
        onRestore={() => {
          restores++;
        }}
        onClose={() => {
          closes++;
        }}
      />
    </QueryClientProvider>
  );
  return { restores: () => restores, closes: () => closes };
}

test('wide, it is a list row naming the prompt and that it waits on you', async () => {
  const calls = renderDocked(() =>
    Promise.resolve(
      record({
        pendingApprovals: [
          { requestId: 'q-1' } as OverseerRecord['pendingApprovals'][number],
        ],
      })
    )
  );
  const row = await screen.findByTestId('overseer-docked');
  // The row is a button; the list item around it also holds its close button,
  // so a screen reader hears both as one item of the Set aside list.
  expect(row.tagName).toBe('BUTTON');
  const item = row.closest('[role="listitem"]');
  expect(item).not.toBeNull();
  expect(
    item?.contains(
      screen.getByRole('button', { name: 'Close this set-aside conversation' })
    )
  ).toBe(true);
  expect(row.textContent).toContain('why did r-41 fail?');
  expect(row.textContent).toContain('waiting on you');
  // The waiting dot takes the warning tone; the words say it too.
  expect(row.querySelector('[data-tone="warning"]')).not.toBeNull();
  fireEvent.click(row);
  expect(calls.restores()).toBe(1);
  fireEvent.click(
    screen.getByRole('button', { name: 'Close this set-aside conversation' })
  );
  expect(calls.closes()).toBe(1);
  expect(calls.restores()).toBe(1);
});

test('its tooltip shows the prompt and the last reply', async () => {
  renderDocked(() => Promise.resolve(record()));
  const row = await screen.findByTestId('overseer-docked');
  act(() => row.focus());
  const tip = screen.getByRole('tooltip', { hidden: true });
  expect(tip.textContent).toContain('why did r-41 fail?');
  expect(tip.textContent).toContain('The cache test timed out.');
  expect(row.getAttribute('aria-describedby')).toBe(tip.id);
});

test('compact, it is a chip button that brings the conversation back', async () => {
  const calls = renderDocked(
    () => Promise.resolve(record({ state: 'failed', messages: [] })),
    true
  );
  const chip = await screen.findByTestId('overseer-docked');
  expect(chip.tagName).toBe('BUTTON');
  expect(chip.textContent).toContain('why did r-41 fail?');
  expect(chip.textContent).toContain('failed');
  expect(chip.querySelector('.toneText[data-tone="danger"]')).not.toBeNull();
  fireEvent.click(chip);
  expect(calls.restores()).toBe(1);
  // No reply yet: the tooltip says what a press does.
  act(() => chip.focus());
  expect(screen.getByRole('tooltip', { hidden: true }).textContent).toContain(
    'Bring this conversation back'
  );
});

test('a running conversation says it is working', async () => {
  renderDocked(() => Promise.resolve(record({ state: 'running' })));
  const row = await screen.findByTestId('overseer-docked');
  expect(row.textContent).toContain('working');
});

test('a conversation the daemon no longer has leaves the dock', async () => {
  const calls = renderDocked(() =>
    Promise.reject(new ApiError('not found', 404))
  );
  await waitFor(() => expect(calls.closes()).toBe(1));
  expect(screen.queryByTestId('overseer-docked')).toBeNull();
});
