import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { PeekDrawer } from './PeekDrawer';

test('a peek shows its title, address line and summary above the body, and closes', async () => {
  const onClose = mock(() => {});
  render(
    <PeekDrawer
      label="Conversation with Sam"
      testId="person-peek"
      title="Sam"
      subtitle="human:sam · teammate"
      summary={<span>here since 08:30</span>}
      onClose={onClose}
    >
      <p>timeline</p>
    </PeekDrawer>
  );
  const drawer = screen.getByRole('dialog', { name: 'Conversation with Sam' });
  const header = drawer.querySelector('[data-slot="peek-header"]');
  expect(header?.textContent).toContain('Sam');
  expect(header?.textContent).toContain('human:sam · teammate');
  expect(drawer.querySelector('[data-slot="peek-summary"]')?.textContent).toBe(
    'here since 08:30'
  );
  // Focus moves into the drawer on open.
  await waitFor(() =>
    expect(
      document.activeElement === screen.getByRole('button', { name: 'Close' })
    ).toBe(true)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

test('without a summary the header carries the hairline itself', () => {
  render(
    <PeekDrawer
      label="Thread"
      testId="thread-peek"
      title="Thread"
      onClose={() => {}}
    >
      <p>body</p>
    </PeekDrawer>
  );
  const header = document.querySelector('[data-slot="peek-header"]');
  expect(header?.className).toContain('shadow-hairline-bottom');
  expect(document.querySelector('[data-slot="peek-summary"]')).toBeNull();
});

test('Escape closes a peek', async () => {
  const onClose = mock(() => {});
  render(
    <PeekDrawer
      label="Thread"
      testId="thread-peek"
      title="Thread"
      onClose={onClose}
    >
      <p>body</p>
    </PeekDrawer>
  );
  const drawer = screen.getByRole('dialog', { name: 'Thread' });
  fireEvent.keyDown(drawer, { key: 'Escape' });
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});
