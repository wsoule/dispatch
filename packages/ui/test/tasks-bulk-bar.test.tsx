import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useState } from 'react';

import {
  BulkBar,
  type BulkBarConfirm,
  ToastProvider,
  useBulkBarHeight,
} from '../src/index';

afterEach(cleanup);

// BulkBar: the floating toolbar of a list selection (paper in a 1px ink
// frame, like the toasts). The count is a live region; a confirmation
// replaces the actions and takes focus; busy and a note disable the
// actions; Esc clears.

function actions() {
  return (
    <>
      <button type="button">Move to milestone</button>
      <button type="button">Assignee</button>
    </>
  );
}

describe('BulkBar', () => {
  test('without a selection only the empty live region is there', () => {
    const view = render(
      <BulkBar count={0} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    expect(view.queryByRole('toolbar')).toBeNull();
    const status = view.getByRole('status');
    expect(status.textContent).toBe('');
    expect(status.className).toBe('srOnly');
  });

  // A live region created already holding its text is not announced: the
  // region stays mounted (the same node) from 0 to the first selection.
  test('a named toolbar; the count in a live region that was already there', () => {
    const view = render(
      <BulkBar count={0} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    const before = view.getByRole('status');
    view.rerender(
      <BulkBar count={3} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    const bar = view.getByRole('toolbar', {
      name: 'Actions for 3 selected issues',
    });
    const status = view.getByRole('status');
    expect(status).toBe(before);
    expect(status.textContent).toBe('3 selected');
    // The visible count is not read twice.
    expect(bar.textContent).toContain('3 selected');
    expect(bar.querySelector('[aria-hidden="true"]')?.textContent).toBe(
      '3 selected'
    );
    view.rerender(
      <BulkBar
        count={1}
        countLabel="1 issue selected"
        onClear={() => undefined}
      >
        {actions()}
      </BulkBar>
    );
    expect(view.getByRole('status').textContent).toBe('1 issue selected');
    expect(
      view.getByRole('toolbar', { name: 'Actions for 1 selected issue' })
    ).toBeTruthy();
  });

  test('the confirm strip takes focus; Cancel brings the actions back', () => {
    function Host() {
      const [confirm, setConfirm] = useState<BulkBarConfirm | null>(null);
      return (
        <BulkBar count={24} onClear={() => undefined} confirm={confirm}>
          <button
            type="button"
            onClick={() =>
              setConfirm({
                message:
                  'Move 24 issues to Garnet mobile app › Push notifications? This changes them in Linear, as you.',
                confirmLabel: 'Move 24 issues',
                onConfirm: () => undefined,
                onCancel: () => setConfirm(null),
              })
            }
          >
            Move to milestone
          </button>
        </BulkBar>
      );
    }
    const view = render(<Host />);
    const move = view.getByRole('button', { name: 'Move to milestone' });
    move.focus();
    fireEvent.click(move);
    const primary = view.getByRole('button', { name: 'Move 24 issues' });
    expect(document.activeElement).toBe(primary);
    expect(
      view.queryByRole('button', { name: 'Move to milestone' })
    ).toBeNull();
    expect(view.getByRole('toolbar').textContent).toContain(
      'This changes them in Linear, as you.'
    );
    fireEvent.click(view.getByRole('button', { name: 'Cancel' }));
    const back = view.getByRole('button', { name: 'Move to milestone' });
    expect(document.activeElement).toBe(back);
  });

  test('Esc during a confirmation cancels it rather than clearing', () => {
    const onClear = mock(() => {});
    const onCancel = mock(() => {});
    const view = render(
      <BulkBar
        count={20}
        onClear={onClear}
        confirm={{
          message: 'Set 20 issues to High priority?',
          confirmLabel: 'Set 20 issues',
          onConfirm: () => undefined,
          onCancel,
        }}
      >
        {actions()}
      </BulkBar>
    );
    fireEvent.keyDown(view.getByRole('button', { name: 'Set 20 issues' }), {
      key: 'Escape',
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onClear).not.toHaveBeenCalled();
  });

  test('busy says so in the count’s place and disables the actions', () => {
    const view = render(
      <BulkBar count={12} busy="Moving 12 issues…" onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    expect(view.getByRole('status').textContent).toBe('Moving 12 issues…');
    const move = view.getByRole('button', { name: 'Move to milestone' });
    // A disabled fieldset disables every control in it (browsers do;
    // happy-dom does not compute it, so the fieldset is what is checked).
    expect(move.closest('fieldset')?.disabled).toBe(true);
    // Clearing stays possible.
    expect(
      (
        view.getByRole('button', {
          name: 'Clear selection',
        }) as HTMLButtonElement
      ).disabled
    ).toBe(false);
  });

  // A browser blurs the focused action when its fieldset is disabled
  // (happy-dom does not, so the blur is done by hand): once the change has
  // answered, focus goes back to that action, not left on <body>.
  test('after a busy spell focus returns to the action that sent it', () => {
    const view = render(
      <BulkBar count={2} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    const assignee = view.getByRole('button', { name: 'Assignee' });
    act(() => assignee.focus());
    view.rerender(
      <BulkBar count={2} busy="Changing 2 issues…" onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    act(() => assignee.blur());
    expect(document.activeElement).toBe(document.body);
    view.rerender(
      <BulkBar count={2} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    expect(document.activeElement).toBe(assignee);
    // Focus a person moved on to is left alone.
    const clear = view.getByRole('button', { name: 'Clear selection' });
    view.rerender(
      <BulkBar count={2} busy="Changing 2 issues…" onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    act(() => clear.focus());
    view.rerender(
      <BulkBar count={2} onClear={() => undefined}>
        {actions()}
      </BulkBar>
    );
    expect(document.activeElement).toBe(clear);
  });

  test('a note is shown and disables the actions', () => {
    const view = render(
      <BulkBar
        count={312}
        note="At most 100 at a time (312 selected)."
        onClear={() => undefined}
      >
        {actions()}
      </BulkBar>
    );
    expect(view.getByRole('toolbar').textContent).toContain(
      'At most 100 at a time (312 selected).'
    );
    expect(
      view.getByRole('button', { name: 'Assignee' }).closest('fieldset')
        ?.disabled
    ).toBe(true);
  });

  test('Esc clears the selection; ✕ does too; ← → move between buttons', () => {
    const onClear = mock(() => {});
    const view = render(
      <BulkBar count={2} onClear={onClear}>
        {actions()}
      </BulkBar>
    );
    const move = view.getByRole('button', { name: 'Move to milestone' });
    move.focus();
    fireEvent.keyDown(move, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(
      view.getByRole('button', { name: 'Assignee' })
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(move);
    fireEvent.keyDown(move, { key: 'Escape' });
    expect(onClear).toHaveBeenCalledTimes(1);
    fireEvent.click(view.getByRole('button', { name: 'Clear selection' }));
    expect(onClear).toHaveBeenCalledTimes(2);
  });

  test('an Esc a picker inside already handled is left alone', () => {
    const onClear = mock(() => {});
    const view = render(
      <BulkBar count={2} onClear={onClear}>
        <span data-picker-popup="">
          <input aria-label="Search people" />
        </span>
      </BulkBar>
    );
    const field = view.getByRole('textbox', { name: 'Search people' });
    act(() => field.focus());
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(onClear).not.toHaveBeenCalled();
  });
});

describe('BulkBar and the toasts', () => {
  // The height goes to what must clear the bar (useBulkBarHeight), which
  // sets it on its own element: the toast stack's viewport here. Never a
  // custom property on <html>: every element inherits that one, so the
  // bar coming or going restyled the whole page (0.5-0.7 s on the
  // showcase's 300-row /issues).
  test('while up it is marked for the toasts and publishes its height', () => {
    const root = document.documentElement;
    const heights: (number | null)[] = [];
    function Reader() {
      heights.push(useBulkBarHeight());
      return null;
    }
    const page = (count: number) => (
      <ToastProvider>
        <Reader />
        <BulkBar count={count} onClear={() => undefined}>
          {actions()}
        </BulkBar>
      </ToastProvider>
    );
    const view = render(page(2));
    const bar = view.getByRole('toolbar');
    expect(bar.getAttribute('data-bulk-bar')).toBe('true');
    // happy-dom lays nothing out: the measured height is 0px, but set.
    expect(heights.at(-1)).toBe(0);
    const viewport = view.container.ownerDocument.querySelector('section');
    expect(viewport?.style.getPropertyValue('--bulk-bar-h')).toBe('0px');
    expect(root.style.getPropertyValue('--bulk-bar-h')).toBe('');
    view.rerender(page(0));
    expect(heights.at(-1)).toBeNull();
    expect(viewport?.style.getPropertyValue('--bulk-bar-h')).toBe('');
    expect(root.style.getPropertyValue('--bulk-bar-h')).toBe('');
  });

  test('the toast stack sits above a bulk bar, on desktop and on phones', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'shell', 'toast.module.css'),
      'utf8'
    );
    expect(css).toContain(
      ":global(body:has([data-bulk-bar='true'])) .viewport {\n  bottom: calc(20px + var(--bulk-bar-h, 44px) + 12px);"
    );
    expect(css).toMatch(
      /:global\(body:has\(\[data-shell-tabbar='true'\]\):has\(\[data-bulk-bar='true'\]\)\)/
    );
    // The lift matches where the bar sits (20px up on a desktop).
    const bar = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'tasks', 'bulk-bar.module.css'),
      'utf8'
    );
    expect(/\n\.bar \{[^}]*\}/.exec(bar)?.[0]).toContain('bottom: 20px;');
  });

  test('the bar is drawn like a toast: the inverted Gr8r pill on the pop shadow', () => {
    const css = readFileSync(
      path.join(import.meta.dir, '..', 'src', 'tasks', 'bulk-bar.module.css'),
      'utf8'
    );
    const bar = /\n\.bar \{[^}]*\}/.exec(css)?.[0] ?? '';
    expect(bar).toContain('background: var(--text);');
    expect(bar).toContain('color: var(--text-inv);');
    expect(bar).toContain('border-radius: var(--r-lg);');
    expect(bar).toContain('box-shadow: var(--shadow-pop);');
    // Its ghost actions dim to 0.85 at rest (checked at 4.5:1 in
    // tasks-contrast.test.ts) and wash, never flood, on hover.
    expect(css).toMatch(/\n\.ghost,\n\.close \{[^}]*opacity: 0\.85;/);
    const code = css.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(
      /background: var\(--accent\);\s*color: var\(--on-accent\)/
    );
  });
});
