import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  mock,
  test,
} from 'bun:test';

import { COPIED_MS, MermaidSource } from '../src/graph/mermaid-source';

const SOURCE = [
  'flowchart LR',
  '  n0["M3 Cutover<br/>Atlas"]',
  '  n1["Invoices v2<br/>Billing"]',
  '  n0 -->|2| n1',
].join('\n');

const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

function mockClipboard(writeText: (text: string) => Promise<void>) {
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText },
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

describe('MermaidSource', () => {
  test('copies the source and says COPIED for 1600ms', async () => {
    const writeText = mock((_text: string) => Promise.resolve());
    mockClipboard(writeText);
    const onCopy = mock((_ok: boolean) => undefined);
    render(<MermaidSource source={SOURCE} onCopy={onCopy} />);

    const button = screen.getByRole('button', { name: /copy mermaid/i });
    await click(button);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText.mock.calls[0][0]).toBe(SOURCE);
    expect(onCopy.mock.calls[0][0]).toBe(true);
    expect(button.textContent).toBe('Copied');
    expect(button.dataset.state).toBe('copied');
    expect(screen.getByRole('status').textContent).toContain('copied');

    act(() => {
      jest.advanceTimersByTime(COPIED_MS - 1);
    });
    expect(button.textContent).toBe('Copied');
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(button.textContent).toBe('Copy Mermaid');
    expect(button.dataset.state).toBe('idle');
  });

  test('a second copy restarts the 1600ms window', async () => {
    mockClipboard(() => Promise.resolve());
    render(<MermaidSource source={SOURCE} />);
    const button = screen.getByRole('button', { name: /copy mermaid/i });
    await click(button);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    await click(button);
    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(button.textContent).toBe('Copied');
    act(() => {
      jest.advanceTimersByTime(600);
    });
    expect(button.textContent).toBe('Copy Mermaid');
  });

  test('when the clipboard refuses, says so and opens the source', async () => {
    mockClipboard(() => Promise.reject(new Error('denied')));
    const onCopy = mock((_ok: boolean) => undefined);
    const { container } = render(
      <MermaidSource source={SOURCE} onCopy={onCopy} />
    );
    const details = container.querySelector('details');
    expect(details?.open).toBe(false);
    await click(screen.getByRole('button', { name: /copy mermaid/i }));
    expect(onCopy.mock.calls[0][0]).toBe(false);
    expect(screen.getByRole('button').textContent).toContain('Copy failed');
    expect(details?.open).toBe(true);
  });

  test('shows the source in mono lines with a receipt', () => {
    mockClipboard(() => Promise.resolve());
    const { container } = render(<MermaidSource source={`${SOURCE}\n`} />);
    expect(container.textContent).toContain('4 lines · flowchart LR');
    const code = container.querySelector('code');
    expect(code?.textContent).toBe(`${SOURCE}\n`);
    expect(screen.getByText('Mermaid source')).toBeTruthy();
  });
});
