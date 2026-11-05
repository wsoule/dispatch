import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { ScopeRequestCard } from './ScopeRequestCard';

const CAN_DECIDE: DecideAvailability = {
  enabled: true,
  notice: null,
  explanation: null,
  restart: null,
};

const PATHS = [
  'packages/server/src/team/federation/very/long/path/to/roster.ts',
  'docs/spec.md',
];

/** A promise the test settles by hand, to look at the card mid-flight. */
function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function card(
  onDecide: (granted: boolean) => Promise<void>,
  availability: DecideAvailability = CAN_DECIDE
) {
  render(
    <ScopeRequestCard
      paths={PATHS}
      reason="It needs the **roster** too."
      onDecide={onDecide}
      availability={availability}
      onRestartDaemon={() => Promise.resolve()}
    />
  );
}

describe('ScopeRequestCard', () => {
  // The line under the answers says "Selected" while the grant is in
  // flight and "Answered" only once it went out.
  test('Grant decides at once; Answered only once it is sent', async () => {
    const sent = deferred();
    const onDecide = mock((_granted: boolean) => sent.promise);
    card(onDecide);
    fireEvent.click(screen.getByRole('radio', { name: /^Grant Recommended/ }));
    expect(onDecide.mock.calls).toEqual([[true]]);
    expect(screen.getByText(/^Selected —/).textContent).toBe(
      'Selected — Granting…'
    );
    expect(
      screen
        .getAllByRole('radio')
        .map((radio) => radio.hasAttribute('disabled'))
    ).toEqual([true, true]);
    sent.resolve();
    await waitFor(() =>
      expect(screen.getByText(/^Answered —/).textContent).toBe(
        'Answered — Grant'
      )
    );
  });

  // A refused answer did not go out: the error shows and no choice is
  // left looking made.
  test('a refused grant shows the error and no Selected line', async () => {
    const onDecide = mock((_granted: boolean) =>
      Promise.reject(new Error('scope request already decided'))
    );
    card(onDecide);
    fireEvent.click(screen.getByRole('radio', { name: /^Grant/ }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'scope request already decided'
    );
    expect(screen.queryByText(/^(Selected|Answered) —/)).toBeNull();
    expect(
      screen.getByRole('radio', { name: 'Deny' }).hasAttribute('disabled')
    ).toBe(false);
  });

  // What the grant applies to is shown whole: never cut, the full path as
  // its title too.
  test('every path is listed in full, under the reason', () => {
    card(() => Promise.resolve());
    const items = screen.getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual(PATHS);
    expect(items.map((item) => item.getAttribute('title'))).toEqual(PATHS);
    expect(screen.getByText('roster').tagName).toBe('STRONG');
    expect(
      document
        .querySelector('[data-slot="scope-request-card"]')
        ?.contains(items[0] ?? null)
    ).toBe(true);
  });

  test('a window that cannot decide disables both answers and says why', () => {
    const onDecide = mock((_granted: boolean) => Promise.resolve());
    card(onDecide, {
      enabled: false,
      notice: 'Restart daemon to enable approvals',
      explanation: 'This window did not start the daemon.',
      restart: { safe: false, blockedReason: 'A run is in flight.' },
    });
    expect(screen.getByRole('note').textContent).toContain(
      'Restart daemon to enable approvals'
    );
    fireEvent.click(screen.getByRole('radio', { name: /^Grant/ }));
    expect(onDecide).not.toHaveBeenCalled();
  });
});
