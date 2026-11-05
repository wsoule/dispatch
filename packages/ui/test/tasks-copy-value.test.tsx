import { act, cleanup, fireEvent, render } from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test';
import { renderToString } from 'react-dom/server';

import { COPIED_MS, CopyValue } from '../src/index';

// CopyValue: a value in a code well and a Copy button named "Copy
// {label}" that says Copied for COPIED_MS, or "Select it" when the
// clipboard is missing or refused, then returns to Copy.

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function mockClipboard(writeText: ((text: string) => Promise<void>) | null) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: writeText === null ? undefined : { writeText },
  });
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  if (original !== undefined) {
    Object.defineProperty(navigator, 'clipboard', original);
  }
});

/** Clicks and lets the clipboard promise settle. */
async function click(el: HTMLElement) {
  await act(async () => {
    fireEvent.click(el);
    await Promise.resolve();
  });
}

describe('CopyValue', () => {
  test('the value is the code element’s text, and the host hooks land there', () => {
    mockClipboard(() => Promise.resolve());
    const { getByTestId, getByRole } = render(
      <CopyValue
        value="dsp_tok_123"
        label="token"
        data-testid="issued-token"
        data-slot="copy-value"
      />
    );
    const code = getByTestId('issued-token');
    expect(code.tagName).toBe('CODE');
    expect(code.textContent).toBe('dsp_tok_123');
    expect(code.getAttribute('data-slot')).toBe('copy-value');
    const button = getByRole('button', { name: 'Copy token' });
    expect(button.textContent).toBe('Copy');
    // Untruncated: no title, the value wraps instead.
    expect(code.hasAttribute('title')).toBe(false);
  });

  test('copies, says Copied for COPIED_MS, then returns to Copy', async () => {
    const writeText = mock((_text: string) => Promise.resolve());
    mockClipboard(writeText);
    const { getByRole, container } = render(
      <CopyValue value="dispatch-team:LINK" label="invite link" />
    );
    const button = getByRole('button', { name: 'Copy invite link' });
    await click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0]?.[0]).toBe('dispatch-team:LINK');
    expect(button.textContent).toBe('Copied');
    expect(button.getAttribute('data-state')).toBe('copied');
    // The name stays put; a polite live region says what happened.
    expect(getByRole('button', { name: 'Copy invite link' })).toBe(button);
    const live = container.querySelector('[aria-live="polite"]');
    expect(live?.textContent).toBe('Copied the invite link.');

    act(() => {
      jest.advanceTimersByTime(COPIED_MS - 1);
    });
    expect(button.textContent).toBe('Copied');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(button.textContent).toBe('Copy');
    expect(button.getAttribute('data-state')).toBe('idle');
    expect(live?.textContent).toBe('');
  });

  test('a refused clipboard says Select it and selects the value', async () => {
    mockClipboard(() => Promise.reject(new Error('denied')));
    const { getByRole, container } = render(
      <CopyValue value="482-119" label="code" />
    );
    const button = getByRole('button', { name: 'Copy code' });
    await click(button);
    expect(button.textContent).toBe('Select it');
    expect(button.getAttribute('data-state')).toBe('failed');
    expect(window.getSelection()?.toString()).toBe('482-119');
    expect(
      container.querySelector('[aria-live="polite"]')?.textContent
    ).toContain('Could not copy');
    act(() => {
      jest.advanceTimersByTime(COPIED_MS);
    });
    expect(button.textContent).toBe('Copy');
  });

  test('no clipboard at all (an insecure origin) also says Select it', async () => {
    mockClipboard(null);
    const { getByRole } = render(<CopyValue value="482-119" label="code" />);
    const button = getByRole('button', { name: 'Copy code' });
    await click(button);
    expect(button.textContent).toBe('Select it');
  });

  test('unmounting clears the timer', async () => {
    mockClipboard(() => Promise.resolve());
    const clear = jest.spyOn(globalThis, 'clearTimeout');
    const { getByRole, unmount } = render(
      <CopyValue value="482-119" label="code" />
    );
    await click(getByRole('button', { name: 'Copy code' }));
    const before = clear.mock.calls.length;
    unmount();
    expect(clear.mock.calls.length).toBe(before + 1);
    clear.mockRestore();
  });

  test('truncate keeps one line with the whole value in the title', () => {
    mockClipboard(() => Promise.resolve());
    const long = 'https://dispatch.example/join?code='.padEnd(120, 'x');
    const { getByText } = render(
      <CopyValue value={long} label="invite link" truncate mono={false} />
    );
    expect(getByText(long).getAttribute('title')).toBe(long);
  });

  test('renders on the server with no clipboard and no state', () => {
    const html = renderToString(
      <CopyValue value="dsp_tok_123" label="token" data-testid="issued-token" />
    );
    expect(html).toContain('data-testid="issued-token"');
    expect(html).toContain('dsp_tok_123');
    expect(html).toContain('aria-label="Copy token"');
    expect(html).toContain('data-state="idle"');
  });
});
