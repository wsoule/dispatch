import { render, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import {
  Dialog,
  DialogChrome,
  DialogContent,
  DialogTitle,
  initialFocusTarget,
} from './dialog';

// A chrome row owns the close; the corner one stays in the tree as a fallback but
// carries the rule that hides it whenever a chrome row is inside the popup.
test('the corner close hides itself once a DialogChrome is present', () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogChrome>Tasks › New task</DialogChrome>
        <DialogTitle>New task</DialogTitle>
      </DialogContent>
    </Dialog>
  );
  const corner = document.querySelector('[data-slot="dialog-corner-close"]');
  expect(corner?.className).toContain(
    '[[data-slot=dialog-content]:has([data-slot=dialog-chrome])>&]:hidden'
  );
  expect(
    document.querySelectorAll(
      '[data-slot="dialog-chrome"] [data-slot="dialog-close"]'
    )
  ).toHaveLength(1);
});

test('showCloseButton={false} drops the corner close entirely', () => {
  render(
    <Dialog open>
      <DialogContent showCloseButton={false}>
        <DialogTitle>Plain</DialogTitle>
      </DialogContent>
    </Dialog>
  );
  expect(
    document.querySelector('[data-slot="dialog-corner-close"]')
  ).toBeNull();
});

// `initialFocusTarget` on static markup: the popup carries Base UI's `tabIndex=-1`, and
// the chrome row and corner close are what the default "first tabbable" rule would pick.
function popupWith(inner: string): HTMLElement {
  const popup = document.createElement('div');
  popup.setAttribute('data-slot', 'dialog-content');
  popup.tabIndex = -1;
  popup.innerHTML = inner;
  return popup;
}

const CHROME =
  '<div data-slot="dialog-chrome"><button type="button" aria-label="Expand"></button><button type="button" aria-label="Close"></button></div>';

test('initialFocusTarget skips the chrome row and lands on the first field', () => {
  const popup = popupWith(
    `${CHROME}<div data-slot="dialog-body"><input aria-label="Title" /><textarea></textarea></div>`
  );
  expect(initialFocusTarget(popup)).toBe(popup.querySelector('input'));
});

test('a chrome-only dialog (the shortcuts reference) focuses the popup itself', () => {
  const popup = popupWith(
    `${CHROME}<div data-slot="dialog-body"><p>?</p></div>`
  );
  expect(initialFocusTarget(popup)).toBe(popup);
});

test('a corner close alone also falls back to the popup', () => {
  const popup = popupWith(
    '<p>Plain</p><button data-slot="dialog-corner-close" type="button" aria-label="Close"></button>'
  );
  expect(initialFocusTarget(popup)).toBe(popup);
});

test('a disabled first field is skipped for the next enabled one', () => {
  const popup = popupWith(
    `${CHROME}<input aria-label="Locked" disabled /><button type="button" tabindex="-1">Hidden from tab</button><button type="button">Save</button>`
  );
  expect(initialFocusTarget(popup)?.textContent).toBe('Save');
});

test('initialFocusTarget hands a missing popup back to Base UI', () => {
  expect(initialFocusTarget(null)).toBeNull();
});

// The popup ref merges with a consumer's own, so `TaskPeekDialog`'s `ref={contentRef}`
// still resolves the popup element.
test('DialogContent forwards its popup element to a consumer ref', () => {
  const contentRef: { current: HTMLDivElement | null } = { current: null };
  render(
    <Dialog open>
      <DialogContent ref={contentRef}>
        <DialogTitle>Plain</DialogTitle>
      </DialogContent>
    </Dialog>
  );
  expect(contentRef.current?.getAttribute('data-slot')).toBe('dialog-content');
});

// The wiring behind `initialFocusTarget`: a rendered `DialogContent` actually moves
// focus, and a consumer's explicit `initialFocus` (placed after the default) wins.
test('an opened dialog puts the caret in the first body field, not the chrome', async () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogChrome>Tasks › New task</DialogChrome>
        <DialogTitle>New task</DialogTitle>
        <input aria-label="Title" />
      </DialogContent>
    </Dialog>
  );
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Title')
  );
});

test('a chrome-only dialog focuses the popup itself', async () => {
  render(
    <Dialog open>
      <DialogContent>
        <DialogChrome>Keyboard shortcuts</DialogChrome>
        <DialogTitle>Shortcuts</DialogTitle>
        <p>?</p>
      </DialogContent>
    </Dialog>
  );
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-slot')).toBe(
      'dialog-content'
    )
  );
});

test("a consumer's explicit initialFocus wins over the default", async () => {
  const contentRef: { current: HTMLDivElement | null } = { current: null };
  render(
    <Dialog open>
      <DialogContent ref={contentRef} initialFocus={contentRef}>
        <DialogTitle>Task</DialogTitle>
        <input aria-label="Title" defaultValue="Pre-filled" />
      </DialogContent>
    </Dialog>
  );
  await waitFor(() =>
    expect(document.activeElement?.getAttribute('data-slot')).toBe(
      'dialog-content'
    )
  );
  expect(document.activeElement?.getAttribute('aria-label')).toBeNull();
});
