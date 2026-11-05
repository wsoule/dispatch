import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { describe, expect, mock, test } from 'bun:test';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { DecideUnavailableNotice } from './DecideUnavailableNotice';

const UNAVAILABLE: DecideAvailability = {
  enabled: false,
  notice: 'Restart daemon to enable approvals',
  explanation: 'This window did not start the daemon.',
  restart: { safe: true, blockedReason: null },
};

/** A promise the test settles by hand, to look at the button mid-restart. */
function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (err: Error) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('DecideUnavailableNotice', () => {
  test('a window that can decide shows nothing', () => {
    const { container } = render(
      <DecideUnavailableNotice
        availability={{
          enabled: true,
          notice: null,
          explanation: null,
          restart: null,
        }}
        onRestartDaemon={() => Promise.resolve()}
      />
    );
    expect(container.childElementCount).toBe(0);
  });

  // The restart's words swap to "Restarting…" while it runs (Button busy,
  // never a spinner), then come back.
  test('the restart reads Restarting… while it runs', async () => {
    const restart = deferred();
    const onRestartDaemon = mock(() => restart.promise);
    render(
      <DecideUnavailableNotice
        availability={UNAVAILABLE}
        onRestartDaemon={onRestartDaemon}
      />
    );
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('Restart daemon to enable approvals');
    expect(note.textContent).toContain('This window did not start the daemon.');
    fireEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));
    expect(onRestartDaemon).toHaveBeenCalledTimes(1);
    const busy = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Restarting…',
    });
    expect(busy.disabled).toBe(true);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    await act(async () => {
      restart.resolve();
      await restart.promise;
    });
    expect(screen.getByRole('button', { name: 'Restart daemon' })).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  test('a failed restart says why', async () => {
    const restart = deferred();
    render(
      <DecideUnavailableNotice
        availability={UNAVAILABLE}
        onRestartDaemon={() => restart.promise}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Restart daemon' }));
    await act(async () => {
      restart.reject(new Error('the daemon did not come back'));
      await restart.promise.catch(() => undefined);
    });
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'the daemon did not come back'
      )
    );
    expect(screen.getByRole('button', { name: 'Restart daemon' })).toBeTruthy();
  });

  // A restart that is not safe (a run in flight) is not offered; the
  // reason it is blocked is said instead.
  test('no restart button when it is not safe; the blocked reason shows', () => {
    render(
      <DecideUnavailableNotice
        availability={{
          ...UNAVAILABLE,
          restart: { safe: false, blockedReason: 'Two runs are in flight.' },
        }}
        onRestartDaemon={() => Promise.resolve()}
      />
    );
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByRole('note').textContent).toContain(
      'Two runs are in flight.'
    );
  });
});
