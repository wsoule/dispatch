import type { SendInput } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  test('a long draft grows the text area only to a cap, then scrolls inside it', () => {
    mount('human:sam');
    type(Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n'));
    const composer = screen.getByTestId('home-composer');
    const box = screen.getByLabelText('Write to Sam');
    expect(composer.contains(box)).toBe(true);
    expect(
      within(composer).getByRole('button', { name: 'Send to Sam ↑' })
    ).toBeTruthy();
    // The cap lives in the module (two classes, so it outranks the library
    // TextArea's overflow: hidden); happy-dom draws no layout, so the
    // browser smoke measures the box itself.
    const css = readFileSync(
      join(import.meta.dir, 'HomeComposer.module.css'),
      'utf8'
    );
    const rule = /\.root \.text \{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(rule).toContain('max-height:');
    expect(rule).toContain('overflow-y: auto');
  });

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

  test('Kind is a radio group whose choice the send carries', async () => {
    const sent = mount('human:sam');
    const kinds = screen.getByRole('radiogroup', { name: 'Kind' });
    const radios = within(kinds).getAllByRole('radio');
    expect(radios.map((r) => r.textContent)).toEqual([
      'Message',
      'Question',
      'Notice',
    ]);
    expect(
      within(kinds)
        .getByRole('radio', { name: 'Message' })
        .getAttribute('aria-checked')
    ).toBe('true');
    fireEvent.click(within(kinds).getByRole('radio', { name: 'Question' }));
    expect(
      within(kinds)
        .getByRole('radio', { name: 'Question' })
        .getAttribute('aria-checked')
    ).toBe('true');
    type('does the spec say 403?');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Sam ↑' }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].input.kind).toBe('question');
    expect(sent[0].input.wake).toBe('request');
  });

  test('the Undo notice is a status line, and Undo restores the kind too', () => {
    mount('human:sam', 60_000);
    fireEvent.click(screen.getByRole('radio', { name: 'Notice' }));
    type('deploys freeze on Friday');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Sam ↑' }));
    const notice = screen.getByTestId('undo-send');
    expect(notice.getAttribute('role')).toBe('status');
    fireEvent.click(screen.getByRole('radio', { name: 'Message' }));
    fireEvent.click(within(notice).getByRole('button', { name: 'Undo' }));
    expect(
      screen.getByRole('radio', { name: 'Notice' }).getAttribute('aria-checked')
    ).toBe('true');
    expect(screen.queryByTestId('undo-send')).toBeNull();
  });

  test('Cancel on the outside warning keeps the draft and sends nothing', () => {
    const sent = mount('a2a:acme');
    type('hi');
    fireEvent.click(screen.getByRole('button', { name: 'Send to Sam ↑' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText('Write to Sam')).toHaveProperty('value', 'hi');
    expect(sent).toEqual([]);
    expect(localStorage.getItem('dispatch:a2a-confirmed:a2a:acme')).toBeNull();
  });
});
