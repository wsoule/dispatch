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

  it('adds the address typed in full rather than a longer one listed first, unless another is picked', () => {
    const people = { ...KNOWN, humans: ['human:adam', 'human:ada'] };
    render(
      <Composer
        known={people}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    type('@human:ada');
    press('Enter');
    expect(screen.getByText('human:ada')).toBeTruthy();
    expect(screen.queryByText('human:adam')).toBeNull();
    type('@human:ada');
    press('ArrowDown');
    press('Enter');
    expect(screen.getByText('human:adam')).toBeTruthy();
  });

  it('blocks an @token that matches nothing, inline, and sends nothing', () => {
    const onSend = mock(() => Promise.resolve(SENT));
    render(<Composer known={KNOWN} label={label} onSend={onSend} />);
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
    render(<Composer known={KNOWN} label={label} onSend={onSend} />);
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

  it('offers no way to remove a locked recipient, and removes any other', () => {
    render(
      <Composer
        known={KNOWN}
        initialTo={['task:t-1a2b3c', 'human:wyat']}
        locked={['task:t-1a2b3c']}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    expect(
      screen.queryByRole('button', { name: 'Remove task:t-1a2b3c' })
    ).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove human:wyat' }));
    expect(screen.queryByText('human:wyat')).toBeNull();
    expect(screen.getByText('task:t-1a2b3c')).toBeTruthy();
  });

  it('sends a question that wakes a task by default, then clears the draft', async () => {
    const onSend = mock((_state: ComposeState) => Promise.resolve(SENT));
    const onSent = mock((_result: SendResult) => {});
    render(
      <Composer known={KNOWN} label={label} onSend={onSend} onSent={onSent} />
    );
    type('@t-1a');
    press('Enter');
    fireEvent.click(screen.getByRole('radio', { name: 'Question' }));
    type('Which cart?');
    press('Enter');
    await waitFor(() => expect(onSent).toHaveBeenCalledWith(SENT));
    expect(onSend).toHaveBeenCalledWith(
      {
        to: ['task:t-1a2b3c'],
        body: 'Which cart?',
        kind: 'question',
        urgent: false,
        wake: true,
      },
      expect.any(String)
    );
    expect(box().value).toBe('');
    expect(screen.queryByText('task:t-1a2b3c')).toBeNull();
  });

  it('keeps one idempotency key per draft: resent unchanged after a lost response, new after an edit or a send', async () => {
    const onSend = mock((_state: ComposeState, _key: string) =>
      Promise.resolve(SENT)
    );
    onSend.mockImplementationOnce(() =>
      Promise.reject(new TypeError('Failed to fetch'))
    );
    render(
      <Composer
        known={KNOWN}
        initialTo={['task:t-1a2b3c']}
        label={label}
        onSend={onSend}
      />
    );
    const send = async (calls: number) => {
      press('Enter');
      await waitFor(() => expect(onSend).toHaveBeenCalledTimes(calls));
    };
    type('ship it');
    await send(1);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    // Unchanged: the same key, so the daemon replays a send that landed.
    await send(2);
    await waitFor(() => expect(box().value).toBe(''));
    type('ship it');
    await send(3);
    fireEvent.click(screen.getByRole('switch', { name: 'Urgent' }));
    type('ship it now');
    await send(4);
    const keys = onSend.mock.calls.map((call) => call[1]);
    expect(keys[1]).toBe(keys[0]);
    expect(new Set(keys).size).toBe(3);
  });

  it('ties the recipient list to the text box, so the highlighted recipient is announced', () => {
    render(
      <Composer
        known={KNOWN}
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

  it('says there is no match in a status region already on the page, so it is announced', () => {
    render(
      <Composer
        known={KNOWN}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    const status = screen.getByRole('status');
    expect(status.textContent).toBe('');
    type('@t-1a');
    expect(screen.getByRole('status') === status).toBe(true);
    expect(status.textContent).toBe('');
    type('@zzz');
    expect(screen.getByRole('status') === status).toBe(true);
    expect(status.textContent).toBe('No match. Type kind:id, then Enter.');
  });

  it('Escape drops the @token being completed', () => {
    render(
      <Composer
        known={KNOWN}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    type('hi @t-1');
    press('Escape');
    expect(box().value).toBe('hi ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Escape with no @token cancels, after dropping one first', () => {
    const onCancel = mock(() => {});
    render(
      <Composer
        known={KNOWN}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
        onCancel={onCancel}
      />
    );
    type('hi @t-1');
    press('Escape');
    expect(onCancel).not.toHaveBeenCalled();
    press('Escape');
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Cancel is offered only with somewhere to go back to', () => {
    const onCancel = mock(() => {});
    const { rerender } = render(
      <Composer
        known={KNOWN}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
      />
    );
    expect(
      screen.queryByRole('button', { name: 'Cancel' })?.textContent
    ).toBeUndefined();
    rerender(
      <Composer
        known={KNOWN}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
        onCancel={onCancel}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('focusOnMount puts the caret in the message box', () => {
    render(
      <Composer
        known={KNOWN}
        label={label}
        onSend={mock(() => Promise.resolve(SENT))}
        focusOnMount
      />
    );
    expect(document.activeElement === box()).toBe(true);
  });
});
