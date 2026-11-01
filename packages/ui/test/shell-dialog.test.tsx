import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { type ReactNode, useRef, useState } from 'react';

import {
  Button,
  ConfirmDialog,
  Dialog,
  type DialogProps,
  PickerPopover,
} from '../src/index';
import SlideOver from '../src/shell/slide-over';

afterEach(cleanup);

// Dialog and ConfirmDialog. The first block ports the 11 behaviours of
// packages/ui-legacy/src/dialog.test.tsx (the Base UI dialog) to their
// Gr8r equivalents: the header row (Back, title, close) plays the legacy
// chrome row and corner close, the panel plays the popup, and the data-*
// hooks and initialFocusRef play the popup ref.

function modal(): HTMLElement | null {
  return document.querySelector('[aria-modal="true"]');
}

/** An opener and a Dialog it opens; the dialog's props are the test's. */
function Opener(
  props: Omit<DialogProps, 'open' | 'onClose' | 'title'> & {
    title?: ReactNode;
    onClose?: () => void;
  }
) {
  const [open, setOpen] = useState(false);
  const { title = 'New doc', onClose, ...rest } = props;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      <Dialog
        {...rest}
        open={open}
        title={title}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
      />
    </>
  );
}

/** Opens the Opener's dialog and returns it (the one aria-modal panel). */
function openDialog(): HTMLElement {
  fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
  const dialog = modal();
  if (!(dialog instanceof HTMLElement)) throw new Error('no modal dialog');
  return dialog;
}

