import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
} from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { OverseerDoor } from '../../lib/overseerThread';
import { AwayDigest, useNarratorSince } from './AwayDigest';

test('renders each line with its door and dismisses on Got it', () => {
  const opened: OverseerDoor[] = [];
  let dismissed = false;
  render(
    <AwayDigest
      lines={[
        {
          key: 'failed',
          tone: 'failed',
          text: '✕ r-1 failed · A',
          door: { taskId: 't-1' },
        },
      ]}
      since="2026-10-06T09:00:00Z"
      onDismiss={() => {
        dismissed = true;
      }}
      onOpenDoor={(door) => opened.push(door)}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Show t-1 in tasks →' }));
  expect(opened).toEqual([{ taskId: 't-1' }]);
  fireEvent.click(screen.getByRole('button', { name: 'Got it' }));
  expect(dismissed).toBe(true);
});

test('says nothing with no lines', () => {
  const { container } = render(
    <AwayDigest
      lines={[]}
      since="2026-10-06T09:00:00Z"
      onDismiss={() => {}}
      onOpenDoor={() => {}}
    />
  );
  expect(container.textContent).toBe('');
});

test('a project never seen starts now; dismiss moves the mark', () => {
  window.localStorage.removeItem('dispatch:narrator-seen:/repo');
  const before = new Date().toISOString();
  const { result } = renderHook(() => useNarratorSince('/repo'));
  expect(result.current.since >= before).toBe(true);
  expect(window.localStorage.getItem('dispatch:narrator-seen:/repo')).toBe(
    result.current.since
  );
  const first = result.current.since;
  act(() => result.current.dismiss());
  expect(result.current.since >= first).toBe(true);
});
