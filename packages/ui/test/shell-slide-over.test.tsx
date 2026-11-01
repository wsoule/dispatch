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

import { Dialog, type PickerOption, PickerPopover } from '../src/index';
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

  test('on a phone it is modal while open, and not while it slides out', () => {
    jest.useFakeTimers();
    const original = window.matchMedia;
    window.matchMedia = (query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
    try {
      render(<Harness />);
      const opener = screen.getByRole('button', { name: 'Open M3 cutover' });
      opener.focus();
      fireEvent.click(opener);
      expect(
        screen
          .getByRole('dialog', { name: 'M3 cutover' })
          .getAttribute('aria-modal')
      ).toBe('true');
      fireEvent.keyDown(document.activeElement ?? document.body, {
        key: 'Escape',
      });
      // Still mounted for the exit slide, but no longer modal: the page's
      // shortcuts (isAnyModalOpen) are live again at once.
      expect(screen.getByText('M3 cutover')).toBeTruthy();
      expect(document.querySelector('[aria-modal="true"]')).toBeNull();
      act(() => {
        jest.advanceTimersByTime(400);
      });
      expect(screen.queryByText('M3 cutover')).toBeNull();
    } finally {
      window.matchMedia = original;
    }
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

// modal, size and footer: the form surface (a task composer) on every
// viewport. aria-modal while open, a scrim, the page locked, Tab kept in,
// and a modal layer of the stack, so Escape peels one layer at a time:
// a picker in it, a dialog over it, then the panel; never a non-modal
// SlideOver underneath first.
describe('SlideOver modal', () => {
  const STATES: PickerOption[] = [
    { value: 'todo', label: 'Todo' },
    { value: 'doing', label: 'In Progress' },
  ];

  function modals(): number {
    return document.querySelectorAll('[aria-modal="true"]').length;
  }

  function escape(): void {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });
  }

  /** Focus the button, then press it: a browser focuses on mousedown. */
  function press(name: string | RegExp): void {
    const button = screen.getByRole('button', { name });
    act(() => button.focus());
    fireEvent.click(button);
  }

  function scrimOf(panel: HTMLElement): HTMLElement {
    const scrim = panel.previousElementSibling;
    if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
    return scrim;
  }

  /** A composer: a modal, wide slide-over with a field, a picker, a
      button that opens a dialog over it, and a footer. */
  function Composer() {
    const [open, setOpen] = useState(false);
    const [status, setStatus] = useState<string | null>('todo');
    const [confirm, setConfirm] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          New task
        </button>
        <SlideOver
          open={open}
          onClose={() => setOpen(false)}
          title="New task"
          modal
          size="wide"
          data-testid="task-composer"
          data-slot="composer"
          footer={
            <>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
              <button type="button">Create task</button>
            </>
          }
        >
          <input aria-label="Task title" />
          <PickerPopover
            label="Status"
            options={STATES}
            value={status}
            onChange={setStatus}
          />
          <button type="button" onClick={() => setConfirm(true)}>
            Discard…
          </button>
          <Dialog
            open={confirm}
            onClose={() => setConfirm(false)}
            title="Discard this draft?"
          >
            <button type="button">Keep editing</button>
          </Dialog>
        </SlideOver>
      </>
    );
  }

  function composer(): HTMLElement | null {
    return screen.queryByRole('dialog', { name: 'New task' });
  }

  test('on a desktop width: aria-modal, a scrim, the page locked, Tab kept inside', () => {
    jest.useFakeTimers();
    render(<Composer />);
    press('New task');
    const panel = composer();
    if (panel === null) throw new Error('not open');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(panel.getAttribute('data-modal')).toBe('true');
    expect(scrimOf(panel).getAttribute('aria-hidden')).toBe('true');
    expect(document.documentElement.style.overflow).toBe('hidden');
    expect(panel.contains(document.activeElement)).toBe(true);
    // Tab past the footer's last button wraps to the header's close.
    const close = screen.getByRole('button', { name: 'Close' });
    const create = screen.getByRole('button', { name: 'Create task' });
    create.focus();
    fireEvent.keyDown(create, { key: 'Tab' });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(create);
    // Closing: no longer modal while it slides out, the page unlocked.
    escape();
    expect(document.querySelector('[data-testid="task-composer"]')).not.toBe(
      null
    );
    expect(modals()).toBe(0);
    expect(document.documentElement.style.overflow).toBe('');
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(document.querySelector('[data-testid="task-composer"]')).toBeNull();
  });

  test('a press on the scrim closes it, and focus goes back to the opener', () => {
    render(<Composer />);
    press('New task');
    const panel = composer();
    if (panel === null) throw new Error('not open');
    const scrim = scrimOf(panel);
    fireEvent.pointerDown(scrim);
    fireEvent.mouseDown(scrim);
    fireEvent.click(scrim);
    expect(composer()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'New task' })
    );
  });

  test('a press on the scrim with a picker open closes only the picker', () => {
    render(<Composer />);
    press('New task');
    press(/^Status/);
    expect(screen.getByRole('dialog', { name: 'Status' })).toBeTruthy();
    const panel = composer();
    if (panel === null) throw new Error('not open');
    const scrim = scrimOf(panel);
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(screen.queryByRole('dialog', { name: 'Status' })).toBeNull();
    expect(composer()).not.toBeNull();
    // The next press on the scrim closes the panel.
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(composer()).toBeNull();
  });

  test('Escape with a picker open closes only the picker, then the panel', () => {
    render(<Composer />);
    press('New task');
    press(/^Status/);
    escape();
    expect(screen.queryByRole('dialog', { name: 'Status' })).toBeNull();
    expect(composer()).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Status/ })
    );
    escape();
    expect(composer()).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'New task' })
    );
  });

  test('a Dialog over it: Escape closes the dialog, then the panel, focus back to each opener', () => {
    render(<Composer />);
    press('New task');
    press('Discard…');
    expect(modals()).toBe(2);
    expect(
      screen.getByRole('dialog', { name: 'Discard this draft?' })
    ).toBeTruthy();
    escape();
    expect(
      screen.queryByRole('dialog', { name: 'Discard this draft?' })
    ).toBeNull();
    expect(composer()).not.toBeNull();
    expect(modals()).toBe(1);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Discard…' })
    );
    escape();
    expect(composer()).toBeNull();
    expect(modals()).toBe(0);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'New task' })
    );
  });

  test('Escape with focus fallen to <body> still closes it', () => {
    render(<Composer />);
    press('New task');
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(composer()).toBeNull();
  });

  test('focus fallen to <body> comes back to the panel, and Tab from <body> moves into it', async () => {
    render(<Composer />);
    press('New task');
    const panel = composer();
    if (panel === null) throw new Error('not open');
    function blurActive(): void {
      act(() => {
        if (document.activeElement instanceof HTMLElement) {
          document.activeElement.blur();
        }
      });
    }
    // A Tab from <body> walks into the panel, never the page behind it.
    blurActive();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Close' })
    );
    // A focused control lost with nowhere to go: a tick later the panel
    // holds focus, so page keys and Tab start from inside it.
    blurActive();
    expect(document.activeElement).toBe(document.body);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(panel);
    // A host that moves focus itself first keeps its choice.
    const field = screen.getByRole('textbox', { name: 'Task title' });
    act(() => {
      field.focus();
      field.blur();
      screen.getByRole('button', { name: 'Create task' }).focus();
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Create task' })
    );
  });

  test('a non-modal panel leaves focus on <body> alone', async () => {
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open M3 cutover' });
    act(() => opener.focus());
    fireEvent.click(opener);
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(document.body);
  });

  test('the footer stays out of the scrolling body; data hooks reach the panel; wide', () => {
    render(<Composer />);
    press('New task');
    const panel = composer();
    if (panel === null) throw new Error('not open');
    const heading = screen.getByRole('heading', { name: 'New task' });
    const body = heading.parentElement;
    if (body === null) throw new Error('no body');
    const create = screen.getByRole('button', { name: 'Create task' });
    expect(body.contains(create)).toBe(false);
    expect(panel.lastElementChild?.contains(create)).toBe(true);
    expect(body.nextElementSibling).toBe(panel.lastElementChild);
    expect(panel.getAttribute('data-testid')).toBe('task-composer');
    expect(panel.getAttribute('data-slot')).toBe('composer');
    expect(panel.getAttribute('data-size')).toBe('wide');
    // The component's own data-* attributes stay its own.
    expect(panel.getAttribute('data-state')).toBe('open');
  });

  test('a modal SlideOver over a non-modal one takes Escape first', () => {
    function Stack() {
      const [issue, setIssue] = useState(false);
      const [composerOpen, setComposerOpen] = useState(false);
      return (
        <>
          <button type="button" onClick={() => setIssue(true)}>
            Open ENG-12
          </button>
          <SlideOver
            open={issue}
            onClose={() => setIssue(false)}
            title="ENG-12"
          >
            <button type="button" onClick={() => setComposerOpen(true)}>
              Add sub-task
            </button>
          </SlideOver>
          <SlideOver
            open={composerOpen}
            onClose={() => setComposerOpen(false)}
            title="New sub-task"
            modal
          >
            <input aria-label="Sub-task title" />
          </SlideOver>
        </>
      );
    }
    render(<Stack />);
    press('Open ENG-12');
    press('Add sub-task');
    const sub = screen.getByRole('dialog', { name: 'New sub-task' });
    expect(sub.getAttribute('aria-modal')).toBe('true');
    // From inside the modal panel.
    escape();
    expect(screen.queryByRole('dialog', { name: 'New sub-task' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'ENG-12' })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Add sub-task' })
    );
    // With focus fallen to <body>: the stack takes it first.
    press('Add sub-task');
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'New sub-task' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'ENG-12' })).toBeTruthy();
    // Then the non-modal one, from its own document listener.
    escape();
    expect(screen.queryByRole('dialog', { name: 'ENG-12' })).toBeNull();
  });

  test('defaults unchanged: a desktop panel has no scrim, no aria-modal, no lock', () => {
    render(<Harness />);
    press('Open M3 cutover');
    const panel = screen.getByRole('dialog', { name: 'M3 cutover' });
    expect(panel.getAttribute('aria-modal')).toBeNull();
    expect(panel.getAttribute('data-modal')).toBeNull();
    expect(panel.getAttribute('data-size')).toBe('default');
    // The scrim is the one aria-hidden element carrying a data-state.
    expect(
      document.querySelector('[aria-hidden="true"][data-state="open"]') === null
    ).toBe(true);
    expect(document.documentElement.style.overflow).toBe('');
    // No footer: the body is the panel's last child.
    expect(panel.lastElementChild?.querySelector('h2')).not.toBeNull();
  });
});

