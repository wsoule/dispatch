import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { useRef, useState } from 'react';

import { Button, ConfirmDialog, Dialog, TextField } from '../src/index';
import { modalIsOpen } from '../src/shell/dom';

afterEach(cleanup);

// Dialog and ConfirmDialog: naming, focus in and back, Tab, Esc, the close
// button and the scrim (never for a confirmation), and the chrome row.

function Host({ onClose, crumb }: { onClose?: () => void; crumb?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Export
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Export to Linear"
        description="Pick what to send."
        crumb={crumb}
        footer={
          <>
            <Button variant="quiet" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary">Export</Button>
          </>
        }
      >
        <TextField aria-label="Team" />
      </Dialog>
    </>
  );
}

function open(): HTMLElement {
  const opener = screen.getByRole('button', { name: 'Export' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('Dialog', () => {
  test('is a modal dialog named and described, focus on its first field', () => {
    render(<Host />);
    open();
    const dialog = screen.getByRole('dialog', { name: 'Export to Linear' });
    expect(dialog.tagName).toBe('DIALOG');
    expect((dialog as HTMLDialogElement).open).toBe(true);
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    // The shell's single-key shortcuts stand down while it is open.
    expect(modalIsOpen()).toBe(true);
    const description = document.getElementById(
      dialog.getAttribute('aria-describedby') ?? ''
    );
    expect(description?.textContent).toBe('Pick what to send.');
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Team' })
    );
  });

  test('Esc closes it and focus returns to the opener', () => {
    const onClose = mock(() => undefined);
    render(<Host onClose={onClose} />);
    const opener = open();
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Team' }), {
      key: 'Escape',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  test('Esc that something inside already took does not close it', () => {
    const onClose = mock(() => undefined);
    render(<Host onClose={onClose} />);
    open();
    const field = screen.getByRole('textbox', { name: 'Team' });
    field.addEventListener('keydown', (event) => event.preventDefault());
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  test('the close button and a click on the scrim close it', () => {
    const onClose = mock(() => undefined);
    render(<Host onClose={onClose} />);
    open();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    open();
    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  test('Tab wraps from the last control to the first', () => {
    render(<Host />);
    open();
    const dialog = screen.getByRole('dialog');
    const buttons = screen.getAllByRole('button');
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);
  });

  test('a crumb draws the chrome row with the close button and Expand', () => {
    function Expanding() {
      const [expanded, setExpanded] = useState(false);
      return (
        <Dialog
          open
          onClose={() => undefined}
          title="New issue"
          titleHidden
          crumb="Atlas › New issue"
          expanded={expanded}
          onExpand={() => setExpanded((value) => !value)}
        >
          <p>Body</p>
        </Dialog>
      );
    }
    render(<Expanding />);
    expect(screen.getByRole('dialog', { name: 'New issue' })).toBeTruthy();
    expect(screen.getByText('Atlas › New issue')).toBeTruthy();
    const expand = screen.getByRole('button', { name: 'Expand' });
    fireEvent.click(expand);
    expect(
      screen
        .getByRole('button', { name: 'Collapse' })
        .getAttribute('aria-pressed')
    ).toBe('true');
    expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(1);
  });

  test('initialFocusRef wins over the first field', () => {
    function Focused() {
      const ref = useRef<HTMLTextAreaElement>(null);
      return (
        <Dialog
          open
          onClose={() => undefined}
          title="Quick capture"
          initialFocusRef={ref}
          closeButton={false}
        >
          <TextField aria-label="Title" />
          <textarea ref={ref} aria-label="Note" />
        </Dialog>
      );
    }
    render(<Focused />);
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', { name: 'Note' })
    );
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});

describe('ConfirmDialog', () => {
  function Confirm({
    onConfirm,
    onCancel,
  }: {
    onConfirm: () => void;
    onCancel: () => void;
  }) {
    return (
      <ConfirmDialog
        open
        title="Revoke agent@atlas?"
        description="Its token stops working at once."
        confirmLabel="Revoke"
        destructive
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }

  test('is an alertdialog that starts on Cancel', () => {
    render(<Confirm onConfirm={() => undefined} onCancel={() => undefined} />);
    const dialog = screen.getByRole('alertdialog', {
      name: 'Revoke agent@atlas?',
    });
    expect(dialog.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Cancel' })
    );
    expect(
      screen
        .getByRole('button', { name: 'Revoke' })
        .getAttribute('data-variant')
    ).toBe('danger');
  });

  test('confirm and cancel call back; Esc cancels; the scrim does nothing', () => {
    const onConfirm = mock(() => undefined);
    const onCancel = mock(() => undefined);
    render(<Confirm onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('alertdialog'));
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('button', { name: 'Cancel' }), {
      key: 'Escape',
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
