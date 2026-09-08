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
