import { SECRET_URL_MASK_SUFFIX } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { testConfig as config } from './fixtures.test-helper';
import { NotificationsSection } from './NotificationsSection';

test('unchecking a kind saves just that toggle', () => {
  const saved: unknown[] = [];
  render(
    <NotificationsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  fireEvent.click(screen.getByLabelText('A fix loop stops and needs a ruling'));
  expect(saved).toEqual([
    { notifications: { kinds: { 'fix-loop-capped': false } } },
  ]);
});

test('renders the saved toggle state', () => {
  render(
    <NotificationsSection
      config={{
        ...config,
        notifications: {
          kinds: { ...config.notifications.kinds, 'run-stalled': false },
        },
      }}
      onSave={() => Promise.resolve()}
    />
  );
  expect(
    screen.getByLabelText('A run fails or stalls').getAttribute('aria-checked')
  ).toBe('false');
  expect(
    screen
      .getByLabelText('An agent asks you a question')
      .getAttribute('aria-checked')
  ).toBe('true');
});

test('an edited webhook saves on blur, trimmed', () => {
  const saved: unknown[] = [];
  render(
    <NotificationsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  const input = screen.getByLabelText('Webhook URL');
  fireEvent.change(input, {
    target: { value: '  https://hooks.example.com/a ' },
  });
  fireEvent.blur(input);
  expect(saved).toEqual([
    { notifications: { webhook: 'https://hooks.example.com/a' } },
  ]);
});

// An empty URL and no webhook are the same thing to the daemon, so clearing
// sends null rather than an empty string core would reject.
test('clearing the webhook sends null', () => {
  const saved: unknown[] = [];
  render(
    <NotificationsSection
      config={{
        ...config,
        notifications: {
          ...config.notifications,
          webhook: 'https://hooks.example.com/a',
        },
      }}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  const input = screen.getByLabelText('Webhook URL');
  expect((input as HTMLInputElement).value).toBe('https://hooks.example.com/a');
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  expect(saved).toEqual([{ notifications: { webhook: null } }]);
});

test('an unchanged webhook saves nothing on blur', () => {
  const saved: unknown[] = [];
  render(
    <NotificationsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  fireEvent.blur(screen.getByLabelText('Webhook URL'));
  expect(saved).toEqual([]);
});

// The daemon never hands the stored URL back — GET /api/config masks it to
// the origin plus the mask suffix — so the section must treat that string as
// display text: shown, never round-tripped through the input to disk.
const MASKED = `https://hooks.example.com${SECRET_URL_MASK_SUFFIX}`;

function renderMasked(saved: unknown[]) {
  render(
    <NotificationsSection
      config={{
        ...config,
        notifications: { ...config.notifications, webhook: MASKED },
      }}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
}

test('a masked stored webhook renders as read-only text with no input', () => {
  const saved: unknown[] = [];
  renderMasked(saved);
  expect(screen.getByText(MASKED)).toBeTruthy();
  expect(screen.getByText(/^Configured:/)).toBeTruthy();
  expect(screen.queryByLabelText('Webhook URL')).toBeNull();
  expect(saved).toEqual([]);
});

test('Replace reveals an empty input and saving a new URL PATCHes exactly it', () => {
  const saved: unknown[] = [];
  renderMasked(saved);
  fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
  const input = screen.getByLabelText('Webhook URL');
  expect((input as HTMLInputElement).value).toBe('');
  fireEvent.change(input, {
    target: { value: ' https://hooks.example.com/services/new ' },
  });
  fireEvent.blur(input);
  expect(saved).toEqual([
    { notifications: { webhook: 'https://hooks.example.com/services/new' } },
  ]);
});

test('leaving the replacement empty keeps the stored URL and saves nothing', () => {
  const saved: unknown[] = [];
  renderMasked(saved);
  fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
  fireEvent.blur(screen.getByLabelText('Webhook URL'));
  expect(saved).toEqual([]);
  expect(screen.queryByLabelText('Webhook URL')).toBeNull();
  expect(screen.getByText(MASKED)).toBeTruthy();
});

test('a value ending in the mask suffix is refused and PATCHes nothing', () => {
  const saved: unknown[] = [];
  renderMasked(saved);
  fireEvent.click(screen.getByRole('button', { name: 'Replace' }));
  const input = screen.getByLabelText('Webhook URL');
  fireEvent.change(input, { target: { value: MASKED } });
  fireEvent.blur(input);
  expect(saved).toEqual([]);
  expect(screen.getByText(/masked form of a stored URL/)).toBeTruthy();
});

test('the mask suffix is refused even with nothing stored', () => {
  const saved: unknown[] = [];
  render(
    <NotificationsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
    />
  );
  const input = screen.getByLabelText('Webhook URL');
  fireEvent.change(input, {
    target: { value: `https://other.example.com${SECRET_URL_MASK_SUFFIX}` },
  });
  fireEvent.blur(input);
  expect(saved).toEqual([]);
});

test('Clear on a masked webhook PATCHes null', () => {
  const saved: unknown[] = [];
  renderMasked(saved);
  fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(saved).toEqual([{ notifications: { webhook: null } }]);
});
