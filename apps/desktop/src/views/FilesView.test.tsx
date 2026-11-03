import type {
  WorkspaceFile,
  WorkspaceSearchResult,
  WorkspaceTree,
} from '@dispatch/client';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { AUTOSAVE_DEBOUNCE_MS } from '../lib/editorBuffer';
import { FilesView } from './FilesView';

interface Recorded {
  fetched: string[];
  saved: { path: string; text: string }[];
}

// Only what FilesView, its tree and its quick open read; every fetch and save
// is recorded. A save fails with `saveError` when one is given.
function fakeData(
  recorded: Recorded,
  saveError: string | null = null
): DispatchProjectData {
  return {
    client: {
      fetchWorkspaceTree: (path: string): Promise<WorkspaceTree> =>
        Promise.resolve({ path, runId: null, entries: [] }),
      fetchWorkspaceFile: (path: string): Promise<WorkspaceFile> => {
        recorded.fetched.push(path);
        // A `.bin` path is a binary file: no text, nothing to edit.
        const binary = path.endsWith('.bin');
        return Promise.resolve({
          path,
          runId: null,
          size: binary ? 2048 : 1,
          modifiedAt: '2026-11-03T00:00:00Z',
          mime: binary
            ? 'application/octet-stream'
            : path.endsWith('.md')
              ? 'text/markdown'
              : 'text/plain',
          preview: 'none',
          kind: binary ? 'binary' : 'text',
          text: binary
            ? null
            : path.endsWith('.md')
              ? 'Some **bold** text'
              : 'x',
        });
      },
      saveWorkspaceFile: (path: string, text: string) => {
        recorded.saved.push({ path, text });
        return saveError === null
          ? Promise.resolve({})
          : Promise.reject(new Error(saveError));
      },
      workspaceFileUrl: (path: string) => `http://127.0.0.1:4100/raw/${path}`,
      searchWorkspace: (query: string): Promise<WorkspaceSearchResult> =>
        Promise.resolve({
          runId: null,
          query,
          total: 1,
          results: [{ path: 'src/b.ts', score: 1, positions: [4] }],
        }),
    },
    portLoading: false,
    portErrorDetail: null,
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
}

function recorder(): Recorded {
  return { fetched: [], saved: [] };
}

// Lets the tree's root load (a resolved promise) land inside act.
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

test('opens on initialPath, as a file link in a thread asks', async () => {
  const recorded = recorder();
  render(<FilesView data={fakeData(recorded)} initialPath="src/a.ts" />);
  await waitFor(() => expect(recorded.fetched).toEqual(['src/a.ts']));
  expect(await screen.findByLabelText('Editing src/a.ts')).toBeTruthy();
});

test('opens nothing without an initialPath', async () => {
  const recorded = recorder();
  render(<FilesView data={fakeData(recorded)} />);
  await act(() => new Promise((r) => setTimeout(r, 20)));
  expect(recorded.fetched).toEqual([]);
  expect(screen.getByText('Pick a file')).toBeTruthy();
  expect(screen.getByText('No file open')).toBeTruthy();
});

test('the project page heads with an h1; inside a run it is an h2 with the run chip', async () => {
  const { unmount } = render(<FilesView data={fakeData(recorder())} />);
  await settle();
  expect(screen.getByRole('heading', { level: 1, name: 'Files' })).toBeTruthy();
  unmount();
  render(<FilesView data={fakeData(recorder())} runId="0123456789abcdef" />);
  await settle();
  expect(screen.getByRole('heading', { level: 2, name: 'Files' })).toBeTruthy();
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  expect(screen.getByText('01234567')).toBeTruthy();
});

test('a controlled quick open mounts Go to file; a pick opens the file and closes it', async () => {
  const recorded = recorder();
  const changes: boolean[] = [];
  render(
    <FilesView
      data={fakeData(recorded)}
      quickOpen
      onQuickOpenChange={(open) => changes.push(open)}
    />
  );
  expect(screen.getByRole('dialog', { name: 'Go to file' })).toBeTruthy();
  const hit = await screen.findByRole('option');
  fireEvent.click(hit);
  await waitFor(() => expect(recorded.fetched).toEqual(['src/b.ts']));
  expect(changes).toEqual([false]);
});

test('a controlled quick open stays shut while quickOpen is false', async () => {
  render(
    <FilesView
      data={fakeData(recorder())}
      quickOpen={false}
      onQuickOpenChange={() => {}}
    />
  );
  await settle();
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a window ⌘P opens nothing: the key is App’s global command now', async () => {
  render(<FilesView data={fakeData(recorder())} />);
  await settle();
  fireEvent.keyDown(window, { key: 'p', metaKey: true });
  fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('the Go to file button opens quick open uncontrolled; Escape closes it', async () => {
  render(<FilesView data={fakeData(recorder())} />);
  await settle();
  const button = screen.getByRole('button', { name: 'Go to file' });
  expect(button.getAttribute('title')).toMatch(/^Go to file \((⌘P|Ctrl\+P)\)$/);
  fireEvent.click(button);
  const field = screen.getByRole('combobox', { name: 'Go to file' });
  fireEvent.keyDown(field, { key: 'Escape' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

test('the Go to file button asks a controlling host to open it', async () => {
  const changes: boolean[] = [];
  render(
    <FilesView
      data={fakeData(recorder())}
      quickOpen={false}
      onQuickOpenChange={(open) => changes.push(open)}
    />
  );
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Go to file' }));
  expect(changes).toEqual([true]);
});

test('an edit shows Unsaved, then Saved once autosave sends it', async () => {
  const recorded = recorder();
  render(<FilesView data={fakeData(recorded)} initialPath="src/a.ts" />);
  const editor = await screen.findByLabelText('Editing src/a.ts');
  expect(editor.getAttribute('spellcheck')).toBe('false');
  fireEvent.change(editor, { target: { value: 'xy' } });
  expect(screen.getByText('Unsaved')).toBeTruthy();
  await act(() => new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 50)));
  await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());
  expect(recorded.saved).toEqual([{ path: 'src/a.ts', text: 'xy' }]);
});

test('a failed save says why, in the danger tone', async () => {
  const recorded = recorder();
  render(
    <FilesView
      data={fakeData(recorded, 'disk is full')}
      initialPath="src/a.ts"
    />
  );
  const editor = await screen.findByLabelText('Editing src/a.ts');
  fireEvent.change(editor, { target: { value: 'xy' } });
  await act(() => new Promise((r) => setTimeout(r, AUTOSAVE_DEBOUNCE_MS + 50)));
  const error = await screen.findByText('disk is full');
  expect(error.getAttribute('data-tone')).toBe('danger');
});

test('a Markdown file offers Preview and renders through Markdown; plain text does not', async () => {
  const { unmount } = render(
    <FilesView data={fakeData(recorder())} initialPath="notes/a.txt" />
  );
  expect(await screen.findByLabelText('Editing notes/a.txt')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
  unmount();
  render(<FilesView data={fakeData(recorder())} initialPath="notes/b.md" />);
  expect(await screen.findByLabelText('Editing notes/b.md')).toBeTruthy();
  const toggle = screen.getByRole('button', { name: 'Preview' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  fireEvent.click(toggle);
  expect(toggle.getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByLabelText('Editing notes/b.md')).toBeNull();
  expect(screen.getByText('bold').tagName).toBe('STRONG');
});

test('a binary file shows its preview with no Preview toggle to misreport', async () => {
  render(<FilesView data={fakeData(recorder())} initialPath="build/app.bin" />);
  expect(await screen.findByRole('link', { name: /Download/ })).toBeTruthy();
  expect(screen.queryByLabelText('Editing build/app.bin')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
});

test('a controlled quick open is dropped while the daemon is down', async () => {
  const changes: boolean[] = [];
  const data = { ...fakeData(recorder()), client: null };
  render(
    <FilesView
      data={data as unknown as DispatchProjectData}
      quickOpen
      onQuickOpenChange={(open) => changes.push(open)}
    />
  );
  await settle();
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(changes).toEqual([false]);
});

// ⌘P from another page unmounts whatever had focus, so the dialog's own focus
// return has nowhere to go: the page takes it instead of <body>.
test('closing quick open with focus nowhere lands it on Go to file, or the editor', async () => {
  const host = (open: boolean, initialPath?: string) => (
    <FilesView
      data={fakeData(recorder())}
      initialPath={initialPath}
      quickOpen={open}
      onQuickOpenChange={() => {}}
    />
  );
  const first = render(host(true));
  await settle();
  expect(document.activeElement?.getAttribute('role')).toBe('combobox');
  first.rerender(host(false));
  expect(document.activeElement).toBe(
    screen.getByRole('button', { name: 'Go to file' })
  );
  first.unmount();

  const second = render(host(false, 'src/a.ts'));
  const editor = await screen.findByLabelText('Editing src/a.ts');
  second.rerender(host(true, 'src/a.ts'));
  await settle();
  second.rerender(host(false, 'src/a.ts'));
  expect(document.activeElement).toBe(editor);
});
