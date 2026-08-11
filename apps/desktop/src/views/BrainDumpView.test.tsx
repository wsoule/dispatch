import type { InboxItem } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { BrainDumpView } from './BrainDumpView';

interface UpdateCall {
  id: string;
  patch: { text?: string };
}

function inboxItem(over: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'in-aaa',
    kind: 'idea',
    text: 'the picker forgets its selection',
    done: false,
    linkedTaskId: null,
    createdByRunId: null,
    created: '2026-08-10T00:00:00.000Z',
    ...over,
  };
}

/**
 * A `DispatchProjectData` stub carrying only what BrainDumpView reads, plus a recorder for
 * every call the view makes out to the daemon. `calls` is what the network assertions read:
 * opening the editor must not add to it.
 */
function mount(
  inbox: InboxItem[],
  onUpdate: () => Promise<void> = () => Promise.resolve()
) {
  const updates: UpdateCall[] = [];
  const calls: string[] = [];
  const data = {
    portLoading: false,
    portError: false,
    portErrorDetail: null,
    client: {},
    retryEnsureDispatchd: () => {},
    inbox,
    handleCaptureInbox: () => {
      calls.push('capture');
      return Promise.resolve();
    },
    handleUpdateInboxItem: (id: string, patch: { text?: string }) => {
      calls.push('update');
      updates.push({ id, patch });
      return onUpdate();
    },
    handleDismissInbox: () => {
      calls.push('dismiss');
      return Promise.resolve();
    },
    handleConvertInbox: () => {
      calls.push('convert');
      return Promise.resolve({ results: [], converted: 0, failed: 0 });
    },
    handleClusterInbox: () => {
      calls.push('cluster');
      return Promise.resolve({ groups: [], error: null });
    },
  } as unknown as DispatchProjectData;

  render(
    <BrainDumpView data={data} onPlanText={() => {}} onOpenTask={() => {}} />
  );
  return { updates, calls };
}

function addDetailButtons() {
  return screen.getAllByRole<HTMLButtonElement>('button', {
    name: 'Add detail',
  });
}

function editor(item: InboxItem) {
  return screen.getByLabelText<HTMLTextAreaElement>(`Edit "${item.text}"`);
}

test('Add detail opens an editor pre-filled with the row text and calls nothing', () => {
  const item = inboxItem();
  const { calls } = mount([item]);

  expect(screen.queryByLabelText(`Edit "${item.text}"`)).toBeNull();
  fireEvent.click(addDetailButtons()[0]);

  expect(editor(item).value).toBe(item.text);
  expect(calls).toEqual([]);
});

test('Save persists the edited text through handleUpdateInboxItem and closes', async () => {
  const item = inboxItem();
  const { updates } = mount([item]);

  fireEvent.click(addDetailButtons()[0]);
  fireEvent.change(editor(item), {
    target: { value: 'the picker forgets its selection after a refetch' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  // One act tick flushes the resolved update's state updates; polling the DOM with waitFor
  // hangs under happy-dom (its observer/timer machinery never fires).
  await act(async () => {});

  expect(updates).toEqual([
    {
      id: item.id,
      patch: { text: 'the picker forgets its selection after a refetch' },
    },
  ]);
  expect(screen.queryByLabelText(`Edit "${item.text}"`)).toBeNull();
});

test('⌘⏎ saves from inside the editor', async () => {
  const item = inboxItem();
  const { updates } = mount([item]);

  fireEvent.click(addDetailButtons()[0]);
  fireEvent.change(editor(item), { target: { value: 'with more detail' } });
  fireEvent.keyDown(editor(item), { key: 'Enter', metaKey: true });
  await act(async () => {});

  expect(updates).toEqual([
    { id: item.id, patch: { text: 'with more detail' } },
  ]);
});

test('Cancel closes the editor without persisting', async () => {
  const item = inboxItem();
  const { updates, calls } = mount([item]);

  fireEvent.click(addDetailButtons()[0]);
  fireEvent.change(editor(item), { target: { value: 'discard me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => {});

  expect(updates).toEqual([]);
  expect(calls).toEqual([]);
  expect(screen.queryByLabelText(`Edit "${item.text}"`)).toBeNull();
  // Reopening starts from the stored text again, not the abandoned edit.
  fireEvent.click(addDetailButtons()[0]);
  expect(editor(item).value).toBe(item.text);
});

test('Escape closes the editor without persisting', () => {
  const item = inboxItem();
  const { updates } = mount([item]);

  fireEvent.click(addDetailButtons()[0]);
  fireEvent.keyDown(editor(item), { key: 'Escape' });

  expect(updates).toEqual([]);
  expect(screen.queryByLabelText(`Edit "${item.text}"`)).toBeNull();
});

test('only one row edits at a time', () => {
  const first = inboxItem();
  const second = inboxItem({ id: 'in-bbb', text: 'flaky upload test' });
  mount([first, second]);

  fireEvent.click(addDetailButtons()[0]);
  expect(editor(first).value).toBe(first.text);
  // The editing row's own button is out of play while its editor is open.
  expect(addDetailButtons()[0].disabled).toBe(true);

  fireEvent.click(addDetailButtons()[1]);
  expect(screen.queryByLabelText(`Edit "${first.text}"`)).toBeNull();
  expect(editor(second).value).toBe(second.text);
});

test('a failed save keeps the editor open with the edit still in it', async () => {
  const item = inboxItem();
  mount([item], () => Promise.reject(new Error('daemon said no')));

  fireEvent.click(addDetailButtons()[0]);
  fireEvent.change(editor(item), { target: { value: 'do not lose me' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('daemon said no');

  expect(editor(item).value).toBe('do not lose me');
});

test('a second ⌘⏎ while a save is in flight does not save twice', async () => {
  const item = inboxItem();
  let release: () => void = () => {};
  const { updates } = mount(
    [item],
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );

  fireEvent.click(addDetailButtons()[0]);
  fireEvent.change(editor(item), { target: { value: 'once' } });
  fireEvent.keyDown(editor(item), { key: 'Enter', metaKey: true });
  fireEvent.keyDown(editor(item), { key: 'Enter', metaKey: true });

  expect(updates).toEqual([{ id: item.id, patch: { text: 'once' } }]);
  release();
  await act(async () => {});
  expect(screen.queryByLabelText(`Edit "${item.text}"`)).toBeNull();
});

test('an emptied editor refuses to save', async () => {
  const item = inboxItem();
  const { updates } = mount([item]);

  fireEvent.click(addDetailButtons()[0]);
  fireEvent.change(editor(item), { target: { value: '   ' } });

  const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save' });
  expect(save.disabled).toBe(true);
  // ⌘⏎ bypasses the disabled button, so the guard has to hold on that path too.
  fireEvent.keyDown(editor(item), { key: 'Enter', metaKey: true });
  await act(async () => {});
  expect(updates).toEqual([]);
});
