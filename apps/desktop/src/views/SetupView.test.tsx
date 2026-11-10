import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import type { ReactElement } from 'react';

const tauri = {
  gitSetupStatus: mock(() =>
    Promise.resolve({
      installed: true,
      version: 'git version 2',
      name: 'Ada',
      email: 'a@b.c',
      installHint: null,
    })
  ),
  installGit: mock(() => Promise.resolve()),
  setGitIdentity: mock(() => Promise.resolve()),
  pickDirectory: mock(() => Promise.resolve('/Users/ada/site')),
  projectFolderState: mock(() =>
    Promise.resolve({
      isDir: true,
      isGitRepo: false,
      hasCommits: false,
      hasGitignore: false,
      tooBroad: false,
    })
  ),
  prepareProjectFolder: mock(() => Promise.resolve()),
  installCliCommand: mock(() =>
    Promise.resolve({ path: '/usr/local/bin/dispatch', onPath: true })
  ),
};
// bun replaces the whole module for every file in the run, so keep the real exports (isTauri
// and the rest, which other files import) and stub the ones the setup steps and
// AddProjectDialog call.
const realTauri = await import('../lib/tauri');
void mock.module('../lib/tauri', () => ({
  ...realTauri,
  ...tauri,
  // The mock registry is shared across test files, so AgentStep.test's import needs this.
  openUrl: mock(() => Promise.resolve()),
  listGithubRepos: mock(() => Promise.resolve([])),
  cloneGithubRepo: mock(() => Promise.resolve('')),
}));

const { SetupView } = await import('./SetupView');
const { CliCommandStep } = await import('../components/setup/CliCommandStep');

// GitStep reads and invalidates react-query, so every render needs a fresh client.
function render(ui: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return rtlRender(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>
  );
}

beforeEach(() => {
  for (const fn of Object.values(tauri)) fn.mockClear();
});

// Clicks inside an awaited act so the async state updates a click triggers are flushed.
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

// Lets in-flight state updates land inside act before the next test starts.
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
});

test('shows a tick for installed git with identity', async () => {
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  expect(
    await screen.findByText('Git is installed and knows who you are.')
  ).toBeTruthy();
});

test('asks for a name and email when git has none, and saves them', async () => {
  tauri.gitSetupStatus.mockImplementationOnce(() =>
    Promise.resolve({
      installed: true,
      version: 'v',
      name: null,
      email: null,
      installHint: null,
    })
  );
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  fireEvent.change(await screen.findByLabelText('Your name'), {
    target: { value: 'Ada' },
  });
  fireEvent.change(screen.getByLabelText('Your email'), {
    target: { value: 'ada@example.com' },
  });
  await click(screen.getByText('Save'));
  await waitFor(() =>
    expect(tauri.setGitIdentity).toHaveBeenCalledWith('Ada', 'ada@example.com')
  );
  await screen.findByText('Git is installed and knows who you are.');
});

test('offers to install git when it is missing', async () => {
  tauri.gitSetupStatus.mockImplementationOnce(() =>
    Promise.resolve({
      installed: false,
      version: null,
      name: null,
      email: null,
      installHint: null,
    })
  );
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  await click(await screen.findByText('Install Git'));
  await waitFor(() => expect(tauri.installGit).toHaveBeenCalled());
});