describe('Dialog: the ported focus and chrome rules', () => {
  // Legacy: "the corner close hides itself once a DialogChrome is
  // present". Gr8r: the header row owns the one close button, beside a
  // Back action, and nothing else adds a second.
  test('the header row holds the one close button, beside a Back action', () => {
    render(
      <Opener titleAction={<Button aria-label="Back" icon={<svg />} />}>
        <input aria-label="Title" />
      </Opener>
    );
    const dialog = openDialog();
    expect(
      within(dialog).getAllByRole('button', { name: 'Close' })
    ).toHaveLength(1);
    expect(within(dialog).getByRole('button', { name: 'Back' })).toBeTruthy();
  });

  // Legacy: "showCloseButton={false} drops the corner close entirely".
  // Gr8r: an alertdialog has no close button (its buttons answer it).
  test('role="alertdialog" draws no close button', () => {
    render(
      <Opener role="alertdialog" actions={<Button>OK</Button>}>
        Plain
      </Opener>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    const dialog = screen.getByRole('alertdialog', { name: 'New doc' });
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
  });

  // Legacy: "initialFocusTarget skips the chrome row and lands on the
  // first field".
  test('focus skips the header row and lands on the first body field', () => {
    render(
      <Opener titleAction={<Button aria-label="Back" icon={<svg />} />}>
        <input aria-label="Title" />
        <textarea aria-label="Body" />
      </Opener>
    );
    openDialog();
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Title' })
    );
  });

  // Legacy: "a chrome-only dialog (the shortcuts reference) focuses the
  // popup itself".
  test('a dialog with nothing but its header to focus focuses the panel', () => {
    render(
      <Opener titleAction={<Button aria-label="Back" icon={<svg />} />}>
        <p>?</p>
      </Opener>
    );
    const dialog = openDialog();
    expect(document.activeElement).toBe(dialog);
    expect(dialog.getAttribute('tabindex')).toBe('-1');
  });

  // Legacy: "a corner close alone also falls back to the popup".
  test('the close button alone also falls back to the panel', () => {
    render(<Opener>Plain</Opener>);
    const dialog = openDialog();
    expect(document.activeElement).toBe(dialog);
  });

  // Legacy: "a disabled first field is skipped for the next enabled one".
  test('a disabled first field and a tabindex=-1 button are skipped', () => {
    render(
      <Opener titleAction={<Button aria-label="Back" icon={<svg />} />}>
        <input aria-label="Locked" disabled />
        <button type="button" tabIndex={-1}>
          Hidden from tab
        </button>
        <button type="button">Save</button>
      </Opener>
    );
    openDialog();
    expect(document.activeElement?.textContent).toBe('Save');
  });

  // Legacy: "initialFocusTarget hands a missing popup back to Base UI".
  // Gr8r: a closed dialog renders nothing and takes no focus.
  test('closed, it renders nothing and leaves focus alone', () => {
    render(
      <Dialog open={false} onClose={() => undefined} title="Hidden">
        <input aria-label="Title" />
      </Dialog>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(modal()).toBeNull();
    expect(document.activeElement).toBe(document.body);
  });

  // Legacy: "DialogContent forwards its popup element to a consumer ref".
  // Gr8r: a host finds the panel through its own data hooks.
  test("a host's data hooks land on the panel (the role=dialog element)", () => {
    render(
      <Opener data-testid="publish" data-slot="dialog-content">
        Plain
      </Opener>
    );
    const dialog = openDialog();
    expect(screen.getByTestId('publish')).toBe(dialog);
    expect(dialog.getAttribute('data-slot')).toBe('dialog-content');
  });

  // Legacy: "an opened dialog puts the caret in the first body field, not
  // the chrome" (with actions in the footer too).
  test('an opened form puts the caret in its first field, not a footer button', () => {
    render(
      <Opener
        titleAction={<Button aria-label="Back" icon={<svg />} />}
        actions={<Button variant="primary">Create</Button>}
      >
        <input aria-label="Title" />
      </Opener>
    );
    openDialog();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Title');
  });

  // Legacy: "a chrome-only dialog focuses the popup itself" (rendered).
  test('a reading dialog (a reference) focuses the panel so its title is read', () => {
    render(
      <Opener title="Shortcuts" size="lg">
        <p>?</p>
      </Opener>
    );
    const dialog = openDialog();
    expect(document.activeElement).toBe(dialog);
    expect(dialog.getAttribute('aria-labelledby')).toBe(
      screen.getByRole('heading', { name: 'Shortcuts' }).id
    );
    expect(dialog.dataset.size).toBe('lg');
  });

  // Legacy: "a consumer's explicit initialFocus wins over the default".
  test('an explicit initialFocusRef wins over the first field', () => {
    function Explicit() {
      const ref = useRef<HTMLButtonElement>(null);
      return (
        <Opener
          initialFocusRef={ref}
          actions={
            <Button ref={ref} variant="primary">
              Publish
            </Button>
          }
        >
          <input aria-label="Title" defaultValue="Pre-filled" />
        </Opener>
      );
    }
    render(<Explicit />);
    openDialog();
    expect(document.activeElement?.textContent).toBe('Publish');
  });
});

describe('Dialog behaviour', () => {
  test('aria-modal while open, named and described; gone when closed', () => {
    render(
      <Opener description="Pick a folder for the new doc.">
        <input aria-label="Title" />
      </Opener>
    );
    expect(modal()).toBeNull();
    const dialog = openDialog();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(modal()).toBe(dialog);
    expect(
      screen.getByRole('dialog', {
        name: 'New doc',
        description: 'Pick a folder for the new doc.',
      })
    ).toBe(dialog);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(modal()).toBeNull();
  });

  test('Escape closes it, returns focus to the opener, and the page never sees it', () => {
    const pageEsc = mock((_event: KeyboardEvent) => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') pageEsc(event);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onKey);
    try {
      render(
        <Opener>
          <input aria-label="Title" />
        </Opener>
      );
      const opener = screen.getByRole('button', { name: 'Open dialog' });
      opener.focus();
      openDialog();
      fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Escape' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(document.activeElement).toBe(opener);
      expect(pageEsc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('keydown', onKey);
    }
  });

  test('Escape from focus outside the panel still closes it (the stack)', () => {
    render(<Opener>Plain</Opener>);
    openDialog();
    act(() => (document.activeElement as HTMLElement | null)?.blur());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('a press on the scrim closes it, unless dismissOnOutsideClick is false', () => {
    const view = render(<Opener>Plain</Opener>);
    let dialog = openDialog();
    const scrim = () =>
      dialog.parentElement?.querySelector(':scope > [aria-hidden="true"]');
    const first = scrim();
    if (!(first instanceof HTMLElement)) throw new Error('no scrim');
    // The press must not take focus out of the dialog.
    expect(fireEvent.mouseDown(first)).toBe(false);
    fireEvent.pointerDown(first);
    expect(screen.queryByRole('dialog')).toBeNull();
    view.unmount();
    render(<Opener dismissOnOutsideClick={false}>Plain</Opener>);
    dialog = openDialog();
    const second = scrim();
    if (!(second instanceof HTMLElement)) throw new Error('no scrim');
    fireEvent.pointerDown(second);
    expect(screen.getByRole('dialog')).toBe(dialog);
  });

  test('dismissible={false} ignores Escape, the scrim and the close button', () => {
    const onClose = mock(() => undefined);
    const pageEsc = mock(() => undefined);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') pageEsc();
    };
    document.addEventListener('keydown', onKey);
    try {
      render(
        <Dialog open dismissible={false} onClose={onClose} title="Cloning…">
          <p>Cloning the repository.</p>
        </Dialog>
      );
      const dialog = screen.getByRole('dialog');
      fireEvent.keyDown(dialog, { key: 'Escape' });
      const scrim = dialog.parentElement?.firstElementChild;
      if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
      fireEvent.pointerDown(scrim);
      const close = within(dialog).getByRole('button', { name: 'Close' });
      expect(close.hasAttribute('disabled')).toBe(true);
      fireEvent.click(close);
      expect(onClose).not.toHaveBeenCalled();
      // Swallowed all the same: nothing beneath reacts to the key.
      expect(pageEsc).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('Tab cycles inside the panel', () => {
    render(
      <Opener actions={<Button variant="primary">Create</Button>}>
        <input aria-label="Title" />
      </Opener>
    );
    const dialog = openDialog();
    const create = within(dialog).getByRole('button', { name: 'Create' });
    create.focus();
    fireEvent.keyDown(create, { key: 'Tab' });
    // Wraps to the first focusable element: the header's close button.
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Close' })
    );
    fireEvent.keyDown(document.activeElement ?? dialog, {
      key: 'Tab',
      shiftKey: true,
    });
    expect(document.activeElement).toBe(create);
  });

  test('a new contentKey moves focus to the new step and scrolls to the top', () => {
    function Steps() {
      const [step, setStep] = useState<'choose' | 'clone'>('choose');
      return (
        <Dialog
          open
          onClose={() => undefined}
          title={step === 'choose' ? 'Add project' : 'Clone from GitHub'}
          contentKey={step}
          titleAction={
            step === 'clone' ? (
              <Button
                aria-label="Back"
                icon={<svg />}
                onClick={() => setStep('choose')}
              />
            ) : undefined
          }
        >
          {step === 'choose' ? (
            <button type="button" onClick={() => setStep('clone')}>
              Clone from GitHub…
            </button>
          ) : (
            <input aria-label="Repository" />
          )}
        </Dialog>
      );
    }
    render(<Steps />);
    const choose = screen.getByRole('button', { name: 'Clone from GitHub…' });
    expect(document.activeElement).toBe(choose);
    fireEvent.click(choose);
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Repository' })
    );
  });
});

describe('Dialog nested with other layers', () => {
  function WithPicker() {
    const [value, setValue] = useState<string | null>('docs');
    return (
      <Opener>
        <p>Folder</p>
        <PickerPopover
          label="Folder"
          options={[
            { value: 'docs', label: 'docs' },
            { value: 'notes', label: 'notes' },
          ]}
          value={value}
          onChange={setValue}
        />
      </Opener>
    );
  }

  test('a picker inside takes Escape first and never closes the dialog', () => {
    render(<WithPicker />);
    openDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Folder/ }));
    fireEvent.keyDown(screen.getByRole('combobox'), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Folder' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New doc' })).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Folder/ })
    );
  });

  test('a press in the dialog closes only the picker; the scrim then closes the dialog', () => {
    render(<WithPicker />);
    const dialog = openDialog();
    fireEvent.click(screen.getByRole('button', { name: /^Folder/ }));
    fireEvent.pointerDown(
      within(dialog).getByText('Folder', { selector: 'p' })
    );
    expect(screen.queryByRole('dialog', { name: 'Folder' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New doc' })).toBe(dialog);
    // With the picker open, a scrim press closes the picker, not the dialog.
    fireEvent.click(screen.getByRole('button', { name: /^Folder/ }));
    const scrim = dialog.parentElement?.firstElementChild;
    if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
    fireEvent.pointerDown(scrim);
    expect(screen.queryByRole('dialog', { name: 'Folder' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'New doc' })).toBe(dialog);
    fireEvent.pointerDown(scrim);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  test('over a SlideOver, Escape closes the dialog and leaves the drawer open', () => {
    function DrawerAndDialog() {
      const [drawer, setDrawer] = useState(true);
      return (
        <SlideOver
          open={drawer}
          onClose={() => setDrawer(false)}
          title="ENG-12"
        >
          <Opener>
            <input aria-label="Reason" />
          </Opener>
        </SlideOver>
      );
    }
    render(<DrawerAndDialog />);
    openDialog();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Reason' }), {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog', { name: 'New doc' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'ENG-12' })).toBeTruthy();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'Escape',
    });
    expect(screen.queryByRole('dialog', { name: 'ENG-12' })).toBeNull();
  });
});

