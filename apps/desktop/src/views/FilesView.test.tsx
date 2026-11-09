import type {
  ApiClient,
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
  /** Paths whose raw bytes a preview read through `fetchWorkspaceBlob`. */
  blobs: string[];
  /** Paths a Download asked a single-use ticket URL for. */
  tickets: string[];
}

// The client members FilesView, its tree, its quick open and FilePreview
// call. The fake below is checked against them, so a renamed or replaced
// member fails the typecheck here instead of silently going unexercised.
type FilesClient = Pick<
  ApiClient,
  | 'fetchWorkspaceTree'
  | 'fetchWorkspaceFile'
  | 'saveWorkspaceFile'
  | 'workspaceFileUrl'
  | 'workspaceDownloadUrl'
  | 'fetchWorkspaceBlob'
  | 'searchWorkspace'
>;

// What the daemon says about a path, by its extension: `.bin` is binary with
// no preview, `.png` a binary image, `.svg` a text file that previews as an
// image, `.md` Markdown, anything else plain text.
function describeFile(path: string): WorkspaceFile {
  const base = {
    path,
    runId: null,
    size: 1,
    modifiedAt: '2026-11-03T00:00:00Z',
  };
  if (path.endsWith('.bin')) {
    return {
      ...base,
      size: 2048,
      mime: 'application/octet-stream',
      preview: 'none',
      kind: 'binary',
      text: null,
    };
  }
  if (path.endsWith('.png')) {
    return {
      ...base,
      size: 3,
      mime: 'image/png',
      preview: 'image',
      kind: 'binary',
      text: null,
    };
  }
  if (path.endsWith('.svg')) {
    return {
      ...base,
      mime: 'image/svg+xml',
      preview: 'image',
      kind: 'text',
      text: '<svg xmlns="http://www.w3.org/2000/svg"/>',
    };
  }
  const markdown = path.endsWith('.md');
  return {
    ...base,
    mime: markdown ? 'text/markdown' : 'text/plain',
    preview: 'none',
    kind: 'text',
    text: markdown ? 'Some **bold** text' : 'x',
  };
}

// Only what FilesView, its tree, its quick open and its preview read; every
// fetch, save and raw read is recorded. A save fails with `saveError` when one
// is given.
function fakeData(
  recorded: Recorded,
  saveError: string | null = null
): DispatchProjectData {
  const client: FilesClient = {
    fetchWorkspaceTree: (path: string): Promise<WorkspaceTree> =>
      Promise.resolve({ path, runId: null, entries: [] }),
    fetchWorkspaceFile: (path: string): Promise<WorkspaceFile> => {
      recorded.fetched.push(path);
      return Promise.resolve(describeFile(path));
    },
    saveWorkspaceFile: (path: string, text: string) => {
      recorded.saved.push({ path, text });
      return saveError === null
        ? Promise.resolve({
            path,
            size: text.length,
            modifiedAt: '2026-11-03T00:00:01Z',
          })
        : Promise.reject(new Error(saveError));
    },
    workspaceFileUrl: (path: string) => `http://127.0.0.1:4100/raw/${path}`,
    workspaceDownloadUrl: (path: string): Promise<string> => {
      recorded.tickets.push(path);
      return Promise.resolve(
        `http://127.0.0.1:4100/api/files/raw?ticket=t-${recorded.tickets.length}`
      );
    },
    fetchWorkspaceBlob: (path: string): Promise<Blob> => {
      recorded.blobs.push(path);
      return Promise.resolve(new Blob([new Uint8Array([1, 2, 3])]));
    },
    searchWorkspace: (query: string): Promise<WorkspaceSearchResult> =>
      Promise.resolve({
        runId: null,
        query,
        total: 1,
        results: [{ path: 'src/b.ts', score: 1, positions: [4] }],
      }),
  };
  return {
    client,
    portLoading: false,
    portErrorDetail: null,
    retryEnsureDispatchd: () => {},
  } as unknown as DispatchProjectData;
}

function recorder(): Recorded {
  return { fetched: [], saved: [], blobs: [], tickets: [] };
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

// In a browser, Download asks the daemon for a single-use ticket URL when it
// is clicked and hands that to the browser's own download: the page never
// reads the bytes.
test("a binary file's Download goes through a ticket, not a read into the page", async () => {
  const recorded = recorder();
  const clicked: string[] = [];
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
    clicked.push(this.href);
  };
  try {
    render(<FilesView data={fakeData(recorded)} initialPath="build/app.bin" />);
    fireEvent.click(await screen.findByRole('link', { name: 'Download' }));
    await waitFor(() =>
      expect(clicked).toEqual([
        'http://127.0.0.1:4100/api/files/raw?ticket=t-1',
      ])
    );
    expect(recorded.tickets).toEqual(['build/app.bin']);
    expect(recorded.blobs).toEqual([]);
    await settle();
  } finally {
    HTMLAnchorElement.prototype.click = originalClick;
  }
});

