import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';
import { useState } from 'react';

import { BRAIN_DUMP_DRAFT_KEY } from '../../hooks/usePersistedDraft';
import { QuickCaptureDialog } from './QuickCaptureDialog';

// The draft persists to localStorage (shared with the full view); one test's typing must
// not leak into the next mount.
beforeEach(() => {
  window.localStorage.removeItem(BRAIN_DUMP_DRAFT_KEY);
});

// `open` is controlled by App in production (⌘D and the rail row drive it); the harness
// plays App's role with a button standing in for both.
function Harness({
  onCapture = () => Promise.resolve(),
}: {
  onCapture?: (text: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Drop a thought
      </button>
      <QuickCaptureDialog
        open={open}
        onOpenChange={setOpen}
        onCapture={onCapture}
      />
    </>
  );
}

function mount(
  onCapture: (text: string) => Promise<void> = () => Promise.resolve()
) {
  return render(<Harness onCapture={onCapture} />);
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Drop a thought' }));
  return screen.getByPlaceholderText<HTMLTextAreaElement>('Dump it here…');
}

test('the dialog stays closed until opened, and there is no floating button', () => {
  mount();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Add to Notes' })).toBeNull();
  openPanel();
  expect(screen.getByRole('dialog', { name: 'Quick capture' })).not.toBeNull();
  // The 12px crumb names where the thought goes.
  expect(screen.getByText('Notes')).not.toBeNull();
  expect(screen.getAllByText('Quick capture').length).toBeGreaterThan(0);
});

test('capturing hands the draft to onCapture, then clears and closes', async () => {
  const captured: string[] = [];
  mount((text) => {
    captured.push(text);
    return Promise.resolve();
  });
  const textarea = openPanel();
  fireEvent.change(textarea, { target: { value: 'fix the flaky test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Drop it' }));
  // One explicit act tick flushes the resolved capture's state updates; polling the DOM
  // with waitFor hangs under happy-dom (its observer/timer machinery never fires).
  await act(async () => {});
  expect(captured).toEqual(['fix the flaky test']);
  expect(screen.queryByRole('dialog')).toBeNull();
  // Reopening starts fresh — the landed draft is gone.
  expect(openPanel().value).toBe('');
});

test('⌘⏎ commits the draft from the textarea', async () => {
  const captured: string[] = [];
  mount((text) => {
    captured.push(text);
    return Promise.resolve();
  });
  const textarea = openPanel();
  fireEvent.change(textarea, { target: { value: 'an idea' } });
  fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
  await waitFor(() => expect(captured).toEqual(['an idea']));
});

test('a second ⌘⏎ while a capture is in flight does not double-capture', async () => {
  let release: () => void = () => {};
  const captured: string[] = [];
  mount((text) => {
    captured.push(text);
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const textarea = openPanel();
  fireEvent.change(textarea, { target: { value: 'once' } });
  fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
  fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
  expect(captured).toEqual(['once']);
  release();
  await act(async () => {});
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a failed capture keeps the draft and shows the error inline', async () => {
  mount(() => Promise.reject(new Error('daemon said no')));
  const textarea = openPanel();
  fireEvent.change(textarea, { target: { value: 'do not lose me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Drop it' }));
  await screen.findByText('daemon said no');
  expect(screen.getByRole('dialog')).not.toBeNull();
  expect(textarea.value).toBe('do not lose me');
});

test('the Drop it button is disabled while the draft is blank', () => {
  mount();
  openPanel();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Drop it' }).disabled
  ).toBe(true);
});

test('Escape closes the dialog', () => {
  mount();
  const textarea = openPanel();
  fireEvent.keyDown(textarea, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});
