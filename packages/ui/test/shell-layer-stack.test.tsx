import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';
import { useEffect, useState } from 'react';

import {
  Button,
  Dialog,
  Field,
  Menu,
  type MenuEntry,
  type PickerOption,
  PickerPopover,
  Popover,
  Select,
  Tooltip,
} from '../src/index';
import SlideOver from '../src/shell/slide-over';

afterEach(cleanup);

// The layer stack (src/shell/layer.ts), as a matrix of nestings: each
// Escape closes exactly one layer, innermost first; a press outside an
// inner layer but inside an outer one keeps the outer one; focus walks
// back along the chain; and [aria-modal="true"] is there only while a
// Dialog (or a SlideOver on a phone, which is modal there) is open.

const FOLDERS: PickerOption[] = [
  { value: 'docs', label: 'docs' },
  { value: 'notes', label: 'notes' },
];

function modals(): number {
  return document.querySelectorAll('[aria-modal="true"]').length;
}

/** Escape where focus is now, as a keyboard would send it. */
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

function dialogNamed(name: string): HTMLElement | null {
  return screen.queryByRole('dialog', { name });
}

/** A drawer holding a button that opens a dialog, which holds a picker
    and a field with a tooltip. */
function Chain() {
  const [drawer, setDrawer] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [folder, setFolder] = useState<string | null>('docs');
  return (
    <>
      <button type="button" onClick={() => setDrawer(true)}>
        Open drawer
      </button>
      <p>Page</p>
      <SlideOver open={drawer} onClose={() => setDrawer(false)} title="ENG-12">
        <button type="button" onClick={() => setDialog(true)}>
          Publish…
        </button>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Publish">
          <p>Where it goes</p>
          <PickerPopover
            label="Folder"
            options={FOLDERS}
            value={folder}
            onChange={setFolder}
          />
          <Tooltip content="Visible to the team">
            <button type="button">Visibility</button>
          </Tooltip>
        </Dialog>
      </SlideOver>
    </>
  );
}

describe('Dialog ⊃ PickerPopover, over a SlideOver', () => {
  test('each Escape closes one layer, innermost first, and focus walks back', () => {
    render(<Chain />);
    press('Open drawer');
    expect(modals()).toBe(0);
    press('Publish…');
    expect(modals()).toBe(1);
    press(/^Folder/);
    expect(dialogNamed('Folder')).not.toBeNull();

    escape();
    expect(dialogNamed('Folder')).toBeNull();
    expect(dialogNamed('Publish')).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Folder/ })
    );

    escape();
    expect(dialogNamed('Publish')).toBeNull();
    expect(dialogNamed('ENG-12')).not.toBeNull();
    expect(modals()).toBe(0);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Publish…' })
    );

    escape();
    expect(dialogNamed('ENG-12')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Open drawer' })
    );
  });

  test('a press inside an outer layer closes only the inner one', () => {
    render(<Chain />);
    press('Open drawer');
    press('Publish…');
    press(/^Folder/);
    // In the dialog, outside the picker: the picker goes.
    fireEvent.pointerDown(screen.getByText('Where it goes'));
    expect(dialogNamed('Folder')).toBeNull();
    expect(dialogNamed('Publish')).not.toBeNull();
    // On the scrim, outside the dialog: the dialog goes, the drawer stays.
    const panel = dialogNamed('Publish');
    const scrim = panel?.parentElement?.firstElementChild;
    if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
    fireEvent.pointerDown(scrim);
    expect(dialogNamed('Publish')).toBeNull();
    expect(dialogNamed('ENG-12')).not.toBeNull();
  });

  test('Tooltip in the Dialog: Escape hides the tooltip first', () => {
    render(<Chain />);
    press('Open drawer');
    press('Publish…');
    const visibility = screen.getByRole('button', { name: 'Visibility' });
    act(() => visibility.focus());
    expect(screen.getByRole('tooltip', { hidden: true }).textContent).toBe(
      'Visible to the team'
    );
    escape();
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    expect(dialogNamed('Publish')).not.toBeNull();
    expect(document.activeElement).toBe(visibility);
    escape();
    expect(dialogNamed('Publish')).toBeNull();
    expect(dialogNamed('ENG-12')).not.toBeNull();
  });
});

describe('Tooltip mounted open inside an open Dialog', () => {
  // Both open in one commit: React runs the tooltip's effect first, and
  // the stack still puts the dialog beneath it.
  test('the tooltip is the top layer', () => {
    render(
      <Dialog open onClose={() => undefined} title="Shortcuts">
        <Tooltip content="Press ? anywhere" defaultOpen>
          <button type="button">Help</button>
        </Tooltip>
      </Dialog>
    );
    expect(screen.getByRole('tooltip', { hidden: true })).toBeTruthy();
    escape();
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull();
    expect(dialogNamed('Shortcuts')).not.toBeNull();
  });
});

