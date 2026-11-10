import type { SetupReport } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, expect, mock, test } from 'bun:test';

const openUrl = mock(() => Promise.resolve());
// bun replaces the whole module for every file in the run, so keep the real exports
// (isTauri and the rest, which other files import) and stub the one AgentStep calls.
const realTauri = await import('../../lib/tauri');
void mock.module('../../lib/tauri', () => ({ ...realTauri, openUrl }));

const { AgentStep } = await import('./AgentStep');

const caps = { execute: true, plan: false, oversee: false };
function report(over: Partial<SetupReport> = {}): SetupReport {
  return {
    defaultProvider: 'claude',
    steps: [
      {
        id: 'agent',
        status: 'needs-action',
        message: "Claude Code isn't signed in.",
        fix: {
          kind: 'run',
          label: 'Sign in',
          command: ['claude', 'auth', 'login'],
        },
      },
    ],
    providers: [
      {
        id: 'claude',
        name: 'Claude Code',
        blurb: 'Uses your Claude Pro or Max plan.',
        installed: true,
        works: true,
        auth: 'signed-out',
        usingApiKey: false,
        ready: false,
        capabilities: { execute: true, plan: true, oversee: true },
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        signIn: {
          kind: 'run',
          label: 'Sign in',
          command: ['claude', 'auth', 'login'],
        },
      },
      {
        id: 'codex',
        name: 'Codex',
        blurb: 'Uses your ChatGPT plan.',
        installed: false,
        works: false,
        auth: 'unknown',
        usingApiKey: false,
        ready: false,
        capabilities: caps,
        apiKeyEnv: 'OPENAI_API_KEY',
        install: {
          kind: 'run',
          label: 'Install Codex',
          command: ['brew', 'install', '--cask', 'codex'],
        },
      },
      {
        id: 'cursor',
        name: 'Cursor',
        blurb: 'Uses your Cursor account.',
        installed: false,
        works: false,
        auth: 'unknown',
        usingApiKey: false,
        ready: false,
        capabilities: caps,
        install: {
          kind: 'open-url',
          label: 'Get Cursor',
          href: 'https://cursor.com/download',
        },
      },
    ],
    ...over,
  };
}

function setup(r = report()) {
  const client = {
    fetchSetup: mock(() => Promise.resolve(r)),
    saveAgentKey: mock((..._args: unknown[]) =>
      Promise.resolve(
        report({
          steps: [
            { id: 'agent', status: 'ok', message: 'Claude Code is ready.' },
          ],
        })
      )
    ),
    refreshSetup: mock(() => Promise.resolve({ added: [] })),
    createTerminal: mock(() =>
      Promise.resolve({ id: 't1', state: 'running', pty: true })
    ),
    // CommandTerminal's useTerminalOutput polls these.
    fetchTerminal: mock(() =>
      Promise.resolve({ id: 't1', state: 'running', pty: true })
    ),
    fetchTerminalOutput: mock(() =>
      Promise.resolve({
        data: '',
        next: 0,
        more: false,
        state: 'running',
        exitCode: null,
        total: 0,
      })
    ),
    sendTerminalInput: mock(() => Promise.resolve()),
    // CommandTerminal ends a still-running command when it unmounts.
    closeTerminal: mock((_id: string) => Promise.resolve()),
  };
  const onSetDefault = mock((_id: string) => Promise.resolve());
  const onContinue = mock(() => {});
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  render(
    <QueryClientProvider client={queryClient}>
      <AgentStep
        client={client as unknown as ApiClient}
        port={4771}
        onSetDefault={onSetDefault}
        onContinue={onContinue}
      />
    </QueryClientProvider>
  );
  return { client, onSetDefault, onContinue, queryClient };
}

// Clicks inside an awaited act so the async state updates a click triggers are flushed.
async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
});

test('lists providers with the default first and offers sign-in', async () => {
  setup();
  expect(await screen.findByText("Claude Code isn't signed in.")).toBeTruthy();
  expect(screen.getByText('Sign in')).toBeTruthy();
  expect(screen.getByText('Install Codex')).toBeTruthy();
});

