import type { SendInput } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import { HomeComposer } from './HomeComposer';

afterEach(() => {
  localStorage.clear();
});

function mount(to: string, holdMs = 20) {
  const sent: { input: SendInput; continueThread?: boolean }[] = [];
  const client = {
    sendMessage: (input: SendInput, opts?: { continueThread?: boolean }) => {
      sent.push({ input, continueThread: opts?.continueThread });
      return Promise.resolve({
        message: {},
        deliveries: [],
        downgraded: false,
      });
    },
  } as unknown as Parameters<typeof HomeComposer>[0]['client'];
  render(
    <QueryClientProvider client={new QueryClient()}>
      <HomeComposer
        client={client}
        port={1}
        to={to}
        label="Sam"
        holdMs={holdMs}
      />
    </QueryClientProvider>
  );
  return sent;
}

function type(text: string) {
  fireEvent.change(screen.getByLabelText('Write to Sam'), {
    target: { value: text },
  });
}

describe('HomeComposer', () => {
  test('the send button names who it reaches', () => {
    mount('human:sam');
    expect(screen.getByRole('button', { name: 'Send to Sam ↑' })).toBeTruthy();
  });

  test('a send waits for Undo, and Undo puts the draft back unsent', () => {
    const sent = mount('human:sam', 60_000);
    type('the spec says 403');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Sam ↑' }));
    expect(screen.getByTestId('undo-send').textContent).toContain(
      'Sending to Sam'
    );
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(screen.getByLabelText('Write to Sam')).toHaveProperty(
      'value',
      'the spec says 403'
    );
    expect(sent).toEqual([]);
  });

  test('after the hold it sends into the newest open thread', async () => {
    const sent = mount('human:sam');
    type('hello');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Sam ↑' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].input.to).toEqual(['human:sam']);
    expect(sent[0].input.body).toBe('hello');
    expect(sent[0].continueThread).toBe(true);
  });

  test('the first send to an outside agent asks first, once', async () => {
    const sent = mount('a2a:acme');
    type('hi');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Sam ↑' }));
    expect(screen.getByRole('alert').textContent).toContain(
      'Someone outside your team will see this'
    );
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Send to Sam' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(localStorage.getItem('dispatch:a2a-confirmed:a2a:acme')).toBe('1');
  });
});
