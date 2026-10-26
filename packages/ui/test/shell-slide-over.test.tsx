import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, jest, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';

import AlertStrip from '../src/shell/alert-strip';
import PropertyList from '../src/shell/property-list';
import SlideOver from '../src/shell/slide-over';

afterEach(() => {
  cleanup();
  jest.useRealTimers();
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open M3 cutover
      </button>
      <SlideOver
        open={open}
        onClose={() => setOpen(false)}
        title="M3 cutover"
        breadcrumb="Atlas / M3"
        actions={
          <button type="button" aria-label="Copy link">
            Copy
          </button>
        }
      >
        <AlertStrip
          label="Overdue"
          tone="danger"
          action={{ label: 'Reschedule', onClick: () => undefined }}
        >
          Overdue by 3 days.
        </AlertStrip>
        <PropertyList
          label="Milestone details"
          items={[
            { label: 'Status', value: 'Overdue' },
            { label: 'Due date', value: 'Oct 18' },
          ]}
        />
      </SlideOver>
    </>
  );
}

describe('SlideOver', () => {
  test('is a labelled dialog that takes focus when opened', () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open M3 cutover' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog', { name: 'M3 cutover' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    // Desktop: the page beside it stays usable, so it is not aria-modal.
    expect(dialog.getAttribute('aria-modal')).toBeNull();
    expect(screen.getByText('Overdue by 3 days.')).toBeTruthy();
    expect(screen.getByText('Due date').tagName).toBe('DT');
  });

  test('Esc closes it and focus returns to the opener', () => {
    jest.useFakeTimers();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open M3 cutover' });
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });
    // Hidden from assistive tech while the exit slide plays…
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    // …and unmounted after it.
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(screen.queryByText('M3 cutover')).toBeNull();
  });

  test('the close button closes it too', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open M3 cutover' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('Tab wraps inside the panel', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open M3 cutover' }));
    const dialog = screen.getByRole('dialog');
    const copy = screen.getByRole('button', { name: 'Copy link' });
    const reschedule = screen.getByRole('button', { name: 'Reschedule' });
    reschedule.focus();
    fireEvent.keyDown(reschedule, { key: 'Tab' });
    expect(document.activeElement).toBe(copy);
    fireEvent.keyDown(copy, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(reschedule);
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  // A drawer that swaps its content in place (milestone → issue, relation
  // row → another issue, "Back to …"): the row that had focus unmounts.
  function SwapHarness() {
    const [open, setOpen] = useState(false);
    const [shown, setShown] = useState('ms-1');
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Open drawer
        </button>
        <button type="button" onClick={() => setShown('ms-2')}>
          Page row ms-2
        </button>
        <SlideOver
          open={open}
          onClose={() => setOpen(false)}
          title={shown === 'ms-1' ? 'Dual-write' : 'Schema cutover'}
          contentKey={shown}
        >
          <div key={shown}>
            <button
              type="button"
              onClick={() => setShown(shown === 'ms-1' ? 'ENG-10' : 'ms-1')}
            >
              {shown === 'ms-1' ? 'ENG-10' : 'Back to Dual-write'}
            </button>
          </div>
        </SlideOver>
      </>
    );
  }

  test('a swap in place moves focus to the panel, not <body>', () => {
    jest.useFakeTimers();
    render(<SwapHarness />);
    const opener = screen.getByRole('button', { name: 'Open drawer' });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    const body = dialog.lastElementChild as HTMLElement;
    body.scrollTop = 200;
    const row = screen.getByRole('button', { name: 'ENG-10' });
    row.focus();
    act(() => {
      fireEvent.click(row);
    });
    expect(document.activeElement).toBe(dialog);
    expect(body.scrollTop).toBe(0);
    // And back: the crumb that had focus unmounts as well.
    const back = screen.getByRole('button', { name: 'Back to Dual-write' });
    back.focus();
    act(() => {
      fireEvent.click(back);
    });
    expect(document.activeElement).toBe(dialog);
    // Closing still returns focus to what opened the panel.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(document.activeElement).toBe(opener);
  });

  test('a swap from a row on the page leaves focus on that row', () => {
    render(<SwapHarness />);
    fireEvent.click(screen.getByRole('button', { name: 'Open drawer' }));
    const pageRow = screen.getByRole('button', { name: 'Page row ms-2' });
    pageRow.focus();
    act(() => {
      fireEvent.click(pageRow);
    });
    expect(screen.getByRole('dialog', { name: 'Schema cutover' })).toBeTruthy();
    expect(document.activeElement).toBe(pageRow);
  });
});

// On a phone the header's worded actions ("Open in Linear ↗", "Copy
// link") show their icons only, so the crumb is not cut short; the words
// are hidden visually, never removed, so every action keeps its name.
describe('SlideOver header actions on a phone', () => {
  const sheet = readFileSync(
    path.join(import.meta.dir, '..', 'src', 'shell', 'slide-over.module.css'),
    'utf8'
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');

  test('a worded action with an icon hides its words visually at 640px', () => {
    const phone = sheet.slice(sheet.indexOf('@media (width <= 640px)'));
    const rule =
      /\.actions :is\(a, button\):has\(> \[aria-hidden='true'\]\) > span:not\(\[aria-hidden='true'\]\) \{([^}]*)\}/.exec(
        phone
      );
    expect(rule).not.toBeNull();
    expect(rule?.[1]).toContain('clip-path: inset(50%)');
    expect(rule?.[1]).not.toContain('display: none');
  });

  test('the words stay in the button name', () => {
    render(
      <SlideOver
        open
        onClose={() => {}}
        title="M3 cutover"
        breadcrumb="Atlas / M3"
        actions={
          <button type="button">
            <span aria-hidden="true">↗</span>
            <span>Open in Linear</span>
          </button>
        }
      >
        <p>Body</p>
      </SlideOver>
    );
    expect(screen.getByRole('button', { name: 'Open in Linear' })).toBeTruthy();
  });
});