test('sign-in opens the provider login in a terminal', async () => {
  const { client } = setup();
  await click(await screen.findByText('Sign in'));
  await waitFor(() =>
    expect(client.createTerminal).toHaveBeenCalledWith({
      command: ['claude', 'auth', 'login'],
      title: 'Sign in to Claude Code',
    })
  );
});

test('a download link opens in the browser instead of a terminal', async () => {
  const { client } = setup();
  await click(await screen.findByText('Get Cursor'));
  expect(openUrl).toHaveBeenCalledWith('https://cursor.com/download');
  expect(client.createTerminal).not.toHaveBeenCalled();
});

test('saves an API key instead', async () => {
  const { client } = setup();
  await click(await screen.findByText('Use an API key instead'));
  fireEvent.change(screen.getByLabelText('Claude Code API key'), {
    target: { value: 'sk-ant-1' },
  });
  await click(screen.getByText('Save key'));
  await waitFor(() =>
    expect(client.saveAgentKey).toHaveBeenCalledWith('claude', 'sk-ant-1')
  );
  expect(document.body.textContent).not.toContain('sk-ant-1');
});

test('a failed key save shows a sentence with the reason under Details', async () => {
  const { client } = setup();
  client.saveAgentKey.mockImplementationOnce(() =>
    Promise.reject('disk is full')
  );
  await click(await screen.findByText('Use an API key instead'));
  fireEvent.change(screen.getByLabelText('Claude Code API key'), {
    target: { value: 'sk-ant-1' },
  });
  await click(screen.getByText('Save key'));
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe(
    "Couldn't save that key. Check it and try again."
  );
  expect(screen.getByText('Details')).toBeTruthy();
  expect(document.body.textContent).not.toContain('sk-ant-1');
});

test('continue is disabled until the agent step is ok or unknown', async () => {
  setup();
  const button = (await screen.findByText('Continue')).closest('button');
  expect(button?.disabled).toBe(true);
});

test('continue is enabled for a ready agent and makes it the default', async () => {
  const base = report();
  const ready = report({
    steps: [{ id: 'agent', status: 'ok', message: 'Codex is ready.' }],
    defaultProvider: 'codex',
    providers: [
      {
        ...base.providers[1],
        installed: true,
        works: true,
        ready: true,
        auth: 'signed-in',
      },
    ],
  });
  const { onSetDefault, onContinue } = setup(ready);
  await click(await screen.findByText('Continue'));
  await waitFor(() => expect(onSetDefault).toHaveBeenCalledWith('codex'));
  await waitFor(() => expect(onContinue).toHaveBeenCalled());
});

test('saving refreshes the executor list, so Dispatch buttons follow the new default', async () => {
  const base = report();
  const ready = report({
    steps: [{ id: 'agent', status: 'ok', message: 'Codex is ready.' }],
    defaultProvider: 'codex',
    providers: [
      {
        ...base.providers[1],
        installed: true,
        works: true,
        ready: true,
        auth: 'signed-in',
      },
    ],
  });
  const { queryClient, onContinue } = setup(ready);
  queryClient.setQueryData(['dispatch-executors', 4771], { default: 'claude' });
  await click(await screen.findByText('Continue'));
  await waitFor(() => expect(onContinue).toHaveBeenCalled());
  expect(
    queryClient.getQueryState(['dispatch-executors', 4771])?.isInvalidated
  ).toBe(true);
});

test('re-reads installed agents before saving the default', async () => {
  const base = report();
  const ready = report({
    steps: [{ id: 'agent', status: 'ok', message: 'Codex is ready.' }],
    defaultProvider: 'codex',
    providers: [
      {
        ...base.providers[1],
        installed: true,
        works: true,
        ready: true,
        auth: 'signed-in',
      },
    ],
  });
  const order: string[] = [];
  const { client, onSetDefault } = setup(ready);
  client.refreshSetup.mockImplementation(() => {
    order.push('refresh');
    return Promise.resolve({ added: [] });
  });
  onSetDefault.mockImplementation((id: string) => {
    order.push(`default:${id}`);
    return Promise.resolve();
  });
  await click(await screen.findByText('Continue'));
  await waitFor(() => expect(order).toEqual(['refresh', 'default:codex']));
});

const usingKey = () => {
  const r = report();
  r.providers[0] = {
    ...r.providers[0],
    usingApiKey: true,
    ready: true,
  };
  return r;
};