// The preview reads an image's bytes with the client's credential and shows
// them from a blob: URL; the raw route never goes into the img src, where a
// bearer-authenticated page would get a 401.
test('an image opens straight into its preview, read through fetchWorkspaceBlob', async () => {
  const recorded = recorder();
  render(<FilesView data={fakeData(recorded)} initialPath="img/shot.png" />);
  const image = await screen.findByRole('img', { name: 'img/shot.png' });
  expect(image.getAttribute('src')).toStartWith('blob:');
  expect(recorded.fetched).toEqual(['img/shot.png']);
  expect(recorded.blobs).toEqual(['img/shot.png']);
  expect(screen.queryByLabelText('Editing img/shot.png')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull();
});

// An SVG is text the daemon marks `preview` "image": it opens in the editor,
// and Preview swaps in the rendered image, read through the client.
test('an SVG opens as text and offers Preview, which shows it as an image', async () => {
  const recorded = recorder();
  render(<FilesView data={fakeData(recorded)} initialPath="img/logo.svg" />);
  expect(await screen.findByLabelText('Editing img/logo.svg')).toBeTruthy();
  expect(recorded.blobs).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  const image = await screen.findByRole('img', { name: 'img/logo.svg' });
  expect(image.getAttribute('src')).toStartWith('data:image/svg+xml');
  expect(recorded.blobs).toEqual(['img/logo.svg']);
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
  // Closing quick open brings the tree back, which loads its root again.
  await settle();
});

// The fake client with one file's text replaced, to give Tab something to indent.
function withText(data: DispatchProjectData, text: string) {
  const client = data.client;
  if (client === null) throw new Error('fake data has a client');
  return {
    ...data,
    client: {
      ...client,
      fetchWorkspaceFile: (path: string) =>
        client
          .fetchWorkspaceFile(path)
          .then((file) => ({ ...file, text }) satisfies WorkspaceFile),
    },
  } as DispatchProjectData;
}

test('opening another file inside the autosave debounce still saves the edit', async () => {
  const recorded = recorder();
  render(
    <FilesView
      data={fakeData(recorded)}
      initialPath="src/a.ts"
      quickOpen
      onQuickOpenChange={() => {}}
    />
  );
  const editor = await screen.findByLabelText('Editing src/a.ts');
  fireEvent.change(editor, { target: { value: 'a edited' } });
  // Quick open's only hit is src/b.ts.
  fireEvent.click(await screen.findByRole('option'));

  await screen.findByLabelText('Editing src/b.ts');
  expect(recorded.saved).toEqual([{ path: 'src/a.ts', text: 'a edited' }]);
});

test('leaving the view saves an unsaved edit', async () => {
  const recorded = recorder();
  const { unmount } = render(
    <FilesView data={fakeData(recorded)} initialPath="src/a.ts" />
  );
  const editor = await screen.findByLabelText('Editing src/a.ts');
  fireEvent.change(editor, { target: { value: 'changed' } });
  unmount();
  await waitFor(() =>
    expect(recorded.saved).toEqual([{ path: 'src/a.ts', text: 'changed' }])
  );
});

test('⌘S saves now rather than after the debounce', async () => {
  const recorded = recorder();
  render(<FilesView data={fakeData(recorded)} initialPath="src/a.ts" />);
  const editor = await screen.findByLabelText('Editing src/a.ts');
  fireEvent.change(editor, { target: { value: 'now' } });
  fireEvent.keyDown(window, { key: 's', metaKey: true });
  expect(recorded.saved).toEqual([{ path: 'src/a.ts', text: 'now' }]);
  expect(await screen.findByText('Saved')).toBeDefined();
});

test('Tab indents in the editor with the file’s own unit instead of leaving it', async () => {
  render(
    <FilesView
      data={withText(fakeData(recorder()), 'if (x) {\n    y;\n}')}
      initialPath="src/a.ts"
    />
  );
  const editor =
    await screen.findByLabelText<HTMLTextAreaElement>('Editing src/a.ts');
  editor.setSelectionRange(8, 8);
  fireEvent.keyDown(editor, { key: 'Tab' });
  // The file indents by four, so Tab types four.
  expect(editor.value).toBe('if (x) {    \n    y;\n}');
});
