import type {
  ApiClient,
  WorkspaceEntry,
  WorkspaceTree,
} from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { FileTree } from './FileTree';

// One tree entry; size and time are never read by the tree.
function entry(path: string, kind: WorkspaceEntry['kind']): WorkspaceEntry {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return { name, path, kind, size: 0, modifiedAt: null };
}

// A two-level checkout: src/ holding app.ts, and README.md at the root.
const TREE: Record<string, WorkspaceEntry[]> = {
  '': [entry('src', 'directory'), entry('README.md', 'file')],
  src: [entry('src/app.ts', 'file')],
};

// A client serving TREE that records every directory it was asked for.
function fakeClient(loads: string[]): ApiClient {
  return {
    fetchWorkspaceTree: (path: string): Promise<WorkspaceTree> => {
      loads.push(path);
      return Promise.resolve({ path, runId: null, entries: TREE[path] ?? [] });
    },
  } as unknown as ApiClient;
}

function mount(
  loads: string[],
  selectedPath: string | null = null,
  onSelect: (path: string) => void = () => {}
) {
  return render(
    <FileTree
      client={fakeClient(loads)}
      runId={null}
      selectedPath={selectedPath}
      onSelect={onSelect}
    />
  );
}

test('the root entries render as buttons', async () => {
  const loads: string[] = [];
  mount(loads);
  const src = await screen.findByRole('button', { name: 'src' });
  expect(src.getAttribute('type')).toBe('button');
  expect(screen.getByRole('button', { name: 'README.md' })).toBeTruthy();
  expect(loads).toEqual(['']);
});

test('a directory toggles aria-expanded and loads its children once', async () => {
  const loads: string[] = [];
  mount(loads);
  const src = await screen.findByRole('button', { name: 'src' });
  expect(src.getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(src);
  expect(src.getAttribute('aria-expanded')).toBe('true');
  const child = await screen.findByRole('button', { name: 'app.ts' });
  // Nested one level: the row's indent reads --depth.
  expect(child.style.getPropertyValue('--depth')).toBe('1');
  fireEvent.click(src);
  expect(src.getAttribute('aria-expanded')).toBe('false');
  expect(screen.queryByRole('button', { name: 'app.ts' })).toBeNull();
  fireEvent.click(src);
  await screen.findByRole('button', { name: 'app.ts' });
  expect(loads).toEqual(['', 'src']);
});

test('a file carries no aria-expanded; the selected one has aria-current', async () => {
  mount([], 'README.md');
  const readme = await screen.findByRole('button', { name: 'README.md' });
  expect(readme.hasAttribute('aria-expanded')).toBe(false);
  expect(readme.getAttribute('aria-current')).toBe('true');
  const src = screen.getByRole('button', { name: 'src' });
  expect(src.hasAttribute('aria-current')).toBe(false);
});

test('onSelect fires for a file, never for a directory', async () => {
  const picked: string[] = [];
  mount([], null, (path) => picked.push(path));
  fireEvent.click(await screen.findByRole('button', { name: 'src' }));
  fireEvent.click(screen.getByRole('button', { name: 'README.md' }));
  await waitFor(() => expect(picked).toEqual(['README.md']));
});

test('a failed load shows its words in the danger tone', async () => {
  render(
    <FileTree
      client={
        {
          fetchWorkspaceTree: () => Promise.reject(new Error('no such run')),
        } as unknown as ApiClient
      }
      runId="run-1"
      selectedPath={null}
      onSelect={() => {}}
    />
  );
  const error = await screen.findByText('no such run');
  expect(error.getAttribute('data-tone')).toBe('danger');
});
