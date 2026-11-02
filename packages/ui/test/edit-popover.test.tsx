import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type ReactNode, useRef, useState } from 'react';

import { type PickerOption, PickerPopover, Popover } from '../src/index';

afterEach(cleanup);

// Popover: a non-modal role="dialog" anchored to a trigger (or another
// element), one layer of the package's stack. Every close path, where
// focus goes after each, and how it nests with a PickerPopover inside.

/** A host owning the open state, with a trigger and two fields. */
function Host({
  children,
  onOpenChange,
  ...rest
}: {
  children?: ReactNode;
  onOpenChange?: (open: boolean) => void;
  initialFocus?: 'first' | 'panel' | false;
  returnFocus?: boolean | (() => HTMLElement | null);
  closeOnOutside?: boolean;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button">Before</button>
      <Popover
        open={open}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          setOpen(next);
        }}
        label="Display options"
        trigger={<button type="button">Display</button>}
        {...rest}
      >
        {children ?? (
          <>
            <input aria-label="View name" />
            <button type="button">Save</button>
          </>
        )}
      </Popover>
      <p>Elsewhere</p>
      <button type="button" onClick={() => setOpen(false)}>
        Host close
      </button>
    </>
  );
}

function openButton(): HTMLElement {
  return screen.getByRole('button', { name: 'Display' });
}

function openIt(): HTMLElement {
  fireEvent.click(openButton());
  return screen.getByRole('dialog', { name: 'Display options' });
}