describe('slide-over.module.css: modal, wide and footer', () => {
  const sheet = readFileSync(
    path.join(import.meta.dir, '..', 'src', 'shell', 'slide-over.module.css'),
    'utf8'
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\s+/g, ' ');

  function rule(selector: string): string {
    const at = sheet.indexOf(` ${selector} {`);
    expect({ selector, found: at >= 0 }).toEqual({ selector, found: true });
    const open = sheet.indexOf('{', at);
    return sheet.slice(open + 1, sheet.indexOf('}', open));
  }

  test('wide is min(960px, 90vw), and covers a phone like the default', () => {
    expect(rule('.panel')).toContain('width: min(620px, 100vw);');
    expect(rule('.wide')).toContain('width: min(960px, 90vw);');
    const phone = sheet.slice(sheet.indexOf('@media (width <= 640px)'));
    expect(phone).toContain('.wide { width: 100vw; }');
  });

  test('the footer is a row under a --divider rule, outside the scroller', () => {
    const footer = rule('.footer');
    expect(footer).toContain('flex: 0 0 auto;');
    expect(footer).toContain('border-top: 1px solid var(--divider);');
    expect(rule('.body')).toContain('overflow-y: auto;');
  });

  test('a modal panel and its scrim sit over a non-modal panel', () => {
    expect(rule('.panel')).toContain('z-index: 50;');
    expect(rule(".panel[data-modal='true']")).toContain('z-index: 52;');
    expect(rule('.scrim')).toContain('z-index: 51;');
    expect(rule('.scrim')).toContain('background: var(--overlay);');
    expect(sheet).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