describe('ConfirmDialog', () => {
  /** A host with a Delete button that asks first. */
  function DeleteView({
    onConfirm,
    onCancel = () => undefined,
    tone = 'danger',
    keepOpen = false,
  }: {
    onConfirm: () => void | Promise<unknown>;
    onCancel?: () => void;
    tone?: 'danger' | 'default';
    /** A host that never flips `open` back: the dialog still closes. */
    keepOpen?: boolean;
  }) {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Delete
        </button>
        <ConfirmDialog
          open={open}
          title="Delete this view?"
          confirmLabel="Delete view"
          tone={tone}
          onConfirm={async () => {
            await onConfirm();
            if (!keepOpen) setOpen(false);
          }}
          onCancel={() => {
            onCancel();
            if (!keepOpen) setOpen(false);
          }}
        >
          Its filters and grouping are lost.
        </ConfirmDialog>
      </>
    );
  }

  function ask(): HTMLElement {
    const opener = screen.getByRole('button', { name: 'Delete' });
    opener.focus();
    fireEvent.click(opener);
    return screen.getByRole('alertdialog', { name: 'Delete this view?' });
  }

  test('an alertdialog, aria-modal, described by its message, Cancel focused first', () => {
    render(<DeleteView onConfirm={() => undefined} />);
    const dialog = ask();
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(
      screen.getByRole('alertdialog', {
        description: 'Its filters and grouping are lost.',
      })
    ).toBe(dialog);
    expect(document.activeElement).toBe(
      within(dialog).getByRole('button', { name: 'Cancel' })
    );
    expect(within(dialog).queryByRole('button', { name: 'Close' })).toBeNull();
  });

  test('Enter never confirms a danger action', () => {
    const onConfirm = mock(() => undefined);
    render(<DeleteView onConfirm={onConfirm} />);
    const dialog = ask();
    const confirm = within(dialog).getByRole('button', { name: 'Delete view' });
    confirm.focus();
    // Prevented on keydown, so the browser's Enter activation never runs.
    expect(fireEvent.keyDown(confirm, { key: 'Enter' })).toBe(false);
    expect(fireEvent.keyDown(confirm, { key: ' ' })).toBe(true);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(confirm.dataset.variant).toBe('danger');
  });

  test('Escape means Cancel: onCancel once, focus back on the opener', () => {
    const onCancel = mock(() => undefined);
    const onConfirm = mock(() => undefined);
    render(<DeleteView onConfirm={onConfirm} onCancel={onCancel} />);
    const dialog = ask();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Delete' })
    );
  });

  test('a press on the scrim does nothing', () => {
    const onCancel = mock(() => undefined);
    render(<DeleteView onConfirm={() => undefined} onCancel={onCancel} />);
    const dialog = ask();
    const scrim = dialog.parentElement?.firstElementChild;
    if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
    fireEvent.pointerDown(scrim);
    expect(screen.getByRole('alertdialog')).toBe(dialog);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('busy while the promise runs; each callback once; it closes when done', async () => {
    let finish = (): void => undefined;
    const onConfirm = mock(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const onCancel = mock(() => undefined);
    render(<DeleteView onConfirm={onConfirm} onCancel={onCancel} keepOpen />);
    const dialog = ask();
    const confirm = within(dialog).getByRole('button', { name: 'Delete view' });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const busy = within(dialog).getByRole('button', { name: 'Working…' });
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(
      within(dialog)
        .getByRole('button', { name: 'Cancel' })
        .hasAttribute('disabled')
    ).toBe(true);
    // Escape waits too.
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
    await act(async () => {
      finish();
      await Promise.resolve();
      await Promise.resolve();
    });
    // Closed by its own answer, though the host never flipped `open`.
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test('a rejected confirm re-enables it for another try', async () => {
    let fail = (): void => undefined;
    let attempts = 0;
    const onConfirm = () => {
      attempts += 1;
      return new Promise<void>((_resolve, reject) => {
        fail = () => reject(new Error('Offline'));
      });
    };
    render(
      <ConfirmDialog
        open
        title="Revoke this key?"
        confirmLabel="Revoke"
        tone="danger"
        onConfirm={onConfirm}
        onCancel={() => undefined}
      >
        Clients using it stop working.
      </ConfirmDialog>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(attempts).toBe(1);
    await act(async () => {
      fail();
      await Promise.resolve();
      await Promise.resolve();
    });
    const again = screen.getByRole('button', { name: 'Revoke' });
    expect(again.hasAttribute('aria-busy')).toBe(false);
    fireEvent.click(again);
    expect(attempts).toBe(2);
  });

  test("the host's busy holds both buttons and Escape", () => {
    const onCancel = mock(() => undefined);
    render(
      <ConfirmDialog
        open
        busy
        title="Pause all runs?"
        confirmLabel="Pause all"
        onConfirm={() => undefined}
        onCancel={onCancel}
      >
        Every live run stops at its next step.
      </ConfirmDialog>
    );
    const dialog = screen.getByRole('alertdialog');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onCancel).not.toHaveBeenCalled();
    // A default tone confirms with the primary button.
    const confirm = within(dialog).getByRole('button', { name: 'Working…' });
    expect(confirm.dataset.variant).toBe('primary');
  });

  test('Cancel answers once, even on a host that never closes it', () => {
    const onCancel = mock(() => undefined);
    render(
      <DeleteView onConfirm={() => undefined} onCancel={onCancel} keepOpen />
    );
    const dialog = ask();
    const cancel = within(dialog).getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancel);
    fireEvent.click(cancel);
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('dialog.module.css', () => {
  const css = readFileSync(
    path.join(import.meta.dir, '..', 'src', 'shell', 'dialog.module.css'),
    'utf8'
  );

  test('the card on tokens, the three widths, motion only when welcome', () => {
    const panel = /^\.panel \{[^}]*\}/m.exec(css)?.[0] ?? '';
    expect(panel).toContain('border-radius: var(--r-xl);');
    expect(panel).toContain('box-shadow: var(--shadow-pop);');
    expect(panel).toContain('background: var(--surface);');
    expect(panel).not.toContain('animation');
    expect(css).toMatch(/^\.scrim \{[^}]*background: var\(--overlay\);/m);
    expect(css).toMatch(/^\.sm \{\s*width: min\(360px, 100%\);/m);
    expect(css).toMatch(/^\.md \{\s*width: min\(520px, 100%\);/m);
    expect(css).toMatch(/^\.lg \{\s*width: min\(880px, 100%\);/m);
    expect(css).not.toMatch(/outline:\s*none/);
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
