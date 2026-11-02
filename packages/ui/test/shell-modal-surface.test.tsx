import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { type ReactNode, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import {
  type PickerOption,
  PickerPopover,
  useModalSurface,
} from '../src/index';

afterEach(cleanup);

// useModalSurface: a host's own panel over a scrim (Dispatch's Settings),
// with the behaviour of a modal SlideOver, which runs on the same hook.

const OPTIONS: PickerOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'high', label: 'High' },
];

/** A host panel wrapped by its scrim, as Dispatch's Settings draws it. */
function Panel({
  onClose,
  modal,
  children,
}: {
  onClose: () => void;
  modal?: boolean;
  children?: ReactNode;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const scrimRef = useRef<HTMLDivElement>(null);
  const surface = useModalSurface({
    open: true,
    modal,
    panelRef,
    scrimRef,
    onClose,
  });
  return (
    <div ref={scrimRef} data-testid="scrim" {...surface.scrimProps}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal={modal === false ? undefined : 'true'}
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={surface.onKeyDown}
      >
        <button type="button">First</button>
        {children}
        <button type="button">Last</button>
      </div>
    </div>
  );
}

/** The panel behind an opener, closing itself as a host would. */
function Host({
  onClose = () => undefined,
  modal,
  children,
}: {
  onClose?: () => void;
  modal?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Gear
      </button>
      {open ? (
        <Panel
          modal={modal}
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        >
          {children}
        </Panel>
      ) : null}
    </>
  );
}

function openPanel(): HTMLElement {
  const gear = screen.getByRole('button', { name: 'Gear' });
  act(() => gear.focus());
  fireEvent.click(gear);
  return screen.getByRole('dialog', { name: 'Settings' });
}

/** Counts the Escapes a page listener on document sees (bubble phase). */
function pageEscapes(): { count: () => number; stop: () => void } {
  let seen = 0;
  const listener = (event: KeyboardEvent) => {
    if (event.key === 'Escape') seen += 1;
  };
  document.addEventListener('keydown', listener);
  return {
    count: () => seen,
    stop: () => document.removeEventListener('keydown', listener),
  };
}

function blurActive(): void {
  act(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

describe('useModalSurface', () => {
  test('focus moves in on open and back to the opener on close; the page stops scrolling meanwhile', () => {
    render(<Host />);
    const panel = openPanel();
    expect(document.activeElement).toBe(panel);
    expect(document.documentElement.style.overflow).toBe('hidden');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Gear' })
    );
    expect(document.documentElement.style.overflow).toBe('');
  });

  test('Escape from inside closes it, unless something inside took it; the page never sees it', () => {
    const onClose = mock(() => {});
    render(<Host onClose={onClose} />);
    const panel = openPanel();
    const first = screen.getByRole('button', { name: 'First' });
    const handled = (event: KeyboardEvent) => event.preventDefault();
    first.addEventListener('keydown', handled);
    fireEvent.keyDown(first, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    first.removeEventListener('keydown', handled);
    const page = pageEscapes();
    fireEvent.keyDown(panel, { key: 'Escape' });
    page.stop();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(page.count()).toBe(0);
  });

  test('Tab and Shift+Tab cycle inside the panel', () => {
    render(<Host />);
    openPanel();
    const first = screen.getByRole('button', { name: 'First' });
    const last = screen.getByRole('button', { name: 'Last' });
    act(() => last.focus());
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test('a click on the scrim closes it; a click in the panel does not; a press on the scrim keeps focus', () => {
    const onClose = mock(() => {});
    render(<Host onClose={onClose} />);
    const panel = openPanel();
    fireEvent.click(panel);
    expect(onClose).not.toHaveBeenCalled();
    const scrim = screen.getByTestId('scrim');
    // mouseDown returns false when the default (moving focus) was prevented.
    expect(fireEvent.mouseDown(scrim)).toBe(false);
    expect(fireEvent.mouseDown(panel)).toBe(true);
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('a press on the scrim with a picker open closes only the picker; Escape there too', () => {
    const onClose = mock(() => {});
    function Effort() {
      const [value, setValue] = useState<string | null>('low');
      return (
        <PickerPopover
          label="Effort"
          options={OPTIONS}
          value={value}
          onChange={(next: string | null) => setValue(next)}
        />
      );
    }
    render(
      <Host onClose={onClose}>
        <Effort />
      </Host>
    );
    openPanel();
    fireEvent.click(screen.getByRole('button', { name: /^Effort/ }));
    expect(screen.queryByRole('listbox')).not.toBeNull();
    const scrim = screen.getByTestId('scrim');
    act(() => {
      fireEvent.pointerDown(scrim);
    });
    fireEvent.click(scrim);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /^Effort/ }));
    const list = screen.getByRole('listbox');
    fireEvent.keyDown(document.activeElement ?? list, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  test('focus fallen to <body> comes back to the panel, and Tab from <body> moves into it', async () => {
    render(<Host />);
    const panel = openPanel();
    blurActive();
    expect(document.activeElement).toBe(document.body);
    fireEvent.keyDown(document.body, { key: 'Tab' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'First' })
    );
    blurActive();
    expect(document.activeElement).toBe(document.body);
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(document.activeElement).toBe(panel);
  });

  test('Escape with focus fallen to <body> closes it through the stack, before the page', () => {
    const onClose = mock(() => {});
    render(<Host onClose={onClose} />);
    openPanel();
    blurActive();
    const page = pageEscapes();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    page.stop();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(page.count()).toBe(0);
  });

  // A host's legacy dialog portalled to <body> from inside the panel: its
  // keys bubble to the panel through React, but they are not the panel's.
  test('keys from a portal outside the panel are left to it', () => {
    const onClose = mock(() => {});
    function Legacy() {
      return createPortal(
        <div role="dialog" aria-modal="true" aria-label="Session">
          <button type="button">Inside the session</button>
        </div>,
        document.body
      );
    }
    render(
      <Host onClose={onClose}>
        <Legacy />
      </Host>
    );
    const panel = openPanel();
    const inside = screen.getByRole('button', { name: 'Inside the session' });
    expect(panel.contains(inside)).toBe(false);
    act(() => inside.focus());
    fireEvent.keyDown(inside, { key: 'Tab' });
    expect(document.activeElement).toBe(inside);
    const page = pageEscapes();
    fireEvent.keyDown(inside, { key: 'Escape' });
    page.stop();
    expect(onClose).not.toHaveBeenCalled();
    expect(page.count()).toBe(1);
  });

  test('modal: false keeps only the focus moves and the Tab trap', () => {
    const onClose = mock(() => {});
    render(<Host onClose={onClose} modal={false} />);
    const panel = openPanel();
    expect(document.activeElement).toBe(panel);
    expect(document.documentElement.style.overflow).toBe('');
    fireEvent.keyDown(panel, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    const last = screen.getByRole('button', { name: 'Last' });
    act(() => last.focus());
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'First' })
    );
    blurActive();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });
});
