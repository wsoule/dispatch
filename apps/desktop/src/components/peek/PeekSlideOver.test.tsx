import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';

import { PeekSlideOver, PeekTitle, PresenceLine } from './PeekSlideOver';

afterEach(cleanup);

test('a peek is a slide-over named by its title, with the address in the bar and the summary above the body', async () => {
  const onClose = mock(() => {});
  render(
    <PeekSlideOver
      testId="person-peek"
      contentKey="human:sam"
      title={<PeekTitle name="Sam" />}
      subtitle="human:sam · teammate"
      summary={<PresenceLine live>here since 08:30</PresenceLine>}
      onClose={onClose}
    >
      <p>timeline</p>
    </PeekSlideOver>
  );
  const dialog = screen.getByRole('dialog', { name: 'Sam' });
  expect(within(dialog).getByText('human:sam · teammate')).toBeTruthy();
  const peek = screen.getByTestId('person-peek');
  expect(peek.querySelector('[data-slot=peek-summary]')?.textContent).toBe(
    'here since 08:30'
  );
  // The summary precedes the body.
  const summary = peek.querySelector('[data-slot=peek-summary]');
  const body = within(peek).getByText('timeline');
  expect(
    summary !== null &&
      (summary.compareDocumentPosition(body) &
        Node.DOCUMENT_POSITION_FOLLOWING) !==
        0
  ).toBe(true);
  // Focus moves into the panel on open; Close and Esc close it.
  await waitFor(() =>
    expect(dialog.contains(document.activeElement)).toBe(true)
  );
  fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(document, { key: 'Escape' });
  expect(onClose).toHaveBeenCalledTimes(2);
});

test('the presence dot carries the tone while live and goes muted away', () => {
  const { rerender } = render(
    <PresenceLine live tone="success">
      up
    </PresenceLine>
  );
  expect(screen.getByText('up').parentElement?.getAttribute('data-tone')).toBe(
    'success'
  );
  rerender(<PresenceLine live={false}>away</PresenceLine>);
  expect(
    screen.getByText('away').parentElement?.getAttribute('data-tone')
  ).toBe('muted');
});

test('without a summary the body follows the title directly, and actions sit in the bar', () => {
  render(
    <PeekSlideOver
      testId="thread-peek"
      contentKey="m-1"
      title="Thread"
      actions={<button type="button">Open in its home →</button>}
      onClose={() => {}}
    >
      <p>body</p>
    </PeekSlideOver>
  );
  const peek = screen.getByTestId('thread-peek');
  expect(peek.querySelector('[data-slot=peek-summary]')).toBeNull();
  expect(
    screen.getByRole('button', { name: 'Open in its home →' })
  ).toBeTruthy();
});