describe('Popover', () => {
  test('closed: the trigger says what it opens, and nothing else renders', () => {
    render(<Host />);
    const button = openButton();
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('opens as a named non-modal dialog with focus on its first field', () => {
    render(<Host />);
    const dialog = openIt();
    const button = openButton();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-controls')).toBe(dialog.id);
    expect(dialog.hasAttribute('aria-modal')).toBe(false);
    expect(dialog.getAttribute('popover')).toBe('manual');
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'View name' })
    );
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });

  test('controlled: the trigger asks the host, and a host that says no keeps it closed', () => {
    const onOpenChange = mock((_open: boolean) => undefined);
    render(
      <Popover
        open={false}
        onOpenChange={onOpenChange}
        label="Due date"
        trigger={<button type="button">Due</button>}
      >
        <p>Calendar</p>
      </Popover>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Due' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Due' }).getAttribute('aria-expanded')
    ).toBe('false');
  });

  test('the trigger toggles it; a press on the trigger is not outside', () => {
    render(<Host />);
    openIt();
    fireEvent.pointerDown(openButton());
    fireEvent.click(openButton());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('Escape closes it, returns focus to the trigger and stays from the page', () => {
    const pageEsc = mock((_event: KeyboardEvent) => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') pageEsc(event);
    };
    document.addEventListener('keydown', onKey);
    try {
      render(<Host />);
      openIt();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(openButton());
      expect(pageEsc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('a press outside closes it', () => {
    const changes: boolean[] = [];
    render(<Host onOpenChange={(next) => changes.push(next)} />);
    openIt();
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(changes).toEqual([true, false]);
  });

  test('closeOnOutside={false} keeps it through a press outside', () => {
    render(<Host closeOnOutside={false} />);
    openIt();
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('a press inside keeps it open', () => {
    render(<Host />);
    openIt();
    fireEvent.pointerDown(screen.getByRole('textbox'));
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  test('Tab past the last element closes it and leaves from the trigger', () => {
    render(<Host />);
    openIt();
    const save = screen.getByRole('button', { name: 'Save' });
    save.focus();
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openButton());
  });

  test('Tab inside moves on; Shift+Tab before the first goes back to the trigger', () => {
    render(<Host />);
    openIt();
    const field = screen.getByRole('textbox');
    fireEvent.keyDown(field, { key: 'Tab' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openButton());
  });

  test('closed by the host while focus was inside: focus goes back to the trigger', () => {
    render(<Host />);
    openIt();
    fireEvent.click(screen.getByRole('button', { name: 'Host close' }));
    // The click itself would focus the host's button in a browser; here
    // focus fell with the field, so the trigger takes it back.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(openButton());
  });

  test('initialFocus="panel" focuses the panel; a footer sits under the body', () => {
    render(
      <Host
        initialFocus="panel"
        footer={<button type="button">Apply</button>}
      />
    );
    const dialog = openIt();
    const panel = dialog.firstElementChild;
    expect(document.activeElement).toBe(panel);
    expect(screen.getByRole('button', { name: 'Apply' })).toBeTruthy();
  });

  test('initialFocus={ref} wins over the first focusable element', () => {
    function Focused() {
      const ref = useRef<HTMLInputElement>(null);
      const [open, setOpen] = useState(false);
      return (
        <Popover
          open={open}
          onOpenChange={setOpen}
          label="More options"
          trigger={<button type="button">More</button>}
          initialFocus={ref}
        >
          <button type="button">First</button>
          <input ref={ref} aria-label="Files it may change" />
        </Popover>
      );
    }
    render(<Focused />);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Files it may change' })
    );
  });

  test('returnFocus sends focus elsewhere on Escape; false leaves it', () => {
    function Elsewhere({ keep }: { keep: boolean }) {
      const target = useRef<HTMLButtonElement>(null);
      return (
        <>
          <button type="button" ref={target}>
            Row title
          </button>
          <Host returnFocus={keep ? false : () => target.current} />
        </>
      );
    }
    const view = render(<Elsewhere keep={false} />);
    openIt();
    fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Row title' })
    );
    view.unmount();
    render(<Elsewhere keep />);
    openIt();
    const field = screen.getByRole('textbox');
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).not.toBe(openButton());
  });
});

describe('Popover anchored to a wrapper that cannot take focus', () => {
  /** A saved-views menu's name form: anchored to the menu's wrapper span,
      handing focus back to the menu's own button. */
  function NameForm() {
    const [open, setOpen] = useState(true);
    const wrapper = useRef<HTMLSpanElement>(null);
    const button = useRef<HTMLButtonElement>(null);
    return (
      <>
        <span ref={wrapper}>
          <button type="button" ref={button}>
            view: All
          </button>
        </span>
        <Popover
          open={open}
          onOpenChange={setOpen}
          label="Save view"
          anchorRef={wrapper}
          returnFocus={() => button.current}
        >
          <input aria-label="View name" />
          <button type="button">Save</button>
        </Popover>
        <button type="button" onClick={() => setOpen(false)}>
          Host close
        </button>
      </>
    );
  }

  function menuButton(): HTMLElement {
    return screen.getByRole('button', { name: 'view: All' });
  }

  test('Shift+Tab before the first field hands focus to returnFocus()', () => {
    render(<NameForm />);
    const field = screen.getByRole('textbox', { name: 'View name' });
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'Tab', shiftKey: true });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  test('Tab past the last element leaves from returnFocus() too', () => {
    render(<NameForm />);
    const save = screen.getByRole('button', { name: 'Save' });
    act(() => save.focus());
    fireEvent.keyDown(save, { key: 'Tab' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });

  test('closed by the host while focus was inside: returnFocus() takes it', () => {
    render(<NameForm />);
    fireEvent.click(screen.getByRole('button', { name: 'Host close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(menuButton());
  });
});

describe('Popover anchored to another element', () => {
  /** A field the popover suggests for: focus stays in the field. */
  function Suggest({ onEscapeSeen }: { onEscapeSeen?: () => void }) {
    const [open, setOpen] = useState(true);
    const field = useRef<HTMLInputElement>(null);
    return (
      <div
        onKeyDown={(event) => {
          if (event.key === 'Escape') onEscapeSeen?.();
        }}
      >
        <input ref={field} aria-label="Describe a filter…" />
        <Popover
          open={open}
          onOpenChange={setOpen}
          label="Suggestions"
          anchorRef={field}
          initialFocus={false}
        >
          <button type="button">Assigned to me</button>
        </Popover>
        <p>Elsewhere</p>
      </div>
    );
  }

  test('initialFocus={false} leaves focus in the anchor, which counts as inside', () => {
    render(<Suggest />);
    const field = screen.getByRole('textbox');
    field.focus();
    expect(screen.getByRole('dialog', { name: 'Suggestions' })).toBeTruthy();
    fireEvent.pointerDown(field);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).toBe(field);
  });

  test('Escape from the anchor closes it first, and the field never sees it', () => {
    const seen = mock(() => undefined);
    render(<Suggest onEscapeSeen={seen} />);
    const field = screen.getByRole('textbox');
    field.focus();
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(field);
    expect(seen).not.toHaveBeenCalled();
    // Nothing open any more: the next Escape is the page's.
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(seen).toHaveBeenCalledTimes(1);
  });
});

describe('Popover with a PickerPopover inside', () => {
  const GROUPINGS: PickerOption[] = [
    { value: 'status', label: 'Status' },
    { value: 'priority', label: 'Priority' },
  ];

  function Display() {
    const [open, setOpen] = useState(false);
    const [grouping, setGrouping] = useState<string | null>('status');
    return (
      <>
        <Popover
          open={open}
          onOpenChange={setOpen}
          label="Display options"
          trigger={<button type="button">Display</button>}
        >
          <p>Grouping</p>
          <PickerPopover
            label="Grouping"
            options={GROUPINGS}
            value={grouping}
            onChange={setGrouping}
          />
        </Popover>
        <p>Elsewhere</p>
      </>
    );
  }

  function openPicker(): void {
    fireEvent.click(screen.getByRole('button', { name: 'Display' }));
    fireEvent.click(screen.getByRole('button', { name: /^Grouping/ }));
    expect(screen.getByRole('dialog', { name: 'Grouping' })).toBeTruthy();
  }

  test("the picker's Escape closes only the picker; the next closes the popover", () => {
    render(<Display />);
    openPicker();
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Grouping' })).toBeNull();
    const popover = screen.getByRole('dialog', { name: 'Display options' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Grouping/ })
    );
    fireEvent.keyDown(screen.getByRole('button', { name: /^Grouping/ }), {
      key: 'Escape',
    });
    expect(popover.isConnected).toBe(false);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Display' })
    );
  });

  test('a press in the popover outside the picker closes the picker only', () => {
    render(<Display />);
    openPicker();
    fireEvent.pointerDown(screen.getByText('Grouping', { selector: 'p' }));
    expect(screen.queryByRole('dialog', { name: 'Grouping' })).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'Display options' })
    ).toBeTruthy();
  });

  test('choosing in the picker keeps the popover open', async () => {
    render(<Display />);
    openPicker();
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: 'Priority' }));
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog', { name: 'Grouping' })).toBeNull();
    expect(
      screen.getByRole('dialog', { name: 'Display options' })
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Grouping: Priority' })
    ).toBeTruthy();
  });

  test('a press outside both closes the picker and the popover together', () => {
    render(<Display />);
    openPicker();
    fireEvent.pointerDown(screen.getByText('Elsewhere'));
    expect(screen.queryByRole('dialog', { name: 'Grouping' })).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('Popover on a phone', () => {
  test('is a bottom sheet with a Done button that closes it', () => {
    const original = window.matchMedia;
    window.matchMedia = (query: string) => ({
      matches: query === '(max-width: 640px)',
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    });
    try {
      render(<Host />);
      const dialog = openIt();
      expect(dialog.dataset.side).toBe('sheet');
      fireEvent.click(screen.getByRole('button', { name: 'Done' }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(openButton());
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('popover.module.css', () => {
  const css = readFileSync(
    path.join(import.meta.dir, '..', 'src', 'edit', 'popover.module.css'),
    'utf8'
  );

  test("draws Gr8r's .pop card on tokens, its motion only when welcome", () => {
    const panel = /^\.panel \{[^}]*\}/m.exec(css)?.[0] ?? '';
    expect(panel).toContain('background: var(--surface);');
    expect(panel).toContain('border-radius: var(--r-lg);');
    expect(panel).toContain('box-shadow: var(--shadow-pop);');
    expect(panel).not.toContain('animation');
    expect(css).toContain('@media (prefers-reduced-motion: no-preference)');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
