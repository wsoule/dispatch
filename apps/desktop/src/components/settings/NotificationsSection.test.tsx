import { SECRET_URL_MASK_SUFFIX } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { OPERATOR_ONLY } from './fields';
import { testConfig as config } from './fixtures.test-helper';
import { NotificationsSection } from './NotificationsSection';

// Each kind is a row whose title labels a `Switch`; the switch itself is the
// click target, named by that label.
function toggle(name: string) {
  fireEvent.click(screen.getByRole('switch', { name }));
}

test('unchecking a kind saves just that toggle', () => {
  const saved: unknown[] = [];
  render(
    <NotificationsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
      canOperate
    />
  );
  toggle('A fix loop gives up');
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
      canOperate
    />
  );
  expect(
    screen
      .getByRole('switch', { name: 'A run fails or gets stuck' })
      .getAttribute('aria-checked')
  ).toBe('false');
  expect(
    screen
      .getByRole('switch', { name: 'An agent asks you a question' })
      .getAttribute('aria-checked')
  ).toBe('true');
});

test('an edited webhook saves on blur, trimmed', () => {
  const saved: unknown[] = [];
  render(
    <NotificationsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
      canOperate
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
      canOperate
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
      canOperate
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
      canOperate
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
  expect(
    screen.getByText(/shortened address shown for a saved webhook/)
  ).toBeTruthy();
});

test('the mask suffix is refused even with nothing stored', () => {
  const saved: unknown[] = [];
  render(
    <NotificationsSection
      config={config}
      onSave={(p) => Promise.resolve(void saved.push(p))}
      canOperate
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

// The webhook sends data elsewhere, so below the operator tier it is disabled
// and marked with the lock, and a masked one offers no Replace or Clear.
test('below the operator tier the webhook is locked', () => {
  const { unmount } = render(
    <NotificationsSection
      config={config}
      onSave={() => Promise.resolve()}
      canOperate={false}
    />
  );
  expect(screen.getByLabelText<HTMLInputElement>('Webhook URL').disabled).toBe(
    true
  );
  expect(screen.getAllByLabelText(OPERATOR_ONLY).length).toBe(1);
  unmount();

  render(
    <NotificationsSection
      config={{
        ...config,
        notifications: { ...config.notifications, webhook: MASKED },
      }}
      onSave={() => Promise.resolve()}
      canOperate={false}
    />
  );
  expect(screen.getByText(MASKED)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
});