test('a saved key can be replaced', async () => {
  const { client } = setup(usingKey());
  expect(
    await screen.findByText(
      'Using an API key instead of your Claude Code sign-in.'
    )
  ).toBeTruthy();
  expect(screen.queryByText('Use an API key instead')).toBeNull();
  await click(screen.getByText('Replace key'));
  fireEvent.change(screen.getByLabelText('Claude Code API key'), {
    target: { value: 'sk-ant-2' },
  });
  await click(screen.getByText('Save key'));
  await waitFor(() =>
    expect(client.saveAgentKey).toHaveBeenCalledWith('claude', 'sk-ant-2')
  );
});

test('a saved key can be removed', async () => {
  const { client } = setup(usingKey());
  await click(await screen.findByText('Remove key'));
  await waitFor(() =>
    expect(client.saveAgentKey).toHaveBeenCalledWith('claude', null)
  );
});

test('never shows internal words', async () => {
  setup();
  await screen.findByText("Claude Code isn't signed in.");
  expect(document.body.textContent).not.toMatch(
    /dispatchd|\.dispatch\/|tracker|worktree|executor/i
  );
});

test('continue follows the selected agent, not the default', async () => {
  const signedOutDefault = report({
    defaultProvider: 'codex',
    steps: [{ id: 'agent', status: 'ok', message: 'Codex is ready.' }],
    providers: [
      {
        ...report().providers[0],
        id: 'codex',
        name: 'Codex',
        ready: true,
        auth: 'signed-in',
      },
      report().providers[0],
    ],
  });
  setup(signedOutDefault);
  const button = (await screen.findByText('Continue')).closest('button');
  expect(button?.disabled).toBe(false);
  await click(screen.getByLabelText('Use Claude Code'));
  await waitFor(() => expect(button?.disabled).toBe(true));
});

test('continue is enabled for a ready selection even when the default needs action', async () => {
  const mixed = report();
  mixed.providers[1] = {
    ...mixed.providers[1],
    installed: true,
    works: true,
    ready: true,
    auth: 'signed-in',
  };
  setup(mixed);
  const button = (await screen.findByText('Continue')).closest('button');
  expect(button?.disabled).toBe(true);
  await click(screen.getByLabelText('Use Codex'));
  await waitFor(() => expect(button?.disabled).toBe(false));
});

test('re-checks the machine after an install command exits', async () => {
  const { client } = setup();
  client.fetchTerminal.mockImplementation(() =>
    Promise.resolve({ id: 't1', state: 'exited', pty: true, exitCode: 0 })
  );
  await click(await screen.findByText('Install Codex'));
  await waitFor(() => expect(client.refreshSetup).toHaveBeenCalled());
  await waitFor(() =>
    expect(client.fetchSetup.mock.calls.length).toBeGreaterThan(1)
  );
});

test('the step is a section named by its h2, with a toned status glyph', async () => {
  setup();
  const section = await screen.findByRole('region', { name: 'Your AI agent' });
  const heading = within(section).getByRole('heading', {
    level: 2,
    name: 'Your AI agent',
  });
  expect(section.getAttribute('aria-labelledby')).toBe(heading.id);
  const glyph = within(section).getByRole('img', { name: 'Needs you' });
  expect(glyph.getAttribute('data-tone')).toBe('warning');
});

test('Install and Sign in sit beside the card, outside the radio name', async () => {
  setup();
  const radio = await screen.findByRole('radio', { name: 'Use Claude Code' });
  expect(radio.getAttribute('aria-label')).toBe('Use Claude Code');
  expect(radio.closest('label')?.textContent).not.toContain('Sign in');
  // The state chip and the buttons are real controls, not part of any radio.
  const signIn = screen.getByRole('button', { name: 'Sign in' });
  expect(signIn.closest('label')).toBeNull();
  expect(screen.getByText('Signed out')).toBeTruthy();
  const install = screen.getByRole('button', { name: 'Install Codex' });
  expect(install.closest('label')).toBeNull();
  // A provider that is not installed cannot be picked.
  const codex = screen.getByRole<HTMLInputElement>('radio', {
    name: 'Use Codex',
  });
  expect(codex.disabled).toBe(true);
});

