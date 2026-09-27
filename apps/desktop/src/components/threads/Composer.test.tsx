import type { SendResult } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';

import type { ComposeState } from '../../lib/composer';
import { Composer } from './Composer';

const KNOWN = {
  tasks: [{ id: 't-1a2b3c', title: 'Checkout' }],
  channels: ['general'],
  agents: [],
  humans: ['human:wyat'],
};
const SENT = {
  message: { id: 'm-01', thread: 'm-01' },
  deliveries: [],
  downgraded: false,
} as unknown as SendResult;
const box = () => screen.getByLabelText<HTMLTextAreaElement>('New message');
const type = (value: string) => fireEvent.change(box(), { target: { value } });
const press = (key: string) => fireEvent.keyDown(box(), { key });
const label = (address: string) => address;

describe('Composer', () => {
  it('completes a task on @ and turns it into a recipient pill', () => {
    render(
      <Composer
        known={KNOWN}
        disabledReason={null}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    type('@t-1a');
    expect(screen.getByRole('option', { name: /t-1a2b3c/ })).toBeTruthy();
    press('Enter');
    expect(box().value).toBe('');
    expect(screen.getByText('task:t-1a2b3c')).toBeTruthy();
  });

  it('blocks an @token that matches nothing, inline, and sends nothing', () => {
    const onSend = mock(() => Promise.resolve(SENT));
    render(
      <Composer
        known={KNOWN}
        disabledReason={null}
        label={label}
        onSend={onSend}
      />
    );
    type('hello @bogus');
    press('Enter');
    expect(screen.getByRole('alert').textContent).toContain(
      'No address matches @bogus'
    );
    expect(onSend).not.toHaveBeenCalled();
  });

  it("shows the daemon's field and text for a rejected address, once, and keeps the draft", async () => {
    const onSend = mock(() =>
      Promise.reject(
        new ApiError(
          'invalid address "task:t-zzzzzz": not a task id',
          400,
          undefined,
          'to[0]'
        )
      )
    );
    render(
      <Composer
        known={KNOWN}
        disabledReason={null}
        label={label}
        onSend={onSend}
      />
    );
    type('@task:t-zzzzzz');
    press('Enter');
    type('ship it');
    press('Enter');
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toBe(
        'Recipient 1: invalid address "task:t-zzzzzz": not a task id'
      )
    );
    expect(box().value).toBe('ship it');
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('keeps a locked recipient and says why the window cannot send', () => {
    render(
      <Composer
        known={KNOWN}
        initialTo={['task:t-1a2b3c']}
        locked={['task:t-1a2b3c']}
        disabledReason="This window cannot send."
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    expect(screen.getByText('task:t-1a2b3c')).toBeTruthy();
    expect(screen.getByText('This window cannot send.')).toBeTruthy();
    expect(box().disabled).toBe(true);
  });

  it('sends a question that wakes a task by default, then clears the draft', async () => {
    const onSend = mock((_state: ComposeState) => Promise.resolve(SENT));
    const onSent = mock((_result: SendResult) => {});
    render(
      <Composer
        known={KNOWN}
        disabledReason={null}
        label={label}
        onSend={onSend}
        onSent={onSent}
      />
    );
    type('@t-1a');
    press('Enter');
    fireEvent.click(screen.getByRole('radio', { name: 'Question' }));
    type('Which cart?');
    press('Enter');
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(SENT));
    expect(onSend).toHaveBeenCalledWith({
      to: ['task:t-1a2b3c'],
      body: 'Which cart?',
      kind: 'question',
      urgent: false,
      wake: true,
    });
    expect(box().value).toBe('');
    expect(screen.queryByText('task:t-1a2b3c')).toBeNull();
  });

  it('ties the recipient list to the text box, so the highlighted recipient is announced', () => {
    render(
      <Composer
        known={KNOWN}
        disabledReason={null}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    type('@');
    const list = screen.getByRole('listbox', { name: 'Recipients' });
    expect(box().getAttribute('aria-controls')).toBe(list.id);
    expect(box().getAttribute('aria-autocomplete')).toBe('list');
    const options = screen.getAllByRole('option');
    expect(options.length).toBeGreaterThan(1);
    expect(box().getAttribute('aria-activedescendant')).toBe(options[0]?.id);
    press('ArrowDown');
    expect(box().getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    press('Escape');
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
  });

  it('says there is no match outside the list, and lets Tab and Shift+Tab leave', () => {
    render(
      <Composer
        known={KNOWN}
        disabledReason={null}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    type('@zzz');
    expect(screen.queryByRole('listbox') === null).toBe(true);
    expect(
      screen.getByText('No match. Type kind:id, then Enter.')
    ).toBeTruthy();
    // fireEvent returns false when a handler kept the key from moving focus.
    expect(fireEvent.keyDown(box(), { key: 'Tab' })).toBe(true);
    type('@t-1a');
    expect(fireEvent.keyDown(box(), { key: 'Tab', shiftKey: true })).toBe(true);
    expect(box().value).toBe('@t-1a');
  });

  it('Escape drops the @token being completed', () => {
    render(
      <Composer
        known={KNOWN}
        disabledReason={null}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    type('hi @t-1');
    press('Escape');
    expect(box().value).toBe('hi ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