describe('Popover ⊃ PickerPopover', () => {
  function Display() {
    const [open, setOpen] = useState(false);
    const [grouping, setGrouping] = useState<string | null>('docs');
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
            options={FOLDERS}
            value={grouping}
            onChange={setGrouping}
          />
        </Popover>
        <p>Page</p>
      </>
    );
  }

  test('Escape peels the picker, then the popover; no layer is modal', () => {
    render(<Display />);
    press('Display');
    press(/^Grouping/);
    expect(modals()).toBe(0);
    escape();
    expect(dialogNamed('Grouping')).toBeNull();
    expect(dialogNamed('Display options')).not.toBeNull();
    escape();
    expect(dialogNamed('Display options')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Display' })
    );
  });

  test('a press in the popover body closes the picker and keeps the popover', () => {
    render(<Display />);
    press('Display');
    press(/^Grouping/);
    fireEvent.pointerDown(screen.getByText('Grouping', { selector: 'p' }));
    expect(dialogNamed('Grouping')).toBeNull();
    expect(dialogNamed('Display options')).not.toBeNull();
  });
});

describe('Dialog over a SlideOver on a phone (modal there)', () => {
  test('two modal layers, closed one per Escape', () => {
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
      render(<Chain />);
      press('Open drawer');
      // On a phone the drawer itself is modal.
      expect(modals()).toBe(1);
      press('Publish…');
      expect(modals()).toBe(2);
      escape();
      expect(dialogNamed('Publish')).toBeNull();
      expect(modals()).toBe(1);
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Publish…' })
      );
      escape();
      expect(dialogNamed('ENG-12')).toBeNull();
      expect(modals()).toBe(0);
    } finally {
      window.matchMedia = original;
    }
  });
});

describe('A modal surface outside the stack (the command palette)', () => {
  /** A stand-in for Dispatch's command palette: an aria-modal dialog that
      is not a stack layer, takes focus when it opens and owns Escape in
      its own React handler. */
  function Palette({ onClose }: { onClose: () => void }) {
    return (
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return;
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }}
      >
        <input aria-label="Search commands" />
        <button type="button">Go to Issues</button>
      </div>
    );
  }

  /** The page: Display (a Popover holding a Grouping picker), a Publish
      dialog, and the palette, opened from outside the stack the way ⌘K
      does (a document-level key listener, as the host's global keyboard). */
  function Page() {
    const [display, setDisplay] = useState(false);
    const [dialog, setDialog] = useState(false);
    const [palette, setPalette] = useState(false);
    const [grouping, setGrouping] = useState<string | null>('docs');
    useEffect(() => {
      const onKey = (event: KeyboardEvent) => {
        if (event.key === 'k' && event.metaKey) setPalette(true);
      };
      document.addEventListener('keydown', onKey);
      return () => document.removeEventListener('keydown', onKey);
    }, []);
    return (
      <>
        <Popover
          open={display}
          onOpenChange={setDisplay}
          label="Display options"
          trigger={<button type="button">Display</button>}
        >
          <PickerPopover
            label="Grouping"
            options={FOLDERS}
            value={grouping}
            onChange={setGrouping}
          />
        </Popover>
        <button type="button" onClick={() => setDialog(true)}>
          Publish…
        </button>
        <Dialog open={dialog} onClose={() => setDialog(false)} title="Publish">
          <p>Where it goes</p>
        </Dialog>
        {palette ? <Palette onClose={() => setPalette(false)} /> : null}
      </>
    );
  }

  /** ⌘K: the palette opens and its search field takes focus. */
  function openPalette(): HTMLElement {
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'k',
      metaKey: true,
    });
    const field = screen.getByRole('textbox', { name: 'Search commands' });
    act(() => field.focus());
    return field;
  }

  test('focus moving into it closes the popover and the picker; its Escape is its own', () => {
    render(<Page />);
    press('Display');
    press(/^Grouping/);
    expect(dialogNamed('Grouping')).not.toBeNull();
    const field = openPalette();
    expect(dialogNamed('Grouping')).toBeNull();
    expect(dialogNamed('Display options')).toBeNull();
    expect(document.activeElement).toBe(field);
    escape();
    expect(dialogNamed('Command palette')).toBeNull();
  });

  test('a Dialog beneath keeps itself through the palette’s Escape and presses', () => {
    render(<Page />);
    press('Publish…');
    expect(dialogNamed('Publish')).not.toBeNull();
    const field = openPalette();
    // A modal layer keeps focus itself: focus moving out does not close it.
    expect(dialogNamed('Publish')).not.toBeNull();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Go to Issues' }));
    expect(dialogNamed('Publish')).not.toBeNull();
    act(() => field.focus());
    escape();
    expect(dialogNamed('Command palette')).toBeNull();
    expect(dialogNamed('Publish')).not.toBeNull();
  });

  test('focus leaving a popover for the page closes it, focus staying put', () => {
    render(
      <>
        <Page />
        <button type="button">Elsewhere</button>
      </>
    );
    press('Display');
    expect(dialogNamed('Display options')).not.toBeNull();
    const elsewhere = screen.getByRole('button', { name: 'Elsewhere' });
    act(() => elsewhere.focus());
    expect(dialogNamed('Display options')).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  });
});