test('the API key block shows only under the checked card', async () => {
  const both = report();
  both.providers[1] = {
    ...both.providers[1],
    installed: true,
    works: true,
    ready: true,
    auth: 'signed-in',
  };
  setup(both);
  const claude = await screen.findByRole<HTMLInputElement>('radio', {
    name: 'Use Claude Code',
  });
  expect(claude.checked).toBe(true);
  expect(screen.getAllByText('Use an API key instead')).toHaveLength(1);
  await click(screen.getByRole('radio', { name: 'Use Codex' }));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Use Codex' }).checked
    ).toBe(true)
  );
  // Still one offer: Codex's, now that its card is the checked one.
  expect(screen.getAllByText('Use an API key instead')).toHaveLength(1);
  await click(screen.getByText('Use an API key instead'));
  expect(screen.getByLabelText('Codex API key')).toBeTruthy();
  expect(screen.queryByLabelText('Claude Code API key')).toBeNull();
});

test('a step the machine could not check says so with a grey glyph', async () => {
  setup(
    report({
      steps: [
        {
          id: 'agent',
          status: 'unknown',
          message: "Couldn't check your agents.",
        },
      ],
    })
  );
  const glyph = await screen.findByRole('img', { name: "Couldn't check" });
  expect(glyph.getAttribute('data-tone')).toBe('muted');
});

test('a running sign-in keeps its terminal while another card is picked, and starts once', async () => {
  const both = report();
  both.providers[1] = {
    ...both.providers[1],
    installed: true,
    works: true,
    ready: true,
    auth: 'signed-in',
  };
  const { client } = setup(both);
  await click(await screen.findByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(client.createTerminal).toHaveBeenCalledTimes(1));
  expect(screen.getByLabelText('Sign in to Claude Code')).toBeTruthy();
  // Picking Codex hides Claude's key controls but not the running command.
  await click(screen.getByRole('radio', { name: 'Use Codex' }));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'Use Codex' }).checked
    ).toBe(true)
  );
  const terminal = screen.getByLabelText('Sign in to Claude Code');
  // Back to Claude: the same terminal, and the login was not started again.
  await click(screen.getByRole('radio', { name: 'Use Claude Code' }));
  expect(screen.getByLabelText('Sign in to Claude Code') === terminal).toBe(
    true
  );
  expect(client.createTerminal).toHaveBeenCalledTimes(1);
  // The terminal sits outside every card, so no radio's label holds it.
  expect(terminal.closest('label')).toBeNull();
});

test('another action leaves a running install to finish, and ends a running sign-in', async () => {
  const { client } = setup();
  let started = 0;
  client.createTerminal.mockImplementation(() => {
    started += 1;
    return Promise.resolve({ id: `t${started}`, state: 'running', pty: true });
  });
  await click(await screen.findByRole('button', { name: 'Install Codex' }));
  await waitFor(() => expect(client.createTerminal).toHaveBeenCalledTimes(1));
  // Signing in to Claude replaces the install's terminal, but a half-done
  // `brew install` is never stopped.
  await click(screen.getByRole('button', { name: 'Sign in' }));
  await waitFor(() => expect(client.createTerminal).toHaveBeenCalledTimes(2));
  expect(screen.getByLabelText('Sign in to Claude Code')).toBeTruthy();
  expect(client.closeTerminal).not.toHaveBeenCalled();
  // Starting the install again replaces the sign-in, which nobody could
  // answer any more, so it ends.
  await click(screen.getByRole('button', { name: 'Install Codex' }));
  await waitFor(() => expect(client.createTerminal).toHaveBeenCalledTimes(3));
  expect(client.closeTerminal.mock.calls).toEqual([['t2']]);
});

test('a key typed for one agent is not carried to another', async () => {
  const both = report();
  both.providers[1] = {
    ...both.providers[1],
    installed: true,
    works: true,
    ready: true,
    auth: 'signed-in',
  };
  setup(both);
  await click(await screen.findByText('Use an API key instead'));
  fireEvent.change(screen.getByLabelText('Claude Code API key'), {
    target: { value: 'sk-ant-1' },
  });
  await click(screen.getByRole('radio', { name: 'Use Codex' }));
  await click(screen.getByText('Use an API key instead'));
  expect(screen.getByLabelText<HTMLInputElement>('Codex API key').value).toBe(
    ''
  );
});
