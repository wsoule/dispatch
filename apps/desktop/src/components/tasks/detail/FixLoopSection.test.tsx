import type { FixLoopState } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { FixLoopSection } from './FixLoopSection';

function state(overrides: Partial<FixLoopState>): FixLoopState {
  return {
    taskId: 't-1',
    round: 1,
    cap: 5,
    state: 'implementing',
    baseSha: 'abc123',
    lastReviewedSha: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

// The bar is the library SectionHeader (data-tone on its root); the status
// line's words carry the state, the tone only adds the diamond and edge.
function bar(container: HTMLElement): HTMLElement | null {
  const name = container.querySelector('[data-part="name"]');
  return name?.parentElement?.parentElement ?? null;
}

test('offers Review & fix before any loop, with no tone', () => {
  const onStart = mock(() => {});
  const { container } = render(
    <FixLoopSection
      fixLoop={null}
      escalation={[]}
      onStart={onStart}
      onStop={() => {}}
    />
  );
  expect(screen.getByRole('heading', { name: 'Fix loop' })).toBeDefined();
  expect(
    screen.getByText(
      'Not started — review and fixes run when you ask for them.'
    )
  ).toBeDefined();
  expect(bar(container)?.hasAttribute('data-tone')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Review & fix' }));
  expect(onStart).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
});

test('a loop capped for a ruling reads in the warning tone and offers Continue', () => {
  const { container } = render(
    <FixLoopSection
      fixLoop={state({
        state: 'capped',
        round: 5,
        stopReason: 'rounds-exhausted',
      })}
      escalation={[]}
      onStart={() => {}}
      onStop={() => {}}
    />
  );
  expect(screen.getByText('Capped at 5/5: needs a ruling')).toBeDefined();
  expect(bar(container)?.getAttribute('data-tone')).toBe('warning');
  expect(screen.getByRole('button', { name: 'Continue' })).toBeDefined();
});

test('a failed loop reads in the danger tone with its failure text', () => {
  const { container } = render(
    <FixLoopSection
      fixLoop={state({
        state: 'capped',
        stopReason: 'error',
        stopDetail: 'reviewer crashed',
      })}
      escalation={[]}
      onStart={() => {}}
      onStop={() => {}}
    />
  );
  expect(bar(container)?.getAttribute('data-tone')).toBe('danger');
  expect(screen.getByText('reviewer crashed')).toBeDefined();
});

test('a running loop offers Stop, and a start error reads in the danger tone', () => {
  const onStop = mock(() => {});
  render(
    <FixLoopSection
      fixLoop={state({ state: 'reviewing', round: 2 })}
      escalation={[]}
      onStart={() => {}}
      onStop={onStop}
      startError="daemon offline"
    />
  );
  expect(screen.getByText('Round 2/5 · Reviewing')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Review & fix' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  expect(onStop).toHaveBeenCalledTimes(1);
  const error = screen.getByText('daemon offline');
  expect(error.classList.contains('toneText')).toBe(true);
  expect(error.getAttribute('data-tone')).toBe('danger');
});

test('the start button is disabled while a start is in flight', () => {
  render(
    <FixLoopSection
      fixLoop={null}
      escalation={[]}
      onStart={() => {}}
      onStop={() => {}}
      starting
    />
  );
  expect(
    screen
      .getByRole('button', { name: 'Review & fix' })
      .hasAttribute('disabled')
  ).toBe(true);
});
