import type {
  ApiClient,
  WorkspaceSearchHit,
  WorkspaceSearchResult,
} from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { QuickOpenDialog } from './QuickOpenDialog';

// A search the test answers by hand, so a late reply can be staged.
interface PendingSearch {
  query: string;
  resolve: (hits: WorkspaceSearchHit[]) => void;
  reject: (error: Error) => void;
}

// A client whose searchWorkspace records each query and waits for the test
// to answer it; only what QuickOpenDialog reads.
function fakeClient(): { client: ApiClient; searches: PendingSearch[] } {
  const searches: PendingSearch[] = [];
  const client = {
    searchWorkspace: (query: string) =>
      new Promise<WorkspaceSearchResult>((resolve, reject) => {
        searches.push({
          query,
          resolve: (results) =>
            resolve({ runId: null, query, total: results.length, results }),
          reject,
        });
      }),
  } as unknown as ApiClient;
  return { client, searches };
}

const HITS: WorkspaceSearchHit[] = [
  { path: 'src/app.ts', score: 10, positions: [0, 4] },
  { path: 'src/lib/api.ts', score: 5, positions: [] },
];

// Lets the 80 ms debounce run out (and a little over).
async function pastDebounce(): Promise<void> {
  await act(() => new Promise((resolve) => setTimeout(resolve, 120)));
}

// Answers a recorded search and lets React apply the reply.
async function answer(
  search: PendingSearch | undefined,
  hits: WorkspaceSearchHit[]
): Promise<void> {
  await act(async () => {
    search?.resolve(hits);
    await Promise.resolve();
  });
}

function mount(client: ApiClient) {
  const calls = { picked: [] as string[], closed: 0 };
  const view = render(
    <QuickOpenDialog
      client={client}
      runId={null}
      onPick={(path) => calls.picked.push(path)}
      onClose={() => {
        calls.closed += 1;
      }}
    />
  );
  return { ...view, calls };
}

function input(): HTMLElement {
  return screen.getByRole('combobox', { name: 'Go to file' });
}

test('the dialog is named Go to file, and so is its field', () => {
  const { client } = fakeClient();
  mount(client);
  const dialog = screen.getByRole('dialog', { name: 'Go to file' });
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(input().getAttribute('placeholder')).toBe('Go to file');
});

test('searches once on mount, with an empty query', async () => {
  const { client, searches } = fakeClient();
  mount(client);
  expect(searches).toHaveLength(0);
  await pastDebounce();
  expect(searches.map((s) => s.query)).toEqual(['']);
});

test('typing debounces into one search after 80 ms', async () => {
  const { client, searches } = fakeClient();
  mount(client);
  await pastDebounce();
  fireEvent.change(input(), { target: { value: 'a' } });
  fireEvent.change(input(), { target: { value: 'ap' } });
  fireEvent.change(input(), { target: { value: 'app' } });
  expect(searches.map((s) => s.query)).toEqual(['']);
  await pastDebounce();
  expect(searches.map((s) => s.query)).toEqual(['', 'app']);
});

test('a reply that lands after a newer query is dropped', async () => {
  const { client, searches } = fakeClient();
  mount(client);
  await pastDebounce();
  fireEvent.change(input(), { target: { value: 'app' } });
  await pastDebounce();
  // The empty query's reply comes back after 'app' went out: stale.
  await answer(searches[0], HITS);
  expect(screen.queryByRole('option')).toBeNull();
  await answer(searches[1], HITS.slice(0, 1));
  expect(screen.getAllByRole('option')).toHaveLength(1);
});

test('closing before the debounce runs out sends no search', async () => {
  const { client, searches } = fakeClient();
  const { unmount } = mount(client);
  unmount();
  await pastDebounce();
  expect(searches).toHaveLength(0);
});

test('a reply that lands after unmount is dropped without a warning', async () => {
  const { client, searches } = fakeClient();
  const { unmount } = mount(client);
  await pastDebounce();
  unmount();
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    await answer(searches[0], HITS);
  } finally {
    console.error = original;
  }
  expect(errors).toEqual([]);
});

test('marks the matched positions of each path', async () => {
  const { client, searches } = fakeClient();
  mount(client);
  await pastDebounce();
  await answer(searches[0], HITS);
  const [first, second] = screen.getAllByRole('option');
  const marks =
    first === undefined ? [] : Array.from(first.querySelectorAll('mark'));
  expect(marks.map((m) => m.textContent)).toEqual(['s', 'a']);
  expect(first?.textContent).toContain('src/app.ts');
  expect(second?.querySelector('mark')).toBeNull();
});

test('paths are drawn in the mono voice (Q5)', async () => {
  const { client, searches } = fakeClient();
  mount(client);
  await pastDebounce();
  await answer(searches[0], HITS);
  const labels = screen
    .getAllByRole('option')
    .map((o) => o.querySelector('[data-mono]')?.textContent);
  expect(labels).toEqual(['src/app.ts', 'src/lib/api.ts']);
});

test('a failed search says so with Retry, which searches the same text again', async () => {
  const { client, searches } = fakeClient();
  mount(client);
  await pastDebounce();
  fireEvent.change(input(), { target: { value: 'app' } });
  await pastDebounce();
  await act(async () => {
    searches[1]?.reject(new Error('daemon unreachable'));
    await Promise.resolve();
  });
  expect(screen.getByRole('group', { name: 'Could not load' })).toBeTruthy();
  expect(screen.queryByText(/No matches/)).toBeNull();
  const retry = screen.getByRole('option', { name: /Retry loading/ });
  expect(retry.textContent).toContain('daemon unreachable');
  fireEvent.click(retry);
  await pastDebounce();
  expect(searches.map((s) => s.query)).toEqual(['', 'app', 'app']);
  await answer(searches[2], HITS);
  expect(screen.queryByRole('group', { name: 'Could not load' })).toBeNull();
  expect(screen.getAllByRole('option')).toHaveLength(2);
});

test('Enter picks the new best match after arrowing on the previous list', async () => {
  const { client, searches } = fakeClient();
  const { calls } = mount(client);
  await pastDebounce();
  await answer(searches[0], HITS);
  fireEvent.change(input(), { target: { value: 'api' } });
  // Still the empty query's list: the person arrows to its second row.
  fireEvent.keyDown(input(), { key: 'ArrowDown' });
  await pastDebounce();
  await answer(searches[1], [
    { path: 'src/lib/api.ts', score: 9, positions: [8, 9, 10] },
    { path: 'docs/api.md', score: 3, positions: [5, 6, 7] },
  ]);
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(calls.picked).toEqual(['src/lib/api.ts']);
});

test('Enter on the active row picks it and closes', async () => {
  const { client, searches } = fakeClient();
  const { calls } = mount(client);
  await pastDebounce();
  await answer(searches[0], HITS);
  fireEvent.keyDown(input(), { key: 'Enter' });
  expect(calls.picked).toEqual(['src/app.ts']);
  expect(calls.closed).toBe(1);
});

test('a click on a row picks it and closes', async () => {
  const { client, searches } = fakeClient();
  const { calls } = mount(client);
  await pastDebounce();
  await answer(searches[0], HITS);
  const second = screen.getAllByRole('option')[1];
  if (second !== undefined) fireEvent.click(second);
  expect(calls.picked).toEqual(['src/lib/api.ts']);
  expect(calls.closed).toBe(1);
});

test('Escape closes without picking', () => {
  const { client } = fakeClient();
  const { calls } = mount(client);
  fireEvent.keyDown(input(), { key: 'Escape' });
  expect(calls.closed).toBe(1);
  expect(calls.picked).toEqual([]);
});