describe('Outside presses through nested layers', () => {
  test('a press on the page closes a picker and the popover holding it together', () => {
    function Display() {
      const [open, setOpen] = useState(false);
      const [grouping, setGrouping] = useState<string | null>('docs');
      return (
        <>
          <Popover
            open={open}
            onOpenChange={setOpen}
            label="Display options"
            trigger={<button type="button">Display</button>}
          >
            <PickerPopover
              label="Grouping"
              options={FOLDERS}
              value={grouping}
              onChange={setGrouping}
            />
          </Popover>
          <p>Page</p>
        </>
      );
    }
    render(<Display />);
    press('Display');
    press(/^Grouping/);
    fireEvent.pointerDown(screen.getByText('Page'));
    expect(dialogNamed('Grouping')).toBeNull();
    expect(dialogNamed('Display options')).toBeNull();
  });

  test('a press on a dialog’s scrim with a picker open closes the picker only', () => {
    render(<Chain />);
    press('Open drawer');
    press('Publish…');
    press(/^Folder/);
    const panel = dialogNamed('Publish');
    const scrim = panel?.parentElement?.firstElementChild;
    if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
    fireEvent.pointerDown(scrim);
    expect(dialogNamed('Folder')).toBeNull();
    expect(dialogNamed('Publish')).not.toBeNull();
  });
});

