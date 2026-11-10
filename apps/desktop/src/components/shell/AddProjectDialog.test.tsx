import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, describe, expect, mock, test } from 'bun:test';

import type { GithubRepo } from '../../lib/tauri';

const REPOS: GithubRepo[] = [
  {
    nameWithOwner: 'ada/storefront',
    name: 'storefront',
    description: 'The shop front',
  },
  { nameWithOwner: 'ada/billing', name: 'billing', description: '' },
];

// What the stubbed Tauri commands do in the current test; each test sets
// the ones it needs and afterEach puts the defaults back.
const tauri = {
  pickDirectory: (): Promise<string | null> => Promise.resolve('/Users/ada'),
  listGithubRepos: (): Promise<GithubRepo[]> => Promise.resolve(REPOS),
  cloneGithubRepo: (_name: string, parent: string): Promise<string> =>
    Promise.resolve(`${parent}/storefront`),
};
const defaults = { ...tauri };

// bun replaces the whole module for every file in the run, so keep the real
// exports (isTauri and the rest, which other files import) and stub only the
// three commands the dialog calls.
const realTauri = await import('../../lib/tauri');
void mock.module('../../lib/tauri', () => ({
  ...realTauri,
  pickDirectory: () => tauri.pickDirectory(),
  listGithubRepos: () => tauri.listGithubRepos(),
  cloneGithubRepo: (name: string, parent: string) =>
    tauri.cloneGithubRepo(name, parent),
}));

const { AddProjectDialog } = await import('./AddProjectDialog');

afterEach(() => {
  cleanup();
  Object.assign(tauri, defaults);
});

function open(over: Partial<Parameters<typeof AddProjectDialog>[0]> = {}): {
  onAdd: ReturnType<typeof mock>;
  onClose: ReturnType<typeof mock>;
} {
  const onAdd = mock((_path: string) => Promise.resolve());
  const onClose = mock(() => {});
  render(<AddProjectDialog onAdd={onAdd} onClose={onClose} {...over} />);
  return { onAdd, onClose };
}

function dialog(): HTMLElement {
  return screen.getByRole('dialog');
}

/** A promise the test settles by hand, for a command still in flight. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('AddProjectDialog', () => {
  test('the choice offers a local folder and GitHub', () => {
    open();
    expect(screen.getByRole('dialog', { name: 'Add project' })).toBeTruthy();
    expect(
      screen.getByText(
        'Open a local folder, or clone a repository from GitHub.'
      )
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: /Local folder…/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /From GitHub/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
  });

  test('a local folder is added through onAdd', async () => {
    const { onAdd } = open();
    fireEvent.click(screen.getByRole('button', { name: /Local folder…/ }));
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0]).toEqual(['/Users/ada']);
  });

  test('From GitHub lists the repositories, and the search filters them', async () => {
    open();
    fireEvent.click(screen.getByRole('button', { name: /From GitHub/ }));
    expect(
      screen.getByRole('dialog', { name: 'Clone from GitHub' })
    ).toBeTruthy();
    const list = await screen.findByRole('list', { name: 'Repositories' });
    expect(
      within(list)
        .getAllByRole('button')
        .map((row) => row.getAttribute('aria-label'))
    ).toEqual(['Clone ada/storefront, The shop front', 'Clone ada/billing']);
    expect(within(list).getByText('The shop front')).toBeTruthy();
    // The row's hover hint is its description, or its name without one.
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((row) => row.getAttribute('title'))
    ).toEqual(['The shop front', 'ada/billing']);
    // Focus follows the choice into the search box.
    const search = screen.getByRole('searchbox', {
      name: 'Search repositories',
    });
    expect(document.activeElement).toBe(search);
    expect(search.getAttribute('placeholder')).toBe('Search repositories…');
    fireEvent.change(search, { target: { value: 'shop' } });
    expect(
      within(screen.getByRole('list', { name: 'Repositories' }))
        .getAllByRole('button')
        .map((row) => row.getAttribute('aria-label'))
    ).toEqual(['Clone ada/storefront, The shop front']);
    fireEvent.change(search, { target: { value: 'nothing like it' } });
    expect(screen.getByText('No repositories match your search.')).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Repositories' })).toBeNull();
  });

  test('Escape clears the search first, then closes the dialog', async () => {
    const { onClose } = open({ initialMode: 'github' });
    await screen.findByRole('list', { name: 'Repositories' });
    const search = screen.getByRole<HTMLInputElement>('searchbox', {
      name: 'Search repositories',
    });
    fireEvent.change(search, { target: { value: 'bill' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  test('Back returns to the choice', async () => {
    open({ initialMode: 'github' });
    await screen.findByRole('list', { name: 'Repositories' });
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByRole('dialog', { name: 'Add project' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /From GitHub/ })).toBeTruthy();
  });

  test('no repositories says so', async () => {
    tauri.listGithubRepos = () => Promise.resolve<GithubRepo[]>([]);
    open({ initialMode: 'github' });
    expect(await screen.findByText('No repositories found.')).toBeTruthy();
  });

  test('a clone in flight disables Cancel and Escape, then registers the checkout', async () => {
    const clone = deferred<string>();
    tauri.cloneGithubRepo = () => clone.promise;
    const { onAdd, onClose } = open({ initialMode: 'github' });
    await screen.findByRole('list', { name: 'Repositories' });
    fireEvent.click(
      screen.getByRole('button', { name: /^Clone ada\/storefront/ })
    );
    expect(await screen.findByText('Cloning storefront…')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')
    ).toBe(true);
    fireEvent.keyDown(dialog(), { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    await act(async () => {
      clone.resolve('/Users/ada/storefront');
      await clone.promise;
    });
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(onAdd.mock.calls[0]).toEqual(['/Users/ada/storefront']);
  });

  test('a rejected add shows its message and keeps the dialog open', async () => {
    const { onClose } = open({
      onAdd: () => Promise.reject(new Error('Not a directory: /Users/ada')),
    });
    fireEvent.click(screen.getByRole('button', { name: /Local folder…/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Not a directory: /Users/ada');
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Add project' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Cancel' }).hasAttribute('disabled')
    ).toBe(false);
  });

  test('a failed repository load shows the error', async () => {
    tauri.listGithubRepos = () =>
      Promise.reject(new Error('gh is not signed in'));
    open({ initialMode: 'github' });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('gh is not signed in');
    expect(screen.queryByRole('list', { name: 'Repositories' })).toBeNull();
  });

  test('a failed load is asked once, and again only when GitHub is chosen again', async () => {
    const calls = mock(() =>
      Promise.reject<GithubRepo[]>(new Error('gh is not signed in'))
    );
    tauri.listGithubRepos = calls;
    open({ initialMode: 'github' });
    await screen.findByRole('alert');
    // Settled: the failure does not ask again by itself.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(calls).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Back' }));
    fireEvent.click(screen.getByRole('button', { name: /From GitHub/ }));
    await screen.findByRole('alert');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(calls).toHaveBeenCalledTimes(2);
  });
});
