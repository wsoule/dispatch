import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { DaemonUnavailable, describeDaemonError } from './DaemonUnavailable';

test('error state speaks plainly, offers Retry and tucks the raw detail behind Details', () => {
  const onRetry = mock(() => {});
  const { container } = render(
    <DaemonUnavailable
      starting={false}
      errorDetail="spawn failed: ENOENT /x/dispatchd"
      onRetry={onRetry}
    />
  );
  expect(
    screen.getByText('Dispatch couldn’t start for this project')
  ).toBeTruthy();
  // The alert glyph is toned through data-tone, never a literal colour.
  expect(container.querySelector('[data-tone="danger"] svg')).not.toBeNull();

  const details = screen.getByRole('button', { name: 'Details' });
  expect(details.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('spawn failed: ENOENT /x/dispatchd')).toBeNull();

  fireEvent.click(details);
  expect(details.getAttribute('aria-expanded')).toBe('true');
  const pre = screen.getByText('spawn failed: ENOENT /x/dispatchd');
  expect(pre.tagName).toBe('PRE');
  const panelId = details.getAttribute('aria-controls');
  expect(panelId).toBeTruthy();
  expect(pre.closest(`[id="${panelId}"]`)).not.toBeNull();

  fireEvent.click(details);
  expect(details.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByText('spawn failed: ENOENT /x/dispatchd')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(onRetry).toHaveBeenCalledTimes(1);
});

test('an Error instance shows its message behind Details too', () => {
  render(
    <DaemonUnavailable
      starting={false}
      errorDetail={new Error('daemon exited with code 1')}
      onRetry={() => {}}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Details' }));
  expect(screen.getByText('daemon exited with code 1').tagName).toBe('PRE');
});

test('error state without detail text has Retry but no Details', () => {
  render(
    <DaemonUnavailable starting={false} errorDetail={null} onRetry={() => {}} />
  );
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
});

test('starting state shows a status spinner and does not mention the daemon', () => {
  const { container } = render(
    <DaemonUnavailable starting errorDetail={null} onRetry={() => {}} />
  );
  const status = screen.getByRole('status');
  expect(status.getAttribute('aria-label')).toBe(
    'Starting Dispatch’s background service'
  );
  expect(
    screen.getByText('Starting Dispatch’s background service…')
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(container.textContent).not.toMatch(/dispatchd|daemon/i);
  expect(container.innerHTML).not.toMatch(/dispatchd|daemon/i);
});

test('describeDaemonError accepts Error instances and non-empty strings only', () => {
  expect(describeDaemonError(new Error('boom'))).toBe('boom');
  expect(describeDaemonError('tail of output')).toBe('tail of output');
  expect(describeDaemonError('')).toBeNull();
  expect(describeDaemonError(null)).toBeNull();
  expect(describeDaemonError({ message: 'not an error' })).toBeNull();
});