test('shows a plain sentence, with the raw reason under Details, when saving the name fails', async () => {
  tauri.gitSetupStatus.mockImplementationOnce(() =>
    Promise.resolve({
      installed: true,
      version: 'v',
      name: null,
      email: null,
      installHint: null,
    })
  );
  tauri.setGitIdentity.mockImplementationOnce(() =>
    Promise.reject('fatal: boom')
  );
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  fireEvent.change(await screen.findByLabelText('Your name'), {
    target: { value: 'Ada' },
  });
  fireEvent.change(screen.getByLabelText('Your email'), {
    target: { value: 'ada@example.com' },
  });
  await click(screen.getByText('Save'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(
    "Couldn't save that. Check your name and email and try again."
  );
  expect(screen.getByText('Details')).toBeTruthy();
});

test('shows the reason under Details when the folder cannot be checked', async () => {
  tauri.projectFolderState.mockImplementationOnce(() =>
    Promise.reject('permission denied')
  );
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  await click(await screen.findByText('Choose a folder'));
  expect(await screen.findByText('Details')).toBeTruthy();
  expect(screen.getByText('Set up this folder')).toBeTruthy();
});

test('turns on version tracking for a plain folder before adding it', async () => {
  const onProjectChosen = mock(() => Promise.resolve());
  render(<SetupView projectPath={null} onProjectChosen={onProjectChosen} />);
  await click(await screen.findByText('Choose a folder'));
  await click(await screen.findByText('Turn on version tracking'));
  await waitFor(() =>
    expect(tauri.prepareProjectFolder).toHaveBeenCalledWith('/Users/ada/site')
  );
  await waitFor(() =>
    expect(onProjectChosen).toHaveBeenCalledWith('/Users/ada/site')
  );
  await waitFor(() => expect(onProjectChosen).toHaveBeenCalledTimes(1));
});

test('adds a folder that is already a repo with history straight away', async () => {
  tauri.projectFolderState.mockImplementationOnce(() =>
    Promise.resolve({
      isDir: true,
      isGitRepo: true,
      hasCommits: true,
      hasGitignore: true,
      tooBroad: false,
    })
  );
  const onProjectChosen = mock(() => Promise.resolve());
  render(<SetupView projectPath={null} onProjectChosen={onProjectChosen} />);
  await click(await screen.findByText('Choose a folder'));
  await waitFor(() =>
    expect(onProjectChosen).toHaveBeenCalledWith('/Users/ada/site')
  );
  expect(tauri.prepareProjectFolder).not.toHaveBeenCalled();
});

test('refuses a folder too broad to be one project', async () => {
  tauri.pickDirectory.mockImplementationOnce(() =>
    Promise.resolve('/Users/ada/Documents')
  );
  tauri.projectFolderState.mockImplementationOnce(() =>
    Promise.resolve({
      isDir: true,
      isGitRepo: false,
      hasCommits: false,
      hasGitignore: false,
      tooBroad: true,
    })
  );
  const onProjectChosen = mock(() => Promise.resolve());
  render(<SetupView projectPath={null} onProjectChosen={onProjectChosen} />);
  await click(await screen.findByText('Choose a folder'));
  expect(
    await screen.findByText(
      'Pick a project folder, not your whole Documents folder.'
    )
  ).toBeTruthy();
  expect(screen.queryByText('Turn on version tracking')).toBeNull();
  expect(tauri.prepareProjectFolder).not.toHaveBeenCalled();
  expect(onProjectChosen).not.toHaveBeenCalled();
});

test('goes back to picking from the version tracking prompt', async () => {
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  await click(await screen.findByText('Choose a folder'));
  await click(await screen.findByText('Choose a different folder'));
  expect(await screen.findByText('Choose a folder')).toBeTruthy();
  expect(screen.queryByText('Turn on version tracking')).toBeNull();
  expect(tauri.prepareProjectFolder).not.toHaveBeenCalled();
});

test('goes back to picking from an open folder that is not set up', async () => {
  render(
    <SetupView
      projectPath="/Users/ada/site"
      onProjectChosen={() => Promise.resolve()}
    />
  );
  await screen.findByText('Git is installed and knows who you are.');
  await click(await screen.findByText('Choose a different folder'));
  expect(await screen.findByText('Choose a folder')).toBeTruthy();
});

test('says where the terminal command went when its folder is on PATH', async () => {
  render(<CliCommandStep />);
  await click(screen.getByText('Install command'));
  expect(
    await screen.findByText('Installed at /usr/local/bin/dispatch')
  ).toBeTruthy();
});

test('tells you to add ~/.local/bin to PATH when it is not on it', async () => {
  tauri.installCliCommand.mockImplementationOnce(() =>
    Promise.resolve({
      path: '/Users/ada/.local/bin/dispatch',
      onPath: false,
    })
  );
  render(<CliCommandStep />);
  await click(screen.getByText('Install command'));
  expect(
    await screen.findByText(
      `Installed. Add ~/.local/bin to your PATH to use it: echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`
    )
  ).toBeTruthy();
});

test('never shows internal words', async () => {
  const { container } = render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  await screen.findByText('Git is installed and knows who you are.');
  expect(container.textContent).not.toMatch(
    /dispatchd|\.dispatch\/|tracker|worktree|executor/i
  );
});

test('each step is a section named by its h2, its glyph named for its state', async () => {
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  expect(
    screen.getByRole('heading', { level: 1, name: 'Welcome to Dispatch' })
  ).toBeTruthy();
  const git = screen.getByRole('region', { name: 'Git' });
  expect(within(git).getByRole('heading', { level: 2 }).textContent).toBe(
    'Git'
  );
  // Probing the machine: a spinner and the words, no glyph name yet.
  expect(within(git).getByText('Checking…')).toBeTruthy();
  await within(git).findByRole('img', { name: 'Done' });
  expect(
    within(git).getByRole('img', { name: 'Done' }).getAttribute('data-tone')
  ).toBe('success');
  const project = screen.getByRole('region', { name: 'Your project' });
  expect(
    within(project)
      .getByRole('img', { name: 'Needs you' })
      .getAttribute('data-tone')
  ).toBe('warning');
  const agent = screen.getByRole('region', { name: 'Your AI agent' });
  expect(
    within(agent)
      .getByRole('img', { name: 'Not yet' })
      .getAttribute('data-tone')
  ).toBe('muted');
  // SetupView is only the column: App's signed-out frame owns the one <main>.
  expect(screen.queryByRole('main')).toBeNull();
});

test('the project step waits for git, with a Not yet glyph', async () => {
  tauri.gitSetupStatus.mockImplementationOnce(() =>
    Promise.resolve({
      installed: false,
      version: null,
      name: null,
      email: null,
      installHint: null,
    })
  );
  render(
    <SetupView projectPath={null} onProjectChosen={() => Promise.resolve()} />
  );
  await screen.findByText('Install Git');
  const project = screen.getByRole('region', { name: 'Your project' });
  expect(within(project).getByRole('img', { name: 'Not yet' })).toBeTruthy();
  expect(within(project).queryByRole('button')).toBeNull();
});

test('a failed terminal command install names itself and keeps the reason under Details', async () => {
  tauri.installCliCommand.mockImplementationOnce(() =>
    Promise.reject('permission denied')
  );
  render(<CliCommandStep />);
  const step = screen.getByRole('region', { name: 'Terminal command' });
  expect(within(step).getByRole('img', { name: 'Not yet' })).toBeTruthy();
  await click(within(step).getByRole('button', { name: 'Install command' }));
  expect(
    await within(step).findByText("Couldn't install the command.")
  ).toBeTruthy();
  await click(within(step).getByRole('button', { name: 'Details' }));
  expect(within(step).getByText('permission denied')).toBeTruthy();
});