describe('Menu and Select (the controls family) in the stack', () => {
  const MORE: MenuEntry[] = [
    { id: 'copy', label: 'Copy link', onSelect: () => undefined },
    {
      kind: 'submenu',
      id: 'move',
      label: 'Move to',
      items: [{ id: 'docs', label: 'docs', onSelect: () => undefined }],
    },
  ];

  function menuNamed(name: string): HTMLElement | null {
    return screen.queryByRole('menu', { name });
  }

  function scrimOfDialog(name: string): HTMLElement {
    const scrim = dialogNamed(name)?.parentElement?.firstElementChild;
    if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
    return scrim;
  }

  /** A Publish dialog holding a More menu with a Move to submenu. */
  function MenuInDialog() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Publish…
        </button>
        <p>Page</p>
        <Dialog open={open} onClose={() => setOpen(false)} title="Publish">
          <p>Where it goes</p>
          <Menu
            label="More"
            items={MORE}
            trigger={(props) => <Button {...props}>More</Button>}
          />
        </Dialog>
      </>
    );
  }

  /** Opens the dialog, its More menu and the Move to submenu from the
      keyboard; focus ends on the submenu's first row. */
  function openAll(): { more: HTMLElement; row: HTMLElement } {
    press('Publish…');
    const more = screen.getByRole('button', { name: 'More' });
    act(() => more.focus());
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const row = screen.getByRole('menuitem', { name: 'Move to' });
    act(() => row.focus());
    fireEvent.keyDown(row, { key: 'ArrowRight' });
    expect(menuNamed('Move to')).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('menuitem', { name: 'docs' })
    );
    return { more, row };
  }

  test('Dialog ⊃ Menu ⊃ submenu: each Escape closes one, innermost first', () => {
    const page = { escapes: 0 };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') page.escapes += 1;
    };
    render(<MenuInDialog />);
    document.addEventListener('keydown', onKey);
    try {
      const { more, row } = openAll();
      escape();
      expect(menuNamed('Move to')).toBeNull();
      expect(menuNamed('More')).not.toBeNull();
      expect(document.activeElement).toBe(row);
      escape();
      expect(menuNamed('More')).toBeNull();
      expect(dialogNamed('Publish')).not.toBeNull();
      expect(document.activeElement).toBe(more);
      escape();
      expect(dialogNamed('Publish')).toBeNull();
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Publish…' })
      );
      expect(page.escapes).toBe(0);
    } finally {
      document.removeEventListener('keydown', onKey);
    }
  });

  test('a press on the dialog’s scrim or in its body closes the menu only', () => {
    render(<MenuInDialog />);
    openAll();
    // The scrim: the submenu and the menu go, the dialog stays.
    fireEvent.pointerDown(scrimOfDialog('Publish'));
    expect(menuNamed('Move to')).toBeNull();
    expect(menuNamed('More')).toBeNull();
    expect(dialogNamed('Publish')).not.toBeNull();
    // The body.
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(menuNamed('More')).not.toBeNull();
    fireEvent.pointerDown(screen.getByText('Where it goes'));
    expect(menuNamed('More')).toBeNull();
    expect(dialogNamed('Publish')).not.toBeNull();
    // No stale layer: the next Escape (focus fallen to <body>) is the
    // dialog's.
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur();
      }
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(dialogNamed('Publish')).toBeNull();
  });

  /** A modal SlideOver (a form surface) holding a Menu and a Select in a
      Field. */
  function Panel() {
    const [open, setOpen] = useState(false);
    const [tier, setTier] = useState<string | null>('member');
    return (
      <>
        <button type="button" onClick={() => setOpen(true)}>
          Edit member
        </button>
        <SlideOver
          open={open}
          onClose={() => setOpen(false)}
          title="Member"
          modal
        >
          <Field label="Tier">
            <Select
              label="Tier"
              value={tier}
              options={[
                { value: 'member', label: 'Member' },
                { value: 'admin', label: 'Admin' },
              ]}
              onChange={setTier}
            />
          </Field>
          <Menu
            label="More"
            items={MORE}
            trigger={(props) => <Button {...props}>More</Button>}
          />
        </SlideOver>
      </>
    );
  }

  function scrimOfPanel(): HTMLElement {
    const scrim = dialogNamed('Member')?.previousElementSibling;
    if (!(scrim instanceof HTMLElement)) throw new Error('no scrim');
    return scrim;
  }

  test('modal SlideOver ⊃ Select: Escape closes the list, then the panel', () => {
    render(<Panel />);
    press('Edit member');
    press(/^Tier/);
    expect(dialogNamed('Tier')).not.toBeNull();
    escape();
    expect(dialogNamed('Tier')).toBeNull();
    expect(dialogNamed('Member')).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: /^Tier/ })
    );
    escape();
    expect(dialogNamed('Member')).toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Edit member' })
    );
  });

  test('modal SlideOver ⊃ Select: a press on the scrim closes the list only', () => {
    render(<Panel />);
    press('Edit member');
    press(/^Tier/);
    const scrim = scrimOfPanel();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(dialogNamed('Tier')).toBeNull();
    expect(dialogNamed('Member')).not.toBeNull();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(dialogNamed('Member')).toBeNull();
  });

  test('modal SlideOver ⊃ Menu: the scrim closes the menu only; Escape then closes the panel', () => {
    render(<Panel />);
    press('Edit member');
    press('More');
    expect(menuNamed('More')).not.toBeNull();
    const scrim = scrimOfPanel();
    fireEvent.pointerDown(scrim);
    fireEvent.click(scrim);
    expect(menuNamed('More')).toBeNull();
    expect(dialogNamed('Member')).not.toBeNull();
    press('More');
    escape();
    expect(menuNamed('More')).toBeNull();
    expect(dialogNamed('Member')).not.toBeNull();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'More' })
    );
    escape();
    expect(dialogNamed('Member')).toBeNull();
  });

  test('focus moving into the command palette closes an open menu; the palette keeps its Escape', () => {
    function Page() {
      const [palette, setPalette] = useState(false);
      return (
        <>
          <Menu
            label="More"
            items={MORE}
            trigger={(props) => <Button {...props}>More</Button>}
          />
          <button type="button" onClick={() => setPalette(true)}>
            Palette
          </button>
          {palette ? (
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Command palette"
              onKeyDown={(event) => {
                if (event.key !== 'Escape') return;
                event.preventDefault();
                event.stopPropagation();
                setPalette(false);
              }}
            >
              <input aria-label="Search commands" />
            </div>
          ) : null}
        </>
      );
    }
    render(<Page />);
    press('More');
    expect(menuNamed('More')).not.toBeNull();
    // Opened from the page's own keyboard (no focus move on the way).
    fireEvent.click(screen.getByRole('button', { name: 'Palette' }));
    const field = screen.getByRole('textbox', { name: 'Search commands' });
    act(() => field.focus());
    expect(menuNamed('More')).toBeNull();
    expect(document.activeElement).toBe(field);
    escape();
    expect(dialogNamed('Command palette')).toBeNull();
  });
});
